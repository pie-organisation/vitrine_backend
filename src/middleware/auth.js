const jwt = require('jsonwebtoken');
const config = require('../config');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  const token = header.slice(7);
  try {
    const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.auth = {
      userId: claims.sub,
      ecoleId: claims.ecole_id,
      role: claims.role,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Rôle admin requis' });
  }
  next();
}

function generateJwt(user) {
  const exp = Math.floor(Date.now() / 1000) + config.jwtExpirationHours * 3600;
  return jwt.sign(
    { sub: user.id, ecole_id: user.ecole_id, role: user.role, exp },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );
}

function generateTempJwt(user) {
  const exp = Math.floor(Date.now() / 1000) + 48 * 3600;
  return jwt.sign(
    { sub: user.id, ecole_id: user.ecole_id, role: user.role, exp },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );
}

module.exports = { requireAuth, requireAdmin, generateJwt, generateTempJwt };
