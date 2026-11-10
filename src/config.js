require('dotenv').config();

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Variable d'environnement manquante : ${key}`);
  return val;
}

module.exports = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpirationHours: parseInt(process.env.JWT_EXPIRATION_HOURS || '24', 10),
  brevoApiKey: process.env.BREVO_API_KEY || '',
  emailFrom: process.env.SMTP_FROM || '',
  appEnv: process.env.APP_ENV || 'development',
  appPort: parseInt(process.env.PORT || process.env.APP_PORT || '3000', 10),
  // FRONT_URL (FRONTEND_URL accepté pour compatibilité), sans slash final : sert aussi d'origine CORS exacte
  frontendUrl: (process.env.FRONT_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  // Origines supplémentaires autorisées en CORS sur /signature (ex. http://localhost:5173 pour tester un front
  // local contre l'API déployée), séparées par des virgules. Vide = FRONT_URL seule. Les liens e-mail restent sur FRONT_URL.
  signatureCorsExtra: (process.env.SIGNATURE_CORS_EXTRA || '')
    .split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean),
  // Secret du endpoint POST /internal/jobs/quotidien (header X-Job-Secret). Vide = endpoint désactivé
  jobSecret: process.env.JOB_SECRET || '',
  // Frais de mise en service HT ajoutés à la première facture d'un contrat (0 = aucune ligne)
  fraisMiseEnServiceCentimes: Math.max(0, parseInt(process.env.FRAIS_MISE_EN_SERVICE_CENTIMES || '0', 10) || 0),
  // 'brevo' (défaut) ou 'memoire' (tests : les e-mails sont gardés en mémoire, rien n'est envoyé)
  emailTransport: process.env.EMAIL_TRANSPORT || 'brevo',
};
