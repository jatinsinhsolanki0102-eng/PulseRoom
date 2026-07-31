import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { db } from '../server/src/db.js';
import { hashPassword, comparePassword, generateToken, authenticateToken } from '../server/src/auth.js';

dotenv.config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

// Multi-Provider Email Dispatcher (Resend Priority #1)
async function sendEmail({ to, subject, htmlText, plainText }) {
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
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
        return { success: true, messageId: resData.id };
      }
    } catch (rErr) {
      console.warn('Resend API Exception:', rErr.message);
    }
  }
  return { success: false };
}

// REST API ROUTES FOR VERCEL SERVERLESS
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'PulseRoom Vercel Engine', resendConfigured: Boolean(process.env.RESEND_API_KEY) });
});

// 1. Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, avatarUrl, bio } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existingUser = await db.findUserByEmail(cleanEmail);
    if (existingUser) {
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

    const confirmLink = `https://pulse-room-chat-app.vercel.app/api/auth/confirm-email?email=${encodeURIComponent(cleanEmail)}`;
    const htmlText = `
      <div style="font-family: Arial, sans-serif; padding: 25px; background: #0b0f19; color: #ffffff; border-radius: 16px; max-width: 480px; margin: 0 auto;">
        <h1 style="color: #10b981;">PulseRoom</h1>
        <p>Hello <strong>${username}</strong>,</p>
        <p>Please click below to confirm your email address and activate your account:</p>
        <a href="${confirmLink}" style="background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; margin: 15px 0;">Confirm Email Address</a>
      </div>
    `;

    await sendEmail({
      to: cleanEmail,
      subject: `Confirm your PulseRoom email address`,
      plainText: `Confirm email: ${confirmLink}`,
      htmlText
    });

    res.status(201).json({
      message: `Confirmation email dispatched to ${cleanEmail}. Check your email inbox to confirm before logging in!`,
      email: cleanEmail
    });
  } catch (err) {
    console.error('Sign Up Error:', err);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// 2. Email Confirmation
app.get('/api/auth/confirm-email', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).send('Email parameter missing.');
    const cleanEmail = email.trim().toLowerCase();
    await db.confirmUserEmail(cleanEmail);

    res.send(`
      <html>
        <head><title>Email Confirmed</title></head>
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

// 3. Login
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

// 4. Password Reset
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email) return res.status(400).json({ error: 'Email address is required.' });
    const cleanEmail = email.trim().toLowerCase();
    const user = await db.findUserByEmail(cleanEmail);
    if (!user) return res.status(404).json({ error: 'No account registered with this email.' });

    if (newPassword) {
      const newHash = await hashPassword(newPassword);
      await db.resetUserPassword(cleanEmail, newHash);
      return res.json({ message: 'Password updated successfully! You can now log in.' });
    }
    res.json({ message: 'Account found.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process password reset.' });
  }
});

// User routes
app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const { username, avatarUrl, bio } = req.body;
    const updatedUser = await db.updateUserProfile(req.user.id, { username, avatarUrl, bio });
    res.json(updatedUser);
  } catch (err) {
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

app.get('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const rooms = await db.getUserRooms(req.user.id);
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rooms.' });
  }
});

app.post('/api/rooms/private', authenticateToken, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    const room = await db.getOrCreatePrivateRoom(req.user.id, targetUserId);
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create room.' });
  }
});

app.get('/api/rooms/:roomId/messages', authenticateToken, async (req, res) => {
  try {
    const messages = await db.getRoomMessages(req.params.roomId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages.' });
  }
});

app.get('/api/statuses', authenticateToken, async (req, res) => {
  try {
    const statuses = await db.getAllActiveStatuses();
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch statuses.' });
  }
});

app.post('/api/statuses', authenticateToken, async (req, res) => {
  try {
    const { text, mediaUrl, mediaType, bgColor } = req.body;
    const status = await db.createStatus({ userId: req.user.id, text, mediaUrl, mediaType, bgColor });
    res.status(201).json(status);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create status.' });
  }
});

app.post('/api/friends/invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email address is required.' });
    const cleanEmail = email.trim().toLowerCase();
    const targetUser = await db.findUserByEmail(cleanEmail);

    if (targetUser) {
      const room = await db.getOrCreatePrivateRoom(req.user.id, targetUser.id);
      return res.json({ status: 'user_found', message: `Found ${targetUser.username}! Private chat initiated.`, room });
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
        plainText: `Your friend ${req.user.username} invited you to join PulseRoom: ${confirmLink}`,
        htmlText
      });

      return res.json({ status: 'invited', message: `Invitation email dispatched to ${cleanEmail} via Resend!` });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to send invitation.' });
  }
});

export default app;
