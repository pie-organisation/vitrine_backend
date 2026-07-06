const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL       PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // Si le schéma existe déjà (déployé par l'ancien backend Rust/sqlx)
  // on marque les migrations comme appliquées sans les rejouer
  const { rows: tableCheck } = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'type_licence'
     ) AS schema_exists`
  );
  const { rows: migCheck } = await pool.query('SELECT COUNT(*) FROM _migrations');

  if (tableCheck[0].schema_exists && parseInt(migCheck[0].count, 10) === 0) {
    for (const file of files) {
      await pool.query(
        'INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      );
      console.log(`Schema existant détecté — migration marquée sans rejeu : ${file}`);
    }
    return;
  }

  // Base de données vierge : exécuter les migrations normalement
  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM _migrations WHERE filename = $1',
      [file]
    );
    if (rows.length) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    console.log(`Migration appliquée : ${file}`);
  }
}

module.exports = runMigrations;
