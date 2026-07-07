require('dotenv').config();
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const pool = require('./db');
const config = require('./config');
const runMigrations = require('./migrate');
const swaggerSpec = require('./swagger');
const { requireAuth, requireCubi, requireEcoleAdmin } = require('./middleware/auth');

const authRouter     = require('./routes/auth');
const sessionsRouter = require('./routes/sessions');
const licencesRouter = require('./routes/licences');
const schoolRouter   = require('./routes/school');
const adminRouter    = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json());

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

// ── Démarrage ─────────────────────────────────────────────────────────────────
async function start() {
  await runMigrations();
  console.log('Migrations appliquées');

  app.listen(config.appPort, '0.0.0.0', () => {
    console.log(`Serveur Cubi démarré sur le port ${config.appPort}`);
  });
}

start().catch(err => {
  console.error('Erreur au démarrage :', err.message);
  process.exit(1);
});
