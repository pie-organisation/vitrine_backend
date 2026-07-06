require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const swaggerUi = require('swagger-ui-express');
const pool = require('./db');
const config = require('./config');
const runMigrations = require('./migrate');
const swaggerSpec = require('./swagger');
const { requireAuth, requireAdmin } = require('./middleware/auth');

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
    const { rows } = await pool.query(
      "SELECT * FROM utilisateur WHERE id = $1",
      [req.auth.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const user = { ...rows[0] };
    delete user.mot_de_passe_hash;
    res.json(user);
  } catch (err) { next(err); }
});

app.use('/sessions', requireAuth, sessionsRouter);
app.use('/licences', requireAuth, licencesRouter);
app.use('/school',   requireAuth, schoolRouter);

// ── Routes admin (JWT + rôle admin) ──────────────────────────────────────────
app.use('/admin', requireAuth, requireAdmin, adminRouter);

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

  await seedAdminIfMissing();

  app.listen(config.appPort, '0.0.0.0', () => {
    console.log(`Serveur Cubi démarré sur le port ${config.appPort}`);
  });
}

async function seedAdminIfMissing() {
  const { rows: tlRows } = await pool.query(
    "SELECT id FROM type_licence ORDER BY sessions_min LIMIT 1"
  );
  if (!tlRows.length) return;
  const typeLicenceId = tlRows[0].id;

  const { rows: ecoleRows } = await pool.query(
    `INSERT INTO ecole (nom_complet_ecole, siret, adresse, code_postal, ville, type_licence_id, mot_de_passe_hash, statut)
     VALUES ('CUBI Admin', '00000000000001', '1 rue CUBI', '75001', 'Paris', $1, 'n/a', 'actif')
     ON CONFLICT (siret) DO UPDATE SET nom_complet_ecole = EXCLUDED.nom_complet_ecole
     RETURNING id`,
    [typeLicenceId]
  );
  const ecoleId = ecoleRows[0].id;

  const hash = await bcrypt.hash('admin123', 12);
  const { rowCount } = await pool.query(
    `INSERT INTO utilisateur (ecole_id, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
     VALUES ($1, 'Admin', 'CUBI', 'admin@cubi.fr', $2, FALSE, 'admin', 'actif')
     ON CONFLICT (email) DO NOTHING`,
    [ecoleId, hash]
  );
  if (rowCount > 0) {
    console.log('Admin prêt : admin@cubi.fr / admin123');
  }
}

start().catch(err => {
  console.error('Erreur au démarrage :', err.message);
  process.exit(1);
});
