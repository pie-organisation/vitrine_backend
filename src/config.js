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
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  appEnv: process.env.APP_ENV || 'development',
  appPort: parseInt(process.env.PORT || process.env.APP_PORT || '3000', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
};
