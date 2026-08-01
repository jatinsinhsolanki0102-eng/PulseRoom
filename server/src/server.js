import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

import { initDb, db } from './db.js';
import { hashPassword, comparePassword, generateToken, generateConfirmationToken, verifyConfirmationToken, authenticateToken } from './auth.js';
import { setupSocketHandlers, notifyRoomCreated } from './socketHandler.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// Universal Email Dispatcher Engine (Gmail SMTP Priority #1 for 100% Universal Delivery to ANY Email)
async function sendEmail({ to, subject, htmlText, plainText }) {
  dotenv.config({ override: true });

  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const gmailUser = (process.env.GMAIL_USER || 'user@example.com').trim();
  const rawPass = (process.env.GMAIL_APP_PASS || 'REDACTED_GMAIL_APP_PASSWORD').trim();
  const gmailPass = rawPass.replace(/\s+/g, '');

  console.log(`\n📧 Dispatching Email to ${to}...`);

  // Priority 1: Direct Gmail SMTP Engine (Universal Delivery to ANY Email Worldwide)
  if (gmailUser && gmailPass) {
    console.log(`🚀 Dispatching via Gmail SMTP (${gmailUser})...`);
    try {
      const gmailTransporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: gmailUser, pass: gmailPass }
      });

      const info = await gmailTransporter.sendMail({
        from: `"PulseRoom Messenger" <${gmailUser}>`,
        to,
        subject,
        text: plainText,
        html: htmlText
      });

      console.log(`✅ GMAIL SMTP EMAIL DELIVERED TO ${to}! MessageID: ${info.messageId}`);
      return { success: true, provider: 'gmail', messageId: info.messageId };
    } catch (gErr) {
      console.error(`❌ GMAIL SMTP ERROR: ${gErr.message}`);
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
          from: 'PulseRoom Messenger <onboarding@resend.dev>',
          to: [to],
          subject,
          html: htmlText,
          text: plainText
        })
      });
      const resData = await response.json();
      if (response.ok && resData.id) {
        console.log(`✅ RESEND EMAIL DELIVERED TO ${to}! MessageID: ${resData.id}`);
        return { success: true, provider: 'resend', messageId: resData.id };
      } else {
        console.warn('⚠️ Resend API notice:', resData.message || resData);
      }
    } catch (rErr) {
      console.warn('⚠️ Resend API Exception:', rErr.message);
    }
  }

  return {
    success: false,
    error: 'Email delivery failed. Please check GMAIL_USER / GMAIL_APP_PASS in server/.env.'
  };
}

// Setup CORS
app.use(cors({
  origin: process.env.CLIENT_URL || process.env.APP_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Uploads directory setup
const uploadsDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Multer storage engine configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || (file.mimetype.includes('video') ? '.mp4' : file.mimetype.includes('audio') ? '.webm' : '.png');
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Initialize Socket.IO Server
const io = new Server(server, {
  cors: {
    origin: '*',
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
    timestamp: new Date().toISOString()
  });
});

// Express Root Route: Redirect backend root GET / to Frontend Web App
app.get('/', (req, res) => {
  const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
  res.redirect(clientUrl);
});

// 1. Auth: Sign Up (Email Confirmation Required Before Login)
app.post('/api/auth/register', async (req, res) => {
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
      return res.status(500).json({
        error: result.error || 'Account created, but we could not send the confirmation email right now. Please check mail credentials.'
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
app.post('/api/auth/resend-confirmation', async (req, res) => {
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

    const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');

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
app.post('/api/auth/login', async (req, res) => {
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
    const token = generateToken(safeUser);

    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// 5. Auth: Password Reset
app.post('/api/auth/forgot-password', async (req, res) => {
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

app.put('/api/users/theme', authenticateToken, async (req, res) => {
  try {
    const themePrefs = req.body;
    const updatedUser = await db.updateUserTheme(req.user.id, themePrefs);
    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update theme preferences.' });
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

    const bridge = await db.createRoomBridge(sourceRoomId, targetRoomId, req.user.id);
    io.emit('room_bridged', bridge);
    res.status(201).json(bridge);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create room bridge.' });
  }
});

app.get('/api/rooms/bridges', authenticateToken, async (req, res) => {
  try {
    const bridges = await db.getAllBridges();
    res.json(bridges);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bridges.' });
  }
});

// 9. Messages REST Routes
app.get('/api/rooms/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const messages = await db.getRoomMessages(req.params.roomId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

app.post('/api/messages', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const { roomId, text, type, replyToId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId is required.' });

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
      replyToId
    });

    io.to(roomId).emit('new_message', message);
    res.status(201).json(message);
  } catch (err) {
    console.error('Create Message Error:', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const message = await db.getMessageById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found.' });

    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own messages.' });
    }

    await db.deleteMessage(req.params.messageId, req.user.id);
    io.to(message.room_id).emit('message_deleted', req.params.messageId);
    io.emit('message_deleted', req.params.messageId);
    res.json({ message: 'Message deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message.' });
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
    const statuses = await db.getStatuses();
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

// 11. Toggle Pin Chat
app.put('/api/rooms/:roomId/pin', authenticateToken, async (req, res) => {
  try {
    const isPinned = await db.togglePinChat(req.user.id, req.params.roomId);
    res.json({ is_pinned: isPinned });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pin chat.' });
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
      
      const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
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
      const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');
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

      if (!result.success) {
        return res.status(500).json({ error: 'Failed to send invitation email.' });
      }

      // Record the pending invitation so the private chat auto-connects once they sign up & confirm
      await db.createPendingInvite({ inviteeEmail: cleanEmail, inviterId: req.user.id });

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

// Boot backend server with port listener and error handling
initDb().then(() => {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n⚠️ Port ${PORT} is currently occupied by another process.`);
      console.error(`👉 Stop the existing process running on port ${PORT} or change PORT in server/.env\n`);
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`🚀 PulseRoom Server listening on http://localhost:${PORT}`);
  });
});
