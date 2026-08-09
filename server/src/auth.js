import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// JWT_SECRET is loaded from server/.env by server.js via dotenv.config().
// If it is missing, we persist a generated secret to a local file so that
// tokens remain valid across server restarts / PC restarts (instead of a
// throwaway per-process secret that invalidates every session on reboot).
const SECRET_FILE = path.join(process.cwd(), 'data', '.jwt-secret');

function loadOrCreatePersistentSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  try {
    if (!fs.existsSync(path.dirname(SECRET_FILE))) {
      fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    }
    if (fs.existsSync(SECRET_FILE)) {
      const stored = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (stored) return stored;
    }
    const secret = 'pr_' + crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, secret);
    console.warn('🔑 Generated a persistent JWT secret (data/.jwt-secret). Sessions now survive restarts.');
    return secret;
  } catch (e) {
    console.warn('⚠️ JWT_SECRET not set and could not persist one; using deterministic fallback. Set JWT_SECRET in server/.env for production.');
    return 'pr_deterministic_fallback_' + crypto.createHash('sha256').update('pulseroom-stable-session-key').digest('hex').slice(0, 32);
  }
}

let dynamicSecret = loadOrCreatePersistentSecret();

const getJwtSecret = () => process.env.JWT_SECRET || dynamicSecret;

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
  if (!token) return { valid: false, error: 'Confirmation token is required.' };
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded && decoded.purpose === 'confirm_email' && decoded.email) {
      return { valid: true, email: decoded.email };
    }
    return { valid: false, error: 'Invalid confirmation token payload.' };
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

export { getJwtSecret };
