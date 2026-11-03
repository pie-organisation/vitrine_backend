const pool = require('./db');

// Messagerie organisations <-> équipe Cubi, partagée par les routes /school et /admin.
// `viewer` vaut 'cubi' ou 'ecole' : il détermine quel indicateur "lu" s'applique.

const OBJET_MAX = 255;
const CONTENU_MAX = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return UUID_RE.test(s);
}

function formatDate(d) {
  return new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function serializeConversation(r, viewer) {
  return {
    id: r.id,
    organisationId: r.ecole_id,
    organisation: r.organisation,
    objet: r.objet,
    statut: r.statut,
    nonLu: viewer === 'cubi' ? !r.lu_par_cubi : !r.lu_par_ecole,
    dernierMessage: r.dernier_contenu || '',
    dernierAuteur: r.dernier_auteur_type,
    nbMessages: Number(r.nb_messages) || 0,
    date: formatDate(r.date_dernier_message),
  };
}

const CONVERSATION_SELECT = `
  SELECT c.*, e.nom_complet_ecole AS organisation,
         m.contenu AS dernier_contenu, m.auteur_type AS dernier_auteur_type,
         (SELECT COUNT(*) FROM message WHERE conversation_id = c.id) AS nb_messages
  FROM conversation c
  JOIN ecole e ON e.id = c.ecole_id
  LEFT JOIN LATERAL (
    SELECT contenu, auteur_type FROM message
    WHERE conversation_id = c.id
    ORDER BY date_envoi DESC LIMIT 1
  ) m ON TRUE`;

// ecoleId null = toutes les organisations (vue admin)
async function listConversations(viewer, ecoleId = null) {
  const { rows } = await pool.query(
    `${CONVERSATION_SELECT}
     WHERE ($1::uuid IS NULL OR c.ecole_id = $1)
     ORDER BY c.date_dernier_message DESC`,
    [ecoleId]
  );
  return rows.map(r => serializeConversation(r, viewer));
}

// Renvoie null si la conversation n'existe pas ou n'appartient pas à ecoleId.
// Ouvrir le fil le marque comme lu pour `viewer`.
async function getThread(id, viewer, ecoleId = null) {
  const { rows } = await pool.query(
    `${CONVERSATION_SELECT}
     WHERE c.id = $1 AND ($2::uuid IS NULL OR c.ecole_id = $2)`,
    [id, ecoleId]
  );
  if (!rows.length) return null;

  const luColumn = viewer === 'cubi' ? 'lu_par_cubi' : 'lu_par_ecole';
  await pool.query(`UPDATE conversation SET ${luColumn} = TRUE WHERE id = $1`, [id]);

  const { rows: messages } = await pool.query(
    `SELECT m.*,
            COALESCE(uc.prenom || ' ' || uc.nom, u.prenom || ' ' || u.nom) AS auteur_nom
     FROM message m
     LEFT JOIN utilisateur_cubi uc ON m.auteur_type = 'cubi'  AND uc.id = m.auteur_id
     LEFT JOIN utilisateur u       ON m.auteur_type = 'ecole' AND u.id  = m.auteur_id
     WHERE m.conversation_id = $1
     ORDER BY m.date_envoi`,
    [id]
  );

  return {
    ...serializeConversation({ ...rows[0], [luColumn]: true }, viewer),
    messages: messages.map(m => ({
      id: m.id,
      auteurType: m.auteur_type,
      auteurNom: m.auteur_nom || (m.auteur_type === 'cubi' ? 'Équipe Cubi' : 'Organisation'),
      contenu: m.contenu,
      date: formatDate(m.date_envoi),
    })),
  };
}

// Renvoie un message d'erreur de validation, ou null si les champs sont valides.
function validate({ objet, contenu }, { withObjet }) {
  if (withObjet && (!objet || !objet.trim())) return "L'objet est obligatoire.";
  if (withObjet && objet.trim().length > OBJET_MAX) return `L'objet ne doit pas dépasser ${OBJET_MAX} caractères.`;
  if (!contenu || !contenu.trim()) return 'Le message ne peut pas être vide.';
  if (contenu.trim().length > CONTENU_MAX) return `Le message ne doit pas dépasser ${CONTENU_MAX} caractères.`;
  return null;
}

async function insertMessage(client, conversationId, auteurType, auteurId, contenu) {
  await client.query(
    `INSERT INTO message (conversation_id, auteur_type, auteur_id, contenu)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, auteurType, auteurId, contenu.trim()]
  );
  // Un nouveau message de l'organisation rouvre la conversation côté Cubi.
  await client.query(
    `UPDATE conversation
     SET date_dernier_message = NOW(),
         lu_par_cubi  = $2,
         lu_par_ecole = $3,
         statut = CASE WHEN $2 THEN statut ELSE 'ouverte' END
     WHERE id = $1`,
    [conversationId, auteurType === 'cubi', auteurType === 'ecole']
  );
}

async function createConversation(ecoleId, auteurType, auteurId, objet, contenu) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO conversation (ecole_id, objet) VALUES ($1, $2) RETURNING id',
      [ecoleId, objet.trim()]
    );
    await insertMessage(client, rows[0].id, auteurType, auteurId, contenu);
    await client.query('COMMIT');
    return rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Renvoie false si la conversation n'existe pas ou n'appartient pas à ecoleId.
async function addMessage(conversationId, auteurType, auteurId, contenu, ecoleId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT 1 FROM conversation WHERE id = $1 AND ($2::uuid IS NULL OR ecole_id = $2) FOR UPDATE',
      [conversationId, ecoleId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return false;
    }
    await insertMessage(client, conversationId, auteurType, auteurId, contenu);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function setStatut(conversationId, statut) {
  const { rowCount } = await pool.query(
    'UPDATE conversation SET statut = $1, lu_par_cubi = TRUE WHERE id = $2',
    [statut, conversationId]
  );
  return rowCount > 0;
}

module.exports = {
  listConversations, getThread, createConversation, addMessage, setStatut, validate, isUuid,
};
