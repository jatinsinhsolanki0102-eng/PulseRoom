import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Stable JWT secret that survives cold starts where possible (env JWT_SECRET is
// required for tokens to survive across real Vercel cold starts; locally we also
// persist a generated secret to disk so restarts do not invalidate sessions).
const _secretFile = path.join(process.cwd(), 'data', '.jwt-secret');
const _instanceJwtSecret = process.env.JWT_SECRET || (() => {
  try {
    if (!fs.existsSync(path.dirname(_secretFile))) fs.mkdirSync(path.dirname(_secretFile), { recursive: true });
    if (fs.existsSync(_secretFile)) {
      const stored = fs.readFileSync(_secretFile, 'utf8').trim();
      if (stored) return stored;
    }
    const secret = 'pr_' + crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(_secretFile, secret);
    return secret;
  } catch (e) {
    // No hardcoded fallback - a predictable secret lets anyone forge tokens.
    if (process.env.NODE_ENV === 'production') {
      console.error('JWT_SECRET is not set. Set it in the Vercel dashboard so sessions survive cold starts.');
    }
    return 'pr_' + crypto.randomBytes(32).toString('hex');
  }
})();
const getJwtSecret = () => _instanceJwtSecret;
const getSupabaseUrl = () => (process.env.SUPABASE_URL || 'https://jponpdmojuxxaecxgpgv.supabase.co').replace(/\/$/, '');
const getSupabaseAnonKey = () => process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impwb25wZG1vanV4eGFlY3hncGd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NjM2NzAsImV4cCI6MjEwMTAzOTY3MH0.hZI2QRFxU7ZHQ4FnH2pLnqQBA6BSUX3bih3WQRh6za4';

// Persistent Global Storage maps across Vercel serverless function invocations
const globalUsers = global._pulseroom_users || new Map();
const globalConfirmedEmails = global._pulseroom_confirmed || new Set();
const globalAccountStore = global._pulseroom_account_store || new Map();
const globalRooms = global._pulseroom_rooms || new Map();
const globalMessages = global._pulseroom_messages || new Map();
const globalStatuses = global._pulseroom_statuses || new Map();
const globalPendingInvites = global._pulseroom_pending_invites || new Map();
const globalE2EEKeys = global._pulseroom_e2ee_keys || new Map();

global._pulseroom_users = globalUsers;
global._pulseroom_confirmed = globalConfirmedEmails;
global._pulseroom_account_store = globalAccountStore;
global._pulseroom_rooms = globalRooms;
global._pulseroom_messages = globalMessages;
global._pulseroom_statuses = globalStatuses;
global._pulseroom_pending_invites = globalPendingInvites;
global._pulseroom_e2ee_keys = globalE2EEKeys;

function getSupabaseHeaders() {
  const key = getSupabaseAnonKey();
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

// Self-Contained Signed Token Helpers
// NOTE: never embed password hashes in the confirmation token - it is sent
// inside an email link. Identity is resolved from the signed payload + lookup.
function generateConfirmationToken(email, username) {
  return jwt.sign(
    {
      email: email.trim().toLowerCase(),
      username: username ? username.trim() : email.split('@')[0],
      purpose: 'confirm_email'
    },
    getJwtSecret(),
    { expiresIn: '72h' }
  );
}

function verifyConfirmationToken(token) {
  if (!token) return { valid: false, error: 'Confirmation token is required.' };
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded && decoded.purpose === 'confirm_email' && decoded.email) {
      return { valid: true, payload: decoded };
    }
    return { valid: false, error: 'Invalid token payload.' };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// Universal Registered Account Finder (Strict lookup of registered users only)
async function findUserByEmail(email) {
  if (!email) return null;
  const clean = email.trim().toLowerCase();

  for (const user of globalUsers.values()) {
    if (user.email && user.email.toLowerCase() === clean) return user;
  }

  if (globalAccountStore.has(clean)) {
    const user = globalAccountStore.get(clean);
    globalUsers.set(user.id, user);
    return user;
  }

  try {
    const res = await fetch(`${getSupabaseUrl()}/rest/v1/users?email=eq.${encodeURIComponent(clean)}&select=*`, {
      headers: getSupabaseHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        globalUsers.set(data[0].id, data[0]);
        globalAccountStore.set(clean, data[0]);
        return data[0];
      }
    }
  } catch (e) {
    console.warn('Supabase query warning:', e.message);
  }

  return null;
}

async function findUserById(id) {
  if (!id) return null;
  if (globalUsers.has(id)) return globalUsers.get(id);

  for (const user of globalAccountStore.values()) {
    if (user.id === id) return user;
  }

  try {
    const res = await fetch(`${getSupabaseUrl()}/rest/v1/users?id=eq.${encodeURIComponent(id)}&select=*`, {
      headers: getSupabaseHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        globalUsers.set(data[0].id, data[0]);
        globalAccountStore.set(data[0].email.toLowerCase(), data[0]);
        return data[0];
      }
    }
  } catch (e) {
    console.warn('Supabase findById warning:', e.message);
  }

  return globalUsers.get(id) || null;
}

async function createUser({ username, email, passwordHash, avatarUrl, bio, emailConfirmed = false }) {
  const cleanEmail = email.trim().toLowerCase();
  const existing = await findUserByEmail(cleanEmail);
  if (existing) {
    if (username && username.trim()) existing.username = username.trim();
    existing.email_confirmed = Boolean(emailConfirmed || existing.email_confirmed);
    if (passwordHash) existing.password_hash = passwordHash;
    globalUsers.set(existing.id, existing);
    globalAccountStore.set(cleanEmail, existing);
    return existing;
  }

  const id = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(7);
  const isConfirmed = Boolean(emailConfirmed || globalConfirmedEmails.has(cleanEmail));
  const finalUsername = (username && username.trim()) ? username.trim() : cleanEmail.split('@')[0];

  const user = {
    id,
    username: finalUsername,
    email: cleanEmail,
    password_hash: passwordHash,
    avatar_url: avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${finalUsername}`,
    bio: bio || 'Available on PulseRoom',
    email_confirmed: isConfirmed,
    status: 'online',
    created_at: new Date().toISOString()
  };

  globalUsers.set(id, user);
  globalAccountStore.set(cleanEmail, user);

  try {
    await fetch(`${getSupabaseUrl()}/rest/v1/users`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify(user)
    });
  } catch (e) {
    console.warn('Supabase insert user error:', e.message);
  }

  return user;
}

async function markEmailConfirmed(email) {
  const clean = email.trim().toLowerCase();
  globalConfirmedEmails.add(clean);

  let user = await findUserByEmail(clean);
  if (user) {
    user.email_confirmed = true;
    globalUsers.set(user.id, user);
    globalAccountStore.set(clean, user);

    try {
      await fetch(`${getSupabaseUrl()}/rest/v1/users?email=eq.${encodeURIComponent(clean)}`, {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({ email_confirmed: true })
      });
    } catch (e) {
      console.warn('Supabase patch email error:', e.message);
    }
  }
}

async function resetUserPassword(email, newPasswordHash) {
  const clean = email.trim().toLowerCase();
  let user = await findUserByEmail(clean);
  if (user) {
    user.password_hash = newPasswordHash;
    globalUsers.set(user.id, user);
    globalAccountStore.set(clean, user);

    try {
      await fetch(`${getSupabaseUrl()}/rest/v1/users?email=eq.${encodeURIComponent(clean)}`, {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({ password_hash: newPasswordHash })
      });
    } catch (e) {
      console.warn('Supabase reset password error:', e.message);
    }
  }
  return user;
}

// Universal Multi-Provider Email Dispatcher (Gmail SMTP Priority #1)
async function sendEmail({ to, subject, htmlText, plainText }) {
  const gmailUser = (process.env.GMAIL_USER || '').trim();
  const gmailPass = (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '');
  const resendKey = (process.env.RESEND_API_KEY || '').trim();

  let lastError = '';

  // Priority 1: Direct Gmail SMTP Engine (Universal Delivery to ANY Email Address)
  if (gmailUser && gmailPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: gmailUser, pass: gmailPass }
      });

      const info = await transporter.sendMail({
        from: `"PulseRoom Messenger" <${gmailUser}>`,
        to,
        subject,
        text: plainText,
        html: htmlText
      });

      if (info && info.messageId) {
        return { success: true, provider: 'gmail', messageId: info.messageId };
      }
    } catch (gErr) {
      console.error('Gmail Direct SMTP Error:', gErr.message);
      lastError = gErr.message;
    }
  }

  // Priority 2: Resend API Fallback
  if (resendKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'PulseRoom Messenger <onboarding@resend.dev>',
          to: [to],
          subject,
          html: htmlText,
          text: plainText
        })
      });
      const resData = await response.json();
      if (response.ok && resData.id) {
        return { success: true, provider: 'resend', messageId: resData.id };
      }
      if (resData.message) lastError = resData.message;
    } catch (err) {
      console.warn('Resend exception:', err.message);
    }
  }

  return { success: false, error: lastError || 'Email dispatch failed. Please verify mail configuration.' };
}

// Express App
const app = express();
app.set('trust proxy', 1);

// Simple in-memory rate limiter (per IP)
const rateBuckets = new Map();
function rateLimit({ windowMs, max, name = 'rl' }) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (now > b.resetAt) rateBuckets.delete(k);
  }
}, 60000);

// CORS - restrict to the configured frontend origin(s)
const allowedOrigins = (process.env.CLIENT_URL || '').split(',').map(s => s.trim()).filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn('⚠️  CLIENT_URL is not set - CORS will allow all origins. Set CLIENT_URL in the Vercel dashboard for production.');
}
app.use(cors({
  origin: allowedOrigins.length > 0
    ? (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
      }
    : true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100kb' }));

// In-memory upload buffer (serverless deployments cannot persist files to disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required.' });

  jwt.verify(token, getJwtSecret(), (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'PulseRoom Vercel Engine',
    gmailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASS),
    usersCount: globalAccountStore.size,
    timestamp: new Date().toISOString()
  });
});

// 1. Sign Up Endpoint (Preserves Username)
app.post('/api/auth/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'register' }), async (req, res) => {
  try {
    const { username, email, password, avatarUrl, bio } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = await findUserByEmail(cleanEmail);
    if (existing && existing.email_confirmed) {
      return res.status(400).json({ error: 'Account with this email already exists. Please log in.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    await createUser({
      username: username.trim(),
      email: cleanEmail,
      passwordHash,
      avatarUrl,
      bio,
      emailConfirmed: false
    });

    const hostUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const confirmToken = generateConfirmationToken(cleanEmail, username.trim());
    const confirmLink = `${hostUrl}/api/auth/confirm-email?token=${confirmToken}&email=${encodeURIComponent(cleanEmail)}`;

    const htmlText = `
      <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #10b981;">PulseRoom</h1>
        <p>Hello <strong>${username.trim()}</strong>,</p>
        <p>Please click below to confirm your email address and activate your account:</p>
        <a href="${confirmLink}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 15px 0;">Confirm Email Address</a>
      </div>
    `;

    const sendRes = await sendEmail({
      to: cleanEmail,
      subject: `Confirm your PulseRoom email address`,
      plainText: `Confirm your email: ${confirmLink}`,
      htmlText
    });

    if (!sendRes.success) {
      await markEmailConfirmed(cleanEmail);
      await createUser({
        username: username.trim(),
        email: cleanEmail,
        passwordHash,
        avatarUrl,
        bio,
        emailConfirmed: true
      });
      return res.status(201).json({
        message: `Account created successfully! Your email (${cleanEmail}) has been auto-activated. You can log in directly!`,
        email: cleanEmail,
        autoConfirmed: true
      });
    }

    return res.status(201).json({
      message: `Confirmation email dispatched to ${cleanEmail}. Please check your inbox to confirm before logging in!`,
      email: cleanEmail,
      sendResult: sendRes
    });
  } catch (err) {
    console.error('Vercel Register Error:', err);
    return res.status(500).json({ error: 'Failed to create account on Vercel.' });
  }
});

// 2. Resend Confirmation Email Endpoint
app.post('/api/auth/resend-confirmation', rateLimit({ windowMs: 60 * 60 * 1000, max: 5, name: 'resend-confirm' }), async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    const cleanEmail = email.trim().toLowerCase();
    let user = await findUserByEmail(cleanEmail);
    if (!user) return res.status(404).json({ error: 'No account found with this email address.' });
    if (user.email_confirmed || globalConfirmedEmails.has(cleanEmail)) {
      return res.status(400).json({ error: 'This email address is already confirmed. Please log in.' });
    }

    const hostUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const confirmToken = generateConfirmationToken(cleanEmail, user.username);
    const confirmLink = `${hostUrl}/api/auth/confirm-email?token=${confirmToken}&email=${encodeURIComponent(cleanEmail)}`;

    const htmlText = `
      <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #10b981;">PulseRoom</h1>
        <p>Hello <strong>${user.username}</strong>,</p>
        <p>Click below to confirm your email address and activate your account:</p>
        <a href="${confirmLink}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 15px 0;">Confirm Email Address</a>
      </div>
    `;

    const sendRes = await sendEmail({
      to: cleanEmail,
      subject: `Confirm your PulseRoom email address`,
      plainText: `Confirm your email: ${confirmLink}`,
      htmlText
    });

    if (!sendRes.success) {
      return res.status(500).json({ error: sendRes.error || 'Failed to send confirmation email.' });
    }

    return res.json({ message: `Confirmation email re-dispatched to ${cleanEmail}. Check your inbox!` });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to resend confirmation email.' });
  }
});

// 3. Email Confirmation Callback Endpoint (Activates Account)
app.get('/api/auth/confirm-email', async (req, res) => {
  try {
    const { token, email } = req.query || {};
    if (!email) return res.status(400).send('Email parameter missing.');

    const cleanEmail = email.trim().toLowerCase();

    if (!token) {
      return res.status(400).send('Confirmation token missing. Please use the link sent to your email.');
    }

    const verification = verifyConfirmationToken(token);
    if (!verification.valid || verification.payload?.email !== cleanEmail) {
      return res.status(400).send('Invalid or expired confirmation link.');
    }

    const { username } = verification.payload || {};

    // The account already exists from register; just mark it confirmed.
    // Never re-create with a dummy password hash.
    await markEmailConfirmed(cleanEmail);
    await findUserByEmail(cleanEmail);

    // Auto-connect pending friend invitations so the inviter's chat room opens automatically
    const confirmedUser = await findUserByEmail(cleanEmail);
    const pendingInviterIds = globalPendingInvites.get(cleanEmail) || [];
    for (const inviterId of pendingInviterIds) {
      if (confirmedUser && inviterId === confirmedUser.id) continue;
      const roomId = 'room_' + [inviterId, confirmedUser?.id].sort().join('_');
      const room = {
        id: roomId,
        type: 'private',
        cleared_by: [],
        partner: confirmedUser ? { id: confirmedUser.id, username: confirmedUser.username || cleanEmail.split('@')[0], avatar_url: confirmedUser.avatar_url, bio: confirmedUser.bio } : null,
        members: [{ id: inviterId }, { id: confirmedUser?.id }]
      };
      globalRooms.set(roomId, room);
    }
    globalPendingInvites.delete(cleanEmail);

    const clientUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    res.send(`
      <html>
        <head><title>Email Confirmed - PulseRoom</title></head>
        <body style="background: #0b0f19; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
          <div style="background: #0f172a; border: 1px solid #10b981; padding: 2.5rem; border-radius: 20px; text-align: center; max-width: 400px;">
            <h2 style="color: #10b981;">⚡ Email Confirmed!</h2>
            <p>Your PulseRoom account (<strong>${cleanEmail}</strong>) is now fully active. Return to the app and sign in with your email and password.</p>
            <a href="${clientUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 10px 0;">Return to PulseRoom Login</a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to confirm email.');
  }
});

// 4. Login Endpoint (Preserves Username - NEVER auto-creates accounts)
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, name: 'login' }), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await findUserByEmail(cleanEmail);

    if (!user) {
      return res.status(401).json({ error: 'No account found with this email. Please sign up first.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password. Please try again or use "Forgot Password?".' });
    }

    if (!user.email_confirmed && !globalConfirmedEmails.has(cleanEmail)) {
      return res.status(403).json({ error: 'Please confirm your email address first before logging in.' });
    }

    user.email_confirmed = true;
    globalConfirmedEmails.add(cleanEmail);

    const { password_hash, ...safeUser } = user;
    const token = jwt.sign(
      { id: safeUser.id, username: safeUser.username, email: safeUser.email },
      getJwtSecret(),
      { expiresIn: '30d' }
    );

    return res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login Endpoint Error:', err);
    return res.status(500).json({ error: 'Server error during login.' });
  }
});

// 5. Password Reset
app.post('/api/auth/forgot-password', rateLimit({ windowMs: 60 * 60 * 1000, max: 5, name: 'forgot-pw' }), async (req, res) => {
  try {
    const { email, newPassword } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    const cleanEmail = email.trim().toLowerCase();
    let user = await findUserByEmail(cleanEmail);
    if (!user) return res.status(404).json({ error: 'No account registered with this email address.' });

    if (newPassword) {
      const salt = await bcrypt.genSalt(10);
      const newHash = await bcrypt.hash(newPassword, salt);
      await resetUserPassword(cleanEmail, newHash);
      return res.json({ message: 'Password updated successfully! You can now log in with your new password.' });
    }
    return res.json({ message: 'Account found.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process password reset.' });
  }
});

// 6. User Profile Endpoints
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: 'Account not found. Please sign up again.' });
    }
    const { password_hash, ...safe } = user;
    return res.json(safe);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const { username, avatarUrl, bio } = req.body || {};
    let user = await findUserById(req.user.id);
    if (!user) {
      user = { id: req.user.id, email: req.user.email, username: req.user.username };
    }

    if (username) user.username = username.trim();
    if (avatarUrl) user.avatar_url = avatarUrl;
    if (bio !== undefined) user.bio = bio.trim();

    globalUsers.set(user.id, user);
    if (user.email) globalAccountStore.set(user.email.toLowerCase(), user);

    const { password_hash, ...safe } = user;
    return res.json(safe);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const users = Array.from(globalAccountStore.values())
      .filter(u => u.id !== req.user.id)
      .map(({ password_hash, ...safe }) => safe);
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

app.put('/api/users/theme', authenticateToken, async (req, res) => {
  try {
    return res.json({ theme_preferences: req.body });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update theme.' });
  }
});

// 7. Rooms & Groups Endpoints
app.get('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const rooms = Array.from(globalRooms.values()).filter(r =>
      r.members && r.members.some(m => m.id === req.user.id) &&
      !(r.cleared_by || []).includes(req.user.id)
    );
    return res.json(rooms);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch rooms.' });
  }
});

app.post('/api/rooms/private', authenticateToken, async (req, res) => {
  try {
    const { targetUserId } = req.body || {};
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required.' });

    const me = await findUserById(req.user.id);
    const partner = await findUserById(targetUserId);

    const roomId = 'room_' + [req.user.id, targetUserId].sort().join('_');
    let room = globalRooms.get(roomId);

    if (!room) {
      room = {
        id: roomId,
        type: 'private',
        cleared_by: [],
        partner: partner ? { id: partner.id, username: partner.username || partner.email?.split('@')[0] || 'Friend', avatar_url: partner.avatar_url, bio: partner.bio } : { id: targetUserId, username: 'Friend' },
        members: [{ id: req.user.id }, { id: targetUserId }],
        created_at: new Date().toISOString()
      };
      globalRooms.set(roomId, room);
    }
    return res.json(room);
  } catch (err) {
    console.error('Initiate room error:', err);
    return res.status(500).json({ error: 'Failed to initiate room.' });
  }
});

app.post('/api/rooms/group', authenticateToken, async (req, res) => {
  try {
    const { name, description, avatarUrl, themeColor, members } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Group name is required.' });

    const roomId = 'group_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    const allMemberIds = Array.from(new Set([req.user.id, ...(members || [])]));

    const room = {
      id: roomId,
      type: 'group',
      name,
      description,
      avatar_url: avatarUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`,
      theme_color: themeColor || '#128c7e',
      created_by: req.user.id,
      cleared_by: [],
      members: allMemberIds.map(id => ({ id })),
      created_at: new Date().toISOString()
    };

    globalRooms.set(roomId, room);
    return res.status(201).json(room);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create group.' });
  }
});

app.post('/api/rooms/bridge', authenticateToken, async (req, res) => {
  try {
    const { sourceRoomId, targetRoomId } = req.body || {};
    const bridgeId = 'bridge_' + Date.now();
    return res.status(201).json({ id: bridgeId, sourceRoomId, targetRoomId, createdBy: req.user.id });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create room bridge.' });
  }
});

app.put('/api/rooms/:roomId/pin', authenticateToken, async (req, res) => {
  try {
    const room = globalRooms.get(req.params.roomId);
    if (room) {
      room.is_pinned = !room.is_pinned;
      return res.json({ is_pinned: room.is_pinned });
    }
    return res.json({ is_pinned: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to pin chat.' });
  }
});

app.post('/api/rooms/:roomId/members', authenticateToken, async (req, res) => {
  try {
    const room = globalRooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found.' });

    if (!room.members || !room.members.some(m => m.id === req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }

    const { memberIds } = req.body || {};
    const ids = Array.isArray(memberIds) ? memberIds : [];
    const existing = new Set((room.members || []).map(m => m.id));

    for (const id of ids) {
      if (!existing.has(id)) {
        room.members.push({ id });
        existing.add(id);
      }
    }

    return res.json(room);
  } catch (err) {
    console.error('Add room members error:', err);
    return res.status(500).json({ error: 'Failed to add members.' });
  }
});

// WhatsApp-style "Clear chat": clears ALL messages for THIS user only (chat stays in list).
app.post('/api/rooms/:roomId/clear', authenticateToken, async (req, res) => {
  try {
    const room = globalRooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found.' });

    if (!room.members || !room.members.some(m => m.id === req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }

    const msgs = globalMessages.get(req.params.roomId) || [];
    for (const msg of msgs) {
      if (!msg.deleted_for) msg.deleted_for = [];
      if (!msg.deleted_for.includes(req.user.id)) msg.deleted_for.push(req.user.id);
    }

    return res.json({ message: 'Chat cleared for you only.' });
  } catch (err) {
    console.error('Clear room error:', err);
    return res.status(500).json({ error: 'Failed to clear chat.' });
  }
});

// WhatsApp-style "Delete chat": removes the chat from THIS user's list only.
app.delete('/api/rooms/:roomId', authenticateToken, async (req, res) => {
  try {
    const room = globalRooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found.' });

    if (!room.members || !room.members.some(m => m.id === req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }

    if (!room.cleared_by) room.cleared_by = [];
    if (!room.cleared_by.includes(req.user.id)) room.cleared_by.push(req.user.id);

    const msgs = globalMessages.get(req.params.roomId) || [];
    for (const msg of msgs) {
      if (!msg.deleted_for) msg.deleted_for = [];
      if (!msg.deleted_for.includes(req.user.id)) msg.deleted_for.push(req.user.id);
    }

    return res.json({ message: 'Chat deleted for you only.' });
  } catch (err) {
    console.error('Delete room error:', err);
    return res.status(500).json({ error: 'Failed to delete chat.' });
  }
});

// 8. Messages REST Endpoints
app.get('/api/rooms/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const room = globalRooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    if (!room.members || !room.members.some(m => m.id === req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }
    const msgs = (globalMessages.get(req.params.roomId) || [])
      .filter(m => !(m.deleted_for || []).includes(req.user.id));
    return res.json(msgs);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch room messages.' });
  }
});

app.post('/api/messages', authenticateToken, async (req, res) => {
  try {
    const { roomId, text, type, mediaUrl, replyToId, e2ee } = req.body || {};
    if (!roomId) return res.status(400).json({ error: 'roomId is required.' });
    // E2EE envelopes carry base64 ciphertext + key material, so allow more room.
    const maxLen = e2ee ? 30000 : 5000;
    if (text && String(text).length > maxLen) {
      return res.status(400).json({ error: `Message is too long (max ${maxLen} characters).` });
    }

    const room = globalRooms.get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    if (!room.members || !room.members.some(m => m.id === req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }

    const user = await findUserById(req.user.id);
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    const message = {
      id: msgId,
      room_id: roomId,
      sender_id: req.user.id,
      username: user ? user.username : req.user.username || 'User',
      avatar_url: user ? user.avatar_url : '',
      sender_name: user ? user.username : req.user.username || 'User',
      sender_avatar: user ? user.avatar_url : '',
      text,
      type: type || 'text',
      media_url: mediaUrl,
      reply_to_id: replyToId,
      e2ee: Boolean(e2ee),
      deleted_for: [],
      created_at: new Date().toISOString()
    };

    if (!globalMessages.has(roomId)) {
      globalMessages.set(roomId, []);
    }
    globalMessages.get(roomId).push(message);

    return res.status(201).json(message);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send message.' });
  }
});

// WhatsApp-style end-to-end encryption key exchange (public keys ONLY - private
// keys never leave the client; the server only relays ciphertext it cannot read).
// Signed identity bundles: clients upload the ECDH identity public key plus an
// ECDSA signature binding it to their userId. Recipients verify this signature
// before trusting any message, so swapped/tampered keys are detected.
app.put('/api/e2ee/keys', authenticateToken, async (req, res) => {
  try {
    const { publicKey, signPublicKey, signature, signedPrekey } = req.body || {};
    if (!publicKey || typeof publicKey !== 'string') {
      return res.status(400).json({ error: 'publicKey is required.' });
    }
    const record = {
      user_id: req.user.id,
      public_key: publicKey,
      signed_prekey: signedPrekey || '',
      sign_public_key: signPublicKey || '',
      signature: signature || ''
    };
    globalE2EEKeys.set(req.user.id, record);
    return res.json(record);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to store encryption key.' });
  }
});

app.get('/api/e2ee/keys/:userId', authenticateToken, async (req, res) => {
  try {
    const key = globalE2EEKeys.get(req.params.userId);
    if (!key) return res.status(404).json({ error: 'No encryption key found for this user yet.' });
    return res.json(key);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch encryption key.' });
  }
});

// WhatsApp-style "Delete for me": hides the message ONLY for the requesting user.
app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    for (const msgs of globalMessages.values()) {
      const msg = msgs.find(m => m.id === req.params.messageId);
      if (msg) {
        if (!msg.deleted_for) msg.deleted_for = [];
        if (!msg.deleted_for.includes(req.user.id)) msg.deleted_for.push(req.user.id);
        return res.json({ message: 'Message deleted for you.', payload: { messageId: req.params.messageId, userId: req.user.id } });
      }
    }
    return res.status(404).json({ error: 'Message not found.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete message.' });
  }
});

// 8b. Upload Endpoint (returns an in-memory data URL since serverless has no persistent disk)
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const mime = req.file.mimetype || 'application/octet-stream';
    const dataUrl = `data:${mime};base64,${req.file.buffer.toString('base64')}`;
    const mediaType = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';
    return res.json({ mediaUrl: dataUrl, mediaType });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process upload.' });
  }
});

// 9. Statuses Endpoints
app.get('/api/statuses', authenticateToken, async (req, res) => {
  try {
    const statuses = Array.from(globalStatuses.values());
    return res.json(statuses);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch statuses.' });
  }
});

app.post('/api/statuses', authenticateToken, async (req, res) => {
  try {
    const { text, mediaUrl, mediaType, bgColor } = req.body || {};
    const user = await findUserById(req.user.id);
    const id = 'st_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    const status = {
      id,
      user_id: req.user.id,
      username: user ? user.username : 'User',
      avatar_url: user ? user.avatar_url : '',
      text,
      media_url: mediaUrl,
      media_type: mediaType || 'image',
      bg_color: bgColor || '#128c7e',
      created_at: new Date().toISOString()
    };

    globalStatuses.set(id, status);
    return res.status(201).json(status);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create status.' });
  }
});

app.delete('/api/statuses/:statusId', authenticateToken, async (req, res) => {
  try {
    const status = globalStatuses.get(req.params.statusId);
    if (status) {
      if (status.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized.' });
      }
      globalStatuses.delete(req.params.statusId);
      return res.json({ message: 'Status deleted.' });
    }
    return res.status(404).json({ error: 'Status not found.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete status.' });
  }
});

// 10. Friends Invite Endpoint (Strict Registered Check)
app.post('/api/friends/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    const cleanEmail = email.trim().toLowerCase();
    
    // Check if target user is ALREADY REGISTERED in the system
    let targetUser = null;
    if (globalAccountStore.has(cleanEmail)) {
      targetUser = globalAccountStore.get(cleanEmail);
    } else {
      for (const u of globalUsers.values()) {
        if (u.email && u.email.toLowerCase() === cleanEmail) {
          targetUser = u;
          break;
        }
      }
    }

    // ONLY IF FRIEND IS ALREADY REGISTERED & CONFIRMED:
    if (targetUser && targetUser.email_confirmed) {
      const roomId = 'room_' + [req.user.id, targetUser.id].sort().join('_');
      const me = await findUserById(req.user.id);
      const room = {
        id: roomId,
        type: 'private',
        cleared_by: [],
        partner: { id: targetUser.id, username: targetUser.username || cleanEmail.split('@')[0], avatar_url: targetUser.avatar_url, bio: targetUser.bio },
        members: [{ id: req.user.id }, { id: targetUser.id }]
      };
      globalRooms.set(roomId, room);

      return res.json({
        status: 'user_found',
        message: `Found registered user ${targetUser.username}! Opening chat...`,
        room
      });
    } else {
      // UNREGISTERED USER: Send invitation email ONLY! DO NOT OPEN CHAT!
      const hostUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const htmlText = `
        <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
          <h1 style="color: #10b981;">PulseRoom</h1>
          <p>Hello,</p>
          <p>Your friend <strong>${req.user.username}</strong> (${req.user.email}) invited you to join PulseRoom Messenger!</p>
          <p>Click below to sign up and create your account to start chatting:</p>
          <a href="${hostUrl}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 15px 0;">Accept Invitation & Create Account</a>
        </div>
      `;

      const result = await sendEmail({
        to: cleanEmail,
        subject: `Your friend ${req.user.username} invited you to join PulseRoom Messenger!`,
        plainText: `Your friend ${req.user.username} invited you: ${hostUrl}`,
        htmlText
      });

      // Record the pending invitation so the private chat auto-connects once they sign up & confirm
      if (!globalPendingInvites.has(cleanEmail)) globalPendingInvites.set(cleanEmail, []);
      if (!globalPendingInvites.get(cleanEmail).includes(req.user.id)) {
        globalPendingInvites.get(cleanEmail).push(req.user.id);
      }

      if (!result.success) {
        return res.json({
          status: 'invited_pending',
          message: `Invitation saved for ${cleanEmail}, but the email could not be sent right now (mail service unavailable). The chat will open automatically once they sign up.`
        });
      }

      return res.json({
        status: 'invited',
        message: `Invitation email dispatched to ${cleanEmail}! Your chat room will open automatically once they sign up and confirm their email.`
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send friend invitation.' });
  }
});

// Fallback Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Vercel Express Error:', err);
  res.status(500).json({ error: err.message || 'An unexpected server error occurred on Vercel.' });
});

export default app;
