// Tests unitaires de la signature, sans base
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const crypto = require('crypto');
const {
  genererToken, hashToken, formatTokenValide, genererOtp, hashOtp, verifierOtp,
  validerSignaturePng, masquerEmail, genererPreuveId, egaliteConstante, PNG_MAX_OCTETS,
} = require('../src/services/signatureCrypto');
const { calculerPalier, prixEnCentimes } = require('../src/services/palier');

// PNG RGBA transparent valide (CRC compris)
function png(largeur, hauteur) {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4); ihdr[8] = 8; ihdr[9] = 6;
  const brut = Buffer.alloc((1 + largeur * 4) * hauteur);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(brut)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const dataUrl = buf => `data:image/png;base64,${buf.toString('base64')}`;

test('token : 32 octets en base64url, seul son SHA-256 est stocké', () => {
  const { token, tokenHash } = genererToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(hashToken(token), tokenHash);
  assert.notEqual(genererToken().token, token);
  assert.ok(formatTokenValide(token));
  for (const invalide of ['', 'abc', `${token}=`, `${token.slice(0, 42)}!`, null, 42]) {
    assert.equal(formatTokenValide(invalide), false, String(invalide));
  }
});

test('OTP : 6 chiffres, vérification liée à la demande et au secret', () => {
  for (let i = 0; i < 500; i++) assert.match(genererOtp(), /^\d{6}$/);
  const otp = '042137';
  const hash = hashOtp(otp, 'demande-1', 'secret');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, crypto.createHash('sha256').update(otp).digest('hex'), 'pas un simple SHA-256 du code');
  assert.ok(verifierOtp(otp, hash, 'demande-1', 'secret'));
  assert.equal(verifierOtp('042138', hash, 'demande-1', 'secret'), false);
  assert.equal(verifierOtp(otp, hash, 'demande-2', 'secret'), false, 'autre demande');
  assert.equal(verifierOtp(otp, hash, 'demande-1', 'autre'), false, 'autre secret');
  assert.equal(verifierOtp('42137', hash, 'demande-1', 'secret'), false, 'format');
  assert.equal(verifierOtp(otp, null, 'demande-1', 'secret'), false, 'aucun code demandé');
  assert.throws(() => hashOtp(otp, 'demande-1', ''), /secret/);
});

test('PNG de signature : vrai PNG, 200 Ko max, dimensions bornées', () => {
  const r = validerSignaturePng(dataUrl(png(600, 200)));
  assert.equal(r.largeur, 600);
  assert.equal(r.hauteur, 200);
  assert.ok(r.png.subarray(1, 4).toString() === 'PNG');

  assert.throws(() => validerSignaturePng('data:image/jpeg;base64,/9j/4AAQ'), /PNG/);
  assert.throws(() => validerSignaturePng(`data:image/png;base64,${Buffer.from('GIF89a pas un png du tout, non').toString('base64')}`), /PNG valide/);
  assert.throws(() => validerSignaturePng('data:image/png;base64,@@@'), /illisible/);
  assert.throws(() => validerSignaturePng(dataUrl(png(20, 20))), /Dimensions/);
  assert.throws(() => validerSignaturePng(dataUrl(png(2400, 200))), /Dimensions/);
  assert.doesNotThrow(() => validerSignaturePng(dataUrl(png(1800, 600))), 'pad 600 × 200 en densité 3');
  const lourd = Buffer.concat([png(600, 200), crypto.randomBytes(PNG_MAX_OCTETS)]);
  assert.throws(() => validerSignaturePng(dataUrl(lourd)), /200 Ko/);
  assert.throws(() => validerSignaturePng(undefined), /PNG/);
});

test('PNG malveillant : CRC, données après IEND, bombe de décompression, profondeur', () => {
  const sain = png(600, 200);
  assert.doesNotThrow(() => validerSignaturePng(dataUrl(sain)));

  // CRC d'IHDR corrompu
  const crcFaux = Buffer.from(sain); crcFaux[29] ^= 0xff;
  assert.throws(() => validerSignaturePng(dataUrl(crcFaux)), /PNG valide/);

  // Octets cachés après IEND
  assert.throws(() => validerSignaturePng(dataUrl(Buffer.concat([sain, Buffer.from('<script>')]))), /PNG valide/);

  // Chunk tronqué
  assert.throws(() => validerSignaturePng(dataUrl(sain.subarray(0, sain.length - 6))), /PNG valide/);

  // Bombe : IHDR annonce 600 × 200, l'IDAT se décompresse en 50 Mo (quelques dizaines de Ko compressés)
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = (largeur, hauteur, profondeur = 8) => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(largeur, 0); b.writeUInt32BE(hauteur, 4); b[8] = profondeur; b[9] = 6;
    return chunk('IHDR', b);
  };
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bombe = Buffer.concat([
    magic, ihdr(600, 200), chunk('IDAT', zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.ok(bombe.length < 200 * 1024, 'la bombe passe la limite de taille');
  assert.throws(() => validerSignaturePng(dataUrl(bombe)), /PNG valide/);

  // 16 bits par canal : refusé (mémoire doublée côté rendu)
  const seize = Buffer.concat([
    magic, ihdr(600, 200, 16), chunk('IDAT', zlib.deflateSync(Buffer.alloc((1 + 600 * 8) * 200))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => validerSignaturePng(dataUrl(seize)), /PNG valide/);

  // Données d'image plus courtes que les dimensions annoncées
  const court = Buffer.concat([
    magic, ihdr(600, 200), chunk('IDAT', zlib.deflateSync(Buffer.alloc(100))), chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => validerSignaturePng(dataUrl(court)), /PNG valide/);
});

test('palier : déduit de la quantité totale (sessions_min / sessions_max)', () => {
  const types = [
    { id: 'l1', nom: 'Licence 1', sessions_min: 1, sessions_max: 30, prix_unitaire: '5.00', actif: true },
    { id: 'l2', nom: 'Licence 2', sessions_min: 31, sessions_max: 100, prix_unitaire: '4.00', actif: true },
    { id: 'l3', nom: 'Licence 3', sessions_min: 101, sessions_max: null, prix_unitaire: '3.00', actif: true },
  ];
  assert.equal(calculerPalier(types, 1).id, 'l1');
  assert.equal(calculerPalier(types, 30).id, 'l1');
  assert.equal(calculerPalier(types, 31).id, 'l2');
  assert.equal(calculerPalier(types, 100).id, 'l2');
  assert.equal(calculerPalier(types, 101).id, 'l3');
  assert.equal(calculerPalier(types, 5000).id, 'l3', 'sessions_max NULL = illimité');
  assert.throws(() => calculerPalier(types, 0), e => e.status === 422);
  assert.throws(() => calculerPalier(types, 2.5), e => e.status === 422);
  assert.throws(() => calculerPalier(types.slice(0, 2), 150), /Aucun palier/);
});

test('palier : un type inactif n\'est jamais choisi', () => {
  const types = [{ id: 'l1', sessions_min: 1, sessions_max: 30, actif: false }];
  assert.throws(() => calculerPalier(types, 10), /Aucun palier/);
});

test('prix NUMERIC -> centimes entiers', () => {
  assert.equal(prixEnCentimes('5.00'), 500);
  assert.equal(prixEnCentimes('6.5'), 650);
  assert.equal(prixEnCentimes('19.99'), 1999);
  assert.equal(prixEnCentimes('0.29'), 29);
  assert.equal(prixEnCentimes('4'), 400);
});

test('e-mail masqué', () => {
  assert.equal(masquerEmail('s.bernard@tilleuls.fr'), 's***d@tilleuls.fr');
  assert.equal(masquerEmail('abc@ex.fr'), 'a***@ex.fr');
  assert.equal(masquerEmail('a@ex.fr'), 'a***@ex.fr');
  assert.equal(masquerEmail('pas-un-email'), '***');
});

test('référence de preuve et comparaison en temps constant', () => {
  const id = genererPreuveId();
  assert.match(id, /^SIG-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.notEqual(genererPreuveId(), id);
  assert.ok(egaliteConstante('secret-du-job', 'secret-du-job'));
  assert.equal(egaliteConstante('secret-du-job', 'secret-du-jo'), false);
  assert.equal(egaliteConstante('', 'x'), false);
});
