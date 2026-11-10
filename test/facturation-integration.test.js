// Facturation de bout en bout, sur une base de test dédiée uniquement (ignoré sans TEST_DATABASE_URL).
// Les contrats signés sont créés directement en SQL (le parcours de signature a son propre test).
// Factures et journaux sont immuables : les données de test restent en base (SIRET, e-mails uniques).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL non définie (aucune base de test)';
const dbTest = (nom, fn) => test(nom, { skip: SKIP }, fn);

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://aucune@127.0.0.1:1/aucune';
process.env.JWT_SECRET = 'test-facturation';
process.env.EMAIL_TRANSPORT = 'memoire';
process.env.APP_ENV = 'test';
process.env.FRAIS_MISE_EN_SERVICE_CENTIMES = '0';

const app = require('../src/app');
const pool = require('../src/db');
const { boiteMemoire } = require('../src/email');
const { generateJwt } = require('../src/middleware/auth');
const documentStorage = require('../src/services/documentStorage');
const { prochainNumero } = require('../src/services/numerotation');
const { prixEnCentimes } = require('../src/services/palier');
const { emettreFacture } = require('../src/services/factures');
const { jobQuotidien } = require('../src/services/jobQuotidien');
const { aujourdhuiParis } = require('../src/services/contrats');
const { finDeMois, debutDeMois } = require('../src/services/calculFacture');
const { closeBrowser } = require('../src/pdf/render');

let server;
let base;
let jwtAdmin;

before(async () => {
  if (SKIP) return;
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_documents_signature.sql'), 'utf8'));
  const { rows: [admin] } = await pool.query(
    `INSERT INTO utilisateur_cubi (nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
     VALUES ('Test', 'Facturation', $1, 'x', FALSE, 'super_admin', 'actif') RETURNING id`,
    [`admin-${crypto.randomUUID()}@cubi.test`]
  );
  jwtAdmin = generateJwt({ id: admin.id, role: 'super_admin' }, 'cubi');
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  await closeBrowser();
  await pool.end();
});

const unique = () => crypto.randomUUID().slice(0, 8);
const siret = () => String(crypto.randomInt(1e13, 1e14));

async function api(method, chemin, { jwt, body } = {}) {
  const res = await fetch(base + chemin, {
    method,
    headers: { ...(jwt && { authorization: `Bearer ${jwt}` }), ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const json = (res.headers.get('content-type') || '').includes('json');
  return { status: res.status, body: json ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

// Contrat signé et organisation activée, sans passer par la signature.
// quantites : une entrée par école (plusieurs = groupe).
async function contratSigne({ quantites = [10], dateDebut }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [tl] } = await client.query('SELECT * FROM type_licence WHERE actif = TRUE ORDER BY sessions_min LIMIT 1');
    let groupeId = null;
    if (quantites.length > 1) {
      ({ rows: [{ id: groupeId }] } = await client.query(
        `INSERT INTO groupe_scolaire (nom_du_siege, nom_daf, prenom_daf, type_licence_id, mot_de_passe_hash, statut)
         VALUES ($1, 'Daf', 'Paula', $2, 'x', 'actif') RETURNING id`,
        [`Groupe ${unique()}`, tl.id]
      ));
    }
    const etablissements = [];
    for (const quantite of quantites) {
      const nom = `École ${unique()}`;
      const s = siret();
      const { rows: [e] } = await client.query(
        `INSERT INTO ecole (groupe_scolaire_id, nom_complet_ecole, siret, adresse, code_postal, ville, type_licence_id, mot_de_passe_hash, statut)
         VALUES ($1, $2, $3, '1 rue Test', '75001', 'Paris', $4, 'x', 'actif') RETURNING id`,
        [groupeId, nom, s, tl.id]
      );
      etablissements.push({ ecoleId: e.id, nom, siret: s, quantite, prixUnitaireCentimes: prixEnCentimes(tl.prix_unitaire) });
    }
    const email = `facturation-${unique()}@client.test`;
    await client.query(
      `INSERT INTO contact_facturation (ecole_id, groupe_scolaire_id, nom_contact, prenom_contact, email_facturation)
       VALUES ($1, $2, 'Compta', 'Service', $3)`,
      [groupeId ? null : etablissements[0].ecoleId, groupeId, email]
    );
    const doc = await documentStorage.put(client, { type: 'contrat_original', contenu: Buffer.from(`%PDF-test-${unique()}`) });
    const donnees = {
      client: { name: groupeId ? 'Groupe test' : etablissements[0].nom, legalForm: 'Test', address: '1 rue Test, 75001 Paris', siret: null, billingContact: 'Service Compta' },
      offre: { nom: tl.nom, badge: null },
      palier: { typeLicenceId: tl.id, nom: tl.nom, prixUnitaireCentimes: prixEnCentimes(tl.prix_unitaire) },
      quantiteTotale: quantites.reduce((s, q) => s + q, 0),
      facturation: { libelle: 'Mensuelle, à terme à échoir' },
      etablissements,
    };
    const { rows: [c] } = await client.query(
      `INSERT INTO contrat
         (numero, ecole_id, groupe_scolaire_id, donnees, duree_mois, date_debut, date_effet, statut,
          signataire_nom, signataire_fonction, signataire_email,
          document_original_id, sha256_original, document_signe_id, sha256_signe, date_signature_client)
       VALUES ($1, $2, $3, $4, 12, $5, $5, 'signe', 'Signataire Test', 'Directrice', $6, $7, $8, $7, $8, NOW())
       RETURNING id`,
      [await prochainNumero(client, 'contrat'), groupeId ? null : etablissements[0].ecoleId, groupeId,
        JSON.stringify(donnees), dateDebut, email, doc.id, doc.sha256]
    );
    await client.query(
      "INSERT INTO contrat_evenement (contrat_id, type, acteur) VALUES ($1, 'organisation_activee', 'systeme')", [c.id]
    );
    await client.query('COMMIT');
    return { contratId: c.id, ecoleIds: etablissements.map(e => e.ecoleId), email };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function emettreMoisCourant(contratId) {
  const jour = aujourdhuiParis();
  return emettreFacture({ contratId, periodeDebut: debutDeMois(jour), periodeFin: finDeMois(jour) });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

dbTest('10 émissions en parallèle : 10 numéros consécutifs, sans trou ni doublon', async () => {
  // Année fictive : la séquence 2098 n'est utilisée que par ce test
  const contrats = [];
  for (let i = 0; i < 10; i++) contrats.push(await contratSigne({ dateDebut: '2098-01-01' }));

  const resultats = await Promise.all(contrats.map(c => emettreFacture({
    contratId: c.contratId, periodeDebut: '2098-01-01', periodeFin: '2098-01-31', dateEmission: '2098-01-01',
  })));
  const numeros = resultats.map(r => Number(r.facture.numero.match(/^FAC-2098-(\d+)$/)[1])).sort((a, b) => a - b);
  assert.equal(new Set(numeros).size, 10);
  for (let i = 1; i < numeros.length; i++) assert.equal(numeros[i], numeros[i - 1] + 1, `trou entre ${numeros[i - 1]} et ${numeros[i]}`);

  // PDF stocké, e-mail parti au contact de facturation avec le PDF
  const f = resultats[0].facture;
  const doc = await documentStorage.get(pool, f.document_id);
  assert.equal(doc.contenu.subarray(0, 4).toString(), '%PDF');
  assert.equal(doc.sha256, f.sha256);
  const mail = boiteMemoire.find(m => m.subject === `Facture CUBI ${f.numero}`);
  assert.ok(mail);
  assert.equal(mail.to[0].email, contrats[0].email);
  assert.equal(mail.attachments[0].content.subarray(0, 4).toString(), '%PDF');

  // Réémettre la même période renvoie la facture existante
  const encore = await emettreFacture({
    contratId: contrats[0].contratId, periodeDebut: '2098-01-01', periodeFin: '2098-01-31', dateEmission: '2098-01-01',
  });
  assert.equal(encore.dejaEmise, true);
  assert.equal(encore.facture.id, resultats[0].facture.id);
});

dbTest('job quotidien rejoué deux fois : une seule facture du mois, jamais re-facturée après avoir', async () => {
  const { contratId } = await contratSigne({ dateDebut: debutDeMois(aujourdhuiParis()) });
  const compter = async () => (await pool.query(
    "SELECT id, statut FROM facture WHERE contrat_id = $1 AND type = 'facture'", [contratId]
  )).rows;

  await jobQuotidien();
  await jobQuotidien();
  const factures = await compter();
  assert.equal(factures.length, 1);

  // Après un avoir total, le job ne ré-émet pas la période
  const r = await api('POST', `/admin/factures/${factures[0].id}/avoir`, { jwt: jwtAdmin, body: { motif: 'Geste commercial' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await jobQuotidien();
  assert.deepEqual((await compter()).map(f => f.statut), ['annulee_par_avoir']);

  // Réémission manuelle de la période annulée : autorisée ; une 2e fois : 409 (facture active)
  const jour = aujourdhuiParis();
  const corps = { contratId, periodeDebut: debutDeMois(jour), periodeFin: finDeMois(jour) };
  let m = await api('POST', '/admin/factures/emettre', { jwt: jwtAdmin, body: corps });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal(m.body.statut, 'en_attente');
  m = await api('POST', '/admin/factures/emettre', { jwt: jwtAdmin, body: corps });
  assert.equal(m.status, 409);
  m = await api('POST', '/admin/factures/emettre', { jwt: jwtAdmin, body: { ...corps, periodeDebut: '2020-01-01', periodeFin: '2020-01-31' } });
  assert.equal(m.status, 422, "avant la date d'effet");
});

dbTest('organisation suspendue : pas de facture par le job', async () => {
  const { contratId, ecoleIds } = await contratSigne({ dateDebut: debutDeMois(aujourdhuiParis()) });
  await pool.query("UPDATE ecole SET statut = 'suspendu' WHERE id = $1", [ecoleIds[0]]);
  await jobQuotidien();
  const { rows } = await pool.query('SELECT 1 FROM facture WHERE contrat_id = $1', [contratId]);
  assert.equal(rows.length, 0);
});

dbTest('avoirs : partiel plafonné, total qui annule la facture', async () => {
  const groupe = await contratSigne({ quantites: [20, 15], dateDebut: '2026-01-01' });
  const { facture } = await emettreMoisCourant(groupe.contratId);
  assert.equal(facture.lignes.length, 2, 'une ligne par établissement');

  // Partiel
  let r = await api('POST', `/admin/factures/${facture.id}/avoir`, {
    jwt: jwtAdmin, body: { motif: 'Panne de 2 jours', lignes: [{ label: 'Geste commercial', prixUnitaireHtCentimes: 1000 }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.reference, /^AV-\d{4}-\d{4,}$/);
  assert.equal(r.body.totalTtcCentimes, -1200);
  assert.equal(r.body.factureOrigine, facture.numero);
  assert.equal(r.body.statut, 'avoir');

  r = await api('GET', `/admin/factures/${facture.id}`, { jwt: jwtAdmin });
  assert.equal(r.body.statutFacture, 'emise');
  assert.equal(r.body.avoirs.length, 1);

  // Au-delà du solde : refusé ; avoir total après un partiel : refusé
  r = await api('POST', `/admin/factures/${facture.id}/avoir`, {
    jwt: jwtAdmin, body: { motif: 'Trop', lignes: [{ label: 'x', prixUnitaireHtCentimes: facture.total_ht_centimes }] },
  });
  assert.equal(r.status, 422);
  r = await api('POST', `/admin/factures/${facture.id}/avoir`, { jwt: jwtAdmin, body: { motif: 'Total' } });
  assert.equal(r.status, 409);

  // Total sur une facture payée : la facture passe en annulee_par_avoir
  const ecole = await contratSigne({ quantites: [10], dateDebut: '2026-01-01' });
  const { facture: f2 } = await emettreMoisCourant(ecole.contratId);
  r = await api('POST', `/admin/factures/${f2.id}/payer`, { jwt: jwtAdmin, body: { datePaiement: aujourdhuiParis() } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.statut, 'payee');
  r = await api('POST', `/admin/factures/${f2.id}/payer`, { jwt: jwtAdmin, body: { datePaiement: aujourdhuiParis() } });
  assert.equal(r.status, 409, 'déjà payée');

  r = await api('POST', `/admin/factures/${f2.id}/avoir`, { jwt: jwtAdmin, body: { motif: 'Résiliation' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.totalTtcCentimes, -f2.total_ttc_centimes);
  r = await api('GET', `/admin/factures/${f2.id}`, { jwt: jwtAdmin });
  assert.equal(r.body.statut, 'annulee');
  assert.equal(r.body.statutFacture, 'annulee_par_avoir');
  r = await api('POST', `/admin/factures/${f2.id}/avoir`, { jwt: jwtAdmin, body: { motif: 'Encore' } });
  assert.equal(r.status, 409);

  // Liste filtrée par organisation : forme du front (tableau)
  r = await api('GET', `/admin/factures?organisation=${ecole.ecoleIds[0]}`, { jwt: jwtAdmin });
  assert.ok(Array.isArray(r.body));
  assert.deepEqual(r.body.map(f => f.statut).sort(), ['annulee', 'avoir']);
  for (const k of ['id', 'organisationId', 'organisation', 'plan', 'montant', 'echeance', 'statut', 'reference']) {
    assert.ok(k in r.body[0], k);
  }
});

dbTest('école A ne voit pas les factures de l\'école B', async () => {
  const comptes = [];
  for (let i = 0; i < 2; i++) {
    const c = await contratSigne({ dateDebut: '2026-01-01' });
    const { facture } = await emettreMoisCourant(c.contratId);
    const { rows: [u] } = await pool.query(
      `INSERT INTO utilisateur (ecole_id, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
       VALUES ($1, 'Admin', 'École', $2, 'x', FALSE, 'admin', 'actif') RETURNING id`,
      [c.ecoleIds[0], `admin-${unique()}@ecole.test`]
    );
    comptes.push({ factureId: facture.id, jwt: generateJwt({ id: u.id, ecole_id: c.ecoleIds[0], role: 'admin' }, 'ecole') });
  }
  const [a, b] = comptes;

  let r = await api('GET', '/school/factures', { jwt: a.jwt });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(f => f.id), [a.factureId]);
  assert.deepEqual(Object.keys(r.body[0]).slice(0, 6), ['id', 'reference', 'date', 'echeance', 'montant', 'statut']);
  assert.equal(r.body[0].statut, 'en_cours');

  r = await api('GET', `/school/factures/${b.factureId}/pdf`, { jwt: a.jwt });
  assert.equal(r.status, 404);
  r = await api('GET', `/school/factures/${a.factureId}/pdf`, { jwt: a.jwt });
  assert.equal(r.status, 200);
  assert.equal(r.body.subarray(0, 4).toString(), '%PDF');
});
