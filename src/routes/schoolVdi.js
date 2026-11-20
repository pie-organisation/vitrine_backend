// /school/vdi : connexion automatique au service « postes de travail » (API Go).
// L'admin enregistre une fois les identifiants du compte staff de l'école ; ensuite le front
// demande un jeton ici avec sa seule session Cubi. Le mot de passe n'est jamais renvoyé.
const router = require('express').Router();
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const pool = require('../db');
const config = require('../config');
const vdi = require('../services/vdi');

const limite = (limit) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.appEnv === 'test',
  message: { error: 'Trop de tentatives. Réessayez dans quelques minutes.' },
});

const schemaIdentifiants = z.object({
  email: z.string().trim().email().max(255),
  mot_de_passe: z.string().min(1).max(512),
});

router.use((req, res, next) => {
  if (!req.auth.ecoleId) return res.status(403).json({ error: 'Aucune école rattachée à ce compte.' });
  if (!vdi.estConfigure()) {
    return res.status(503).json({ error: "Le service des postes de travail n'est pas configuré." });
  }
  next();
});

const envoyerErreur = (res, err, next) =>
  // `message` en plus de `error` : le front affiche `message` sur les 422
  err instanceof vdi.VdiError ? res.status(err.status).json({ error: err.message, message: err.message }) : next(err);

/** État : identifiants enregistrés ou non (e-mail seulement). */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, date_maj FROM vdi_identifiants WHERE ecole_id = $1',
      [req.auth.ecoleId]
    );
    res.json(rows.length
      ? { configure: true, email: rows[0].email, date_maj: rows[0].date_maj }
      : { configure: false });
  } catch (err) { next(err); }
});

/** Enregistre (ou remplace) les identifiants après les avoir vérifiés auprès de l'API Go. */
router.put('/', limite(10), async (req, res, next) => {
  const parsed = schemaIdentifiants.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ message: 'E-mail et mot de passe requis.' });
  const { email, mot_de_passe } = parsed.data;
  try {
    const token = await vdi.connecter(email, mot_de_passe);
    await pool.query(
      `INSERT INTO vdi_identifiants (ecole_id, email, mot_de_passe_chiffre, date_maj)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (ecole_id) DO UPDATE
         SET email = EXCLUDED.email, mot_de_passe_chiffre = EXCLUDED.mot_de_passe_chiffre, date_maj = NOW()`,
      [req.auth.ecoleId, email, vdi.chiffrer(mot_de_passe)]
    );
    res.json({ token, email });
  } catch (err) { envoyerErreur(res, err, next); }
});

/** Jeton de l'API Go obtenu avec les identifiants enregistrés. 404 si rien n'est enregistré. */
router.post('/token', limite(60), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, mot_de_passe_chiffre FROM vdi_identifiants WHERE ecole_id = $1',
      [req.auth.ecoleId]
    );
    if (!rows.length) return res.status(404).json({ error: 'vdi_non_configure' });
    let motDePasse;
    try {
      motDePasse = vdi.dechiffrer(rows[0].mot_de_passe_chiffre);
    } catch {
      // Clé VDI_SECRET_KEY changée : il faut ressaisir les identifiants
      return res.status(422).json({ message: 'Identifiants des postes de travail à ressaisir.' });
    }
    const token = await vdi.connecter(rows[0].email, motDePasse);
    res.json({ token, email: rows[0].email });
  } catch (err) { envoyerErreur(res, err, next); }
});

/** Oublie les identifiants (changement de compte). */
router.delete('/', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM vdi_identifiants WHERE ecole_id = $1', [req.auth.ecoleId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
