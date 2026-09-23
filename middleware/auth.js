const jwt = require('jsonwebtoken');

/**
 * Protege rutas de administrador. Exige un header:
 *   Authorization: Bearer <token>
 * El token se emite en /api/auth/login tras validar email+password.
 */
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'No autenticado. Falta el token de administrador.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = payload; // { id, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' });
  }
}

module.exports = { requireAdmin };
