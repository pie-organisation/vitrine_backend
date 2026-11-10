const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { Pool } = require('pg');
const { prochainNumero } = require('../src/services/numerotation');

const SQL_004 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_documents_signature.sql'), 'utf8');
// Année fictive : les tests de numérotation n'interfèrent pas avec les vraies séquences
const DATE_TEST = new Date('2099-06-15T12:00:00Z');

// Uniquement sur une base de test dédiée (TEST_DATABASE_URL, jamais DATABASE_URL).
// Sans elle, ces tests sont ignorés : npm test passe sans connexion.
const SKIP = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL non définie (aucune base de test)';
const dbTest = (nom, fn) => test(nom, { skip: SKIP }, fn);

let pool;
before(() => { if (!SKIP) pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 25 }); });
after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM sequence_document WHERE annee = 2099');
  await pool.end();
});

test('scripts/verifier-migration.sql est à jour avec la migration 004', () => {
  const { generer, SORTIE } = require('../scripts/generer-verifier-migration');
  const actuel = fs.readFileSync(SORTIE, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actuel, generer(), 'relancer npm run migration:verifier');
});

dbTest('test de fumée verifier-migration.sql : passe et n\'applique rien', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verifier-migration.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
});

dbTest('la migration 004 est rejouable sans erreur', async () => {
  await pool.query(SQL_004);
  await pool.query(SQL_004);
});

dbTest('prochainNumero : 20 transactions concurrentes, numéros consécutifs sans doublon', async () => {
  await pool.query('DELETE FROM sequence_document WHERE annee = 2099');
  const numeros = await Promise.all(Array.from({ length: 20 }, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const n = await prochainNumero(client, 'facture', DATE_TEST);
      await client.query('COMMIT');
      return n;
    } finally { client.release(); }
  }));
  const attendus = Array.from({ length: 20 }, (_, i) => `FAC-2099-${String(i + 1).padStart(4, '0')}`);
  assert.deepEqual([...numeros].sort(), attendus);
});

dbTest('prochainNumero : un ROLLBACK ne laisse pas de trou, séquences indépendantes par type', async () => {
  await pool.query('DELETE FROM sequence_document WHERE annee = 2099');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    assert.equal(await prochainNumero(client, 'contrat', DATE_TEST), 'CTR-2099-0001');
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    assert.equal(await prochainNumero(client, 'contrat', DATE_TEST), 'CTR-2099-0001');
    assert.equal(await prochainNumero(client, 'avoir', DATE_TEST), 'AV-2099-0001');
    assert.equal(await prochainNumero(client, 'contrat', DATE_TEST), 'CTR-2099-0002');
    await client.query('COMMIT');
  } finally { client.release(); }
  await assert.rejects(prochainNumero(pool, 'devis', DATE_TEST), /inconnu/);
});

const INSERT_FACTURE = `
  INSERT INTO facture (numero, contrat_id, ecole_id, periode_debut, periode_fin, date_emission, date_echeance,
                       lignes, total_ht_centimes, total_tva_centimes, total_ttc_centimes, ventilation_tva,
                       client_snapshot, emetteur_snapshot, document_id, sha256)
  VALUES ($1, $2, $3, $4, $4::date + 27, $4, $4::date + 30, '[]', $5, $6, $7, '[]', '{}', '{}', $8, $9)
  RETURNING id`;

// Les garde-fous en base sont testés dans une transaction annulée à la fin : rien ne reste.
dbTest('garde-fous : document immuable, journal append-only, facture immuable', async () => {
  const client = await pool.connect();
  const sha = createHash('sha256').update(randomUUID()).digest('hex');
  const expectError = async (code, sql, params) => {
    await client.query('SAVEPOINT sp');
    await assert.rejects(client.query(sql, params), err => err.code === code);
    await client.query('ROLLBACK TO SAVEPOINT sp');
  };
  try {
    await client.query('BEGIN');
    const { rows: [tl] } = await client.query('SELECT id FROM type_licence ORDER BY sessions_min LIMIT 1');
    const siret = String(Date.now()).padStart(14, '9').slice(-14);
    const { rows: [ecole] } = await client.query(
      `INSERT INTO ecole (nom_complet_ecole, siret, adresse, code_postal, ville, type_licence_id, mot_de_passe_hash, statut)
       VALUES ('École test 004', $1, '1 rue Test', '75001', 'Paris', $2, 'x', 'inactif') RETURNING id`,
      [siret, tl.id]
    );
    const { rows: [doc] } = await client.query(
      `INSERT INTO document (type, taille_octets, sha256, contenu) VALUES ('facture', 3, $1, $2) RETURNING id`,
      [sha, Buffer.from('ABC')]
    );
    await expectError('23000', 'UPDATE document SET mime = $1 WHERE id = $2', ['text/plain', doc.id]);

    const { rows: [contrat] } = await client.query(
      `INSERT INTO contrat (numero, ecole_id, donnees, duree_mois, date_debut)
       VALUES ('CTR-2099-9999', $1, '{}', 12, '2099-01-01') RETURNING id`,
      [ecole.id]
    );
    // Envoi impossible sans signataire ni original figé
    await expectError('23514', "UPDATE contrat SET statut = 'envoye' WHERE id = $1", [contrat.id]);

    const { rows: [evt] } = await client.query(
      `INSERT INTO contrat_evenement (contrat_id, type, acteur) VALUES ($1, 'cree', 'systeme') RETURNING id`,
      [contrat.id]
    );
    await expectError('23000', "UPDATE contrat_evenement SET acteur = 'x' WHERE id = $1", [evt.id]);
    await expectError('23000', 'DELETE FROM contrat_evenement WHERE id = $1', [evt.id]);

    const { rows: [fac] } = await client.query(
      INSERT_FACTURE, ['FAC-2099-9999', contrat.id, ecole.id, '2099-01-01', 1000, 200, 1200, doc.id, sha]
    );
    await expectError('23000', 'UPDATE facture SET total_ht_centimes = 1 WHERE id = $1', [fac.id]);
    await expectError('23000', 'DELETE FROM facture WHERE id = $1', [fac.id]);
    // Payée sans date de paiement : refusé ; avec : autorisé
    await expectError('23514', "UPDATE facture SET statut = 'payee' WHERE id = $1", [fac.id]);
    await client.query("UPDATE facture SET statut = 'payee', date_paiement = '2099-01-15' WHERE id = $1", [fac.id]);

    // Totaux incohérents, doublon de période, avoir sans facture d'origine : refusés
    await expectError('23514', INSERT_FACTURE,
      ['FAC-2099-9998', contrat.id, ecole.id, '2099-02-01', 1000, 200, 1300, doc.id, sha]);
    await expectError('23505', INSERT_FACTURE,
      ['FAC-2099-9997', contrat.id, ecole.id, '2099-01-01', 1000, 200, 1200, doc.id, sha]);
    await expectError('23514', INSERT_FACTURE,
      ['AV-2099-9999', contrat.id, ecole.id, '2099-03-01', -1000, -200, -1200, doc.id, sha]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
