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
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
};
