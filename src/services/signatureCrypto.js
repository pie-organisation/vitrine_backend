// Primitives de la signature électronique, sans base ni config : token, OTP, PNG, masquage.
// Le token et l'OTP ne sont jamais stockés ni loggés en clair.

const crypto = require('crypto');
const zlib = require('zlib');

const OTP_LONGUEUR = 6;
const PNG_MAX_OCTETS = 200 * 1024;
// Un pad de 600 × 200 en densité 3 donne 1800 × 600
const PNG_LARGEUR = { min: 100, max: 2000 };
const PNG_HAUTEUR = { min: 40, max: 1000 };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Octets par pixel en profondeur 8 bits, par type de couleur PNG (gris, RVB, palette, gris+alpha, RVBA)
const PNG_OCTETS_PAR_PIXEL = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Comparaison en temps constant de deux chaînes quelconques : hacher d'abord ramène
// les deux à 32 octets, timingSafeEqual exigeant des longueurs égales
function egaliteConstante(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── Token du lien de signature : 32 octets aléatoires, base64url (43 caractères) ──

const FORMAT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function genererToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

function hashToken(token) {
  return sha256(token);
}

function formatTokenValide(token) {
  return typeof token === 'string' && FORMAT_TOKEN.test(token);
}

// ── OTP : 6 chiffres. HMAC lié à la demande de signature (un hash d'OTP n'est pas
// réutilisable d'une demande à l'autre, et 10^6 valeurs ne se cassent pas sans la clé). ──

function genererOtp() {
  return String(crypto.randomInt(0, 10 ** OTP_LONGUEUR)).padStart(OTP_LONGUEUR, '0');
}

function hashOtp(otp, demandeId, secret) {
  if (!secret) throw new Error('hashOtp : secret manquant');
  return crypto.createHmac('sha256', secret).update(`${demandeId}:${otp}`).digest('hex');
}

function verifierOtp(otp, hashAttendu, demandeId, secret) {
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp) || !hashAttendu) return false;
  const calcule = Buffer.from(hashOtp(otp, demandeId, secret), 'hex');
  const attendu = Buffer.from(hashAttendu, 'hex');
  return calcule.length === attendu.length && crypto.timingSafeEqual(calcule, attendu);
}

// ── Signature manuscrite : data URL PNG, vraie signature PNG, taille et dimensions bornées ──

// Renvoie { png, largeur, hauteur } ou lève une erreur au message affichable.
// Le PNG est entièrement relu avant d'être confié à Chromium : chunks et CRC, IHDR en tête,
// IEND en fin sans données au-delà, 8 bits non entrelacé, et données d'image décompressées
// avec une borne exacte (pas de bombe de décompression).
function validerSignaturePng(dataUrl) {
  const prefixe = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefixe)) {
    throw new Error('La signature doit être une image PNG (data URL).');
  }
  const b64 = dataUrl.slice(prefixe.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('Image de signature illisible.');
  const png = Buffer.from(b64, 'base64');
  if (png.length > PNG_MAX_OCTETS) throw new Error('Image de signature trop lourde (200 Ko maximum).');

  const invalide = () => new Error("L'image de signature n'est pas un PNG valide.");
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_MAGIC)) throw invalide();

  let pos = 8;
  let ihdr = null;
  let fin = false;
  const idat = [];
  while (pos < png.length) {
    if (fin || pos + 12 > png.length) throw invalide(); // octets après IEND ou chunk tronqué
    const longueur = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    if (pos + 12 + longueur > png.length) throw invalide();
    const donnees = png.subarray(pos + 8, pos + 8 + longueur);
    if (zlib.crc32(png.subarray(pos + 4, pos + 8 + longueur)) !== png.readUInt32BE(pos + 8 + longueur)) throw invalide();
    if (!ihdr && type !== 'IHDR') throw invalide();

    if (type === 'IHDR') {
      if (ihdr || longueur !== 13) throw invalide();
      ihdr = {
        largeur: donnees.readUInt32BE(0), hauteur: donnees.readUInt32BE(4),
        profondeur: donnees[8], couleur: donnees[9], entrelacement: donnees[12],
      };
    } else if (type === 'IDAT') {
      idat.push(donnees);
    } else if (type === 'IEND') {
      fin = true;
    }
    pos += 12 + longueur;
  }
  if (!ihdr || !fin || !idat.length) throw invalide();

  const { largeur, hauteur, profondeur, couleur, entrelacement } = ihdr;
  if (largeur < PNG_LARGEUR.min || largeur > PNG_LARGEUR.max || hauteur < PNG_HAUTEUR.min || hauteur > PNG_HAUTEUR.max) {
    throw new Error('Dimensions de la signature hors limites.');
  }
  const octetsParPixel = PNG_OCTETS_PAR_PIXEL[couleur];
  if (profondeur !== 8 || !octetsParPixel || entrelacement !== 0) throw invalide();

  // Taille exacte des données filtrées : un octet de filtre par ligne + les pixels
  const attendu = hauteur * (1 + largeur * octetsParPixel);
  let brut;
  try {
    brut = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: attendu + 1 });
  } catch {
    throw invalide(); // flux corrompu, ou décompression au-delà de la taille annoncée
  }
  if (brut.length !== attendu) throw invalide();

  return { png, largeur, hauteur };
}

// ── Affichage ──

// s.bernard@tilleuls.fr -> s***d@tilleuls.fr
function masquerEmail(email) {
  const [local, domaine] = String(email).split('@');
  if (!domaine) return '***';
  const fin = local.length > 3 ? local.at(-1) : '';
  return `${local[0]}***${fin}@${domaine}`;
}

// Référence de preuve imprimée sur le contrat : SIG-XXXX-XXXX-XXXX
function genererPreuveId() {
  const hex = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `SIG-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`;
}

module.exports = {
  sha256, egaliteConstante,
  genererToken, hashToken, formatTokenValide,
  genererOtp, hashOtp, verifierOtp,
  validerSignaturePng, masquerEmail, genererPreuveId,
  PNG_MAX_OCTETS,
};
