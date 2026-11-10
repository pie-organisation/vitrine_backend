// Routes publiques de signature, protégées par le token du lien (jamais loggé) et rate-limitées.
// CORS limité à FRONT_URL (voir app.js).

const router = require('express').Router();
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const config = require('../config');
const signature = require('../services/signature');

const limite = (limit) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.appEnv === 'test',
  message: { error: 'Trop de requêtes. Réessayez dans quelques minutes.' },
});
const limiteGenerale = limite(100);
const limiteSensible = limite(10);

router.use(limiteGenerale);

const contexte = req => ({ ip: req.ip || null, userAgent: (req.get('user-agent') || '').slice(0, 500) || null });

function envoyerPdf(res, nomFichier, contenu) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${nomFichier}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(contenu);
}

// Déclarée avant /:token pour ne pas être prise pour un token
router.get('/verifier/:preuveId', async (req, res, next) => {
  try {
    const preuve = await signature.verifier(req.params.preuveId);
    if (!preuve) return res.status(404).json({ error: 'Aucune signature ne correspond à cette référence.' });
    res.json(preuve);
  } catch (err) { next(err); }
});

router.get('/:token', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await signature.consulter(req.params.token, contexte(req)));
  } catch (err) { next(err); }
});

router.get('/:token/pdf', async (req, res, next) => {
  try {
    const { numero, contenu, signe } = await signature.pdf(req.params.token);
    envoyerPdf(res, `${numero}${signe ? '-signe' : ''}.pdf`, contenu);
  } catch (err) { next(err); }
});

router.post('/:token/otp', limiteSensible, async (req, res, next) => {
  try {
    res.json(await signature.envoyerOtp(req.params.token, contexte(req)));
  } catch (err) { next(err); }
});

const corpsSigner = z.object({
  otp: z.string().regex(/^\d{6}$/, 'Le code doit contenir 6 chiffres.'),
  signaturePng: z.string().max(300 * 1024, 'Image de signature trop lourde (200 Ko maximum).'),
  mention: z.string().max(100),
  acceptation: z.literal(true, { message: 'Vous devez accepter le contrat pour le signer.' }),
});

router.post('/:token/signer', limiteSensible, async (req, res, next) => {
  try {
    const parsed = corpsSigner.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ message: parsed.error.issues[0].message });
    res.json(await signature.signer(req.params.token, { ...parsed.data, ...contexte(req) }));
  } catch (err) {
    if (err.essaisRestants !== undefined) {
      return res.status(err.status).json({ message: err.message, essaisRestants: err.essaisRestants });
    }
    next(err);
  }
});

// Côté public, une erreur inattendue ne renvoie jamais son message interne.
// Convention du projet : { message } pour les 422 (affiché tel quel par le front), { error } sinon.
router.use((err, req, res, _next) => {
  if (err.status === 422) return res.status(422).json({ message: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (!err.status) console.error('Erreur signature :', err.message);
  res.status(err.status || 500).json({
    error: err.status ? err.message : 'Une erreur est survenue. Réessayez dans quelques minutes.',
  });
});

module.exports = router;
