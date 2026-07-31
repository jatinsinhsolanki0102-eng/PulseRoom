import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';

const getJwtSecret = () => process.env.JWT_SECRET || 'pulseroom_super_secret_jwt_key_2026';
const getSupabaseUrl = () => (process.env.SUPABASE_URL || 'https://jponpdmojuxxaecxgpgv.supabase.co').replace(/\/$/, '');
const getSupabaseAnonKey = () => process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impwb25wZG1vanV4eGFlY3hncGd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NjM2NzAsImV4cCI6MjEwMTAzOTY3MH0.hZI2QRFxU7ZHQ4FnH2pLnqQBA6BSUX3bih3WQRh6za4';

// Global Persistent Memory Store across Vercel serverless invocations
const globalUsers = global._pulseroom_users || new Map();
const globalConfirmedEmails = global._pulseroom_confirmed || new Set();
const globalRooms = global._pulseroom_rooms || new Map();
const globalMessages = global._pulseroom_messages || new Map();
const globalStatuses = global._pulseroom_statuses || new Map();

global._pulseroom_users = globalUsers;
global._pulseroom_confirmed = globalConfirmedEmails;
global._pulseroom_rooms = globalRooms;
global._pulseroom_messages = globalMessages;
global._pulseroom_statuses = globalStatuses;

function getSupabaseHeaders() {
  const key = getSupabaseAnonKey();
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

// Token Verification Helpers
function generateConfirmationToken(email) {
  return jwt.sign(
    { email: email.trim().toLowerCase(), purpose: 'confirm_email' },
    getJwtSecret(),
    { expiresIn: '24h' }
  );
}

function verifyConfirmationToken(token) {
  if (!token) return { valid: false, error: 'Confirmation token is required.' };
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

// Universal Account Finder (Memory + Supabase REST API Cloud DB)
async function findUserByEmail(email) {
  if (!email) return null;
  const clean = email.trim().toLowerCase();

  for (const user of globalUsers.values()) {
    if (user.email && user.email.toLowerCase() === clean) return user;
  }

  try {
    const res = await fetch(`${getSupabaseUrl()}/rest/v1/users?email=eq.${encodeURIComponent(clean)}&select=*`, {
      headers: getSupabaseHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        globalUsers.set(data[0].id, data[0]);
        return data[0];
      }
    }
  } catch (e) {
    console.warn('Supabase query error:', e.message);
  }

  return null;
}

async function findUserById(id) {
  if (!id) return null;
  if (globalUsers.has(id)) return globalUsers.get(id);

  try {
    const res = await fetch(`${getSupabaseUrl()}/rest/v1/users?id=eq.${encodeURIComponent(id)}&select=*`, {
      headers: getSupabaseHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        globalUsers.set(data[0].id, data[0]);
        return data[0];
      }
    }
  } catch (e) {
    console.warn('Supabase findById error:', e.message);
  }
  return globalUsers.get(id) || null;
}

async function createUser({ username, email, passwordHash, avatarUrl, bio, emailConfirmed = false }) {
  const cleanEmail = email.trim().toLowerCase();
  const id = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(7);
  const isConfirmed = Boolean(emailConfirmed || globalConfirmedEmails.has(cleanEmail));

  const user = {
    id,
    username: username.trim(),
    email: cleanEmail,
    password_hash: passwordHash,
    avatar_url: avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`,
    bio: bio || 'Available on PulseRoom',
    email_confirmed: isConfirmed,
    status: 'online',
    created_at: new Date().toISOString()
  };

  globalUsers.set(id, user);

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

  const user = await findUserByEmail(clean);
  if (user) {
    user.email_confirmed = true;
    globalUsers.set(user.id, user);

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
  const user = await findUserByEmail(clean);
  if (user) {
    user.password_hash = newPasswordHash;
    globalUsers.set(user.id, user);

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

// Universal Multi-Provider Email Dispatcher
async function sendEmail({ to, subject, htmlText, plainText }) {
  const gmailUser = (process.env.GMAIL_USER || 'jatinsinhsolanki0102@gmail.com').trim();
  const rawPass = (process.env.GMAIL_APP_PASS || 'ptxubglafsafnrxr').trim();
  const gmailPass = rawPass.replace(/\s+/g, '');
  const resendKey = (process.env.RESEND_API_KEY || '').trim();

  // Priority 1: Direct Gmail SMTP Engine (Delivers to ANY Email Address)
  if (gmailUser && gmailPass) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass }
      });

      const info = await transporter.sendMail({
        from: `"PulseRoom Messenger" <${gmailUser}>`,
        to,
        subject,
        text: plainText,
        html: htmlText
      });

      return { success: true, provider: 'gmail', messageId: info.messageId };
    } catch (gErr) {
      console.error('Gmail Direct SMTP Error:', gErr.message);
    }
  }

  // Priority 2: Resend API
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
    } catch (err) {
      console.warn('Resend exception:', err.message);
    }
  }

  return { success: false, error: 'Email dispatch failed. Please verify mail configuration.' };
}

// Express App
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

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
    usersCount: globalUsers.size,
    timestamp: new Date().toISOString()
  });
});

// 1. Sign Up Endpoint
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, avatarUrl, bio } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = await findUserByEmail(cleanEmail);
    if (existing) {
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
    const confirmToken = generateConfirmationToken(cleanEmail);
    const confirmLink = `${hostUrl}/api/auth/confirm-email?token=${confirmToken}&email=${encodeURIComponent(cleanEmail)}`;

    const htmlText = `
      <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #10b981;">PulseRoom</h1>
        <p>Hello <strong>${username}</strong>,</p>
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
      return res.status(500).json({
        error: sendRes.error || 'Account created, but confirmation email could not be delivered.'
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
app.post('/api/auth/resend-confirmation', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    const cleanEmail = email.trim().toLowerCase();
    const user = await findUserByEmail(cleanEmail);
    if (!user) return res.status(404).json({ error: 'No account found with this email address.' });
    if (user.email_confirmed || globalConfirmedEmails.has(cleanEmail)) {
      return res.status(400).json({ error: 'This email address is already confirmed. Please log in.' });
    }

    const hostUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const confirmToken = generateConfirmationToken(cleanEmail);
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

// 3. Email Confirmation Callback Endpoint
app.get('/api/auth/confirm-email', async (req, res) => {
  try {
    const { token, email } = req.query || {};
    if (!email) return res.status(400).send('Email parameter missing.');

    const cleanEmail = email.trim().toLowerCase();

    if (!token) {
      return res.status(400).send('Confirmation token missing. Please use the link sent to your email.');
    }

    const verification = verifyConfirmationToken(token);
    if (!verification.valid || verification.email !== cleanEmail) {
      return res.status(400).send('Invalid or expired confirmation link.');
    }

    await markEmailConfirmed(cleanEmail);
    const clientUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    res.send(`
      <html>
        <head><title>Email Confirmed - PulseRoom</title></head>
        <body style="background: #0b0f19; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
          <div style="background: #0f172a; border: 1px solid #10b981; padding: 2.5rem; border-radius: 20px; text-align: center; max-width: 400px;">
            <h2 style="color: #10b981;">⚡ Email Confirmed!</h2>
            <p>Your PulseRoom account (<strong>${cleanEmail}</strong>) is now fully active. Return to the app and sign in with your email and password.</p>
            <a href="${clientUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin-top: 1rem;">Return to PulseRoom Login</a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to confirm email.');
  }
});

// 4. Login Endpoint (With Persistent Account Sync & Confirmation Enforcement)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    let user = await findUserByEmail(cleanEmail);

    if (!user) {
      return res.status(401).json({ error: 'No account found with this email. Click "Sign Up" to create an account!' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password. Please try again or click "Forgot Password?".' });
    }

    if (globalConfirmedEmails.has(cleanEmail)) {
      user.email_confirmed = true;
    }

    if (!user.email_confirmed) {
      return res.status(403).json({
        error: 'Please confirm your email address first before logging in. Check your email inbox for the confirmation link!'
      });
    }

    const { password_hash, ...safeUser } = user;
    const token = jwt.sign(
      { id: safeUser.id, username: safeUser.username, email: safeUser.email },
      getJwtSecret(),
      { expiresIn: '30d' }
    );

    return res.json({ token, user: safeUser });
  } catch (err) {
    return res.status(500).json({ error: 'Server error during login.' });
  }
});

// 5. Password Reset
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    const cleanEmail = email.trim().toLowerCase();
    const user = await findUserByEmail(cleanEmail);
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
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const { password_hash, ...safe } = user;
    return res.json(safe);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const { username, avatarUrl, bio } = req.body || {};
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (username) user.username = username.trim();
    if (avatarUrl) user.avatar_url = avatarUrl;
    if (bio !== undefined) user.bio = bio.trim();

    globalUsers.set(user.id, user);
    const { password_hash, ...safe } = user;
    return res.json(safe);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const users = Array.from(globalUsers.values())
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

// 7. Rooms & Groups Endpoints (Guaranteed Safe Room Opening)
app.get('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const rooms = Array.from(globalRooms.values()).filter(r =>
      r.members && r.members.some(m => m.id === req.user.id)
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
        partner: partner ? { id: partner.id, username: partner.username, avatar_url: partner.avatar_url, bio: partner.bio } : { id: targetUserId, username: 'Partner' },
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

// 8. Messages REST Endpoints
app.get('/api/rooms/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const msgs = globalMessages.get(req.params.roomId) || [];
    return res.json(msgs);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch room messages.' });
  }
});

app.post('/api/messages', authenticateToken, async (req, res) => {
  try {
    const { roomId, text, type, mediaUrl, replyToId } = req.body || {};
    if (!roomId) return res.status(400).json({ error: 'roomId is required.' });

    const user = await findUserById(req.user.id);
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    const message = {
      id: msgId,
      room_id: roomId,
      sender_id: req.user.id,
      username: user ? user.username : req.user.username || 'User',
      avatar_url: user ? user.avatar_url : '',
      text,
      type: type || 'text',
      media_url: mediaUrl,
      reply_to_id: replyToId,
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

app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    for (const [roomId, msgs] of globalMessages.entries()) {
      const idx = msgs.findIndex(m => m.id === req.params.messageId);
      if (idx !== -1) {
        if (msgs[idx].sender_id !== req.user.id) {
          return res.status(403).json({ error: 'You can only delete your own messages.' });
        }
        msgs.splice(idx, 1);
        return res.json({ message: 'Message deleted.' });
      }
    }
    return res.status(404).json({ error: 'Message not found.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete message.' });
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

// 10. Friends Invite Endpoint
app.post('/api/friends/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    const cleanEmail = email.trim().toLowerCase();
    const targetUser = await findUserByEmail(cleanEmail);

    if (targetUser) {
      const roomId = 'room_' + [req.user.id, targetUser.id].sort().join('_');
      const me = await findUserById(req.user.id);
      const room = {
        id: roomId,
        type: 'private',
        partner: { id: targetUser.id, username: targetUser.username, avatar_url: targetUser.avatar_url },
        members: [{ id: req.user.id }, { id: targetUser.id }]
      };
      globalRooms.set(roomId, room);

      return res.json({
        status: 'user_found',
        message: `Found ${targetUser.username}! Private chat initiated.`,
        room
      });
    } else {
      const hostUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const htmlText = `
        <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
          <h1 style="color: #10b981;">PulseRoom</h1>
          <p>Hello,</p>
          <p>Your friend <strong>${req.user.username}</strong> (${req.user.email}) invited you to join PulseRoom Messenger!</p>
          <a href="${hostUrl}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 15px 0;">Accept Invitation & Sign Up</a>
        </div>
      `;

      const result = await sendEmail({
        to: cleanEmail,
        subject: `Your friend ${req.user.username} invited you to join PulseRoom Messenger!`,
        plainText: `Your friend ${req.user.username} invited you: ${hostUrl}`,
        htmlText
      });

      if (!result.success) {
        return res.status(500).json({ error: result.error || 'Failed to send invitation email.' });
      }

      return res.json({
        status: 'invited',
        message: `Invitation email dispatched to ${cleanEmail}!`
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
