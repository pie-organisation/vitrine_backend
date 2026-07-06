const router = require('express').Router();
const pool = require('../db');

// GET /licences
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM licence WHERE ecole_id = $1 ORDER BY date_creation DESC",
      [req.auth.ecoleId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PATCH /licences/:id/assign
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const { utilisateur_id } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE licence SET utilisateur_id = $1, statut = 'assignee'
       WHERE id = $2 AND ecole_id = $3 AND statut = 'disponible'`,
      [utilisateur_id, req.params.id, req.auth.ecoleId]
    );
    if (rowCount === 0) {
      return res.status(404).json({
        error: "Licence introuvable, déjà assignée ou n'appartient pas à votre école",
      });
    }
    res.json({ message: 'Licence assignée avec succès' });
  } catch (err) { next(err); }
});

// PATCH /licences/:id/unassign
router.patch('/:id/unassign', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE licence SET utilisateur_id = NULL, statut = 'disponible', nb_sessions_actives = 0
       WHERE id = $1 AND ecole_id = $2 AND statut = 'assignee'`,
      [req.params.id, req.auth.ecoleId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Licence introuvable ou non assignée' });
    }
    res.json({ message: 'Licence libérée avec succès' });
  } catch (err) { next(err); }
});

module.exports = router;
