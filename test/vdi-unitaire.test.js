// Tests unitaires du pont « postes de travail », sans base ni réseau
process.env.VDI_API_URL = 'https://vdi.test';
process.env.VDI_SECRET_KEY = 'secret-de-test-assez-long-pour-aes';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vdi = require('../src/services/vdi');

const reponse = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('chiffrement : aller-retour, IV aléatoire, pas de clair dans le chiffré', () => {
  const a = vdi.chiffrer('mot de passe é€');
  const b = vdi.chiffrer('mot de passe é€');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('v1:'));
  assert.ok(!a.includes('mot de passe'));
  assert.equal(vdi.dechiffrer(a), 'mot de passe é€');
});

test('chiffrement : altération ou autre clé rejetées', () => {
  const c = vdi.chiffrer('secret');
  const parts = c.split(':');
  parts[3] = Buffer.from('autre').toString('base64url');
  assert.throws(() => vdi.dechiffrer(parts.join(':')));
  assert.throws(() => vdi.dechiffrer(c, 'une-autre-cle'));
  assert.throws(() => vdi.dechiffrer('nimportequoi'));
});

test('connecter : renvoie le jeton d\'un compte staff', async () => {
  let appel;
  const fetchImpl = async (url, init) => { appel = { url, init }; return reponse(200, { token: 'jwt-go', staff: true })(); };
  assert.equal(await vdi.connecter('a@b.fr', 'pw', fetchImpl), 'jwt-go');
  assert.equal(appel.url, 'https://vdi.test/api/auth/login');
  assert.deepEqual(JSON.parse(appel.init.body), { email: 'a@b.fr', password: 'pw' });
});

test('connecter : identifiants refusés ou compte non staff = 422', async () => {
  await assert.rejects(vdi.connecter('a@b.fr', 'x', reponse(401, { error: 'bad' })), { status: 422 });
  await assert.rejects(vdi.connecter('a@b.fr', 'x', reponse(200, { token: 't', staff: false })), { status: 422 });
});

test('connecter : service en erreur ou injoignable = 502', async () => {
  await assert.rejects(vdi.connecter('a@b.fr', 'x', reponse(500, {})), { status: 502 });
  await assert.rejects(vdi.connecter('a@b.fr', 'x', async () => { throw new Error('ECONNREFUSED'); }), { status: 502 });
});
