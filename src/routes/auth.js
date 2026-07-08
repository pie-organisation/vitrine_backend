const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const config = require('../config');
const { generateJwt } = require('../middleware/auth');

// GET /auth/licences — catalogue public des licences actives (pour le formulaire d'inscription)
router.get('/licences', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, nom FROM type_licence WHERE actif = TRUE ORDER BY sessions_min"
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /auth/inscription
router.post('/inscription', async (req, res, next) => {
  try {
    const {
      type, nom_siege, nom_daf, prenom_daf, nom_ecole, siret, visa_ecole,
      adresse, code_postal, ville, type_licence_id,
      nom_contact, prenom_contact, email, mot_de_passe, mot_de_passe_confirm,
    } = req.body;

    if (!['ecole', 'groupe'].includes(type)) {
      return res.status(422).json({ message: 'Type de demande invalide' });
    }
    const required = {
      nom_siege, nom_daf, prenom_daf, nom_ecole, siret, adresse, code_postal, ville,
      type_licence_id, nom_contact, prenom_contact, email, mot_de_passe, mot_de_passe_confirm,
    };
    const missing = Object.entries(required).filter(([, v]) => !v || !String(v).trim());
    if (missing.length) {
      return res.status(422).json({ message: `Champs obligatoires manquants : ${missing.map(([k]) => k).join(', ')}` });
    }
    if (mot_de_passe !== mot_de_passe_confirm) {
      return res.status(422).json({ message: 'Les mots de passe ne correspondent pas.' });
    }
    if (mot_de_passe.length < 8) {
      return res.status(422).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }

    const siretDigits = String(siret).replace(/\D/g, '');
    if (siretDigits.length !== 14) {
      return res.status(422).json({ message: 'Le SIRET doit contenir exactement 14 chiffres.' });
    }

    const { rows: emailTaken } = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM utilisateur WHERE email = $1) AS exists",
      [email]
    );
    if (emailTaken[0].exists) {
      return res.status(409).json({ error: 'Un compte avec cet email existe déjà' });
    }

    const { rows: licenceRows } = await pool.query(
      "SELECT id FROM type_licence WHERE id = $1 AND actif = TRUE",
      [type_licence_id]
    );
    if (!licenceRows.length) {
      return res.status(422).json({ message: 'Licence sélectionnée invalide' });
    }

    const hash = await bcrypt.hash(mot_de_passe, 12);

    await pool.query(
      `INSERT INTO demande_inscription
         (type_demande, nom_siege_ou_ecole, nom_daf, prenom_daf, nom_ecole, siret, visa_ecole,
          adresse, code_postal, ville, type_licence_id, nom_contact, prenom_contact, email,
          mot_de_passe_hash, statut)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'en_attente')`,
      [
        type, nom_siege, nom_daf, prenom_daf, nom_ecole, siretDigits, visa_ecole || null,
        adresse, code_postal, ville, type_licence_id, nom_contact, prenom_contact, email, hash,
      ]
    );

    try {
      await sendPendingEmail(email, prenom_contact);
    } catch (e) {
      console.warn(`Échec envoi email de confirmation pour ${email} : ${e.message}`);
    }

    console.log(`Demande d'inscription soumise : ${email}`);
    res.json({ message: "Votre demande a été reçue. Un administrateur la traitera sous 48h." });
  } catch (err) { next(err); }
});

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, mot_de_passe } = req.body;

    let type = 'cubi';
    let { rows } = await pool.query(
      "SELECT * FROM utilisateur_cubi WHERE email = $1 AND statut = 'actif'",
      [email]
    );
    if (!rows.length) {
      type = 'ecole';
      ({ rows } = await pool.query(
        "SELECT * FROM utilisateur WHERE email = $1 AND statut = 'actif'",
        [email]
      ));
    }
    if (!rows.length) return res.status(401).json({ error: 'Identifiants invalides' });

    const user = rows[0];
    const valid = await bcrypt.compare(mot_de_passe, user.mot_de_passe_hash);
    if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });

    if (user.mdp_temporaire) {
      return res.status(403).json({ error: 'reset_required' });
    }

    const table = type === 'cubi' ? 'utilisateur_cubi' : 'utilisateur';
    await pool.query(
      `UPDATE ${table} SET derniere_connexion = NOW() WHERE id = $1`,
      [user.id]
    );

    const token = generateJwt(user, type);
    console.log(`Connexion réussie : ${user.id}`);
    res.json({ token, user_id: user.id, role: user.role, type });
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

    const hash = await bcrypt.hash(nouveau_mot_de_passe, 12);
    const table = claims.type === 'cubi' ? 'utilisateur_cubi' : 'utilisateur';
    const { rowCount } = await pool.query(
      `UPDATE ${table}
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

// ── Utilitaires ───────────────────────────────────────────────────────────────

async function sendPendingEmail(email, prenom) {
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
      subject: 'Votre demande d\'inscription CUBI a bien été reçue',
      textContent: `Bonjour ${prenom},\n\nVotre demande d'inscription a bien été reçue et est en attente de validation par notre équipe.\n\nVous recevrez un email dès qu'elle aura été traitée (sous 48h en général).\n\nL'équipe CUBI`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo API ${res.status}: ${body}`);
  }
}

module.exports = router;
