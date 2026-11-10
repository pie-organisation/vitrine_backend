// Routes publiques testées en HTTP sans base : tous ces cas sont rejetés avant toute requête SQL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// URL injoignable : un test qui toucherait la base échouerait au lieu de passer
process.env.DATABASE_URL = 'postgres://aucune@127.0.0.1:1/aucune';
process.env.JWT_SECRET = 'test';
process.env.FRONT_URL = 'http://front.test/';
process.env.JOB_SECRET = 'secret-du-job';
process.env.APP_ENV = 'test';

const app = require('../src/app');
const pool = require('../src/db');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await pool.end();
});

const TOKEN_FACTICE = 'A'.repeat(43);
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('token mal formé : erreur générique, identique à un token inconnu', async () => {
  for (const chemin of ['/signature/abc', '/signature/abc/pdf']) {
    const res = await fetch(base + chemin);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Ce lien de signature est invalide ou a expiré.' });
  }
  const res = await fetch(`${base}/signature/abc/otp`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('signer : corps validé avant tout accès au token', async () => {
  const signer = body => fetch(`${base}/signature/${TOKEN_FACTICE}/signer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const valide = { otp: '123456', signaturePng: PNG_1x1, mention: 'Lu et approuvé', acceptation: true };

  let res = await signer({ ...valide, acceptation: false });
  assert.equal(res.status, 422);
  assert.match((await res.json()).message, /accepter/);

  res = await signer({ ...valide, otp: '12a456' });
  assert.equal(res.status, 422);

  // PNG 1x1 : refusé (dimensions) avant de consommer un essai OTP
  res = await signer(valide);
  assert.equal(res.status, 422);
  assert.match((await res.json()).message, /Dimensions/);
});

test('verifier : référence mal formée rejetée', async () => {
  const res = await fetch(`${base}/signature/verifier/pas-une-reference`);
  assert.equal(res.status, 404);
});

test('CORS : /signature n\'autorise que FRONT_URL, le reste de l\'API reste ouvert', async () => {
  const preflight = origin => fetch(`${base}/signature/${TOKEN_FACTICE}/otp`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST' },
  });
  let res = await preflight('http://front.test');
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://front.test', 'slash final de FRONT_URL ignoré');
  res = await preflight('https://malveillant.example');
  assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://malveillant.example');
  assert.notEqual(res.headers.get('access-control-allow-origin'), '*');

  res = await fetch(`${base}/auth/login`, { method: 'OPTIONS', headers: { origin: 'https://autre.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('job quotidien : secret exigé, réponse identique quel que soit le cas', async () => {
  for (const headers of [{}, { 'X-Job-Secret': 'secret-du-jo' }, { 'X-Job-Secret': '' }]) {
    const res = await fetch(`${base}/internal/jobs/quotidien`, { method: 'POST', headers });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Non autorisé' });
  }
});

test('un lien de réinitialisation (invitation) ne vaut pas session', async () => {
  const { generateTempJwt, generateJwt } = require('../src/middleware/auth');
  const utilisateur = { id: '00000000-0000-4000-8000-000000000001', ecole_id: '00000000-0000-4000-8000-000000000002', role: 'admin' };
  let res = await fetch(`${base}/school/contrats`, { headers: { authorization: `Bearer ${generateTempJwt(utilisateur, 'ecole')}` } });
  assert.equal(res.status, 401);
  // Un admin de l'équipe Cubi en lecture seule ne peut rien écrire
  const lecture = generateJwt({ id: utilisateur.id, role: 'lecture' }, 'cubi');
  for (const [method, chemin] of [
    ['POST', '/admin/factures/emettre'], ['POST', `/admin/factures/${utilisateur.id}/avoir`],
    ['POST', `/admin/factures/${utilisateur.id}/payer`], ['POST', `/admin/contrats/${utilisateur.id}/envoyer`],
    ['PATCH', `/admin/contrats/${utilisateur.id}`], ['PATCH', `/admin/demandes/${utilisateur.id}`],
    ['POST', `/admin/organisations/${utilisateur.id}/suspendre`],
  ]) {
    res = await fetch(base + chemin, { method, headers: { authorization: `Bearer ${lecture}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403, `${method} ${chemin}`);
  }
});

test('routes admin et école des contrats : authentification exigée', async () => {
  for (const chemin of ['/admin/contrats', '/school/contrats']) {
    const res = await fetch(base + chemin);
    assert.equal(res.status, 401, chemin);
  }
});
