const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db');
const { noActiveSession } = require('../middleware/sessionGuard');

// POST /sessions/open
router.post('/open', noActiveSession, async (req, res, next) => {
  try {
    const { ip_origine, appareil_os, type_session = 'normale' } = req.body;

    const { rows } = await pool.query(
      `SELECT l.id, l.nb_sessions_actives, tl.sessions_max
       FROM licence l
       JOIN type_licence tl ON tl.id = l.type_licence_id
       WHERE l.utilisateur_id = $1
         AND l.statut = 'assignee'
         AND (l.date_fin IS NULL OR l.date_fin >= CURRENT_DATE)`,
      [req.auth.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Aucune licence active pour cet utilisateur' });
    }
    const licence = rows[0];

    if (licence.sessions_max !== null && licence.nb_sessions_actives >= licence.sessions_max) {
      return res.status(409).json({ error: 'Le quota de sessions simultanées est atteint pour cette licence' });
    }

    const sessionId = randomUUID();
    const tokenSession = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO session (id, utilisateur_id, licence_id, token_session, ip_origine, appareil_os, statut, type_session)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [sessionId, req.auth.userId, licence.id, tokenSession, ip_origine || null, appareil_os || null, type_session]
      );
      await client.query(
        "UPDATE licence SET nb_sessions_actives = nb_sessions_actives + 1 WHERE id = $1",
        [licence.id]
      );
      await client.query(
        "INSERT INTO log_activite (session_id, action, details) VALUES ($1, 'connexion', $2)",
        [sessionId, appareil_os ? `OS: ${appareil_os}` : null]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    console.log(`Session ouverte : user=${req.auth.userId} session=${sessionId}`);
    res.json({ session_id: sessionId, token_session: tokenSession });
  } catch (err) { next(err); }
});

// POST /sessions/close
router.post('/close', async (req, res, next) => {
  try {
    const { session_id } = req.body;

    const { rows } = await pool.query(
      "SELECT id, licence_id FROM session WHERE id = $1 AND utilisateur_id = $2 AND statut = 'active'",
      [session_id, req.auth.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Session active introuvable' });
    }
    const session = rows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE session SET statut = 'terminee', date_fin = NOW() WHERE id = $1",
        [session.id]
      );
      await client.query(
        "UPDATE licence SET nb_sessions_actives = GREATEST(0, nb_sessions_actives - 1) WHERE id = $1",
        [session.licence_id]
      );
      await client.query(
        "INSERT INTO log_activite (session_id, action) VALUES ($1, 'deconnexion')",
        [session.id]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    console.log(`Session fermée : user=${req.auth.userId} session=${session.id}`);
    res.json({ message: 'Session terminée' });
  } catch (err) { next(err); }
});

module.exports = router;
