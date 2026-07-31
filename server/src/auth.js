import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const getJwtSecret = () => process.env.JWT_SECRET || 'pulseroom_super_secret_jwt_key_2026';

export async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
}

export async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    getJwtSecret(),
    { expiresIn: '30d' }
  );
}

export function generateConfirmationToken(email) {
  return jwt.sign(
    { email: email.trim().toLowerCase(), purpose: 'confirm_email' },
    getJwtSecret(),
    { expiresIn: '24h' }
  );
}

export function verifyConfirmationToken(token) {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded && decoded.purpose === 'confirm_email' && decoded.email) {
      return { valid: true, email: decoded.email };
    }
    return { valid: false, error: 'Invalid token payload.' };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required.' });
  }

  jwt.verify(token, getJwtSecret(), (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
}
