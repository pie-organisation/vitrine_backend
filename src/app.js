// Construction de l'application Express (sans démarrage) : importable par les tests d'intégration.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const swaggerUi = require('swagger-ui-express');
const pool = require('./db');
const config = require('./config');
const swaggerSpec = require('./swagger');
const { requireAuth, requireCubi, requireEcoleAdmin } = require('./middleware/auth');

const authRouter     = require('./routes/auth');
const sessionsRouter = require('./routes/sessions');
const licencesRouter = require('./routes/licences');
const schoolRouter   = require('./routes/school');
const adminRouter    = require('./routes/admin');
const signatureRouter = require('./routes/signature');
const internalRouter  = require('./routes/internal');

const app = express();

// Derrière le proxy de Render : req.ip = IP réelle du client (journal de preuve, rate limit)
app.set('trust proxy', 1);

// ── Signature publique : CORS limité au front, corps jusqu'à 400 Ko (image de signature) ──
// Montée avant le CORS ouvert et le parseur JSON globaux (limite 100 Ko).
const originesSignature = [config.frontendUrl, ...config.signatureCorsExtra];
app.use('/signature', cors({ origin: originesSignature }), express.json({ limit: '400kb' }), signatureRouter);

app.use(cors());
app.use(express.json());

// ── Jobs (cron externe, header X-Job-Secret) ──────────────────────────────────
app.use('/internal', internalRouter);

// ── Swagger UI ────────────────────────────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/', (req, res) => res.redirect('/api-docs'));

// ── Routes publiques ──────────────────────────────────────────────────────────
app.use('/auth', authRouter);

// ── Routes protégées (JWT requis) ─────────────────────────────────────────────
app.get('/me', requireAuth, async (req, res, next) => {
  try {
    const table = req.auth.type === 'cubi' ? 'utilisateur_cubi' : 'utilisateur';
    const { rows } = await pool.query(
      `SELECT * FROM ${table} WHERE id = $1`,
      [req.auth.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const user = { ...rows[0] };
    delete user.mot_de_passe_hash;
    res.json({ ...user, type: req.auth.type });
  } catch (err) { next(err); }
});

app.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { prenom, nom, email } = req.body;
    const table = req.auth.type === 'cubi' ? 'utilisateur_cubi' : 'utilisateur';

    if (email) {
      const { rows: existing } = await pool.query(
        `SELECT EXISTS(SELECT 1 FROM ${table} WHERE email = $1 AND id != $2) AS exists`,
        [email, req.auth.userId]
      );
      if (existing[0].exists) {
        return res.status(409).json({ error: 'Un compte avec cet email existe déjà' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE ${table} SET
         prenom = COALESCE($1, prenom),
         nom    = COALESCE($2, nom),
         email  = COALESCE($3, email)
       WHERE id = $4
       RETURNING *`,
      [prenom || null, nom || null, email || null, req.auth.userId]
    );
    const user = { ...rows[0] };
    delete user.mot_de_passe_hash;
    res.json({ ...user, type: req.auth.type });
  } catch (err) { next(err); }
});

app.post('/me/password', requireAuth, async (req, res, next) => {
  try {
    const { mot_de_passe_actuel, nouveau_mot_de_passe } = req.body;
    if (!nouveau_mot_de_passe || nouveau_mot_de_passe.length < 8) {
      return res.status(422).json({ message: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
    }

    const table = req.auth.type === 'cubi' ? 'utilisateur_cubi' : 'utilisateur';
    const { rows } = await pool.query(
      `SELECT mot_de_passe_hash FROM ${table} WHERE id = $1`,
      [req.auth.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const valid = await bcrypt.compare(mot_de_passe_actuel || '', rows[0].mot_de_passe_hash);
    if (!valid) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

    const hash = await bcrypt.hash(nouveau_mot_de_passe, 12);
    await pool.query(
      `UPDATE ${table} SET mot_de_passe_hash = $1, mdp_temporaire = FALSE WHERE id = $2`,
      [hash, req.auth.userId]
    );
    res.json({ message: 'Mot de passe mis à jour' });
  } catch (err) { next(err); }
});

app.use('/sessions', requireAuth, sessionsRouter);
app.use('/licences', requireAuth, licencesRouter);
app.use('/school',   requireAuth, requireEcoleAdmin, schoolRouter);

// ── Routes admin Cubi (JWT + équipe plateforme) ──────────────────────────────
app.use('/admin', requireAuth, requireCubi('super_admin', 'support', 'lecture'), adminRouter);

// ── Gestion d'erreurs ─────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Erreur interne du serveur' });
});

module.exports = app;
