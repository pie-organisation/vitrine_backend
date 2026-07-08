const router = require('express').Router();
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const config = require('../config');
const { generateTempJwt, requireCubi } = require('../middleware/auth');

// ── Métriques ─────────────────────────────────────────────────────────────────

router.get('/metriques', async (req, res, next) => {
  try {
    const [orgs, users, sessions, licAvail, licAssigned, demandes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM ecole WHERE statut = 'actif'"),
      pool.query("SELECT COUNT(*) FROM utilisateur WHERE statut = 'actif'"),
      pool.query("SELECT COUNT(*) FROM session WHERE statut = 'active'"),
      pool.query("SELECT COUNT(*) FROM licence WHERE statut = 'disponible'"),
      pool.query("SELECT COUNT(*) FROM licence WHERE statut = 'assignee'"),
      pool.query("SELECT COUNT(*) FROM demande_inscription WHERE statut = 'en_attente'"),
    ]);
    res.json({
      nb_organisations:       parseInt(orgs.rows[0].count),
      nb_utilisateurs_actifs: parseInt(users.rows[0].count),
      nb_sessions_actives:    parseInt(sessions.rows[0].count),
      nb_licences_disponibles: parseInt(licAvail.rows[0].count),
      nb_licences_assignees:  parseInt(licAssigned.rows[0].count),
      nb_demandes_en_attente: parseInt(demandes.rows[0].count),
    });
  } catch (err) { next(err); }
});

// ── Alertes ───────────────────────────────────────────────────────────────────

router.get('/alertes', async (req, res, next) => {
  try {
    const [sess, dem] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM session WHERE statut = 'active' AND date_debut < NOW() - INTERVAL '8 hours'"),
      pool.query("SELECT COUNT(*) FROM demande_inscription WHERE statut = 'en_attente' AND date_demande < NOW() - INTERVAL '48 hours'"),
    ]);
    res.json({
      sessions_anormales:   parseInt(sess.rows[0].count),
      demandes_en_attente:  parseInt(dem.rows[0].count),
    });
  } catch (err) { next(err); }
});

// ── Analytiques ───────────────────────────────────────────────────────────────

router.get('/analytiques', async (req, res, next) => {
  try {
    const [orgs, users] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM ecole"),
      pool.query("SELECT COUNT(*) FROM utilisateur"),
    ]);
    res.json({
      evolutionOrgs: [{ mois: 'Jan', orgs: parseInt(orgs.rows[0].count) }],
      usageSessions: [],
      repartitionPlans: [],
      tauxRenouvellement: 0,
      churn: 0,
      totalOrgs:  parseInt(orgs.rows[0].count),
      totalUsers: parseInt(users.rows[0].count),
    });
  } catch (err) { next(err); }
});

// ── Organisations ─────────────────────────────────────────────────────────────

router.get('/organisations', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM ecole ORDER BY date_creation DESC");
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/organisations/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM ecole WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Organisation introuvable' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── Plans (type_licence) ──────────────────────────────────────────────────────

function serializeLicence(r) {
  return {
    id: r.id,
    nom: r.nom,
    sessionsMin: r.sessions_min,
    sessionsMax: r.sessions_max,
    prixUnitaire: parseFloat(r.prix_unitaire),
    personnalisable: r.personnalisable,
    ressourcesCpu: r.ressources_cpu,
    ressourcesRamGo: r.ressources_ram_go,
    actif: r.actif,
    tarif: `${r.prix_unitaire} €/session`,
    statut: r.actif ? 'actif' : 'archive',
    nbOrganisations: 0,
  };
}

router.get('/plans', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM type_licence ORDER BY sessions_min");
    res.json(rows.map(serializeLicence));
  } catch (err) { next(err); }
});

router.post('/plans', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const {
      nom, sessionsMin, sessionsMax, prixUnitaire,
      personnalisable = false, ressourcesCpu, ressourcesRamGo, actif = true,
    } = req.body || {};

    if (!nom || sessionsMin == null || prixUnitaire == null || ressourcesCpu == null || ressourcesRamGo == null) {
      return res.status(422).json({ message: 'Nom, sessions min, prix unitaire et ressources sont obligatoires.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO type_licence
         (nom, sessions_min, sessions_max, prix_unitaire, personnalisable, ressources_cpu, ressources_ram_go, actif)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [nom, sessionsMin, sessionsMax ?? null, prixUnitaire, personnalisable, ressourcesCpu, ressourcesRamGo, actif]
    );
    res.json(serializeLicence(rows[0]));
  } catch (err) { next(err); }
});

router.patch('/plans/:id', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const {
      nom, sessionsMin, sessionsMax, prixUnitaire,
      personnalisable, ressourcesCpu, ressourcesRamGo, actif,
    } = req.body || {};

    const { rows } = await pool.query(
      `UPDATE type_licence SET
         nom               = COALESCE($1, nom),
         sessions_min      = COALESCE($2, sessions_min),
         sessions_max      = $3,
         prix_unitaire     = COALESCE($4, prix_unitaire),
         personnalisable   = COALESCE($5, personnalisable),
         ressources_cpu    = COALESCE($6, ressources_cpu),
         ressources_ram_go = COALESCE($7, ressources_ram_go),
         actif             = COALESCE($8, actif)
       WHERE id = $9
       RETURNING *`,
      [
        nom ?? null,
        sessionsMin ?? null,
        sessionsMax ?? null,
        prixUnitaire ?? null,
        personnalisable ?? null,
        ressourcesCpu ?? null,
        ressourcesRamGo ?? null,
        actif ?? null,
        req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Licence introuvable' });
    res.json(serializeLicence(rows[0]));
  } catch (err) { next(err); }
});

router.delete('/plans/:id', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM type_licence WHERE id = $1", [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Licence introuvable' });
    res.json({ message: 'Licence supprimée' });
  } catch (err) { next(err); }
});

// ── Demandes d'inscription ────────────────────────────────────────────────────

router.get('/demandes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM demande_inscription ORDER BY date_demande DESC"
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.patch('/demandes/:id', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const { statut } = req.body;
    const { rowCount } = await pool.query(
      "UPDATE demande_inscription SET statut = $1, date_traitement = NOW() WHERE id = $2",
      [statut, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Demande introuvable' });
    res.json({ message: 'Demande mise à jour' });
  } catch (err) { next(err); }
});

// ── Sessions ──────────────────────────────────────────────────────────────────

router.get('/sessions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM session ORDER BY date_debut DESC LIMIT 100"
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.delete('/sessions/:id', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE session SET statut = 'terminee', date_fin = NOW() WHERE id = $1",
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Session introuvable' });
    res.json({ message: 'Session terminée' });
  } catch (err) { next(err); }
});

// ── Factures (stub) ───────────────────────────────────────────────────────────

router.get('/factures', (req, res) => res.json([]));

// ── Journaux ──────────────────────────────────────────────────────────────────

router.get('/journaux', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT l.id, l.session_id, l.action, l.details, l.horodatage FROM log_activite l ORDER BY l.horodatage DESC LIMIT 200"
    );
    res.json(rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      type: 'modification',
      organisation: '—',
      utilisateur: '—',
      message: r.details || r.action,
      horodatage: new Date(r.horodatage).toLocaleString('fr-FR'),
    })));
  } catch (err) { next(err); }
});

// ── Équipe (utilisateur_cubi) ─────────────────────────────────────────────────

router.get('/equipe', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM utilisateur_cubi WHERE statut = 'actif' ORDER BY date_invitation DESC"
    );
    res.json(rows.map(u => ({
      id: u.id,
      nom: u.nom,
      prenom: u.prenom,
      email: u.email,
      role: u.role,
      dateAjout: new Date(u.date_invitation).toLocaleDateString('fr-FR'),
    })));
  } catch (err) { next(err); }
});

router.post('/equipe', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const { nom, prenom, email, role } = req.body;

    const { rows: existing } = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM utilisateur_cubi WHERE email = $1) AS exists",
      [email]
    );
    if (existing[0].exists) {
      return res.status(409).json({ error: 'Un membre avec cet email existe déjà' });
    }

    // Mot de passe provisoire non communiqué : le membre définit le sien via le
    // lien de l'email (token de reset), il n'y a jamais besoin de le connaître.
    const placeholderHash = await bcrypt.hash(generateTempPassword(), 12);
    const userId = randomUUID();

    await pool.query(
      `INSERT INTO utilisateur_cubi
         (id, invite_par, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, 'actif')`,
      [userId, req.auth.userId, nom, prenom, email, placeholderHash, role]
    );

    const tokenTemp = generateTempJwt({ id: userId, role }, 'cubi');

    try {
      await sendWelcomeEmail(email, prenom, tokenTemp, config.frontendUrl);
    } catch (e) {
      // Email non envoyé : on annule la création, l'admin n'a aucun moyen de
      // communiquer le mot de passe temporaire autrement.
      await pool.query("DELETE FROM utilisateur_cubi WHERE id = $1", [userId]);
      console.warn(`Échec envoi email pour ${email}, compte annulé : ${e.message}`);
      return res.status(422).json({ message: "L'email d'invitation n'a pas pu être envoyé. Compte non créé, réessaie." });
    }

    console.log(`Membre équipe Cubi créé : ${userId} par ${req.auth.userId}`);
    res.json({ utilisateur_id: userId, message: 'Invitation envoyée' });
  } catch (err) { next(err); }
});

router.patch('/equipe/:id', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const { role, statut } = req.body;
    if (role) {
      await pool.query("UPDATE utilisateur_cubi SET role = $1 WHERE id = $2", [role, req.params.id]);
    }
    if (statut) {
      await pool.query("UPDATE utilisateur_cubi SET statut = $1 WHERE id = $2", [statut, req.params.id]);
    }
    res.json({ message: 'Rôle modifié' });
  } catch (err) { next(err); }
});

router.delete('/equipe/:id', requireCubi('super_admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.auth.userId) {
      return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
    }
    const { rowCount } = await pool.query(
      "DELETE FROM utilisateur_cubi WHERE id = $1",
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Membre introuvable' });
    res.json({ message: 'Membre supprimé' });
  } catch (err) { next(err); }
});

// ── Messages (stubs) ──────────────────────────────────────────────────────────

router.get('/messages', (req, res) => res.json([]));
router.patch('/messages/:id', requireCubi('super_admin'), (req, res) => res.json({ message: 'Message mis à jour' }));

// ── Offres ────────────────────────────────────────────────────────────────────

router.get('/offres', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM offre ORDER BY date_creation ASC");
    res.json(rows.map(o => ({
      id: o.id,
      nom: o.nom,
      tagline: o.tagline,
      prix: o.prix,
      statut: o.statut,
      features: o.features,
      populaire: o.populaire,
    })));
  } catch (err) { next(err); }
});

router.post('/offres', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const {
      nom = 'Nouvelle offre',
      tagline = '',
      prix = 'Sur devis',
      statut = 'brouillon',
      features = [],
      populaire = false,
    } = req.body || {};

    const { rows } = await pool.query(
      `INSERT INTO offre (nom, tagline, prix, statut, features, populaire)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [nom, tagline, prix, statut, features, populaire]
    );
    const o = rows[0];
    res.json({
      id: o.id,
      nom: o.nom,
      tagline: o.tagline,
      prix: o.prix,
      statut: o.statut,
      features: o.features,
      populaire: o.populaire,
    });
  } catch (err) { next(err); }
});

router.patch('/offres/:id', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const { nom, tagline, prix, statut, features, populaire } = req.body;
    const { rows } = await pool.query(
      `UPDATE offre SET
         nom       = COALESCE($1, nom),
         tagline   = COALESCE($2, tagline),
         prix      = COALESCE($3, prix),
         statut    = COALESCE($4, statut),
         features  = COALESCE($5, features),
         populaire = COALESCE($6, populaire)
       WHERE id = $7
       RETURNING *`,
      [nom ?? null, tagline ?? null, prix ?? null, statut ?? null, features ?? null, populaire ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Offre introuvable' });
    res.json({ message: 'Offre mise à jour' });
  } catch (err) { next(err); }
});

router.delete('/offres/:id', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM offre WHERE id = $1", [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Offre introuvable' });
    res.json({ message: 'Offre supprimée' });
  } catch (err) { next(err); }
});

// ── Utilitaires ───────────────────────────────────────────────────────────────

function generateTempPassword() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 12; i++) {
    pwd += charset[Math.floor(Math.random() * charset.length)];
  }
  return pwd;
}

async function sendWelcomeEmail(email, prenom, tokenReset, frontendUrl) {
  const resetLink = `${frontendUrl}/reset-password?token=${tokenReset}`;
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
      subject: 'Bienvenue sur Cubi - Vos identifiants',
      textContent: `Bonjour ${prenom},\n\nVotre compte CUBI a été créé par un administrateur.\n\nDéfinissez votre mot de passe en cliquant sur ce lien :\n${resetLink}\n\nCe lien est valable 48h.\n\nL'équipe CUBI`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo API ${res.status}: ${body}`);
  }
}

module.exports = router;
