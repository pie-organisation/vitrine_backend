const pool = require('../db');

async function noActiveSession(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*) FROM session WHERE utilisateur_id = $1 AND statut = 'active'",
      [req.auth.userId]
    );
    if (parseInt(rows[0].count, 10) > 0) {
      return res.status(409).json({ error: 'Une session est déjà active pour cet utilisateur' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { noActiveSession };
