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
      type: claims.type,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireCubi(...roles) {
  return (req, res, next) => {
    if (!req.auth || req.auth.type !== 'cubi' || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Accès équipe Cubi requis' });
    }
    next();
  };
}

function requireEcoleAdmin(req, res, next) {
  if (!req.auth || req.auth.type !== 'ecole' || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Rôle admin école requis' });
  }
  next();
}

function generateJwt(user, type) {
  const exp = Math.floor(Date.now() / 1000) + config.jwtExpirationHours * 3600;
  return jwt.sign(
    { sub: user.id, ecole_id: user.ecole_id || null, role: user.role, type, exp },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );
}

function generateTempJwt(user, type) {
  const exp = Math.floor(Date.now() / 1000) + 48 * 3600;
  return jwt.sign(
    { sub: user.id, ecole_id: user.ecole_id || null, role: user.role, type, exp },
    config.jwtSecret,
    { algorithm: 'HS256' }
  );
}

module.exports = { requireAuth, requireCubi, requireEcoleAdmin, generateJwt, generateTempJwt };
