// Parcours de signature de bout en bout, sur une base de test dédiée uniquement.
// Sans TEST_DATABASE_URL, tout est ignoré. Les e-mails restent en mémoire (EMAIL_TRANSPORT=memoire) :
// le token et l'OTP y sont lus comme le ferait le signataire.
// Les contrats et leur journal sont des pièces conservées (triggers append-only) : les données de test
// restent en base, avec des SIRET et e-mails uniques à chaque exécution.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const SKIP = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL non définie (aucune base de test)';
const dbTest = (nom, fn) => test(nom, { skip: SKIP }, fn);

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://aucune@127.0.0.1:1/aucune';
process.env.JWT_SECRET = 'test-integration';
process.env.EMAIL_TRANSPORT = 'memoire';
process.env.APP_ENV = 'test';
process.env.FRONT_URL = 'http://front.test';
process.env.JOB_SECRET = 'secret-job-test';
delete process.env.CUBI_SIGNATURE_PNG_BASE64;

const app = require('../src/app');
const pool = require('../src/db');
const { boiteMemoire } = require('../src/email');
const { generateJwt } = require('../src/middleware/auth');
const { onContratSigne } = require('../src/services/onContratSigne');
const { closeBrowser } = require('../src/pdf/render');

let server;
let base;
let jwtAdmin;

before(async () => {
  if (SKIP) return;
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_documents_signature.sql'), 'utf8'));
  const { rows: [admin] } = await pool.query(
    `INSERT INTO utilisateur_cubi (nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
     VALUES ('Test', 'Admin', $1, 'x', FALSE, 'super_admin', 'actif') RETURNING id`,
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

// ── Outils ────────────────────────────────────────────────────────────────────

function png(largeur, hauteur) {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((1 + largeur * 4) * hauteur))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const SIGNATURE = `data:image/png;base64,${png(600, 200).toString('base64')}`;

async function api(method, chemin, { jwt, body } = {}) {
  const res = await fetch(base + chemin, {
    method,
    headers: { ...(jwt && { authorization: `Bearer ${jwt}` }), ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const json = (res.headers.get('content-type') || '').includes('json');
  return { status: res.status, body: json ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const unique = () => crypto.randomUUID().slice(0, 8);
const siret = () => String(crypto.randomInt(1e13, 1e14));

function dernierEmail(email, motif) {
  const m = [...boiteMemoire].reverse().find(e => e.to.some(t => t.email === email) && motif.test(e.subject + e.text));
  assert.ok(m, `aucun e-mail « ${motif} » pour ${email}`);
  return m;
}
const dernierToken = email => dernierEmail(email, /\/signature\//).text.match(/\/signature\/([A-Za-z0-9_-]{43})/)[1];
const dernierOtp = email => dernierEmail(email, /code de signature/i).subject.match(/(\d{6})/)[1];

async function typeLicenceId() {
  const { rows } = await pool.query('SELECT id FROM type_licence WHERE actif = TRUE ORDER BY sessions_min LIMIT 1');
  return rows[0].id;
}

async function demandeEcole(nbLicences) {
  const email = `ecole-${unique()}@ecole.test`;
  const { rows } = await pool.query(
    `INSERT INTO demande_inscription
       (type_demande, nom_siege_ou_ecole, nom_daf, prenom_daf, nom_ecole, siret, adresse, code_postal, ville,
        type_licence_id, nom_contact, prenom_contact, email, mot_de_passe_hash, nb_licences_estime, statut)
     VALUES ('ecole', 'Siège', 'Daf', 'Paul', $1, $2, '1 rue Test', '75001', 'Paris',
             $3, 'Martin', 'Claire', $4, '$2a$12$abcdefghijklmnopqrstuuJ4tQ3l3ZpG1yq7mJcVQhBq9xJQvW6eO', $5, 'en_attente')
     RETURNING id`,
    [`Lycée Test ${unique()}`, siret(), await typeLicenceId(), email, nbLicences]
  );
  return { demandeId: rows[0].id, email };
}

async function demandeGroupe() {
  const email = `groupe-${unique()}@groupe.test`;
  const etablissements = [1, 2].map(i => ({
    nom: `Collège ${i} ${unique()}`, siret: siret(), visa: null, adresse: `${i} rue Test`, code_postal: '69001',
    ville: 'Lyon', nom_responsable: 'Resp', prenom_responsable: `R${i}`,
    email_responsable: `resp-${i}-${unique()}@groupe.test`, nb_licences_estime: null,
  }));
  const { rows } = await pool.query(
    `INSERT INTO demande_inscription
       (type_demande, nom_siege_ou_ecole, nom_daf, prenom_daf, type_licence_id, nom_contact, prenom_contact,
        email, etablissements, statut)
     VALUES ('groupe', $1, 'Daf', 'Paula', $2, 'Contact', 'Jeanne', $3, $4, 'en_attente')
     RETURNING id`,
    [`Groupe Test ${unique()}`, await typeLicenceId(), email, JSON.stringify(etablissements)]
  );
  return { demandeId: rows[0].id, email, etablissements };
}

// Valide la demande, complète le signataire et envoie : renvoie le contrat et le token du lien
async function contratEnvoye({ demande, corpsValidation = {} }) {
  let r = await api('PATCH', `/admin/demandes/${demande.demandeId}`, {
    jwt: jwtAdmin, body: { statut: 'validee', ...corpsValidation },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const contratId = r.body.contrat.id;

  r = await api('POST', `/admin/contrats/${contratId}/envoyer`, { jwt: jwtAdmin });
  assert.equal(r.status, 422, 'envoi refusé sans fonction du signataire');
  // Un groupe n'a pas d'adresse de siège à l'inscription : l'admin la complète avant l'envoi
  const adresse = demande.etablissements ? { adresseClient: '10 place du Siège, 69002 Lyon' } : {};
  r = await api('PATCH', `/admin/contrats/${contratId}`, {
    jwt: jwtAdmin, body: { signataire: { fonction: 'Directrice' }, ...adresse },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('POST', `/admin/contrats/${contratId}/envoyer`, { jwt: jwtAdmin });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  return { contratId, token: dernierToken(demande.email) };
}

async function signer(token, email, { otp } = {}) {
  if (!otp) {
    const r = await api('POST', `/signature/${token}/otp`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return api('POST', `/signature/${token}/signer`, {
    body: { otp: otp || dernierOtp(email), signaturePng: SIGNATURE, mention: 'Lu et approuvé', acceptation: true },
  });
}

async function contrat(id) {
  const { rows } = await pool.query('SELECT * FROM contrat WHERE id = $1', [id]);
  return rows[0];
}

// ── Parcours ──────────────────────────────────────────────────────────────────

dbTest('parcours complet école : validation, envoi, OTP, signature, activation', async () => {
  const demande = await demandeEcole(40);
  const { contratId, token } = await contratEnvoye({ demande });

  const brouillon = await contrat(contratId);
  assert.equal(brouillon.donnees.quantiteTotale, 40);
  const ecoleId = brouillon.ecole_id;
  let { rows: [ecole] } = await pool.query('SELECT statut FROM ecole WHERE id = $1', [ecoleId]);
  assert.equal(ecole.statut, 'inactif', 'organisation inactive avant signature');
  let { rows: comptes } = await pool.query('SELECT id FROM utilisateur WHERE ecole_id = $1', [ecoleId]);
  assert.equal(comptes.length, 0, 'aucun compte avant signature');
  assert.ok(!boiteMemoire.some(e => e.to.some(t => t.email === demande.email) && /connecter/.test(e.text)),
    'pas d\'e-mail « connectez-vous » avant signature');

  let r = await api('GET', `/signature/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.statut, 'a_signer');
  assert.equal(r.body.contrat.numero, brouillon.numero);
  assert.ok(r.body.signataire.emailMasque.includes('***'));
  assert.ok(!JSON.stringify(r.body).includes(demande.email), 'e-mail jamais en clair');

  r = await api('GET', `/signature/${token}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.body.subarray(0, 4).toString(), '%PDF');

  r = await signer(token, demande.email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.preuveId, /^SIG-/);

  const signe = await contrat(contratId);
  assert.equal(signe.statut, 'signe');
  assert.ok(signe.date_effet >= signe.date_debut, "date d'effet = max(date_debut, signature)");
  const { rows: [facture] } = await pool.query(
    "SELECT periode_debut FROM facture WHERE contrat_id = $1 AND type = 'facture'", [contratId]
  );
  assert.equal(facture.periode_debut.getTime(), signe.date_effet.getTime(), "première facture à la date d'effet");
  const { rows: [doc] } = await pool.query('SELECT sha256, contenu FROM document WHERE id = $1', [signe.document_signe_id]);
  assert.equal(crypto.createHash('sha256').update(doc.contenu).digest('hex'), signe.sha256_signe);

  r = await api('GET', `/signature/verifier/${r.body.preuveId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.sha256Signe, signe.sha256_signe);
  assert.equal(r.body.numero, signe.numero);

  ({ rows: [ecole] } = await pool.query('SELECT statut FROM ecole WHERE id = $1', [ecoleId]));
  assert.equal(ecole.statut, 'actif');
  const { rows: [{ n }] } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM licence WHERE ecole_id = $1 AND statut = 'disponible'", [ecoleId]
  );
  assert.equal(n, 40);
  ({ rows: comptes } = await pool.query("SELECT email FROM utilisateur WHERE ecole_id = $1 AND role = 'admin'", [ecoleId]));
  assert.deepEqual(comptes.map(c => c.email), [demande.email]);
  const { rows: contacts } = await pool.query('SELECT 1 FROM contact_facturation WHERE ecole_id = $1', [ecoleId]);
  assert.equal(contacts.length, 1);

  const confirmation = dernierEmail(demande.email, /signé/);
  assert.equal(confirmation.attachments[0].content.subarray(0, 4).toString(), '%PDF');
  dernierEmail(demande.email, /connecter/);

  r = await api('GET', `/signature/${token}`);
  assert.equal(r.body.statut, 'signe');
});

dbTest('double signature refusée', async () => {
  const demande = await demandeEcole(10);
  const { token } = await contratEnvoye({ demande });
  const otp = await (async () => {
    await api('POST', `/signature/${token}/otp`);
    return dernierOtp(demande.email);
  })();
  let r = await signer(token, demande.email, { otp });
  assert.equal(r.status, 200);
  r = await signer(token, demande.email, { otp });
  assert.equal(r.status, 409);
});

dbTest('5 mauvais OTP : demande révoquée, lien désactivé', async () => {
  const demande = await demandeEcole(10);
  const { contratId, token } = await contratEnvoye({ demande });
  await api('POST', `/signature/${token}/otp`);
  const bon = dernierOtp(demande.email);
  const mauvais = bon === '000000' ? '111111' : '000000';

  for (let i = 1; i <= 4; i++) {
    const r = await signer(token, demande.email, { otp: mauvais });
    assert.equal(r.status, 422);
    assert.equal(r.body.essaisRestants, 5 - i);
  }
  let r = await signer(token, demande.email, { otp: mauvais });
  assert.equal(r.status, 403);

  const { rows: [d] } = await pool.query('SELECT statut, otp_tentatives FROM demande_signature WHERE contrat_id = $1', [contratId]);
  assert.equal(d.statut, 'revoquee');
  assert.equal(d.otp_tentatives, 5);
  const { rows: echecs } = await pool.query(
    "SELECT 1 FROM contrat_evenement WHERE contrat_id = $1 AND type = 'otp_echec'", [contratId]
  );
  assert.equal(echecs.length, 5);

  r = await signer(token, demande.email, { otp: bon });
  assert.equal(r.status, 404, 'même le bon code ne passe plus');
  assert.equal((await contrat(contratId)).statut, 'envoye');
});

dbTest('token expiré : lien générique, puis expiration par le job quotidien', async () => {
  const demande = await demandeEcole(10);
  const { contratId, token } = await contratEnvoye({ demande });
  await pool.query(
    "UPDATE demande_signature SET expire_le = NOW() - INTERVAL '1 minute' WHERE contrat_id = $1", [contratId]
  );

  let r = await api('GET', `/signature/${token}`);
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Ce lien de signature est invalide ou a expiré.' });

  r = await fetch(`${base}/internal/jobs/quotidien`, { method: 'POST', headers: { 'X-Job-Secret': 'secret-job-test' } });
  assert.equal(r.status, 200);
  assert.equal((await contrat(contratId)).statut, 'expire');

  // Idempotent : un second passage ne change rien
  r = await fetch(`${base}/internal/jobs/quotidien`, { method: 'POST', headers: { 'X-Job-Secret': 'secret-job-test' } });
  assert.equal(r.status, 200);
  const { rows } = await pool.query("SELECT 1 FROM contrat_evenement WHERE contrat_id = $1 AND type = 'expire'", [contratId]);
  assert.equal(rows.length, 1);
});

dbTest('PDF altéré : signature bloquée et événement integrite_ko', async () => {
  const demande = await demandeEcole(10);
  const { contratId, token } = await contratEnvoye({ demande });
  await pool.query('UPDATE contrat SET sha256_original = $2 WHERE id = $1', [contratId, '0'.repeat(64)]);

  const r = await signer(token, demande.email);
  assert.equal(r.status, 500);
  assert.equal((await contrat(contratId)).statut, 'envoye');
  const { rows } = await pool.query(
    "SELECT 1 FROM contrat_evenement WHERE contrat_id = $1 AND type = 'integrite_ko'", [contratId]
  );
  assert.equal(rows.length, 1);
});

dbTest('école A ne lit pas les contrats de l\'école B', async () => {
  const signes = [];
  for (const nb of [5, 6]) {
    const demande = await demandeEcole(nb);
    const { contratId, token } = await contratEnvoye({ demande });
    assert.equal((await signer(token, demande.email)).status, 200);
    const { rows: [u] } = await pool.query('SELECT id, ecole_id FROM utilisateur WHERE email = $1', [demande.email]);
    signes.push({ contratId, jwt: generateJwt({ id: u.id, ecole_id: u.ecole_id, role: 'admin' }, 'ecole') });
  }
  const [a, b] = signes;

  let r = await api('GET', '/school/contrats', { jwt: a.jwt });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(c => c.id), [a.contratId]);

  r = await api('GET', `/school/contrats/${b.contratId}/pdf`, { jwt: a.jwt });
  assert.equal(r.status, 404);
  r = await api('GET', `/school/contrats/${a.contratId}/pdf`, { jwt: a.jwt });
  assert.equal(r.status, 200);
  assert.equal(r.body.subarray(0, 4).toString(), '%PDF');
});

dbTest('onContratSigne appelé deux fois : aucun doublon', async () => {
  const demande = await demandeEcole(12);
  const { contratId, token } = await contratEnvoye({ demande });
  assert.equal((await signer(token, demande.email)).status, 200);
  const { ecole_id: ecoleId } = await contrat(contratId);

  const compter = async () => (await pool.query(
    `SELECT (SELECT COUNT(*) FROM licence WHERE ecole_id = $1)::int AS licences,
            (SELECT COUNT(*) FROM utilisateur WHERE ecole_id = $1)::int AS comptes,
            (SELECT COUNT(*) FROM contact_facturation WHERE ecole_id = $1)::int AS contacts`,
    [ecoleId]
  )).rows[0];
  const avant = await compter();
  assert.deepEqual(avant, { licences: 12, comptes: 1, contacts: 1 });

  const r = await Promise.all([onContratSigne(contratId), onContratSigne(contratId)]);
  assert.ok(r.every(x => x.dejaActive));
  assert.deepEqual(await compter(), avant);
});

dbTest('groupe : quantités corrigées par l\'admin, licences par établissement, invitations, un seul contact', async () => {
  const demande = await demandeGroupe();
  const corpsValidation = {
    etablissements: demande.etablissements.map((e, i) => ({ siret: e.siret, quantite: [20, 15][i] })),
  };

  // Sans quantité (ni estimation ni correction), la validation est refusée
  let r = await api('PATCH', `/admin/demandes/${demande.demandeId}`, { jwt: jwtAdmin, body: { statut: 'validee' } });
  assert.equal(r.status, 422);

  const { contratId, token } = await contratEnvoye({ demande, corpsValidation });
  const c = await contrat(contratId);
  assert.equal(c.donnees.quantiteTotale, 35);
  assert.ok(c.groupe_scolaire_id);

  r = await signer(token, demande.email);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const { rows: ecoles } = await pool.query(
    `SELECT e.statut, e.siret, COUNT(l.id)::int AS licences
     FROM ecole e LEFT JOIN licence l ON l.ecole_id = e.id
     WHERE e.groupe_scolaire_id = $1 GROUP BY e.id ORDER BY licences DESC`,
    [c.groupe_scolaire_id]
  );
  assert.deepEqual(ecoles.map(e => [e.statut, e.licences]), [['actif', 20], ['actif', 15]]);
  for (const e of demande.etablissements) dernierEmail(e.email_responsable, /Bienvenue/);

  const { rows: contacts } = await pool.query(
    'SELECT ecole_id FROM contact_facturation WHERE groupe_scolaire_id = $1', [c.groupe_scolaire_id]
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].ecole_id, null);
});
