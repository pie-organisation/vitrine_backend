// Pont vers le service « postes de travail » (API Go / Proxmox, routes /api/*).
// L'API Go a ses propres comptes : le back garde, par école, les identifiants du compte staff
// (mot de passe chiffré AES-256-GCM) et s'y connecte à la place de l'admin pour lui remettre un jeton.
const crypto = require('crypto');
const config = require('../config');

const VERSION = 'v1';

class VdiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const estConfigure = () => Boolean(config.vdiApiUrl && config.vdiSecretKey);

// Clé de 32 octets dérivée du secret : accepte n'importe quelle chaîne longue dans VDI_SECRET_KEY
function cle(secret = config.vdiSecretKey) {
  if (!secret) throw new VdiError(503, "Le service des postes de travail n'est pas configuré.");
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

/** Chiffre un texte : « v1:iv:tag:contenu » (base64url). */
function chiffrer(texte, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle(secret), iv);
  const contenu = Buffer.concat([c.update(String(texte), 'utf8'), c.final()]);
  return [VERSION, iv, c.getAuthTag(), contenu].map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p)).join(':');
}

/** Déchiffre ; lève une erreur si le texte a été altéré ou si la clé a changé. */
function dechiffrer(chiffre, secret) {
  const [version, iv, tag, contenu] = String(chiffre).split(':');
  if (version !== VERSION || !iv || !tag || contenu === undefined) throw new Error('Format chiffré inconnu');
  const d = crypto.createDecipheriv('aes-256-gcm', cle(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(contenu, 'base64url')), d.final()]).toString('utf8');
}

/**
 * Connexion à l'API Go (POST /api/auth/login). Renvoie le jeton.
 * 422 : identifiants refusés ou compte sans accès staff ; 502 : service injoignable ou en erreur.
 */
async function connecter(email, motDePasse, fetchImpl = fetch) {
  if (!estConfigure()) throw new VdiError(503, "Le service des postes de travail n'est pas configuré.");
  let res;
  try {
    res = await fetchImpl(`${config.vdiApiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: motDePasse }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new VdiError(502, 'Service des postes de travail injoignable. Réessayez dans un instant.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    throw new VdiError(422, 'Identifiants des postes de travail refusés.');
  }
  if (!res.ok) throw new VdiError(502, 'Le service des postes de travail a rencontré une erreur.');
  if (!data.staff) {
    throw new VdiError(422, "Ce compte n'a pas accès à la gestion des postes de travail (réservé au personnel).");
  }
  if (!data.token) throw new VdiError(502, 'Le service des postes de travail n\'a renvoyé aucun jeton.');
  return data.token;
}

module.exports = { VdiError, estConfigure, chiffrer, dechiffrer, connecter };
