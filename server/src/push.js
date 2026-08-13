import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import { db } from './db.js';

// VAPID keys are either provided via env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)
// or generated once and persisted to data/.vapid.json.
const VAPID_FILE = path.join(process.cwd(), 'data', '.vapid.json');

function loadOrCreateVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (parsed.publicKey && parsed.privateKey) return parsed;
    }
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys));
    console.warn('🔑 Generated VAPID keys (data/.vapid.json). Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in env for production.');
    return keys;
  } catch (e) {
    console.error('Could not load or create VAPID keys:', e.message);
    return null;
  }
}

const vapid = loadOrCreateVapidKeys();

export const vapidPublicKey = vapid ? vapid.publicKey : null;

if (vapid) {
  webpush.setVapidDetails(
    `mailto:${process.env.PUSH_CONTACT_EMAIL || 'admin@pulseroom.app'}`,
    vapid.publicKey,
    vapid.privateKey
  );
}

export async function sendPushToUser(userId, { title, body, data }) {
  if (!vapid || !userId) return;
  const subs = await db.getPushSubscriptions(userId);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body: body || '', ...(data ? { data } : {}) })
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.removePushSubscription(sub.endpoint);
      } else {
        console.warn('Push send error:', err.message);
      }
    }
  }
}

// Notify room members who are NOT currently connected via socket.
export async function sendPushToRoom(io, roomId, sender, message) {
  if (!sender || !roomId) return;
  const memberIds = await db.getRoomMemberIds(roomId);
  for (const memberId of memberIds) {
    if (String(memberId) === String(sender.id)) continue;
    const userRoom = io.sockets.adapter.rooms.get(`user:${memberId}`);
    if (userRoom && userRoom.size > 0) continue; // connected via socket - skip push
    await sendPushToUser(memberId, {
      title: sender.username || 'New message',
      body: message?.e2ee
        ? '🔒 End-to-end encrypted message'
        : (message?.text || '📷 Media/Attachment').slice(0, 120),
      data: { roomId }
    });
  }
}
