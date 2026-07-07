const router = require('express').Router();
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
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

router.get('/plans', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, nom, sessions_min, sessions_max, prix_unitaire, actif FROM type_licence ORDER BY sessions_min"
    );
    res.json(rows.map(r => ({
      id: r.id,
      nom: r.nom,
      sessionsMin: r.sessions_min,
      sessionsMax: r.sessions_max,
      tarif: `${r.prix_unitaire} €/session`,
      statut: r.actif ? 'actif' : 'archive',
      description: `Plan ${r.nom}`,
      nbOrganisations: 0,
    })));
  } catch (err) { next(err); }
});

router.post('/plans', requireCubi('super_admin'), (req, res) => res.json({ message: 'Fonctionnalité à implémenter' }));
router.patch('/plans/:id', requireCubi('super_admin'), (req, res) => res.json({ message: 'Fonctionnalité à implémenter' }));
router.delete('/plans/:id', requireCubi('super_admin'), (req, res) => res.json({ message: 'Fonctionnalité à implémenter' }));

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
      "SELECT * FROM utilisateur_cubi ORDER BY date_invitation DESC"
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

    const tempPassword = generateTempPassword();
    const hash = await bcrypt.hash(tempPassword, 12);
    const userId = randomUUID();

    await pool.query(
      `INSERT INTO utilisateur_cubi
         (id, invite_par, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, 'actif')`,
      [userId, req.auth.userId, nom, prenom, email, hash, role]
    );

    const tokenTemp = generateTempJwt({ id: userId, role }, 'cubi');
    const resetLink = `${config.frontendUrl}/reset-password?token=${tokenTemp}`;

    const EMAIL_WAIT_MS = 2000;
    const emailPromise = sendWelcomeEmail(email, prenom, tempPassword, tokenTemp, config.frontendUrl)
      .then(() => {
        console.log(`Email de bienvenue envoyé à ${email}`);
        return true;
      })
      .catch(e => {
        console.warn(`Échec envoi email pour ${email}: ${e.message}`);
        return false;
      });
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), EMAIL_WAIT_MS));
    const emailSent = await Promise.race([emailPromise, timeoutPromise]);

    console.log(`Membre équipe Cubi créé : ${userId} par ${req.auth.userId}`);
    res.json({
      utilisateur_id: userId,
      reset_link: resetLink,
      ...(emailSent ? {} : { reset_token: tokenTemp }),
    });
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
    const { rowCount } = await pool.query(
      "UPDATE utilisateur_cubi SET statut = 'inactif' WHERE id = $1",
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Membre introuvable' });
    res.json({ message: 'Accès révoqué' });
  } catch (err) { next(err); }
});

// ── Messages (stubs) ──────────────────────────────────────────────────────────

router.get('/messages', (req, res) => res.json([]));
router.patch('/messages/:id', requireCubi('super_admin'), (req, res) => res.json({ message: 'Message mis à jour' }));

// ── Offres (stubs) ────────────────────────────────────────────────────────────

router.get('/offres', (req, res) => res.json([]));
router.post('/offres', requireCubi('super_admin'), (req, res) => res.json({ message: 'Offre créée' }));
router.patch('/offres/:id', requireCubi('super_admin'), (req, res) => res.json({ message: 'Offre mise à jour' }));

// ── Utilitaires ───────────────────────────────────────────────────────────────

function generateTempPassword() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 12; i++) {
    pwd += charset[Math.floor(Math.random() * charset.length)];
  }
  return pwd;
}

async function sendWelcomeEmail(email, prenom, motDePasse, tokenReset, frontendUrl) {
  const resetLink = `${frontendUrl}/reset-password?token=${tokenReset}`;
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: false,
    auth: { user: config.smtpUser, pass: config.smtpPassword },
    tls: { rejectUnauthorized: false },
  });
  await transporter.sendMail({
    from: `Cubi <${config.smtpFrom}>`,
    to: email,
    subject: 'Bienvenue sur Cubi - Vos identifiants',
    text: `Bonjour ${prenom},\n\nVotre compte CUBI a été créé par un administrateur.\n\nEmail : ${email}\nMot de passe temporaire : ${motDePasse}\n\nVous devez définir votre mot de passe définitif en cliquant sur ce lien :\n${resetLink}\n\nCe lien est valable 48h.\n\nL'équipe CUBI`,
  });
}

module.exports = router;
