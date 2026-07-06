const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db');

// GET /school/organisation
router.get('/organisation', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM ecole WHERE id = $1",
      [req.auth.ecoleId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Organisation introuvable' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /school/comptes
router.get('/comptes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM utilisateur WHERE ecole_id = $1 ORDER BY date_invitation DESC",
      [req.auth.ecoleId]
    );
    res.json(rows.map(sanitizeUser));
  } catch (err) { next(err); }
});

// POST /school/comptes
router.post('/comptes', async (req, res, next) => {
  try {
    const { nom, prenom, email, role, classe_id } = req.body;
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO utilisateur
         (id, ecole_id, classe_id, invite_par, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'temporaire', TRUE, $8, 'actif')`,
      [userId, req.auth.ecoleId, classe_id || null, req.auth.userId, nom, prenom, email, role]
    );
    res.json({ id: userId, message: 'Compte créé' });
  } catch (err) { next(err); }
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
router.get('/contact', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM contact_facturation WHERE ecole_id = $1 LIMIT 1",
      [req.auth.ecoleId]
    );
    if (rows.length) return res.json(rows[0]);
    res.json({ nom_contact: '', prenom_contact: '', email_facturation: '', telephone: '' });
  } catch (err) { next(err); }
});

// PATCH /school/contact
router.patch('/contact', async (req, res, next) => {
  try {
    const { nom_contact, prenom_contact, email_facturation, telephone } = req.body;
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
        [nom_contact || null, prenom_contact || null, email_facturation || null, telephone || null, req.auth.ecoleId]
      );
    } else {
      await pool.query(
        `INSERT INTO contact_facturation (ecole_id, nom_contact, prenom_contact, email_facturation, telephone)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.auth.ecoleId, nom_contact || '', prenom_contact || '', email_facturation || '', telephone || null]
      );
    }
    res.json({ message: 'Contact mis à jour' });
  } catch (err) { next(err); }
});

function sanitizeUser(u) {
  const r = { ...u };
  delete r.mot_de_passe_hash;
  return r;
}

module.exports = router;
