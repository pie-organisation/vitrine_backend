// Stockage des fichiers (PDF). Aujourd'hui en base (BYTEA, table document) ; seul point d'accès
// au contenu, pour pouvoir migrer vers un stockage objet (S3 FR) sans toucher aux appelants.
// `db` : le pool ou un client pg en transaction.

const { sha256 } = require('./signatureCrypto');

async function put(db, { type, contenu, mime = 'application/pdf' }) {
  const hash = sha256(contenu);
  const { rows } = await db.query(
    `INSERT INTO document (type, mime, taille_octets, sha256, contenu)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [type, mime, contenu.length, hash, contenu]
  );
  return { id: rows[0].id, sha256: hash, tailleOctets: contenu.length };
}

async function get(db, id) {
  const { rows } = await db.query(
    'SELECT id, type, mime, taille_octets, sha256, contenu FROM document WHERE id = $1',
    [id]
  );
  if (!rows.length) return null;
  const d = rows[0];
  return { id: d.id, type: d.type, mime: d.mime, tailleOctets: d.taille_octets, sha256: d.sha256, contenu: d.contenu };
}

module.exports = { put, get };
