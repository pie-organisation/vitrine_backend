const router = require('express').Router();
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const config = require('../config');
const { generateJwt } = require('../middleware/auth');

// POST /auth/inscription
router.post('/inscription', async (req, res, next) => {
  try {
    const { type, nom, email, siret, nom_daf, prenom_daf } = req.body;

    const { rows } = await pool.query(
      "SELECT id FROM type_licence WHERE actif = TRUE ORDER BY sessions_min LIMIT 1"
    );
    if (!rows.length) {
      return res.status(500).json({ error: 'Aucun type_licence disponible' });
    }

    await pool.query(
      `INSERT INTO demande_inscription
         (type_demande, nom_siege_ou_ecole, nom_daf, prenom_daf, siret, type_licence_id, statut)
       VALUES ($1, $2, $3, $4, $5, $6, 'en_attente')`,
      [type, nom, nom_daf || null, prenom_daf || null, siret || null, rows[0].id]
    );

    console.log(`Demande d'inscription soumise : ${email}`);
    res.json({ message: "Votre demande a été reçue. Un administrateur la traitera sous 48h." });
  } catch (err) { next(err); }
});

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, mot_de_passe } = req.body;

    const { rows } = await pool.query(
      "SELECT * FROM utilisateur WHERE email = $1 AND statut = 'actif'",
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Identifiants invalides' });

    const user = rows[0];
    const valid = await argon2.verify(user.mot_de_passe_hash, mot_de_passe);
    if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });

    if (user.mdp_temporaire) {
      return res.status(403).json({ error: 'reset_required' });
    }

    await pool.query(
      "UPDATE utilisateur SET derniere_connexion = NOW() WHERE id = $1",
      [user.id]
    );

    const token = generateJwt(user);
    console.log(`Connexion réussie : ${user.id}`);
    res.json({ token, user_id: user.id, role: user.role });
  } catch (err) { next(err); }
});

// POST /auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token_temporaire, nouveau_mot_de_passe } = req.body;

    let claims;
    try {
      claims = jwt.verify(token_temporaire, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Token invalide ou expiré' });
    }

    const hash = await argon2.hash(nouveau_mot_de_passe);
    const { rowCount } = await pool.query(
      `UPDATE utilisateur
       SET mot_de_passe_hash = $1, mdp_temporaire = FALSE
       WHERE id = $2 AND mdp_temporaire = TRUE`,
      [hash, claims.sub]
    );

    if (rowCount === 0) {
      return res.status(404).json({
        error: 'Utilisateur introuvable ou mot de passe déjà réinitialisé',
      });
    }

    console.log(`Mot de passe réinitialisé : ${claims.sub}`);
    res.json({ message: 'Mot de passe mis à jour avec succès' });
  } catch (err) { next(err); }
});

module.exports = router;
