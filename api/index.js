import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'pulseroom_super_secret_jwt_key_2026';
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://jponpdmojuxxaecxgpgv.supabase.co').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impwb25wZG1vanV4eGFlY3hncGd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0NjM2NzAsImV4cCI6MjEwMTAzOTY3MH0.hZI2QRFxU7ZHQ4FnH2pLnqQBA6BSUX3bih3WQRh6za4';

// In-Memory Fallback Map
const memoryUsers = new Map();
const memoryRooms = new Map();
const memoryMessages = new Map();
const memoryStatuses = new Map();

// Helper headers for Supabase REST API
function getSupabaseHeaders() {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

// --------------------------------------------------------------------------
// PERSISTENT DB OPERATIONS (Supabase Cloud DB + Memory Fallback)
// --------------------------------------------------------------------------
async function findUserByEmail(email) {
  const clean = email.trim().toLowerCase();
  
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(clean)}&select=*`, {
      headers: getSupabaseHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        memoryUsers.set(data[0].id, data[0]);
        return data[0];
      }
    }
  } catch (e) {
    console.warn('Supabase fetch user error:', e.message);
  }

  for (const user of memoryUsers.values()) {
    if (user.email.toLowerCase() === clean) return user;
  }
  return null;
}

async function findUserById(id) {
  if (memoryUsers.has(id)) return memoryUsers.get(id);

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(id)}&select=*`, {
      headers: getSupabaseHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        memoryUsers.set(data[0].id, data[0]);
        return data[0];
      }
    }
  } catch (e) {
    console.warn('Supabase findById error:', e.message);
  }

  return memoryUsers.get(id) || null;
}

async function createUser({ username, email, passwordHash, avatarUrl, bio, emailConfirmed = false }) {
  const id = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(7);
  const user = {
    id,
    username,
    email,
    password_hash: passwordHash,
    avatar_url: avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`,
    bio: bio || 'Available on PulseRoom',
    email_confirmed: Boolean(emailConfirmed),
    status: 'online',
    created_at: new Date().toISOString()
  };

  memoryUsers.set(id, user);

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/users`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify(user)
    });
  } catch (e) {
    console.warn('Supabase create user error:', e.message);
  }

  return user;
}

async function confirmUserEmail(email) {
  const clean = email.trim().toLowerCase();
  const user = await findUserByEmail(clean);
  if (user) {
    user.email_confirmed = true;
    memoryUsers.set(user.id, user);

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(clean)}`, {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({ email_confirmed: true })
      });
    } catch (e) {
      console.warn('Supabase confirm email error:', e.message);
    }
  }
  return user;
}

async function resetUserPassword(email, newPasswordHash) {
  const clean = email.trim().toLowerCase();
  const user = await findUserByEmail(clean);
  if (user) {
    user.password_hash = newPasswordHash;
    memoryUsers.set(user.id, user);

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(clean)}`, {
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

// Resend API Email Dispatcher
async function sendEmail({ to, subject, htmlText, plainText }) {
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  if (!resendKey) {
    console.warn('RESEND_API_KEY missing in Vercel environment.');
    return { success: false, reason: 'RESEND_API_KEY missing' };
  }

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
    console.log('Resend Response:', resData);
    if (response.ok && resData.id) {
      return { success: true, messageId: resData.id };
    } else {
      return { success: false, error: resData };
    }
  } catch (err) {
    console.error('Resend fetch error:', err.message);
    return { success: false, error: err.message };
  }
}

// --------------------------------------------------------------------------
// EXPRESS APP CONFIGURATION FOR VERCEL
// --------------------------------------------------------------------------
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'PulseRoom Vercel Serverless Engine',
    resendConfigured: Boolean(process.env.RESEND_API_KEY),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
    timestamp: new Date().toISOString()
  });
});

// 1. Sign Up (Register)
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

    const user = await createUser({
      username: username.trim(),
      email: cleanEmail,
      passwordHash,
      avatarUrl,
      bio,
      emailConfirmed: false
    });

    const confirmLink = `https://pulse-room-chat-app.vercel.app/api/auth/confirm-email?email=${encodeURIComponent(cleanEmail)}`;
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

    return res.status(201).json({
      message: `Confirmation email dispatched to ${cleanEmail}. Check your email inbox to confirm before logging in!`,
      email: cleanEmail,
      sendResult: sendRes
    });
  } catch (err) {
    console.error('Vercel Register Error:', err);
    return res.status(500).json({ error: 'Failed to create account on Vercel.' });
  }
});

// 2. Email Confirmation Endpoint
app.get('/api/auth/confirm-email', async (req, res) => {
  try {
    const { email } = req.query || {};
    if (!email) return res.status(400).send('Email parameter missing.');

    const cleanEmail = email.trim().toLowerCase();
    await confirmUserEmail(cleanEmail);

    res.send(`
      <html>
        <head><title>Email Confirmed - PulseRoom</title></head>
        <body style="background: #0b0f19; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
          <div style="background: #0f172a; border: 1px solid #10b981; padding: 2.5rem; border-radius: 20px; text-align: center; max-width: 400px;">
            <h2 style="color: #10b981;">⚡ Email Confirmed!</h2>
            <p>Your PulseRoom account is now fully active. Return to the app and sign in with your email and password.</p>
            <a href="https://pulse-room-chat-app.vercel.app" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin-top: 1rem;">Return to PulseRoom Login</a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to confirm email.');
  }
});

// 3. Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await findUserByEmail(cleanEmail);

    if (!user) {
      return res.status(401).json({ error: 'No account found with this email. Click "Sign Up" to create an account!' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password. Please try again or click "Forgot Password?".' });
    }

    if (!user.email_confirmed) {
      return res.status(403).json({
        error: 'Please confirm your email address first before logging in. Check your email inbox for the confirmation link!'
      });
    }

    const { password_hash, ...safeUser } = user;
    const token = jwt.sign(
      { id: safeUser.id, username: safeUser.username, email: safeUser.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Vercel Login Error:', err);
    return res.status(500).json({ error: 'Server error during login.' });
  }
});

// 4. Password Reset
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

// 5. User Profile Endpoints
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

    memoryUsers.set(user.id, user);
    const { password_hash, ...safe } = user;
    return res.json(safe);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const users = Array.from(memoryUsers.values())
      .filter(u => u.id !== req.user.id)
      .map(({ password_hash, ...safe }) => safe);
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// 6. Rooms Endpoints
app.get('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const rooms = Array.from(memoryRooms.values()).filter(r =>
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
    const me = await findUserById(req.user.id);
    const partner = await findUserById(targetUserId);

    const roomId = 'room_' + [req.user.id, targetUserId].sort().join('_');
    let room = memoryRooms.get(roomId);

    if (!room) {
      room = {
        id: roomId,
        type: 'private',
        partner: partner ? { id: partner.id, username: partner.username, avatar_url: partner.avatar_url, bio: partner.bio } : null,
        members: [
          { id: me.id, username: me.username },
          { id: partner.id, username: partner.username }
        ],
        created_at: new Date().toISOString()
      };
      memoryRooms.set(roomId, room);
    }
    return res.json(room);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to initiate room.' });
  }
});

app.get('/api/rooms/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const msgs = memoryMessages.get(req.params.roomId) || [];
    return res.json(msgs);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch room messages.' });
  }
});

// 7. Statuses Endpoints
app.get('/api/statuses', authenticateToken, async (req, res) => {
  try {
    const statuses = Array.from(memoryStatuses.values());
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
      user_id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      text,
      media_url: mediaUrl,
      media_type: mediaType || 'image',
      bg_color: bgColor || '#128c7e',
      created_at: new Date().toISOString()
    };

    memoryStatuses.set(id, status);
    return res.status(201).json(status);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create status.' });
  }
});

// 8. Friends Invite Endpoint
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
        members: [{ id: me.id }, { id: targetUser.id }]
      };
      memoryRooms.set(roomId, room);

      return res.json({
        status: 'user_found',
        message: `Found ${targetUser.username}! Private chat initiated.`,
        room
      });
    } else {
      const confirmLink = 'https://pulse-room-chat-app.vercel.app';
      const htmlText = `
        <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
          <h1 style="color: #10b981;">PulseRoom</h1>
          <p>Hello,</p>
          <p>Your friend <strong>${req.user.username}</strong> (${req.user.email}) invited you to join PulseRoom Messenger!</p>
          <a href="${confirmLink}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 15px 0;">Accept Invitation & Sign Up</a>
        </div>
      `;

      await sendEmail({
        to: cleanEmail,
        subject: `Your friend ${req.user.username} invited you to join PulseRoom Messenger!`,
        plainText: `Your friend ${req.user.username} invited you: ${confirmLink}`,
        htmlText
      });

      return res.json({
        status: 'invited',
        message: `Invitation email dispatched to ${cleanEmail} via Resend!`
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send friend invitation.' });
  }
});

// Fallback JSON Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Vercel Express Error:', err);
  res.status(500).json({ error: err.message || 'An unexpected server error occurred on Vercel.' });
});

export default app;
