// Endpoints appelés par des services externes (cron), protégés par un secret partagé.
const router = require('express').Router();
const { rateLimit } = require('express-rate-limit');
const config = require('../config');
const { egaliteConstante } = require('../services/signatureCrypto');
const { jobQuotidien } = require('../services/jobQuotidien');

router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.appEnv === 'test',
  message: { error: 'Non autorisé' },
}));

// Toujours la même réponse, secret absent, faux ou non configuré : rien n'est révélé
function requireJobSecret(req, res, next) {
  if (!config.jobSecret) {
    console.warn('Appel de /internal refusé : JOB_SECRET n\'est pas configuré');
    return res.status(401).json({ error: 'Non autorisé' });
  }
  if (!egaliteConstante(req.get('X-Job-Secret') || '', config.jobSecret)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// POST /internal/jobs/quotidien — expiration J+14, relances J+3/J+7, rattrapage des activations, facturation
router.post('/jobs/quotidien', requireJobSecret, async (req, res, next) => {
  try {
    res.json(await jobQuotidien());
  } catch (err) {
    // Pas de message interne en réponse : le détail reste dans les logs
    console.error('Job quotidien en échec :', err);
    res.status(500).json({ error: 'Job en échec, voir les logs' });
  }
});

module.exports = router;
