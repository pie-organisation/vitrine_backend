const router = require('express').Router();
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const config = require('../config');
const { generateTempJwt } = require('../middleware/auth');

const VALID_ROLES = ['admin', 'scolarite', 'eleve', 'enseignant'];

function serializeAccount(r) {
  return {
    id: r.id,
    type: r.role,
    nom: r.nom,
    prenom: r.prenom,
    email: r.email,
    licenceCubi: r.licence_id || '',
    statut: r.statut === 'actif' ? 'actif' : 'inactif',
    derniereConnexion: r.derniere_connexion
      ? new Date(r.derniere_connexion).toLocaleString('fr-FR')
      : 'Jamais connecté',
  };
}

function serializeOrg(r) {
  const nbLicences = Number(r.nb_licences) || 0;
  const licencesUtilisees = Number(r.licences_utilisees) || 0;
  const prixUnitaire = r.prix_unitaire !== null ? Number(r.prix_unitaire) : null;
  return {
    nom: r.nom,
    plan: r.plan,
    dateDebut: r.date_debut
      ? new Date(r.date_debut).toLocaleDateString('fr-FR')
      : new Date(r.date_creation).toLocaleDateString('fr-FR'),
    dateExpiration: r.date_expiration ? new Date(r.date_expiration).toLocaleDateString('fr-FR') : null,
    montant: prixUnitaire !== null ? `${(prixUnitaire * nbLicences).toFixed(2).replace('.', ',')} €/mois` : '—',
    nbLicences,
    licencesUtilisees,
  };
}

function generateTempPassword() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 12; i++) {
    pwd += charset[Math.floor(Math.random() * charset.length)];
  }
  return pwd;
}

// GET /school/organisation
router.get('/organisation', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         e.nom_complet_ecole AS nom,
         e.date_creation,
         tl.nom AS plan,
         tl.prix_unitaire,
         COUNT(l.id) AS nb_licences,
         COUNT(l.id) FILTER (WHERE l.statut = 'assignee') AS licences_utilisees,
         MIN(l.date_debut) AS date_debut,
         CASE WHEN BOOL_OR(l.date_fin IS NULL) THEN NULL ELSE MAX(l.date_fin) END AS date_expiration
       FROM ecole e
       JOIN type_licence tl ON tl.id = e.type_licence_id
       LEFT JOIN licence l ON l.ecole_id = e.id
       WHERE e.id = $1
       GROUP BY e.id, tl.nom, tl.prix_unitaire`,
      [req.auth.ecoleId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Organisation introuvable' });
    res.json(serializeOrg(rows[0]));
  } catch (err) { next(err); }
});

// GET /school/comptes
router.get('/comptes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.*, l.id AS licence_id
       FROM utilisateur u
       LEFT JOIN licence l ON l.utilisateur_id = u.id AND l.statut = 'assignee'
       WHERE u.ecole_id = $1
       ORDER BY u.date_invitation DESC`,
      [req.auth.ecoleId]
    );
    res.json(rows.map(serializeAccount));
  } catch (err) { next(err); }
});

// POST /school/comptes — création en lot (un ou plusieurs comptes)
router.post('/comptes', async (req, res, next) => {
  try {
    const { comptes } = req.body || {};
    if (!Array.isArray(comptes) || comptes.length === 0) {
      return res.status(422).json({ message: "Aucun compte à créer — l'import de fichier n'est pas encore disponible, utilise la création manuelle." });
    }

    for (const c of comptes) {
      if (!c.nom?.trim() || !c.prenom?.trim() || !c.email?.trim()) {
        return res.status(422).json({ message: 'Chaque compte doit avoir un nom, un prénom et un email.' });
      }
      if (!VALID_ROLES.includes(c.type)) {
        return res.status(422).json({ message: `Type de compte invalide : ${c.type}` });
      }
    }

    const client = await pool.connect();
    const created = [];
    try {
      await client.query('BEGIN');
      for (const c of comptes) {
        const { rows: existing } = await client.query(
          "SELECT 1 FROM utilisateur WHERE email = $1",
          [c.email]
        );
        if (existing.length) {
          throw Object.assign(new Error(`Un compte avec l'email ${c.email} existe déjà`), { status: 409 });
        }

        const password = c.password?.trim() || generateTempPassword();
        const hash = await bcrypt.hash(password, 12);
        const userId = randomUUID();

        await client.query(
          `INSERT INTO utilisateur
             (id, ecole_id, classe_id, invite_par, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, TRUE, $8, 'actif')`,
          [userId, req.auth.ecoleId, req.auth.userId, c.nom, c.prenom, c.email, hash, c.type]
        );
        created.push({ id: userId, email: c.email, prenom: c.prenom, password, role: c.type });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    for (const c of created) {
      try {
        const resetToken = generateTempJwt({ id: c.id, role: c.role }, 'ecole');
        await sendAccountCreatedEmail(c.email, c.prenom, c.password, resetToken);
      } catch (e) {
        console.warn(`Échec envoi email de bienvenue pour ${c.email} : ${e.message}`);
      }
    }

    res.json({
      message: `${created.length} compte${created.length > 1 ? 's' : ''} créé${created.length > 1 ? 's' : ''}`,
      comptes: created.map(({ id, email }) => ({ id, email })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /school/comptes/:id
router.patch('/comptes/:id', async (req, res, next) => {
  try {
    const { statut, role } = req.body;
    if (statut) {
      await pool.query(
        "UPDATE utilisateur SET statut = $1 WHERE id = $2 AND ecole_id = $3",
        [statut, req.params.id, req.auth.ecoleId]
      );
    }
    if (role) {
      await pool.query(
        "UPDATE utilisateur SET role = $1 WHERE id = $2 AND ecole_id = $3",
        [role, req.params.id, req.auth.ecoleId]
      );
    }
    res.json({ message: 'Compte mis à jour' });
  } catch (err) { next(err); }
});

// DELETE /school/comptes/:id
router.delete('/comptes/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE utilisateur SET statut = 'suspendu' WHERE id = $1 AND ecole_id = $2",
      [req.params.id, req.auth.ecoleId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Compte introuvable' });
    res.json({ message: 'Compte suspendu' });
  } catch (err) { next(err); }
});

// GET /school/factures
router.get('/factures', (req, res) => res.json([]));

// GET /school/sessions
router.get('/sessions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.statut, s.type_session, s.ip_origine, s.appareil_os,
              s.date_debut, s.date_fin, u.nom, u.prenom, u.role
       FROM session s
       JOIN utilisateur u ON u.id = s.utilisateur_id
       WHERE u.ecole_id = $1
       ORDER BY s.date_debut DESC
       LIMIT 100`,
      [req.auth.ecoleId]
    );
    res.json(rows.map(r => {
      const debut = new Date(r.date_debut);
      const fin   = r.date_fin ? new Date(r.date_fin) : new Date();
      const dureeMin = Math.max(0, Math.round((fin - debut) / 60000));
      const anomalie = r.statut === 'active' && (Date.now() - debut.getTime()) > 8 * 3600 * 1000;
      return {
        id: r.id,
        nomUtilisateur: `${r.prenom} ${r.nom}`,
        role: r.role,
        heureDebut: debut.toLocaleString('fr-FR'),
        duree: dureeMin >= 60 ? `${Math.floor(dureeMin / 60)}h${String(dureeMin % 60).padStart(2, '0')}` : `${dureeMin}min`,
        statut: r.statut,
        anomalie,
        ip: r.ip_origine || '—',
        appareilOs: r.appareil_os || '—',
        typeSession: r.type_session,
      };
    }));
  } catch (err) { next(err); }
});

// DELETE /school/sessions/:id — termine une session en cours
router.delete('/sessions/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.licence_id FROM session s
       JOIN utilisateur u ON u.id = s.utilisateur_id
       WHERE s.id = $1 AND u.ecole_id = $2 AND s.statut = 'active'`,
      [req.params.id, req.auth.ecoleId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session active introuvable' });
    const session = rows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE session SET statut = 'terminee', date_fin = NOW() WHERE id = $1",
        [session.id]
      );
      await client.query(
        "UPDATE licence SET nb_sessions_actives = GREATEST(0, nb_sessions_actives - 1) WHERE id = $1",
        [session.licence_id]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ message: 'Session terminée' });
  } catch (err) { next(err); }
});

// GET /school/activite
router.get('/activite', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.action, l.details, l.horodatage
       FROM log_activite l
       JOIN session s ON s.id = l.session_id
       JOIN utilisateur u ON u.id = s.utilisateur_id
       WHERE u.ecole_id = $1
       ORDER BY l.horodatage DESC LIMIT 50`,
      [req.auth.ecoleId]
    );
    res.json(rows.map(r => ({
      id: r.id,
      type: 'connexion',
      description: r.details || r.action,
      date: new Date(r.horodatage).toLocaleString('fr-FR'),
    })));
  } catch (err) { next(err); }
});

// GET /school/contact
// Le référent par défaut est l'admin connecté (celui qui a créé/gère le
// compte) ; la boîte de facturation et le téléphone viennent de
// contact_facturation quand ils ont déjà été renseignés.
router.get('/contact', async (req, res, next) => {
  try {
    const { rows: userRows } = await pool.query(
      "SELECT nom, prenom, email FROM utilisateur WHERE id = $1",
      [req.auth.userId]
    );
    const { rows: contactRows } = await pool.query(
      "SELECT * FROM contact_facturation WHERE ecole_id = $1 LIMIT 1",
      [req.auth.ecoleId]
    );
    const user = userRows[0] || null;
    const contact = contactRows[0] || null;
    res.json({
      nom:              contact?.nom_contact    || user?.nom    || '',
      prenom:           contact?.prenom_contact || user?.prenom || '',
      email:            user?.email || '',
      boiteFacturation: contact?.email_facturation || '',
      telephone:        contact?.telephone || '',
    });
  } catch (err) { next(err); }
});

// PATCH /school/contact
router.patch('/contact', async (req, res, next) => {
  try {
    const { nom, prenom, boiteFacturation, telephone } = req.body;
    const { rows } = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM contact_facturation WHERE ecole_id = $1) AS exists",
      [req.auth.ecoleId]
    );

    if (rows[0].exists) {
      await pool.query(
        `UPDATE contact_facturation SET
           nom_contact       = COALESCE($1, nom_contact),
           prenom_contact    = COALESCE($2, prenom_contact),
           email_facturation = COALESCE($3, email_facturation),
           telephone         = COALESCE($4, telephone)
         WHERE ecole_id = $5`,
        [nom || null, prenom || null, boiteFacturation || null, telephone || null, req.auth.ecoleId]
      );
    } else {
      const { rows: userRows } = await pool.query(
        "SELECT nom, prenom, email FROM utilisateur WHERE id = $1",
        [req.auth.userId]
      );
      const user = userRows[0] || {};
      await pool.query(
        `INSERT INTO contact_facturation (ecole_id, nom_contact, prenom_contact, email_facturation, telephone)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.auth.ecoleId,
          nom || user.nom || '',
          prenom || user.prenom || '',
          boiteFacturation || user.email,
          telephone || null,
        ]
      );
    }
    res.json({ message: 'Contact mis à jour' });
  } catch (err) { next(err); }
});

// ── Utilitaires ───────────────────────────────────────────────────────────────

async function sendAccountCreatedEmail(email, prenom, motDePasse, resetToken) {
  const resetLink = `${config.frontendUrl}/reset-password?token=${resetToken}`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.brevoApiKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Cubi', email: config.emailFrom },
      to: [{ email, name: prenom }],
      subject: 'Ton compte CUBI est prêt',
      textContent:
        `Bonjour ${prenom},\n\n` +
        `Un compte CUBI vient d'être créé pour toi. Il te permet de te connecter à distance à ton poste de travail.\n\n` +
        `Identifiant : ${email}\n` +
        `Mot de passe temporaire : ${motDePasse}\n\n` +
        `Tu peux changer ce mot de passe à tout moment via ce lien :\n${resetLink}\n\n` +
        `L'équipe CUBI`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo API ${res.status}: ${body}`);
  }
}

module.exports = router;
