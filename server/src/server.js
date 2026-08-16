import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import dns from 'node:dns';
import net from 'node:net';

import { initDb, db } from './db.js';
import { hashPassword, comparePassword, generateToken, generateConfirmationToken, verifyConfirmationToken, authenticateToken } from './auth.js';
import { setupSocketHandlers, notifyRoomCreated } from './socketHandler.js';
import { sendPushToRoom, vapidPublicKey } from './push.js';
import { verifySignedIdentity } from './e2eeVerify.js';

dotenv.config();

// Simple in-memory rate limiter (per IP). Single-instance deployments are
// fine; scale out to Redis when running many server instances.
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

async function isRoomMember(roomId, userId) {
  const memberIds = await db.getRoomMemberIds(roomId);
  return memberIds.includes(userId);
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// Behind a reverse proxy (Railway / Render / Nginx / Vercel) trust the first
// hop so req.ip reflects the real client for rate limiting.
app.set('trust proxy', 1);

// Force IPv4-first DNS resolution. smtp.gmail.com (and other dual-stack hosts)
// resolve to IPv6 first, and hosts without an IPv6 route (Render free tier)
// hit ENETUNREACH / blackhole timeouts. Same fix already applied for Postgres.
dns.setDefaultResultOrder('ipv4first');

// Last email error (for diagnostics - /api/health, /api/email/diag, register).
// Set on every failed attempt so the UI and ops can see the real reason
// (wrong app password, IP blocked by Gmail, TLS error, timeout, etc).
let lastEmailError = '';

// Resolve smtp.gmail.com to an IPv4 literal. nodemailer's built-in resolver
// randomly picks one address from ALL A + AAAA records (ignoring family:4),
// so on IPv4-only hosts (Render free tier, no IPv6 route) it can randomly
// choose Gmail's IPv6 address and die with ENETUNREACH / blackhole timeout.
// Passing a literal IPv4 as `host` makes nodemailer skip its resolver
// entirely; `servername` keeps TLS SNI/cert validation on smtp.gmail.com.
let cachedSmtpIpv4 = '';
async function resolveGmailIpv4() {
  if (cachedSmtpIpv4) return cachedSmtpIpv4;
  try {
    const { address } = await dns.promises.lookup('smtp.gmail.com', { family: 4 });
    cachedSmtpIpv4 = address;
    return cachedSmtpIpv4;
  } catch (e) {
    console.error('⚠️ smtp.gmail.com IPv4 resolution failed, falling back to hostname:', e.message);
    return 'smtp.gmail.com';
  }
}

// Universal Email Dispatcher Engine (Gmail SMTP Priority #1 for 100% Universal Delivery to ANY Email)
async function sendEmailImpl({ to, subject, htmlText, plainText }) {
  dotenv.config({ override: true });

  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const gmailUser = (process.env.GMAIL_USER || '').trim();
  const gmailPass = (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '');

  console.log(`\n📧 Dispatching Email to ${to}...`);

  // Priority 1: Direct Gmail SMTP Engine (Universal Delivery to ANY Email Worldwide)
  // Try explicit-TLS port 465 first, then STARTTLS port 587 (some hosting
  // networks only allow one of them). Generous timeouts: cloud egress paths
  // (Render free tier) can be slow to reach smtp.gmail.com.
  if (gmailUser && gmailPass) {
    const smtpHost = await resolveGmailIpv4();
    // Fast pre-flight: Gmail blackholes some datacenter/cloud egress IPs at the
    // network level (Render free tier is one of them), so raw SMTP to
    // smtp.gmail.com never connects. Probe once (3s) and skip straight to
    // Resend instead of burning two 15s SMTP timeouts per email.
    const gmailReachable = await tcpProbe(smtpHost, 465, 3000);
    if (!gmailReachable.ok) {
      lastEmailError = `Gmail SMTP unreachable from this server (probe ${smtpHost}:465 ${gmailReachable.detail}) - Google likely blocks this IP. Skipping to Resend.`;
      console.warn(`⚠️ ${lastEmailError}`);
    }
    for (const { port, secure } of [{ port: 465, secure: true }, { port: 587, secure: false }]) {
      if (!gmailReachable.ok) break;
      try {
        const gmailTransporter = nodemailer.createTransport({
          host: smtpHost,
          servername: 'smtp.gmail.com',
          port,
          secure,
          family: 4,
          auth: { user: gmailUser, pass: gmailPass },
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 15000
        });

        const info = await gmailTransporter.sendMail({
          from: `"PulseRoom Messenger" <${gmailUser}>`,
          to,
          subject,
          text: plainText,
          html: htmlText
        });

        lastEmailError = '';
        console.log(`✅ GMAIL SMTP EMAIL DELIVERED TO ${to} (port ${port})! MessageID: ${info.messageId}`);
        return { success: true, provider: 'gmail', messageId: info.messageId };
      } catch (gErr) {
        lastEmailError = `Gmail SMTP (port ${port}): ${gErr.message}`;
        console.error(`❌ GMAIL SMTP (port ${port}) ERROR: ${gErr.message}`);
      }
    }
  }

  // Priority 2: Resend API
  if (resendKey) {
    console.log(`🔄 Dispatching via Resend API...`);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'PulseRoom Messenger <onboarding@resend.dev>',
          to: [to],
          subject,
          html: htmlText,
          text: plainText
        }),
        signal: AbortSignal.timeout(8000)
      });
      const resData = await response.json();
      if (response.ok && resData.id) {
        lastEmailError = '';
        console.log(`✅ RESEND EMAIL DELIVERED TO ${to}! MessageID: ${resData.id}`);
        return { success: true, provider: 'resend', messageId: resData.id };
      } else {
        lastEmailError = `Resend API: ${resData.message || JSON.stringify(resData)}`;
        console.warn('⚠️ Resend API notice:', resData.message || resData);
      }
    } catch (rErr) {
      lastEmailError = `Resend API: ${rErr.message}`;
      console.warn('⚠️ Resend API Exception:', rErr.message);
    }
  }

  return {
    success: false,
    error: lastEmailError || 'Email delivery failed. Please check GMAIL_USER / GMAIL_APP_PASS in server/.env.'
  };
}

// Hard cap on how long email dispatch may take. Registrations, resends and
// invites must never hang for the user. The cap (30s) is well above the two
// 15s-timeout SMTP attempts so the port-587 fallback actually gets a chance
// instead of being killed mid-flight by a too-short race timer; on timeout we
// report failure so callers hit the auto-activate fallback instead of leaving
// the UI spinning on "Creating Account...".
async function sendEmail(args) {
  return Promise.race([
    sendEmailImpl(args),
    new Promise((resolve) => setTimeout(() => resolve({ success: false, error: 'Email delivery timed out.' }), 30000))
  ]);
}

// Setup CORS - restricted to the configured frontend origin(s).
// Set CLIENT_URL (comma-separated for multiple origins) in server/.env.
// Same-origin requests (no Origin header) are always allowed.
const allowedOrigins = (process.env.CLIENT_URL || '').split(',').map(s => s.trim()).filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn('⚠️  CLIENT_URL is not set - CORS will allow all origins. Set CLIENT_URL in server/.env for production.');
}

// CLIENT_URL may be a comma-separated list of CORS origins. For building links
// (invite emails, confirmation redirects) we must use a single URL - the first
// configured origin - never the raw comma-joined string.
function getClientUrl() {
  const origins = (process.env.CLIENT_URL || '').split(',').map(s => s.trim()).filter(Boolean);
  return (origins[0] || 'http://localhost:3000').replace(/\/$/, '');
}

// Moderation access control. Set MODERATOR_EMAILS (comma-separated) in .env to
// restrict the reports dashboard to specific accounts. When unset, every logged
// in user can access it (convenient for local dev / single-tenant testing).
const moderatorEmails = (process.env.MODERATOR_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isModerator(user) {
  if (!user || !user.email) return false;
  if (moderatorEmails.length === 0) return true;
  return moderatorEmails.includes(String(user.email).trim().toLowerCase());
}

function requireModerator(req, res, next) {
  if (!isModerator(req.user)) {
    return res.status(403).json({ error: 'Only moderators can access the moderation dashboard.' });
  }
  next();
}
const corsOrigin = allowedOrigins.length > 0
  ? (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    }
  : true;

app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '100kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Uploads directory setup
const uploadsDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Multer storage engine configuration
// Files get unguessable UUID names so media URLs act as private share links
// (WhatsApp-style: only members who received the URL can open it).
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype.includes('video') ? '.mp4' : file.mimetype.includes('audio') ? '.webm' : '.png');
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (/^(image|audio|video)\//.test(file.mimetype)) return cb(null, true);
  return cb(new Error('Only image, audio and video files are allowed.'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// Initialize Socket.IO Server
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    methods: ['GET', 'POST']
  }
});

// Setup Socket handlers
setupSocketHandlers(io);

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'PulseRoom Real-Time Engine',
    pgConnected: db.isPgConnected(),
    resendConfigured: Boolean(process.env.RESEND_API_KEY),
    gmailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASS),
    lastEmailError: lastEmailError,
    timestamp: new Date().toISOString()
  });
});

// Raw TCP connectivity probe (short timeout) - used by the diagnostics
// endpoint to isolate WHERE a send failure happens (DNS, port blocked by
// platform, Gmail blackholing the server IP, auth rejected, etc).
function tcpProbe(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    let settled = false;
    const done = (ok, detail) => {
      if (!settled) { settled = true; socket.destroy(); resolve({ ok, detail }); }
    };
    socket.once('connect', () => done(true, 'connected'));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (e) => done(false, e.message));
    socket.connect(port, host);
  });
}

// Live Email Diagnostics Endpoint: attempts a real SMTP send and returns the
// exact error so the deployed environment can be diagnosed from the browser.
// Sends a test message to the authenticated Gmail account itself (safe - no
// data is touched, only a test email). Also runs raw TCP probes against
// smtp.gmail.com IPv4s and control hosts to separate "platform blocks SMTP
// ports" from "Gmail blackholes this server IP" from "credentials are wrong".
app.get('/api/email/diag', async (req, res) => {
  const gmailUser = (process.env.GMAIL_USER || '').trim();
  const gmailPass = (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '');
  const resendKey = (process.env.RESEND_API_KEY || '').trim();

  if (!gmailUser && !resendKey) {
    return res.status(400).json({ error: 'No email provider configured. Set GMAIL_USER/GMAIL_APP_PASS or RESEND_API_KEY.' });
  }

  // 1. Raw TCP probes
  const probes = [];
  let gmailIps = [];
  try {
    const lookup = await dns.promises.lookup('smtp.gmail.com', { all: true, family: 4 });
    gmailIps = [...new Set(lookup.map((x) => x.address))].slice(0, 3);
  } catch (e) {
    gmailIps = [];
  }
  for (const ip of gmailIps) {
    for (const port of [465, 587, 25]) {
      probes.push({ target: `smtp.gmail.com (${ip})`, port, ...(await tcpProbe(ip, port)) });
    }
  }
  const controlHosts = [
    { host: 'google.com', label: 'google.com (control)' },
    { host: 'smtp-relay.brevo.com', label: 'smtp-relay.brevo.com (non-Gmail SMTP control)' },
    { host: 'smtp.gmail.com', label: 'smtp.gmail.com (control, 443)' }
  ];
  for (const c of controlHosts) {
    const port = c.label.includes('443') ? 443 : 587;
    let ip = c.host;
    try { ip = (await dns.promises.lookup(c.host, { family: 4 })).address; } catch (e) { /* keep hostname */ }
    probes.push({ target: `${c.label} (${ip})`, port, ...(await tcpProbe(ip, port)) });
  }

  // 2. HTTPS egress probe (fetch) + live DB ping. If HTTPS egress works but raw
  // TCP SMTP does not, an HTTPS API provider (Resend) is the reliable path.
  const httpsProbe = {};
  try {
    const resp = await fetch('https://api.resend.com/', { method: 'GET', signal: AbortSignal.timeout(12000) });
    const text = await resp.text();
    httpsProbe.ok = true;
    httpsProbe.status = resp.status;
    httpsProbe.detail = text.slice(0, 120);
  } catch (e) {
    httpsProbe.ok = false;
    httpsProbe.error = e.message;
  }
  const dbPing = await db.ping();

  // 3. Full authenticated SMTP send
  const results = [];
  if (gmailUser && gmailPass) {
    const smtpHost = await resolveGmailIpv4();
    for (const { port, secure } of [{ port: 465, secure: true }, { port: 587, secure: false }]) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          servername: 'smtp.gmail.com',
          port,
          secure,
          family: 4,
          auth: { user: gmailUser, pass: gmailPass },
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 15000
        });
        const info = await transporter.sendMail({
          from: `"PulseRoom Messenger" <${gmailUser}>`,
          to: gmailUser,
          subject: 'PulseRoom email diagnostics test',
          text: 'If you can read this, PulseRoom email sending works.',
          html: '<b>If you can read this, PulseRoom email sending works.</b>'
        });
        results.push({ provider: 'gmail', port, ok: true, messageId: info.messageId });
        break;
      } catch (err) {
        results.push({ provider: 'gmail', port, ok: false, error: err.message });
      }
    }
  }

  if (resendKey && (process.env.RESEND_DIAG_TO || gmailUser)) {
    const diagTo = process.env.RESEND_DIAG_TO || gmailUser;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'PulseRoom Messenger <onboarding@resend.dev>',
          to: [diagTo],
          subject: 'PulseRoom email diagnostics test',
          html: '<b>If you can read this, PulseRoom email sending works.</b>'
        }),
        signal: AbortSignal.timeout(15000)
      });
      const resData = await response.json();
      results.push({ provider: 'resend', ok: response.ok, detail: resData.message || resData.id || resData });
    } catch (err) {
      results.push({ provider: 'resend', ok: false, error: err.message });
    }
  }

  lastEmailError = results.find(r => r.ok) ? '' : (results.map(r => r.error).filter(Boolean).join(' | ') || lastEmailError);
  res.json({ configured: { gmail: Boolean(gmailUser && gmailPass), resend: Boolean(resendKey) }, probes, httpsProbe, dbPing, results });
});

// Express Root Route: Redirect backend root GET / to Frontend Web App. When
// the frontend is served from the SAME origin (single-service deploy), a
// redirect to CLIENT_URL would loop forever, so serve the SPA index instead.
app.get('/', (req, res) => {
  const clientUrl = getClientUrl();
  let sameOrigin = false;
  try {
    sameOrigin = req.get('host') === new URL(clientUrl).host;
  } catch (e) { /* ignore malformed CLIENT_URL */ }
  if (sameOrigin && clientDist) {
    return res.sendFile(path.join(clientDist, 'index.html'));
  }
  res.redirect(clientUrl);
});

// 1. Auth: Sign Up (Email Confirmation Required Before Login)
app.post('/api/auth/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'register' }), async (req, res) => {
  try {
    const { username, email, password, avatarUrl, bio } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    const existingUser = await db.findUserByEmail(cleanEmail);
    if (existingUser && existingUser.email_confirmed) {
      return res.status(400).json({ error: 'Account with this email already exists. Please log in.' });
    }

    const passwordHash = await hashPassword(password);
    
    const user = await db.createUser({
      username: username.trim(),
      email: cleanEmail,
      passwordHash,
      avatarUrl: avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`,
      bio: bio || 'Available on PulseRoom',
      emailConfirmed: false
    });

    const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const confirmToken = generateConfirmationToken(cleanEmail);
    const confirmLink = `${baseUrl}/api/auth/confirm-email?token=${confirmToken}&email=${encodeURIComponent(cleanEmail)}`;

    const htmlText = `
      <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.1);">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #10b981; font-family: 'Outfit', sans-serif; margin: 0; font-size: 26px;">PulseRoom</h1>
          <p style="color: #94a3b8; font-size: 14px; margin-top: 4px;">Confirm Your Email Address</p>
        </div>
        <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 12px; text-align: center; border: 1px solid rgba(16,185,129,0.3);">
          <p style="color: #e2e8f0; font-size: 15px; margin-bottom: 16px;">Hello <strong>${username}</strong>,</p>
          <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">Please click the button below to confirm your email address and activate your account:</p>
          <div style="margin: 20px 0;">
            <a href="${confirmLink}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">Confirm Email Address</a>
          </div>
          <p style="color: #64748b; font-size: 12px;">Or open link: <a href="${confirmLink}" style="color: #38bdf8;">${confirmLink}</a></p>
        </div>
      </div>
    `;

    const result = await sendEmail({
      to: cleanEmail,
      subject: `Confirm your PulseRoom email address`,
      plainText: `Hello ${username}, please confirm your email: ${confirmLink}`,
      htmlText
    });

    if (!result.success) {
      await db.confirmUserEmail(cleanEmail);
      return res.status(201).json({
        message: `Account created successfully! Your email (${cleanEmail}) has been auto-activated. You can log in directly!`,
        email: cleanEmail,
        autoConfirmed: true,
        emailError: result.error
      });
    }

    res.status(201).json({
      message: `Confirmation email dispatched to ${cleanEmail}. Please check your inbox (including Spam folder) to confirm before logging in.`,
      email: cleanEmail
    });
  } catch (err) {
    console.error('Sign Up Error:', err);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// 2. Auth: Resend Confirmation Email Route
app.post('/api/auth/resend-confirmation', rateLimit({ windowMs: 60 * 60 * 1000, max: 5, name: 'resend-confirm' }), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    const cleanEmail = email.trim().toLowerCase();
    const user = await db.findUserByEmail(cleanEmail);
    if (!user) return res.status(404).json({ error: 'No account found with this email.' });
    if (user.email_confirmed) return res.status(400).json({ error: 'This email address is already confirmed. Please sign in.' });

    const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const confirmToken = generateConfirmationToken(cleanEmail);
    const confirmLink = `${baseUrl}/api/auth/confirm-email?token=${confirmToken}&email=${encodeURIComponent(cleanEmail)}`;

    const htmlText = `
      <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #10b981;">PulseRoom</h1>
        <p>Hello <strong>${user.username}</strong>,</p>
        <p>Click below to confirm your email address and activate your account:</p>
        <a href="${confirmLink}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 15px 0;">Confirm Email Address</a>
      </div>
    `;

    const result = await sendEmail({
      to: cleanEmail,
      subject: `Confirm your PulseRoom email address`,
      plainText: `Hello ${user.username}, please confirm your email: ${confirmLink}`,
      htmlText
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to send confirmation email. Check mail server setup.' });
    }

    res.json({ message: `Confirmation email re-dispatched to ${cleanEmail}. Check your inbox!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend confirmation email.' });
  }
});

// 3. Auth: Email Confirmation Callback Route
app.get('/api/auth/confirm-email', async (req, res) => {
  try {
    const { token, email } = req.query;
    if (!email) return res.status(400).send('Email parameter missing.');

    const cleanEmail = email.trim().toLowerCase();

    if (!token) {
      return res.status(400).send('Confirmation token missing. Please use the link sent to your email.');
    }

    const verification = verifyConfirmationToken(token);
    if (!verification.valid || verification.email !== cleanEmail) {
      return res.status(400).send('Invalid or expired confirmation link.');
    }

    const confirmedUser = await db.confirmUserEmail(cleanEmail);

    // Auto-connect pending friend invitations so the inviter's chat room opens automatically
    if (confirmedUser) {
      const pendingInviterIds = await db.getPendingInvitesByEmail(cleanEmail);
      for (const inviterId of pendingInviterIds) {
        if (inviterId === confirmedUser.id) continue;
        try {
          const room = await db.getOrCreatePrivateRoom(inviterId, confirmedUser.id);
          notifyRoomCreated(io, room, [inviterId, confirmedUser.id]);
          await db.deletePendingInvite(cleanEmail, inviterId);
        } catch (roomErr) {
          console.error('Auto-connect invited room error:', roomErr.message);
        }
      }
    }

    const clientUrl = getClientUrl();

    res.send(`
      <html>
        <head>
          <title>Email Confirmed - PulseRoom</title>
          <style>
            body { background: #0b0f19; color: white; font-family: 'Outfit', sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #0f172a; border: 1px solid #10b981; padding: 2.5rem; border-radius: 20px; text-align: center; max-width: 400px; }
            h2 { color: #10b981; margin-bottom: 0.5rem; }
            a { background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin-top: 1rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>⚡ Email Confirmed!</h2>
            <p>Your PulseRoom account is now fully active. Return to the app and sign in with your email and password.</p>
            <a href="${clientUrl}">Return to PulseRoom Login</a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to confirm email.');
  }
});

// 4. Auth: Login with Email & Password
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, name: 'login' }), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await db.findUserByEmail(cleanEmail);

    if (!user) {
      return res.status(401).json({ error: 'No account found with this email. Click "Sign Up" to create an account!' });
    }

    const isMatch = await comparePassword(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password. Please try again or click "Forgot Password?".' });
    }

    if (!user.email_confirmed) {
      return res.status(403).json({
        error: 'Please confirm your email address first before logging in. Open your email inbox and click "Confirm Email Address".'
      });
    }

    const { password_hash, ...safeUser } = user;
    safeUser.is_moderator = isModerator(safeUser);
    const token = generateToken(safeUser);

    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// 5. Auth: Password Reset
app.post('/api/auth/forgot-password', rateLimit({ windowMs: 60 * 60 * 1000, max: 5, name: 'forgot-pw' }), async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email address is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await db.findUserByEmail(cleanEmail);

    if (!user) {
      return res.status(404).json({ error: 'No account registered with this email address.' });
    }

    if (newPassword) {
      const newHash = await hashPassword(newPassword);
      await db.updateUserPassword(cleanEmail, newHash);
      return res.json({ message: 'Password updated successfully! You can now log in with your new password.' });
    }

    res.json({ message: 'Account found.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process password reset.' });
  }
});

// 6. User Profile & Settings Routes
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const { password_hash, ...safeUser } = user;
    safeUser.is_moderator = isModerator(safeUser);
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

app.put('/api/users/profile', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    const { username, bio } = req.body;
    let avatarUrl = undefined;
    if (req.file) {
      avatarUrl = `/uploads/${req.file.filename}`;
    } else if (req.body.avatarUrl) {
      avatarUrl = req.body.avatarUrl;
    }

    const updatedUser = await db.updateUserProfile(req.user.id, { username, avatarUrl, bio });
    if (!updatedUser) return res.status(404).json({ error: 'User not found.' });

    io.emit('user_profile_updated', updatedUser);
    res.json(updatedUser);
  } catch (err) {
    console.error('Update Profile Error:', err);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const users = await db.getAllUsers(req.user.id);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// Delete a user account - restricted to the authenticated user's OWN account
// to prevent any logged-in user from deleting other accounts.
app.delete('/api/users', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    if (email.trim().toLowerCase() !== (req.user.email || '').trim().toLowerCase()) {
      return res.status(403).json({ error: 'You can only delete your own account.' });
    }

    const removed = await db.deleteUserByEmail(email);
    if (!removed) return res.status(404).json({ error: 'No user found with that email address.' });

    res.json({ message: `User ${removed.username} (${removed.email}) deleted.` });
  } catch (err) {
    console.error('Delete User Error:', err);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

app.put('/api/users/theme', authenticateToken, async (req, res) => {
  try {
    const themePrefs = req.body;
    const updatedUser = await db.updateUserTheme(req.user.id, themePrefs);
    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update theme preferences.' });
  }
});

// 6b. Privacy: read/update last-seen visibility, profile photo & status visibility
app.get('/api/users/privacy', authenticateToken, async (req, res) => {
  try {
    const prefs = await db.getPrivacyPrefs(req.user.id);
    res.json(prefs || { last_seen: 'everyone', profile_photo: 'everyone', status: 'everyone' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch privacy preferences.' });
  }
});

app.put('/api/users/privacy', authenticateToken, async (req, res) => {
  try {
    const { last_seen, profile_photo, status } = req.body;
    const updated = await db.updatePrivacyPrefs(req.user.id, { last_seen, profile_photo, status });
    io.emit('privacy_updated', updated);
    res.json(updated);
  } catch (err) {
    console.error('Update Privacy Error:', err);
    res.status(500).json({ error: 'Failed to update privacy preferences.' });
  }
});

// 6c. Blocking: block, unblock and list blocked users
app.post('/api/users/:userId/block', authenticateToken, async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (String(targetId) === String(req.user.id)) {
      return res.status(400).json({ error: 'You cannot block yourself.' });
    }
    await db.blockUser(req.user.id, targetId);
    io.emit('user_blocked', { blockerId: req.user.id, blockedId: targetId });
    res.json({ message: 'User blocked.' });
  } catch (err) {
    console.error('Block User Error:', err);
    res.status(500).json({ error: 'Failed to block user.' });
  }
});

app.delete('/api/users/:userId/block', authenticateToken, async (req, res) => {
  try {
    await db.unblockUser(req.user.id, req.params.userId);
    res.json({ message: 'User unblocked.' });
  } catch (err) {
    console.error('Unblock User Error:', err);
    res.status(500).json({ error: 'Failed to unblock user.' });
  }
});

app.get('/api/users/blocked', authenticateToken, async (req, res) => {
  try {
    const blockedIds = await db.getBlockedUserIds(req.user.id);
    const blocked = [];
    for (const id of blockedIds) {
      const u = await db.findUserById(id);
      if (u) blocked.push({ id: u.id, username: u.username, avatar_url: u.avatar_url, email: u.email });
    }
    res.json(blocked);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch blocked users.' });
  }
});

// 6d. Web Push Notifications
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return res.status(400).json({ error: 'Valid push subscription is required.' });
    }
    await db.savePushSubscription({
      userId: req.user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth
    });
    res.status(201).json({ message: 'Push subscription saved.' });
  } catch (err) {
    console.error('Push Subscribe Error:', err);
    res.status(500).json({ error: 'Failed to save push subscription.' });
  }
});

// 6e. Report a message (community moderation)
app.post('/api/messages/:messageId/report', authenticateToken, rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: 'report' }), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || String(reason).length > 500) {
      return res.status(400).json({ error: 'A reason (max 500 chars) is required.' });
    }
    const message = await db.getMessageById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found.' });

    const report = await db.reportMessage({
      messageId: req.params.messageId,
      reporterId: req.user.id,
      roomId: message.room_id,
      reason
    });
    res.status(201).json(report);
  } catch (err) {
    console.error('Report Message Error:', err);
    res.status(500).json({ error: 'Failed to submit report.' });
  }
});

// 6e1. Moderation dashboard: list reported messages (moderator only)
app.get('/api/moderation/reports', authenticateToken, requireModerator, async (req, res) => {
  try {
    const { status } = req.query;
    const reports = await db.getReports({ status: status || 'pending' });
    res.json(reports);
  } catch (err) {
    console.error('Get Reports Error:', err);
    res.status(500).json({ error: 'Failed to fetch reports.' });
  }
});

// 6e2. Resolve a report (moderator only) - content reviewed, no further action needed
app.post('/api/moderation/reports/:reportId/resolve', authenticateToken, requireModerator, async (req, res) => {
  try {
    const updated = await db.updateReportStatus(req.params.reportId, req.user.id, 'resolved');
    if (!updated) return res.status(404).json({ error: 'Report not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Resolve Report Error:', err);
    res.status(500).json({ error: 'Failed to resolve report.' });
  }
});

// 6e3. Dismiss a report (moderator only) - report is invalid or no action required
app.post('/api/moderation/reports/:reportId/dismiss', authenticateToken, requireModerator, async (req, res) => {
  try {
    const updated = await db.updateReportStatus(req.params.reportId, req.user.id, 'dismissed');
    if (!updated) return res.status(404).json({ error: 'Report not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Dismiss Report Error:', err);
    res.status(500).json({ error: 'Failed to dismiss report.' });
  }
});

// 7. Rooms & Groups Routes
app.get('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const rooms = await db.getUserRooms(req.user.id);
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user rooms.' });
  }
});

app.post('/api/rooms/private', authenticateToken, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required.' });
    if (targetUserId === req.user.id) return res.status(400).json({ error: 'Cannot create direct chat with yourself.' });
    if (await db.isBlockedBetween(req.user.id, targetUserId)) {
      return res.status(403).json({ error: 'You cannot start a chat with this user.' });
    }

    const room = await db.getOrCreatePrivateRoom(req.user.id, targetUserId);
    notifyRoomCreated(io, room, [req.user.id, targetUserId]);
    res.json(room);
  } catch (err) {
    console.error('Create Private Room Error:', err);
    res.status(500).json({ error: 'Failed to create direct chat.' });
  }
});

app.post('/api/rooms/group', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    const { name, description, themeColor } = req.body;
    let members = req.body.members;
    if (typeof members === 'string') {
      try { members = JSON.parse(members); } catch (e) { members = []; }
    }
    if (!name) return res.status(400).json({ error: 'Group name is required.' });

    let avatarUrl = '';
    if (req.file) {
      avatarUrl = `/uploads/${req.file.filename}`;
    } else if (req.body.avatarUrl) {
      avatarUrl = req.body.avatarUrl;
    }

    const room = await db.createGroupRoom({
      name,
      description,
      avatarUrl,
      themeColor,
      createdBy: req.user.id,
      memberIds: members || []
    });

    const allMemberIds = Array.from(new Set([req.user.id, ...(members || [])]));
    notifyRoomCreated(io, room, allMemberIds);

    res.status(201).json(room);
  } catch (err) {
    console.error('Create Group Error:', err);
    res.status(500).json({ error: 'Failed to create group.' });
  }
});

// 8. Room Bridges Routes
app.post('/api/rooms/bridge', authenticateToken, async (req, res) => {
  try {
    const { sourceRoomId, targetRoomId } = req.body;
    if (!sourceRoomId || !targetRoomId) {
      return res.status(400).json({ error: 'sourceRoomId and targetRoomId are required.' });
    }
    if (sourceRoomId === targetRoomId) {
      return res.status(400).json({ error: 'Cannot bridge a room to itself.' });
    }

    const isSourceMember = await isRoomMember(sourceRoomId, req.user.id);
    const isTargetMember = await isRoomMember(targetRoomId, req.user.id);
    if (!isSourceMember || !isTargetMember) {
      return res.status(403).json({ error: 'You must be a member of both rooms to bridge them.' });
    }

    const bridge = await db.createBridge(sourceRoomId, targetRoomId, req.user.id);
    io.emit('room_bridged', bridge);
    res.status(201).json(bridge);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create room bridge.' });
  }
});

app.get('/api/rooms/bridges', authenticateToken, async (req, res) => {
  try {
    const bridges = await db.getBridgesForUser(req.user.id);
    res.json(bridges);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bridges.' });
  }
});

// 9. Messages REST Routes
app.get('/api/rooms/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const isMember = await isRoomMember(req.params.roomId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }
    const messages = await db.getRoomMessages(req.params.roomId, req.user.id);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

app.post('/api/messages', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const { roomId, text, type, replyToId, e2ee, forwarded, forwardedFrom } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId is required.' });
    // E2EE envelopes carry base64 ciphertext + key material, so allow more room.
    const maxLen = e2ee ? 30000 : 5000;
    if (text && String(text).length > maxLen) {
      return res.status(400).json({ error: `Message is too long (max ${maxLen} characters).` });
    }

    const isMember = await isRoomMember(roomId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }

    const memberIds = await db.getRoomMemberIds(roomId);
    if (memberIds.length === 2) {
      const otherId = memberIds.find(id => id !== req.user.id);
      if (otherId && (await db.isBlockedBetween(req.user.id, otherId))) {
        return res.status(403).json({ error: 'You cannot send messages to this user.' });
      }
    }

    let mediaUrl = undefined;
    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
    } else if (req.body.mediaUrl) {
      mediaUrl = req.body.mediaUrl;
    }

    const message = await db.createMessage({
      roomId,
      senderId: req.user.id,
      text,
      type: type || (mediaUrl ? (req.file?.mimetype.startsWith('video/') ? 'video' : 'image') : 'text'),
      mediaUrl,
      replyToId,
      e2ee: Boolean(e2ee),
      forwarded: Boolean(forwarded),
      forwardedFrom: forwardedFrom || null
    });

    io.to(roomId).emit('new_message', message);
    sendPushToRoom(io, roomId, { id: req.user.id, username: message.sender_name }, message);
    res.status(201).json(message);
  } catch (err) {
    console.error('Create Message Error:', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// WhatsApp-style "Delete for me": hides the message ONLY for the requesting user.
app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const message = await db.getMessageById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found.' });

    const result = await db.deleteMessageForMe(req.params.messageId, req.user.id);
    if (!result) return res.status(404).json({ error: 'Message not found.' });

    const payload = { messageId: req.params.messageId, userId: req.user.id };
    io.to(message.room_id).emit('message_deleted_for_me', payload);
    io.to(`user:${req.user.id}`).emit('message_deleted_for_me', payload);

    res.json({ message: 'Message deleted for you.', payload });
  } catch (err) {
    console.error('Delete Message Error:', err);
    res.status(500).json({ error: 'Failed to delete message.' });
  }
});

// WhatsApp-style "Edit message": only the sender can edit. E2EE messages are
// re-encrypted client-side and arrive here as a fresh ciphertext envelope.
app.put('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { text, type, e2ee } = req.body;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Message text is required.' });
    }
    const maxLen = e2ee ? 30000 : 5000;
    if (String(text).length > maxLen) {
      return res.status(400).json({ error: `Message is too long (max ${maxLen} characters).` });
    }

    const message = await db.getMessageById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    if (String(message.sender_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only edit messages you sent.' });
    }
    if (message.deleted_for_everyone || message.type === 'deleted') {
      return res.status(400).json({ error: 'This message was deleted and cannot be edited.' });
    }

    const updated = await db.editMessage(req.params.messageId, req.user.id, text, type || 'text');
    if (!updated) return res.status(404).json({ error: 'Message not found.' });

    io.to(message.room_id).emit('message_edited', updated);
    io.to(`user:${req.user.id}`).emit('message_edited', updated);
    res.json(updated);
  } catch (err) {
    console.error('Edit Message Error:', err);
    res.status(500).json({ error: 'Failed to edit message.' });
  }
});

// WhatsApp-style "Star message": per-user bookmark toggle on any message.
app.post('/api/messages/:messageId/star', authenticateToken, async (req, res) => {
  try {
    const result = await db.toggleStar(req.params.messageId, req.user.id);
    if (!result) return res.status(404).json({ error: 'Message not found.' });
    io.to(result.room_id).emit('message_starred', {
      messageId: result.id,
      roomId: result.room_id,
      isStarred: result.isStarred,
      userId: req.user.id
    });
    res.json(result);
  } catch (err) {
    console.error('Star Message Error:', err);
    res.status(500).json({ error: 'Failed to toggle starred message.' });
  }
});

// List a user's starred messages within a room (membership verified).
app.get('/api/rooms/:roomId/starred', authenticateToken, async (req, res) => {
  try {
    const isMember = await db.isRoomMember(req.params.roomId, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'You are not a member of this room.' });
    const messages = await db.getStarredMessages(req.params.roomId, req.user.id);
    res.json(messages);
  } catch (err) {
    console.error('Get Starred Messages Error:', err);
    res.status(500).json({ error: 'Failed to fetch starred messages.' });
  }
});

app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const mediaUrl = `/uploads/${req.file.filename}`;
  const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : req.file.mimetype.startsWith('audio/') ? 'audio' : 'image';
  res.json({ mediaUrl, mediaType });
});

// 10. Statuses (Stories) Routes
app.get('/api/statuses', authenticateToken, async (req, res) => {
  try {
    const statuses = await db.getAllActiveStatuses();
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch statuses.' });
  }
});

app.post('/api/statuses', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const { text, bgColor, mediaType } = req.body;
    let mediaUrl = undefined;
    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
    } else if (req.body.mediaUrl) {
      mediaUrl = req.body.mediaUrl;
    }

    const status = await db.createStatus({
      userId: req.user.id,
      text,
      mediaUrl,
      mediaType: mediaType || (req.file?.mimetype.startsWith('video/') ? 'video' : 'image'),
      bgColor
    });

    io.emit('new_status', status);
    res.status(201).json(status);
  } catch (err) {
    console.error('Create Status Error:', err);
    res.status(500).json({ error: 'Failed to create status.' });
  }
});

app.delete('/api/statuses/:statusId', authenticateToken, async (req, res) => {
  try {
    const deleted = await db.deleteStatus(req.params.statusId, req.user.id);
    if (deleted) {
      io.emit('status_deleted', req.params.statusId);
      res.json({ message: 'Status deleted.' });
    } else {
      res.status(404).json({ error: 'Status not found or unauthorized.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete status.' });
  }
});

// Status reaction toggle (WhatsApp-style emoji per user)
app.post('/api/statuses/:statusId/reactions', authenticateToken, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji is required.' });

    const result = await db.toggleStatusReaction(req.params.statusId, emoji, req.user.id);
    if (!result) return res.status(404).json({ error: 'Status not found.' });

    io.emit('status_reaction', { statusId: result.id, reactions: result.reactions });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to react to status.' });
  }
});

// Status reply: opens/creates a DM with the status author and sends a quoted reply
app.post('/api/statuses/:statusId/reply', authenticateToken, async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply || !String(reply).trim()) {
      return res.status(400).json({ error: 'Reply message is required.' });
    }

    const result = await db.createStatusReply({
      statusId: req.params.statusId,
      replierId: req.user.id,
      reply: String(reply).trim()
    });
    if (!result) return res.status(404).json({ error: 'Status not found.' });
    if (result.error) return res.status(403).json({ error: result.error });

    const { room, message } = result;
    const memberIds = await db.getRoomMemberIds(room.id);
    for (const memberId of memberIds) {
      io.to(`user:${memberId}`).emit('new_message', message);
    }
    notifyRoomCreated(io, room, memberIds);
    sendPushToRoom(io, room.id, { id: req.user.id, username: message.sender_name }, message);

    res.status(201).json({ room, message });
  } catch (err) {
    console.error('Status Reply Error:', err);
    res.status(500).json({ error: 'Failed to reply to status.' });
  }
});

// 11. Toggle Pin Chat
app.put('/api/rooms/:roomId/pin', authenticateToken, async (req, res) => {
  try {
    const isMember = await isRoomMember(req.params.roomId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }
    const isPinned = await db.togglePinChat(req.user.id, req.params.roomId);
    res.json({ is_pinned: isPinned });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pin chat.' });
  }
});

// 11a. Toggle per-chat notification mute
app.put('/api/rooms/:roomId/mute', authenticateToken, async (req, res) => {
  try {
    const isMember = await isRoomMember(req.params.roomId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }
    const isMuted = await db.toggleMuteRoom(req.user.id, req.params.roomId);
    res.json({ is_muted: isMuted });
  } catch (err) {
    console.error('Toggle mute error:', err);
    res.status(500).json({ error: 'Failed to mute chat.' });
  }
});

// 11a1. Toggle chat archive (WhatsApp-style: hidden from the main inbox)
app.put('/api/rooms/:roomId/archive', authenticateToken, async (req, res) => {
  try {
    const isMember = await isRoomMember(req.params.roomId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }
    const isArchived = await db.toggleArchiveRoom(req.user.id, req.params.roomId);
    res.json({ is_archived: isArchived });
  } catch (err) {
    console.error('Toggle archive error:', err);
    res.status(500).json({ error: 'Failed to archive chat.' });
  }
});

// 11a2. Toggle manual mark-as-unread / mark-as-read per chat
app.put('/api/rooms/:roomId/unread', authenticateToken, async (req, res) => {
  try {
    const isMember = await isRoomMember(req.params.roomId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }
    const isUnread = await db.toggleUnreadRoom(req.user.id, req.params.roomId);
    res.json({ is_unread: isUnread });
  } catch (err) {
    console.error('Toggle unread error:', err);
    res.status(500).json({ error: 'Failed to toggle unread state.' });
  }
});

// 11b. Add members to an existing group room
app.post('/api/rooms/:roomId/members', authenticateToken, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { memberIds } = req.body;
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'memberIds must be a non-empty array.' });
    }

    const existingMemberIds = await db.getRoomMemberIds(roomId);
    if (!existingMemberIds.includes(req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }

    // Group admin roles: only admins may add new members to a group.
    const roomRow = await db.getRoomById(roomId);
    const myRole = await db.getRoomMemberRole(roomId, req.user.id);
    if (roomRow && roomRow.type === 'group' && myRole !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can add members.' });
    }

    const allMemberIds = await db.addRoomMembers(roomId, memberIds);

    const rooms = await db.getUserRooms(req.user.id);
    const updatedRoom = rooms.find(r => r.id === roomId);

    notifyRoomCreated(io, updatedRoom || { id: roomId }, allMemberIds);
    io.emit('room_members_updated', updatedRoom || { id: roomId });

    res.json(updatedRoom || { id: roomId });
  } catch (err) {
    console.error('Add Room Members Error:', err);
    res.status(500).json({ error: 'Failed to add members.' });
  }
});

// 11c. WhatsApp-style "Clear chat": clears ALL messages for THIS user only (chat stays in list).
app.post('/api/rooms/:roomId/clear', authenticateToken, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const memberIds = await db.getRoomMemberIds(roomId);
    if (!memberIds.includes(req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }

    await db.clearChatForUser(roomId, req.user.id);

    io.to(`user:${req.user.id}`).emit('room_cleared', { roomId, userId: req.user.id });
    res.json({ message: 'Chat cleared for you only.' });
  } catch (err) {
    console.error('Clear Room Error:', err);
    res.status(500).json({ error: 'Failed to clear chat.' });
  }
});

// 11c. WhatsApp-style "Delete chat": removes the chat from THIS user's list only.
app.delete('/api/rooms/:roomId', authenticateToken, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const memberIds = await db.getRoomMemberIds(roomId);
    if (!memberIds.includes(req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }

    const result = await db.deleteChatForUser(roomId, req.user.id);
    if (!result) return res.status(404).json({ error: 'Room not found.' });

    const payload = { roomId, userId: req.user.id };
    io.to(`user:${req.user.id}`).emit('room_deleted_for_me', payload);

    res.json({ message: 'Chat deleted for you only.' });
  } catch (err) {
    console.error('Delete Room Error:', err);
    res.status(500).json({ error: 'Failed to delete chat.' });
  }
});

// 11d. WhatsApp-style "Disappearing messages": per-room auto-delete timer (0 = off)
app.put('/api/rooms/:roomId/disappearing', authenticateToken, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { seconds } = req.body;
    const memberIds = await db.getRoomMemberIds(roomId);
    if (!memberIds.includes(req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }
    const valid = [0, 24 * 3600, 7 * 24 * 3600, 90 * 24 * 3600];
    if (!valid.includes(Number(seconds))) {
      return res.status(400).json({ error: 'seconds must be 0, 86400, 604800 or 7776000.' });
    }
    await db.setRoomDisappearingTimer(roomId, Number(seconds));
    const payload = { roomId, disappearing_seconds: Number(seconds), updatedBy: req.user.id };
    io.to(roomId).emit('disappearing_timer_updated', payload);
    res.json(payload);
  } catch (err) {
    console.error('Set Disappearing Timer Error:', err);
    res.status(500).json({ error: 'Failed to update disappearing messages setting.' });
  }
});

// 11e. End-to-End Encryption key exchange (public keys ONLY - private keys never leave the client)
app.put('/api/e2ee/keys', authenticateToken, async (req, res) => {
  try {
    const { publicKey, signPublicKey, signature, signedPrekey } = req.body || {};
    if (!publicKey || typeof publicKey !== 'string') {
      return res.status(400).json({ error: 'publicKey is required.' });
    }
    // WhatsApp-style signed identity bundle: when a signing key + signature are
    // supplied, verify they cryptographically bind this public key to the
    // authenticated user before storing anything (tamper detection).
    if (signPublicKey && signature) {
      const valid = await verifySignedIdentity({
        userId: req.user.id,
        ecdhPub: publicKey,
        signPub: signPublicKey,
        signature
      });
      if (!valid) {
        return res.status(400).json({ error: 'Invalid key signature. The identity key could not be verified.' });
      }
    }
    const record = await db.setE2EEKey({
      userId: req.user.id,
      publicKey,
      signedPrekey: signedPrekey || '',
      signPublicKey: signPublicKey || '',
      signature: signature || ''
    });
    res.json(record);
  } catch (err) {
    console.error('Save E2EE Key Error:', err);
    res.status(500).json({ error: 'Failed to store encryption key.' });
  }
});

app.get('/api/e2ee/keys/:userId', authenticateToken, async (req, res) => {
  try {
    const key = await db.getE2EEKey(req.params.userId);
    if (!key) return res.status(404).json({ error: 'No encryption key found for this user yet.' });
    res.json(key);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch encryption key.' });
  }
});

// 11f. Message search within a chat
app.get('/api/rooms/:roomId/search', authenticateToken, async (req, res) => {
  try {
    const isMember = await isRoomMember(req.params.roomId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this room.' });
    }
    const query = req.query.q || '';
    if (!query.trim()) return res.json([]);
    const results = await db.searchRoomMessages(req.params.roomId, req.user.id, query);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search messages.' });
  }
});

// 11g. Group admin roles: promote / demote member (admin only)
app.put('/api/rooms/:roomId/members/:userId/role', authenticateToken, async (req, res) => {
  try {
    const { roomId, userId: targetId } = req.params;
    const { role } = req.body;

    if (role !== 'admin' && role !== 'member') {
      return res.status(400).json({ error: 'role must be "admin" or "member".' });
    }
    if (String(targetId) === String(req.user.id)) {
      return res.status(400).json({ error: 'You cannot change your own role.' });
    }

    const myRole = await db.getRoomMemberRole(roomId, req.user.id);
    if (myRole !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can manage roles.' });
    }

    const targetRole = await db.getRoomMemberRole(roomId, targetId);
    if (!targetRole) return res.status(404).json({ error: 'Member not found in this group.' });

    const updated = await db.setRoomMemberRole(roomId, targetId, role);
    io.to(roomId).emit('group_role_updated', { roomId, userId: targetId, role, updatedBy: req.user.id });
    io.emit('room_members_updated', { id: roomId });
    res.json(updated);
  } catch (err) {
    console.error('Update Group Role Error:', err);
    res.status(500).json({ error: 'Failed to update member role.' });
  }
});

// 11h. Remove a member from a group (admin only)
app.delete('/api/rooms/:roomId/members/:userId', authenticateToken, async (req, res) => {
  try {
    const { roomId, userId: targetId } = req.params;
    if (String(targetId) === String(req.user.id)) {
      return res.status(400).json({ error: 'Use "Leave group" to exit the group yourself.' });
    }

    const myRole = await db.getRoomMemberRole(roomId, req.user.id);
    if (myRole !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can remove members.' });
    }

    const removed = await db.removeRoomMember(roomId, targetId);
    if (!removed) return res.status(404).json({ error: 'Member not found in this group.' });

    const payload = { roomId, removedUserId: targetId, removedBy: req.user.id };
    io.to(`user:${targetId}`).emit('removed_from_room', payload);
    io.emit('room_members_updated', { id: roomId });
    res.json({ message: 'Member removed from the group.', payload });
  } catch (err) {
    console.error('Remove Group Member Error:', err);
    res.status(500).json({ error: 'Failed to remove member.' });
  }
});

// 11i. Leave a group (any member)
app.post('/api/rooms/:roomId/leave', authenticateToken, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const myRole = await db.getRoomMemberRole(roomId, req.user.id);
    if (!myRole) return res.status(404).json({ error: 'You are not a member of this group.' });

    await db.removeRoomMember(roomId, req.user.id);
    const remaining = await db.getRoomMemberIds(roomId);

    // If the group is now empty, dissolve it.
    if (remaining.length === 0) {
      await db.deleteGroupRoom(roomId);
      io.emit('room_deleted', { roomId });
    } else {
      // Promote a remaining member to admin if the leaver was the only admin.
      const admins = [];
      for (const memberId of remaining) {
        if ((await db.getRoomMemberRole(roomId, memberId)) === 'admin') admins.push(memberId);
      }
      if (admins.length === 0) {
        await db.setRoomMemberRole(roomId, remaining[0], 'admin');
      }
    }

    const payload = { roomId, userId: req.user.id };
    io.to(`user:${req.user.id}`).emit('left_room', payload);
    io.emit('room_members_updated', { id: roomId });
    res.json({ message: 'You left the group.', payload });
  } catch (err) {
    console.error('Leave Group Error:', err);
    res.status(500).json({ error: 'Failed to leave group.' });
  }
});

// 11j. Group edit: rename / photo / description (admin only)
app.put('/api/rooms/:roomId', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const myRole = await db.getRoomMemberRole(roomId, req.user.id);
    if (!myRole) return res.status(404).json({ error: 'You are not a member of this room.' });

    const isGroup = (await db.getRoomMemberIds(roomId)).length > 2 || myRole === 'admin';
    if (myRole !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can edit group details.' });
    }

    let avatarUrl = undefined;
    if (req.file) avatarUrl = `/uploads/${req.file.filename}`;
    else if (req.body.avatarUrl) avatarUrl = req.body.avatarUrl;

    const updated = await db.updateRoom(roomId, {
      name: req.body.name,
      description: req.body.description,
      avatarUrl,
      themeColor: req.body.themeColor
    });
    if (!updated) return res.status(404).json({ error: 'Room not found.' });

    io.to(roomId).emit('room_updated', updated);
    io.emit('room_members_updated', { id: roomId });
    res.json(updated);
  } catch (err) {
    console.error('Update Room Error:', err);
    res.status(500).json({ error: 'Failed to update group details.' });
  }
});

// 11k. Delete for everyone (sender only)
app.post('/api/messages/:messageId/delete-everyone', authenticateToken, async (req, res) => {
  try {
    const message = await db.getMessageById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    if (String(message.sender_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only delete messages you sent.' });
    }

    const result = await db.deleteMessageForEveryone(req.params.messageId, req.user.id);
    if (!result) return res.status(404).json({ error: 'Message not found.' });

    const payload = { messageId: req.params.messageId, roomId: result.room_id };
    io.to(result.room_id).emit('message_deleted_everyone', payload);
    res.json({ message: 'Message deleted for everyone.', payload });
  } catch (err) {
    console.error('Delete for Everyone Error:', err);
    res.status(500).json({ error: 'Failed to delete message for everyone.' });
  }
});

// 11l. Forward a message to one or more rooms (client re-encrypts when E2EE is on)
app.post('/api/messages/forward', authenticateToken, async (req, res) => {
  try {
    const { targetRoomIds, text, type, mediaUrl, originalMessageId, e2ee } = req.body;
    if (!Array.isArray(targetRoomIds) || targetRoomIds.length === 0) {
      return res.status(400).json({ error: 'targetRoomIds must be a non-empty array.' });
    }

    const created = [];
    for (const targetRoomId of targetRoomIds) {
      const isMember = await isRoomMember(targetRoomId, req.user.id);
      if (!isMember) continue;

      // Blocked enforcement for 1:1 targets
      const memberIds = await db.getRoomMemberIds(targetRoomId);
      if (memberIds.length === 2) {
        const otherId = memberIds.find(id => id !== req.user.id);
        if (otherId && (await db.isBlockedBetween(req.user.id, otherId))) continue;
      }

      const msg = await db.forwardMessage({
        roomId: targetRoomId,
        senderId: req.user.id,
        text,
        type: type || 'text',
        mediaUrl: mediaUrl || '',
        originalMessageId: originalMessageId || null,
        e2ee: Boolean(e2ee)
      });
      created.push(msg);

      io.to(targetRoomId).emit('new_message', msg);
      for (const memberId of memberIds) {
        io.to(`user:${memberId}`).emit('new_message', msg);
      }
      sendPushToRoom(io, targetRoomId, { id: req.user.id, username: msg.sender_name }, msg);
    }

    if (created.length === 0) {
      return res.status(403).json({ error: 'Could not forward to any of the selected chats.' });
    }
    res.status(201).json({ messages: created });
  } catch (err) {
    console.error('Forward Message Error:', err);
    res.status(500).json({ error: 'Failed to forward message.' });
  }
});

// 12. Add / Invite Friend by Email (STRICT REGISTERED & CONFIRMED CHECK)
app.post('/api/friends/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    const cleanEmail = email.trim().toLowerCase();
    const targetUser = await db.findUserByEmail(cleanEmail);

    // STRICT RULE: Only initiate direct chat IF user exists AND email_confirmed is TRUE!
    if (targetUser && targetUser.email_confirmed) {
      if (targetUser.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot invite yourself.' });
      }
      const room = await db.getOrCreatePrivateRoom(req.user.id, targetUser.id);
      notifyRoomCreated(io, room, [req.user.id, targetUser.id]);
      
      const clientUrl = getClientUrl();
      const htmlText = `
        <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
          <h1 style="color: #10b981;">PulseRoom</h1>
          <p>Hello <strong>${targetUser.username}</strong>,</p>
          <p>Your friend <strong>${req.user.username}</strong> started a private chat with you on PulseRoom!</p>
          <a href="${clientUrl}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 15px 0;">Open PulseRoom Chat</a>
        </div>
      `;

      sendEmail({
        to: cleanEmail,
        subject: `${req.user.username} started a private chat with you on PulseRoom!`,
        plainText: `Hello ${targetUser.username}, your friend ${req.user.username} started a private chat with you. Open PulseRoom at ${clientUrl}`,
        htmlText
      });

      return res.json({
        status: 'user_found',
        message: `Found ${targetUser.username}! Private chat initiated. Notification sent.`,
        room
      });
    } else {
      // UNREGISTERED OR UNCONFIRMED: Dispatches email ONLY! NO CHAT ROOM OPENED!
      const clientUrl = getClientUrl();
      const inviteSignupUrl = `${clientUrl}/?mode=signup&email=${encodeURIComponent(cleanEmail)}&inviter=${encodeURIComponent(req.user.username)}`;

      const htmlText = `
        <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.1);">
          <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="color: #10b981; font-size: 26px; margin: 0;">PulseRoom</h1>
            <p style="color: #94a3b8; font-size: 14px; margin-top: 4px;">Friend Invitation</p>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 12px; text-align: center; border: 1px solid rgba(16,185,129,0.3);">
            <p style="color: #e2e8f0; font-size: 15px; margin-bottom: 16px;">Hello,</p>
            <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">Your friend <strong>${req.user.username}</strong> (${req.user.email}) invited you to connect on <strong>PulseRoom Messenger</strong>.</p>
            <p style="color: #e2e8f0; font-size: 14px; margin-bottom: 20px;">Click the button below to sign up and create your account to start chatting with ${req.user.username}:</p>
            <div style="margin: 20px 0;">
              <a href="${inviteSignupUrl}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">Accept Invitation & Sign Up</a>
            </div>
            <p style="color: #64748b; font-size: 12px;">Or open link: <a href="${inviteSignupUrl}" style="color: #38bdf8;">${inviteSignupUrl}</a></p>
          </div>
        </div>
      `;

      const result = await sendEmail({
        to: cleanEmail,
        subject: `Your friend ${req.user.username} invited you to join PulseRoom Messenger!`,
        plainText: `Your friend ${req.user.username} invited you to join PulseRoom: ${inviteSignupUrl}`,
        htmlText
      });

      // Record the pending invitation so the private chat auto-connects once they sign up & confirm
      await db.createPendingInvite({ inviteeEmail: cleanEmail, inviterId: req.user.id });

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
    console.error('Invite Friend Error:', err);
    res.status(500).json({ error: 'Failed to send friend invitation.' });
  }
});

// Serve the built React app (single-service deploy: Render hosts frontend + backend).
// The dist folder may sit under <repo>/client/dist or <repo-root-parent>/client/dist
// depending on where the platform starts `node src/server.js`.
const clientDist = [
  path.resolve(process.cwd(), 'client', 'dist'),
  path.resolve(process.cwd(), '..', 'client', 'dist')
].find((p) => fs.existsSync(p));
if (clientDist) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/|uploads\/|socket\.io).*/, (req, res, next) => {
    if (req.path.includes('.')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Boot backend server with port listener and error handling
initDb().then(() => {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n⚠️ Port ${PORT} is currently occupied by another process.`);
      console.error(`👉 Stop the existing process running on port ${PORT} or change PORT in server/.env\n`);
      process.exit(1);
    }
  });

  // Disappearing messages cleanup job - runs every 30 seconds
  setInterval(async () => {
    try {
      const result = await db.cleanupExpiredDisappearingMessages();
      for (const item of result) {
        io.to(item.roomId).emit('messages_expired', { roomId: item.roomId, messageIds: item.messageIds });
      }
    } catch (e) {
      console.error('Disappearing messages cleanup error:', e.message);
    }
  }, 30 * 1000);

  // Status / stories 24h expiry job - runs at startup, then every 30 minutes
  const runStatusExpiryJob = async () => {
    try {
      const expiredIds = await db.deleteExpiredStatuses();
      if (expiredIds && expiredIds.length > 0) {
        for (const id of expiredIds) io.emit('status_deleted', id);
        console.log(`🧹 Status expiry job: removed ${expiredIds.length} expired status(es).`);
      }
    } catch (e) {
      console.error('Status expiry job error:', e.message);
    }
  };
  runStatusExpiryJob();
  setInterval(runStatusExpiryJob, 30 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`🚀 PulseRoom Server listening on http://localhost:${PORT}`);
  });
});
