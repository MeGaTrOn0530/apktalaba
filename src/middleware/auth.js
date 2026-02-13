const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (process.env.ALLOW_DEV_TOKEN === 'true' && token.startsWith('test-')) {
    const role = token.replace('test-', '').trim();
    const ids = {
      super: '000000000000000000000001',
      admin: '000000000000000000000002',
      student: '000000000000000000000003',
    };
    if (role && ids[role]) {
      req.user = { id: ids[role], role };
      return next();
    }
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
};
