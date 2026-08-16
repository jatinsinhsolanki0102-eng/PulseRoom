import pkg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || 'postgres'}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'pulseroom'}`,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 3000,
  // Force IPv4: hostnames like Supabase's db.<ref>.supabase.co resolve to an
  // IPv6 address first, and hosting platforms without IPv6 then fail with
  // ENETUNREACH instead of falling back to IPv4.
  family: 4,
});

let isPgConnected = false;

// Fallback in-memory data store
const memoryDb = {
  users: new Map(),
  rooms: new Map(),
  room_members: [],
  room_bridges: new Map(),
  messages: new Map(),
  statuses: new Map(),
  pinned_chats: new Set(),
  muted_chats: new Set(),
  archived_chats: new Set(),
  marked_unread_chats: new Set(),
  pendingInvites: new Map(),
  blocked: new Map(),
  reports: new Map(),
  pushSubscriptions: new Map(),
  e2ee_keys: new Map(),
};

// ---------- Durable In-Memory Backup (data survives server restarts even without Postgres) ----------
const DATA_DIR = path.join(process.cwd(), 'data');
const MEMORY_DB_FILE = path.join(DATA_DIR, 'memory-db.json');

function readSerializableMemoryDb() {
  return {
    users: Object.fromEntries(memoryDb.users),
    rooms: Object.fromEntries(memoryDb.rooms),
    room_members: memoryDb.room_members,
    room_bridges: Object.fromEntries(memoryDb.room_bridges),
    messages: Object.fromEntries(memoryDb.messages),
    statuses: Object.fromEntries(memoryDb.statuses),
    pinned_chats: Array.from(memoryDb.pinned_chats),
    muted_chats: Array.from(memoryDb.muted_chats),
    archived_chats: Array.from(memoryDb.archived_chats),
    marked_unread_chats: Array.from(memoryDb.marked_unread_chats),
    pendingInvites: Object.fromEntries(memoryDb.pendingInvites),
    blocked: Object.fromEntries(memoryDb.blocked),
    reports: Object.fromEntries(memoryDb.reports),
    pushSubscriptions: Object.fromEntries(memoryDb.pushSubscriptions),
    e2ee_keys: Object.fromEntries(memoryDb.e2ee_keys)
  };
}

function writeSerializableMemoryDb(data) {
  memoryDb.users = new Map(Object.entries(data.users || {}));
  memoryDb.rooms = new Map(Object.entries(data.rooms || {}));
  memoryDb.room_members = Array.isArray(data.room_members) ? data.room_members : [];
  memoryDb.room_bridges = new Map(Object.entries(data.room_bridges || {}));
  memoryDb.messages = new Map(Object.entries(data.messages || {}));
  memoryDb.statuses = new Map(Object.entries(data.statuses || {}));
  memoryDb.pinned_chats = new Set(Array.isArray(data.pinned_chats) ? data.pinned_chats : []);
  memoryDb.muted_chats = new Set(Array.isArray(data.muted_chats) ? data.muted_chats : []);
  memoryDb.archived_chats = new Set(Array.isArray(data.archived_chats) ? data.archived_chats : []);
  memoryDb.marked_unread_chats = new Set(Array.isArray(data.marked_unread_chats) ? data.marked_unread_chats : []);
  memoryDb.pendingInvites = new Map(Object.entries(data.pendingInvites || {}));
  memoryDb.blocked = new Map(Object.entries(data.blocked || {}));
  memoryDb.reports = new Map(Object.entries(data.reports || {}));
  memoryDb.pushSubscriptions = new Map(Object.entries(data.pushSubscriptions || {}));
  memoryDb.e2ee_keys = new Map(Object.entries(data.e2ee_keys || {}));
}

function saveMemoryDbNow() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_DB_FILE, JSON.stringify(readSerializableMemoryDb()));
  } catch (e) {
    console.warn('Memory DB save warning:', e.message);
  }
}

let memorySaveTimer = null;
function scheduleMemoryDbSave() {
  if (isPgConnected) return;
  if (memorySaveTimer) clearTimeout(memorySaveTimer);
  memorySaveTimer = setTimeout(() => {
    memorySaveTimer = null;
    saveMemoryDbNow();
  }, 250);
}

export async function loadMemoryDatabase() {
  try {
    if (fs.existsSync(MEMORY_DB_FILE)) {
      const raw = fs.readFileSync(MEMORY_DB_FILE, 'utf8');
      const data = JSON.parse(raw);
      writeSerializableMemoryDb(data);
      console.log('💾 In-memory database restored from disk backup.');
    }
  } catch (e) {
    console.warn('Memory DB load warning:', e.message);
  }
}

process.on('exit', saveMemoryDbNow);
process.on('SIGINT', () => {
  saveMemoryDbNow();
  process.exit(0);
});

export async function clearAllDatabaseData() {
  memoryDb.users.clear();
  memoryDb.rooms.clear();
  memoryDb.room_members = [];
  memoryDb.room_bridges.clear();
  memoryDb.messages.clear();
  memoryDb.statuses.clear();
  memoryDb.pinned_chats.clear();
  memoryDb.muted_chats.clear();
  memoryDb.archived_chats.clear();
  memoryDb.marked_unread_chats.clear();
  if (memoryDb.pendingInvites) memoryDb.pendingInvites.clear();
  if (memoryDb.e2ee_keys) memoryDb.e2ee_keys.clear();

  if (isPgConnected) {
    try {
      const client = await pool.connect();
      await client.query('TRUNCATE users, rooms, room_members, room_bridges, messages, statuses CASCADE;');
      client.release();
      console.log('🧹 PostgreSQL Database Truncated Cleanly.');
    } catch (err) {
      console.warn('PostgreSQL Truncate Notice:', err.message);
    }
  }
  console.log('🧹 All users and rooms cleared from database.');
}

export async function initDb() {
  try {
    const client = await pool.connect();
    console.log('⚡ Connected to PostgreSQL database successfully.');
    isPgConnected = true;

    // 1. Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_url TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        status VARCHAR(20) DEFAULT 'offline',
        last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        theme_preferences JSONB DEFAULT '{}',
        email_confirmed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Chat Rooms Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id VARCHAR(36) PRIMARY KEY,
        type VARCHAR(20) NOT NULL,
        name VARCHAR(100),
        description TEXT,
        avatar_url TEXT DEFAULT '',
        theme_color VARCHAR(30) DEFAULT '#128c7e',
        created_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Room Members Junction Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS room_members (
        room_id VARCHAR(36) REFERENCES rooms(id) ON DELETE CASCADE,
        user_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(20) DEFAULT 'member',
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (room_id, user_id)
      );
    `);

    // 4. Room Bridges Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS room_bridges (
        id VARCHAR(36) PRIMARY KEY,
        source_room_id VARCHAR(36) REFERENCES rooms(id) ON DELETE CASCADE,
        target_room_id VARCHAR(36) REFERENCES rooms(id) ON DELETE CASCADE,
        created_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Messages Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(36) PRIMARY KEY,
        room_id VARCHAR(36) REFERENCES rooms(id) ON DELETE CASCADE,
        sender_id VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
        text TEXT,
        type VARCHAR(20) DEFAULT 'text',
        media_url TEXT,
        reactions JSONB DEFAULT '{}',
        reply_to_id VARCHAR(36) REFERENCES messages(id) ON DELETE SET NULL,
        read_by JSONB DEFAULT '[]',
        deleted_for JSONB DEFAULT '[]',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Per-user soft-delete support (WhatsApp-style "delete for me")
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for JSONB DEFAULT '[]';`);
    await client.query(`UPDATE messages SET deleted_for = '[]' WHERE deleted_for IS NULL;`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS cleared_by JSONB DEFAULT '[]';`);
    await client.query(`UPDATE rooms SET cleared_by = '[]' WHERE cleared_by IS NULL;`);

    // Status replies: a DM message that quotes a status snapshot (WhatsApp-style)
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS status_reply JSONB;`);

    // 6. Status / Stories Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_statuses (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        text TEXT DEFAULT '',
        media_url TEXT DEFAULT '',
        media_type VARCHAR(20) DEFAULT 'image',
        bg_color VARCHAR(30) DEFAULT '#128c7e',
        reactions JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`ALTER TABLE user_statuses ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}';`);

    // Create performance indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);`);

    // 7. Pending Friend Invites Table (auto-connect once invitee confirms email)
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_invites (
        id VARCHAR(36) PRIMARY KEY,
        invitee_email VARCHAR(100) NOT NULL,
        inviter_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (invitee_email, inviter_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_invites_email ON pending_invites(invitee_email);`);

    // 8. Blocked Users Table (WhatsApp-style privacy)
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        blocker_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        blocked_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (blocker_id, blocked_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_blocked_blocker ON blocked_users(blocker_id);`);

    // 9. Message Reports Table (moderation inbox)
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_reports (
        id VARCHAR(36) PRIMARY KEY,
        message_id VARCHAR(36) REFERENCES messages(id) ON DELETE CASCADE,
        reporter_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        room_id VARCHAR(36) REFERENCES rooms(id) ON DELETE CASCADE,
        reason TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reports_message ON message_reports(message_id);`);
    await client.query(`ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';`);
    await client.query(`ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(36);`);
    await client.query(`ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP WITH TIME ZONE;`);

    // 10. Web Push Subscriptions Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (endpoint)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);`);

    // 11. Extra columns for new features
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS disappearing_timer INT DEFAULT 0;`);
    await client.query(`UPDATE rooms SET disappearing_timer = 0 WHERE disappearing_timer IS NULL;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_preferences JSONB DEFAULT '{}';`);
    await client.query(`UPDATE users SET privacy_preferences = '{}' WHERE privacy_preferences IS NULL;`);
    await client.query(`ALTER TABLE users ALTER COLUMN status SET DEFAULT 'offline';`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_timestamps JSONB DEFAULT '{}';`);
    await client.query(`UPDATE messages SET read_timestamps = '{}' WHERE read_timestamps IS NULL;`);

    // 12. End-to-End Encryption keys (server only stores PUBLIC keys - private keys never leave the client)
    await client.query(`
      CREATE TABLE IF NOT EXISTS e2ee_keys (
        user_id VARCHAR(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        signed_prekey TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // WhatsApp-style signed identity bundle: the ECDSA signing public key and the
    // signature proving the ECDH identity key belongs to this user_id.
    await client.query(`ALTER TABLE e2ee_keys ADD COLUMN IF NOT EXISTS sign_public_key TEXT;`);
    await client.query(`ALTER TABLE e2ee_keys ADD COLUMN IF NOT EXISTS signature TEXT;`);

    // 13. Extra message columns for E2EE + forwarding + delete-for-everyone
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS e2ee BOOLEAN DEFAULT FALSE;`);
    await client.query(`UPDATE messages SET e2ee = FALSE WHERE e2ee IS NULL;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded BOOLEAN DEFAULT FALSE;`);
    await client.query(`UPDATE messages SET forwarded = FALSE WHERE forwarded IS NULL;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from VARCHAR(36);`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN DEFAULT FALSE;`);
    await client.query(`UPDATE messages SET deleted_for_everyone = FALSE WHERE deleted_for_everyone IS NULL;`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS admins_only_post BOOLEAN DEFAULT FALSE;`);

    // 14. Message editing support (WhatsApp-style "edited" label + timestamp)
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP WITH TIME ZONE;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edit_count INT DEFAULT 0;`);
    await client.query(`UPDATE messages SET edit_count = 0 WHERE edit_count IS NULL;`);

    // 15. Starred messages (per-user bookmark, WhatsApp-style)
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS starred_by JSONB DEFAULT '[]';`);
    await client.query(`UPDATE messages SET starred_by = '[]' WHERE starred_by IS NULL;`);

    client.release();
    console.log('✅ PostgreSQL Schema & Indexes Verified.');
  } catch (err) {
    console.warn('⚠️ Could not connect to external PostgreSQL server:', err.message);
    console.log('🚀 Operating in High-Performance Resilient Dual Database Mode (In-Memory Postgres Emulation active).');
    isPgConnected = false;
    await loadMemoryDatabase();
  }
}

// Load a user's pinned chats from PostgreSQL (theme_preferences.pinned_rooms).
// Returns a Set of room ids, or null when running in memory-only mode (in that
// case the durable memory DB already holds the pins). Also hydrates the
// in-memory set so toggle/cleanup logic stays consistent within this session.
async function loadPinnedChatsForUser(userId) {
  if (!isPgConnected || !userId) return null;
  try {
    const res = await pool.query(`SELECT theme_preferences FROM users WHERE id = $1`, [userId]);
    const prefs = res.rows[0]?.theme_preferences || {};
    const pins = Array.isArray(prefs.pinned_rooms) ? prefs.pinned_rooms : [];
    for (const roomId of pins) {
      if (roomId) memoryDb.pinned_chats.add(`${userId}:${roomId}`);
    }
    return new Set(pins);
  } catch (e) {
    // On error, fall back to whatever the in-memory set holds.
    console.warn('Load pinned chats error:', e.message);
    return null;
  }
}

// Load a user's muted chats from PostgreSQL (theme_preferences.muted_rooms).
// Returns a Set of room ids, or null when running in memory-only mode (in that
// case the durable memory DB already holds the mutes).
async function loadMutedChatsForUser(userId) {
  if (!isPgConnected || !userId) return null;
  try {
    const res = await pool.query(`SELECT theme_preferences FROM users WHERE id = $1`, [userId]);
    const prefs = res.rows[0]?.theme_preferences || {};
    const muted = Array.isArray(prefs.muted_rooms) ? prefs.muted_rooms : [];
    for (const roomId of muted) {
      if (roomId) memoryDb.muted_chats.add(`${userId}:${roomId}`);
    }
    return new Set(muted);
  } catch (e) {
    console.warn('Load muted chats error:', e.message);
    return null;
  }
}

// Load a user's archived chats from PostgreSQL (theme_preferences.archived_rooms).
async function loadArchivedChatsForUser(userId) {
  if (!isPgConnected || !userId) return null;
  try {
    const res = await pool.query(`SELECT theme_preferences FROM users WHERE id = $1`, [userId]);
    const prefs = res.rows[0]?.theme_preferences || {};
    const archived = Array.isArray(prefs.archived_rooms) ? prefs.archived_rooms : [];
    for (const roomId of archived) {
      if (roomId) memoryDb.archived_chats.add(`${userId}:${roomId}`);
    }
    return new Set(archived);
  } catch (e) {
    console.warn('Load archived chats error:', e.message);
    return null;
  }
}

// Load a user's manually-marked-unread chats from PostgreSQL
// (theme_preferences.marked_unread_rooms).
async function loadMarkedUnreadForUser(userId) {
  if (!isPgConnected || !userId) return null;
  try {
    const res = await pool.query(`SELECT theme_preferences FROM users WHERE id = $1`, [userId]);
    const prefs = res.rows[0]?.theme_preferences || {};
    const unread = Array.isArray(prefs.marked_unread_rooms) ? prefs.marked_unread_rooms : [];
    for (const roomId of unread) {
      if (roomId) memoryDb.marked_unread_chats.add(`${userId}:${roomId}`);
    }
    return new Set(unread);
  } catch (e) {
    console.warn('Load marked unread chats error:', e.message);
    return null;
  }
}

export const db = {
  isPgConnected: () => isPgConnected,

  // User Operations
  createUser: async ({ username, email, passwordHash, avatarUrl, bio, emailConfirmed = true }) => {
    const id = uuidv4();
    const defaultTheme = {
      bubbleColorSender: '#128c7e',
      bubbleColorReceiver: '#1f2c34',
      chatBarShape: 'floating-pill',
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 'medium',
      backgroundWallpaper: 'wallpaper-mesh-dark',
      sendButtonStyle: 'gradient-circle'
    };

    if (isPgConnected) {
      const res = await pool.query(
        `INSERT INTO users (id, username, email, password_hash, avatar_url, bio, theme_preferences, email_confirmed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, username, email, avatar_url, bio, status, last_seen, theme_preferences, email_confirmed, created_at`,
        [id, username, email, passwordHash, avatarUrl || '', bio || '', JSON.stringify(defaultTheme), emailConfirmed]
      );
      return res.rows[0];
    } else {
      const user = {
        id,
        username,
        email,
        password_hash: passwordHash,
        avatar_url: avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`,
        bio: bio || 'Available on PulseRoom',
        status: 'offline',
        last_seen: new Date().toISOString(),
        theme_preferences: defaultTheme,
        email_confirmed: emailConfirmed,
        created_at: new Date().toISOString()
      };
      memoryDb.users.set(id, user);
      scheduleMemoryDbSave();
      return user;
    }
  },

  updateUserProfile: async (userId, { username, avatarUrl, bio }) => {
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE users
         SET username = COALESCE($1, username),
             avatar_url = COALESCE($2, avatar_url),
             bio = COALESCE($3, bio)
         WHERE id = $4
         RETURNING id, username, email, avatar_url, bio, status, last_seen, theme_preferences`,
        [username || null, avatarUrl || null, bio || null, userId]
      );
      return res.rows[0];
    } else {
      const u = memoryDb.users.get(userId);
      if (u) {
        if (username) u.username = username;
        if (avatarUrl) u.avatar_url = avatarUrl;
        if (bio !== undefined) u.bio = bio;
        scheduleMemoryDbSave();
        const { password_hash, ...safeUser } = u;
        return safeUser;
      }
      return null;
    }
  },

  confirmUserEmail: async (email) => {
    if (isPgConnected) {
      const res = await pool.query(`UPDATE users SET email_confirmed = TRUE WHERE LOWER(email) = LOWER($1) RETURNING *`, [email]);
      return res.rows[0];
    } else {
      for (const u of memoryDb.users.values()) {
        if (u.email.toLowerCase() === email.toLowerCase()) {
          u.email_confirmed = true;
          scheduleMemoryDbSave();
          return u;
        }
      }
      return null;
    }
  },

  findUserByEmail: async (email) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT * FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
      return res.rows[0];
    } else {
      for (const u of memoryDb.users.values()) {
        if (u.email.toLowerCase() === email.toLowerCase()) return u;
      }
      return null;
    }
  },

  findUserById: async (id) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT id, username, email, avatar_url, bio, status, last_seen, theme_preferences, email_confirmed, created_at FROM users WHERE id = $1`, [id]);
      return res.rows[0];
    } else {
      const u = memoryDb.users.get(id);
      if (!u) return null;
      const { password_hash, ...safeUser } = u;
      return safeUser;
    }
  },

  getAllUsers: async (currentUserId) => {
    if (isPgConnected) {
      const blockedIds = await db.getBlockedUserIds(currentUserId);
      const blockerRows = await pool.query(`SELECT blocker_id FROM blocked_users WHERE blocked_id = $1`, [currentUserId]);
      const exclude = new Set([...blockedIds, ...blockerRows.rows.map(r => r.blocker_id), currentUserId]);

      const res = await pool.query(
        `SELECT id, username, email, avatar_url, bio, status, last_seen, privacy_preferences FROM users WHERE id != $1 ORDER BY username ASC`,
        [currentUserId]
      );

      const contactRes = await pool.query(
        `SELECT DISTINCT rm2.user_id FROM room_members rm1 JOIN room_members rm2 ON rm1.room_id = rm2.room_id WHERE rm1.user_id = $1 AND rm2.user_id != $1`,
        [currentUserId]
      );
      const contacts = new Set(contactRes.rows.map(r => r.user_id));

      return res.rows
        .filter(u => !exclude.has(u.id))
        .map(u => {
          const setting = (u.privacy_preferences || {}).last_seen || 'everyone';
          const allowed = setting === 'everyone' || (setting === 'contacts' && contacts.has(u.id));
          return {
            id: u.id,
            username: u.username,
            email: u.email,
            avatar_url: u.avatar_url,
            bio: u.bio,
            status: allowed ? u.status : 'offline',
            last_seen: allowed ? u.last_seen : null,
            privacy_preferences: u.privacy_preferences
          };
        });
    } else {
      const myBlocked = await db.getBlockedUserIds(currentUserId);
      const blockers = [];
      for (const [blocker, list] of (memoryDb.blocked || new Map())) {
        if (list.includes(currentUserId)) blockers.push(blocker);
      }
      const exclude = new Set([...myBlocked, ...blockers, currentUserId]);
      const users = [];
      for (const u of memoryDb.users.values()) {
        if (exclude.has(u.id)) continue;
        const { password_hash, ...safeUser } = u;
        users.push(safeUser);
      }
      return users;
    }
  },

  updateUserStatus: async (userId, status) => {
    const lastSeen = new Date().toISOString();
    if (isPgConnected) {
      await pool.query(`UPDATE users SET status = $1, last_seen = $2 WHERE id = $3`, [status, lastSeen, userId]);
    } else {
      const u = memoryDb.users.get(userId);
      if (u) {
        u.status = status;
        u.last_seen = lastSeen;
        scheduleMemoryDbSave();
      }
    }
  },

  updateUserTheme: async (userId, themePreferences) => {
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE users SET theme_preferences = $1 WHERE id = $2 RETURNING theme_preferences`,
        [JSON.stringify(themePreferences), userId]
      );
      return res.rows[0]?.theme_preferences;
    } else {
      const u = memoryDb.users.get(userId);
      if (u) {
        u.theme_preferences = { ...u.theme_preferences, ...themePreferences };
        scheduleMemoryDbSave();
        return u.theme_preferences;
      }
      return null;
    }
  },

  resetUserPassword: async (email, newPasswordHash) => {
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE users SET password_hash = $1 WHERE LOWER(email) = LOWER($2) RETURNING id, username, email`,
        [newPasswordHash, email]
      );
      return res.rows[0];
    } else {
      for (const u of memoryDb.users.values()) {
        if (u.email.toLowerCase() === email.toLowerCase()) {
          u.password_hash = newPasswordHash;
          scheduleMemoryDbSave();
          return { id: u.id, username: u.username, email: u.email };
        }
      }
      return null;
    }
  },

  // Room Operations
  createRoom: async ({ type, name, description, avatarUrl, themeColor, createdBy, members }) => {
    const id = uuidv4();
    if (isPgConnected) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const roomRes = await client.query(
          `INSERT INTO rooms (id, type, name, description, avatar_url, theme_color, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [id, type, name || null, description || null, avatarUrl || '', themeColor || '#128c7e', createdBy]
        );

        const allMembers = Array.from(new Set([createdBy, ...(members || [])]));
        for (const memberId of allMembers) {
          const role = (memberId === createdBy && type === 'group') ? 'admin' : 'member';
          await client.query(
            `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)`,
            [id, memberId, role]
          );
        }

        await client.query('COMMIT');
        return roomRes.rows[0];
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } else {
      const room = {
        id,
        type,
        name: name || null,
        description: description || null,
        avatar_url: avatarUrl || '',
        theme_color: themeColor || '#128c7e',
        created_by: createdBy,
        cleared_by: [],
        created_at: new Date().toISOString()
      };
      memoryDb.rooms.set(id, room);

      const allMembers = Array.from(new Set([createdBy, ...(members || [])]));
      for (const memberId of allMembers) {
        memoryDb.room_members.push({
          room_id: id,
          user_id: memberId,
          role: (memberId === createdBy && type === 'group') ? 'admin' : 'member',
          joined_at: new Date().toISOString()
        });
      }
      scheduleMemoryDbSave();
      return room;
    }
  },

  createGroupRoom: async ({ name, description, avatarUrl, themeColor, createdBy, memberIds }) => {
    return await db.createRoom({
      type: 'group',
      name,
      description,
      avatarUrl,
      themeColor,
      createdBy,
      members: memberIds
    });
  },

  getRoomMemberIds: async (roomId) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT user_id FROM room_members WHERE room_id = $1`, [roomId]);
      return res.rows.map(r => r.user_id);
    } else {
      return memoryDb.room_members.filter(m => m.room_id === roomId).map(m => m.user_id);
    }
  },

  getRoomById: async (roomId) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT * FROM rooms WHERE id = $1`, [roomId]);
      return res.rows[0] || null;
    } else {
      return memoryDb.rooms.get(roomId) || null;
    }
  },

  isRoomMember: async (roomId, userId) => {
    if (!roomId || !userId) return false;
    const memberIds = await db.getRoomMemberIds(roomId);
    return memberIds.includes(userId);
  },

  // ---------- Blocked Users ----------
  blockUser: async (blockerId, blockedId) => {
    if (blockerId === blockedId) return { blocked: false };
    if (isPgConnected) {
      await pool.query(
        `INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [blockerId, blockedId]
      );
    } else {
      if (!memoryDb.blocked) memoryDb.blocked = new Map();
      if (!memoryDb.blocked.has(blockerId)) memoryDb.blocked.set(blockerId, []);
      const list = memoryDb.blocked.get(blockerId);
      if (!list.includes(blockedId)) list.push(blockedId);
      scheduleMemoryDbSave();
    }
    return { blocked: true };
  },

  unblockUser: async (blockerId, blockedId) => {
    if (isPgConnected) {
      await pool.query(`DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2`, [blockerId, blockedId]);
    } else {
      if (memoryDb.blocked?.has(blockerId)) {
        memoryDb.blocked.set(blockerId, memoryDb.blocked.get(blockerId).filter(id => id !== blockedId));
        scheduleMemoryDbSave();
      }
    }
    return { blocked: false };
  },

  getBlockedUserIds: async (userId) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT blocked_id FROM blocked_users WHERE blocker_id = $1`, [userId]);
      return res.rows.map(r => r.blocked_id);
    } else {
      return (memoryDb.blocked?.get(userId)) || [];
    }
  },

  isBlockedBetween: async (userAId, userBId) => {
    if (!userAId || !userBId) return false;
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT 1 FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
        [userAId, userBId]
      );
      return res.rows.length > 0;
    } else {
      const a = await db.getBlockedUserIds(userAId);
      const b = await db.getBlockedUserIds(userBId);
      return a.includes(userBId) || b.includes(userAId);
    }
  },

  // ---------- Message Reports ----------
  reportMessage: async ({ messageId, reporterId, roomId, reason }) => {
    const id = uuidv4();
    if (isPgConnected) {
      await pool.query(
        `INSERT INTO message_reports (id, message_id, reporter_id, room_id, reason) VALUES ($1, $2, $3, $4, $5)`,
        [id, messageId, reporterId, roomId, reason || '']
      );
    } else {
      if (!memoryDb.reports) memoryDb.reports = new Map();
      memoryDb.reports.set(id, {
        id,
        message_id: messageId,
        reporter_id: reporterId,
        room_id: roomId,
        reason: reason || '',
        status: 'pending',
        resolved_by: null,
        resolved_at: null,
        created_at: new Date().toISOString()
      });
      scheduleMemoryDbSave();
    }
    return { id };
  },

  // ---------- Moderation Inbox ----------
  // Full report rows with message content, sender, reporter and room info.
  getReports: async ({ status } = {}) => {
    const filter = status === 'pending' || status === 'resolved' || status === 'dismissed' ? status : null;
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT rep.id, rep.message_id, rep.reporter_id, rep.room_id, rep.reason, rep.status,
                rep.resolved_by, rep.resolved_at, rep.created_at,
                m.text AS message_text, m.type AS message_type, m.e2ee AS message_e2ee,
                m.created_at AS message_created_at,
                ms.id AS sender_id, ms.username AS sender_username, ms.avatar_url AS sender_avatar,
                rp.username AS reporter_username, rp.avatar_url AS reporter_avatar,
                r.name AS room_name, r.type AS room_type
         FROM message_reports rep
         JOIN messages m ON m.id = rep.message_id
         JOIN users ms ON ms.id = m.sender_id
         JOIN users rp ON rp.id = rep.reporter_id
         LEFT JOIN rooms r ON r.id = rep.room_id
         WHERE ($1::text IS NULL OR rep.status = $1)
         ORDER BY rep.created_at DESC`,
        [filter]
      );
      return res.rows;
    } else {
      const out = [];
      for (const rep of (memoryDb.reports || new Map()).values()) {
        if (filter && rep.status !== filter) continue;
        const msg = memoryDb.messages.get(rep.message_id);
        const sender = msg ? memoryDb.users.get(msg.sender_id) : null;
        const reporter = memoryDb.users.get(rep.reporter_id);
        const room = memoryDb.rooms.get(rep.room_id);
        out.push({
          ...rep,
          message_text: msg ? msg.text : null,
          message_type: msg ? msg.type : null,
          message_e2ee: msg ? Boolean(msg.e2ee) : null,
          message_created_at: msg ? msg.created_at : null,
          sender_id: msg ? msg.sender_id : null,
          sender_username: sender ? sender.username : 'Unknown',
          sender_avatar: sender ? sender.avatar_url : '',
          reporter_username: reporter ? reporter.username : 'Unknown',
          reporter_avatar: reporter ? reporter.avatar_url : '',
          room_name: room ? room.name : null,
          room_type: room ? room.type : null
        });
      }
      return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
  },

  updateReportStatus: async (reportId, moderatorId, status) => {
    if (status !== 'pending' && status !== 'resolved' && status !== 'dismissed') return null;
    const now = new Date().toISOString();
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE message_reports
         SET status = $2, resolved_by = $3, resolved_at = $4
         WHERE id = $1
         RETURNING id, status, resolved_by, resolved_at`,
        [reportId, status, moderatorId, now]
      );
      return res.rows[0] || null;
    } else {
      const rep = (memoryDb.reports || new Map()).get(reportId);
      if (!rep) return null;
      rep.status = status;
      rep.resolved_by = moderatorId;
      rep.resolved_at = now;
      scheduleMemoryDbSave();
      return { id: rep.id, status: rep.status, resolved_by: rep.resolved_by, resolved_at: rep.resolved_at };
    }
  },

  // ---------- Privacy Preferences ----------
  getPrivacyPrefs: async (userId) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT privacy_preferences FROM users WHERE id = $1`, [userId]);
      return res.rows[0]?.privacy_preferences || {};
    } else {
      const u = memoryDb.users.get(userId);
      return u?.privacy_preferences || {};
    }
  },

  updatePrivacyPrefs: async (userId, prefs) => {
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE users SET privacy_preferences = $1 WHERE id = $2 RETURNING privacy_preferences`,
        [JSON.stringify(prefs || {}), userId]
      );
      return res.rows[0]?.privacy_preferences || {};
    } else {
      const u = memoryDb.users.get(userId);
      if (u) {
        u.privacy_preferences = { ...(u.privacy_preferences || {}), ...(prefs || {}) };
        scheduleMemoryDbSave();
        return u.privacy_preferences;
      }
      return {};
    }
  },

  // Returns true when the *viewer* is allowed to see target's last_seen/status.
  canSeeLastSeen: async (viewerId, targetUser) => {
    if (!targetUser) return false;
    if (targetUser.status === 'online') return true;
    const prefs = targetUser.privacy_preferences || {};
    const setting = prefs.last_seen || 'everyone';
    if (setting === 'everyone') return true;
    if (setting === 'nobody') return false;
    // 'contacts': only if they share a room (i.e. are in contact)
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT 1 FROM room_members rm1
         JOIN room_members rm2 ON rm1.room_id = rm2.room_id
         WHERE rm1.user_id = $1 AND rm2.user_id = $2 LIMIT 1`,
        [viewerId, targetUser.id]
      );
      return res.rows.length > 0;
    }
    return memoryDb.room_members.some(m => m.user_id === viewerId &&
      memoryDb.room_members.some(m2 => m2.user_id === targetUser.id && m2.room_id === m.room_id));
  },

  // ---------- Read Receipts ----------
  markRoomMessagesRead: async (roomId, userId) => {
    const timestamp = new Date().toISOString();
    if (isPgConnected) {
      // $4 carries a JSON array of the reader id: `COALESCE(read_by,'[]') || $4::jsonb`
      // must receive a valid JSON value. Passing the raw UUID string as $2::jsonb
      // made Postgres throw "invalid input syntax for type json", silently breaking
      // read receipts (the handler caught the error and emitted nothing).
      const res = await pool.query(
        `UPDATE messages
         SET read_by = CASE WHEN COALESCE(read_by, '[]') ? $2::text THEN read_by ELSE COALESCE(read_by, '[]') || $4::jsonb END,
             read_timestamps = COALESCE(read_timestamps, '{}') || $3::jsonb
         WHERE room_id = $1 AND sender_id != $2 AND NOT (COALESCE(read_by, '[]') ? $2::text)
         RETURNING id`,
        [roomId, userId, JSON.stringify({ [userId]: timestamp }), JSON.stringify([userId])]
      );
      return { roomId, userId, timestamp, messageIds: res.rows.map(r => r.id) };
    } else {
      const messageIds = [];
      for (const msg of memoryDb.messages.values()) {
        if (msg.room_id !== roomId || msg.sender_id === userId) continue;
        if (Array.isArray(msg.read_by) && msg.read_by.includes(userId)) continue;
        if (!Array.isArray(msg.read_by)) msg.read_by = [];
        msg.read_by.push(userId);
        if (!msg.read_timestamps) msg.read_timestamps = {};
        msg.read_timestamps[userId] = timestamp;
        messageIds.push(msg.id);
      }
      if (messageIds.length > 0) scheduleMemoryDbSave();
      return { roomId, userId, timestamp, messageIds };
    }
  },

  // ---------- Disappearing Messages ----------
  setRoomDisappearingTimer: async (roomId, seconds) => {
    const timer = Number(seconds) > 0 ? Math.floor(Number(seconds)) : 0;
    if (isPgConnected) {
      await pool.query(`UPDATE rooms SET disappearing_timer = $1 WHERE id = $2`, [timer, roomId]);
    } else {
      const room = memoryDb.rooms.get(roomId);
      if (room) {
        room.disappearing_timer = timer;
        scheduleMemoryDbSave();
      }
    }
    return { roomId, disappearing_timer: timer };
  },

  getRoomDisappearingTimer: async (roomId) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT disappearing_timer FROM rooms WHERE id = $1`, [roomId]);
      return res.rows[0]?.disappearing_timer || 0;
    } else {
      return memoryDb.rooms.get(roomId)?.disappearing_timer || 0;
    }
  },

  cleanupExpiredDisappearingMessages: async () => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT m.room_id, array_agg(m.id) as ids
         FROM messages m
         JOIN rooms r ON r.id = m.room_id
         WHERE r.disappearing_timer > 0
           AND m.created_at < NOW() - (r.disappearing_timer * INTERVAL '1 second')
         GROUP BY m.room_id`
      );
      for (const row of res.rows) {
        await pool.query(`DELETE FROM messages WHERE id = ANY($1::varchar[])`, [row.ids]);
      }
      return res.rows.map(r => ({ roomId: r.room_id, messageIds: r.ids }));
    } else {
      const now = Date.now();
      const expiredByRoom = new Map();
      for (const [id, msg] of memoryDb.messages.entries()) {
        const room = memoryDb.rooms.get(msg.room_id);
        const timer = room?.disappearing_timer || 0;
        if (timer > 0 && now - new Date(msg.created_at).getTime() > timer * 1000) {
          if (!expiredByRoom.has(msg.room_id)) expiredByRoom.set(msg.room_id, []);
          expiredByRoom.get(msg.room_id).push(id);
        }
      }
      const result = [];
      for (const [roomId, ids] of expiredByRoom) {
        for (const id of ids) memoryDb.messages.delete(id);
        result.push({ roomId, messageIds: ids });
      }
      if (result.length > 0) scheduleMemoryDbSave();
      return result;
    }
  },

  // ---------- Web Push Subscriptions ----------
  savePushSubscription: async ({ userId, endpoint, p256dh, auth }) => {
    const id = uuidv4();
    if (isPgConnected) {
      await pool.query(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = $4, auth = $5`,
        [id, userId, endpoint, p256dh, auth]
      );
    } else {
      if (!memoryDb.pushSubscriptions) memoryDb.pushSubscriptions = new Map();
      memoryDb.pushSubscriptions.set(endpoint, { id, user_id: userId, endpoint, p256dh, auth, created_at: new Date().toISOString() });
      scheduleMemoryDbSave();
    }
    return { ok: true };
  },

  removePushSubscription: async (endpoint) => {
    if (isPgConnected) {
      await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    } else {
      if (memoryDb.pushSubscriptions?.has(endpoint)) {
        memoryDb.pushSubscriptions.delete(endpoint);
        scheduleMemoryDbSave();
      }
    }
  },

  getPushSubscriptions: async (userId) => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
        [userId]
      );
      return res.rows;
    } else {
      return Array.from((memoryDb.pushSubscriptions || new Map()).values())
        .filter(s => s.user_id === userId)
        .map(s => ({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }));
    }
  },

  getBridgesForUser: async (userId) => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT rb.*, r.name AS target_room_name, r.avatar_url AS target_room_avatar
         FROM room_bridges rb
         JOIN rooms r ON rb.target_room_id = r.id
         JOIN room_members rm ON rm.room_id = rb.source_room_id
         WHERE rm.user_id = $1`,
        [userId]
      );
      return res.rows;
    } else {
      const bridges = [];
      for (const b of memoryDb.room_bridges.values()) {
        const isMember = memoryDb.room_members.some(m => m.room_id === b.source_room_id && m.user_id === userId);
        if (!isMember) continue;
        const targetRoom = memoryDb.rooms.get(b.target_room_id);
        bridges.push({
          ...b,
          target_room_name: targetRoom ? targetRoom.name : 'Linked Room',
          target_room_avatar: targetRoom ? targetRoom.avatar_url : ''
        });
      }
      return bridges;
    }
  },

  addRoomMembers: async (roomId, memberIds) => {
    const toAdd = Array.from(new Set(memberIds || []));
    if (toAdd.length === 0) return db.getRoomMemberIds(roomId);

    if (isPgConnected) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const memberId of toAdd) {
          await client.query(
            `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')
             ON CONFLICT (room_id, user_id) DO NOTHING`,
            [roomId, memberId]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return db.getRoomMemberIds(roomId);
    } else {
      const existing = new Set(memoryDb.room_members.filter(m => m.room_id === roomId).map(m => m.user_id));
      for (const memberId of toAdd) {
        if (!existing.has(memberId)) {
          memoryDb.room_members.push({
            room_id: roomId,
            user_id: memberId,
            role: 'member',
            joined_at: new Date().toISOString()
          });
        }
      }
      scheduleMemoryDbSave();
      return memoryDb.room_members.filter(m => m.room_id === roomId).map(m => m.user_id);
    }
  },

  deleteRoom: async (roomId) => {
    if (isPgConnected) {
      const res = await pool.query(`DELETE FROM rooms WHERE id = $1 RETURNING id, type, name`, [roomId]);
      return res.rows[0] || null;
    } else {
      const room = memoryDb.rooms.get(roomId);
      if (!room) return null;
      memoryDb.rooms.delete(roomId);
      memoryDb.room_members = memoryDb.room_members.filter(m => m.room_id !== roomId);
      for (const [id, msg] of memoryDb.messages.entries()) {
        if (msg.room_id === roomId) memoryDb.messages.delete(id);
      }
      for (const [id, bridge] of memoryDb.room_bridges.entries()) {
        if (bridge.source_room_id === roomId || bridge.target_room_id === roomId) memoryDb.room_bridges.delete(id);
      }
      for (const key of memoryDb.pinned_chats) {
        if (key.endsWith(`:${roomId}`)) memoryDb.pinned_chats.delete(key);
      }
      for (const key of memoryDb.muted_chats) {
        if (key.endsWith(`:${roomId}`)) memoryDb.muted_chats.delete(key);
      }
      for (const key of memoryDb.archived_chats) {
        if (key.endsWith(`:${roomId}`)) memoryDb.archived_chats.delete(key);
      }
      for (const key of memoryDb.marked_unread_chats) {
        if (key.endsWith(`:${roomId}`)) memoryDb.marked_unread_chats.delete(key);
      }
      scheduleMemoryDbSave();
      return room;
    }
  },

  getOrCreatePrivateRoom: async (user1Id, user2Id) => {
    let room = null;
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT r.* FROM rooms r
         JOIN room_members rm1 ON r.id = rm1.room_id
         JOIN room_members rm2 ON r.id = rm2.room_id
         WHERE r.type = 'private' AND rm1.user_id = $1 AND rm2.user_id = $2`,
        [user1Id, user2Id]
      );
      if (res.rows.length > 0) {
        room = res.rows[0];
      } else {
        room = await db.createRoom({
          type: 'private',
          createdBy: user1Id,
          members: [user2Id]
        });
      }
    } else {
      for (const r of memoryDb.rooms.values()) {
        if (r.type === 'private') {
          const members = memoryDb.room_members.filter(m => m.room_id === r.id).map(m => m.user_id);
          if (members.includes(user1Id) && members.includes(user2Id)) {
            room = { ...r };
            break;
          }
        }
      }
      if (!room) {
        room = await db.createRoom({
          type: 'private',
          createdBy: user1Id,
          members: [user2Id]
        });
      }
    }

    const partnerUser = await db.findUserById(user2Id);
    if (partnerUser) {
      const { password_hash, ...safePartner } = partnerUser;
      room.partner = safePartner;
    }
    return room;
  },

  // Pending Friend Invites (auto-connect once the invitee confirms their email)
  createPendingInvite: async ({ inviteeEmail, inviterId }) => {
    const cleanEmail = inviteeEmail.trim().toLowerCase();
    if (isPgConnected) {
      const id = uuidv4();
      await pool.query(
        `INSERT INTO pending_invites (id, invitee_email, inviter_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (invitee_email, inviter_id) DO NOTHING`,
        [id, cleanEmail, inviterId]
      );
    } else {
      if (!memoryDb.pendingInvites.has(cleanEmail)) memoryDb.pendingInvites.set(cleanEmail, []);
      const arr = memoryDb.pendingInvites.get(cleanEmail);
      if (!arr.includes(inviterId)) arr.push(inviterId);
      scheduleMemoryDbSave();
    }
  },

  getPendingInvitesByEmail: async (email) => {
    const cleanEmail = email.trim().toLowerCase();
    if (isPgConnected) {
      const res = await pool.query(`SELECT inviter_id FROM pending_invites WHERE LOWER(invitee_email) = LOWER($1)`, [cleanEmail]);
      return res.rows.map(r => r.inviter_id);
    } else {
      return memoryDb.pendingInvites.get(cleanEmail) || [];
    }
  },

  deletePendingInvite: async (email, inviterId) => {
    const cleanEmail = email.trim().toLowerCase();
    if (isPgConnected) {
      await pool.query(`DELETE FROM pending_invites WHERE LOWER(invitee_email) = LOWER($1) AND inviter_id = $2`, [cleanEmail, inviterId]);
    } else {
      const arr = memoryDb.pendingInvites.get(cleanEmail);
      if (arr) {
        const filtered = arr.filter(id => id !== inviterId);
        if (filtered.length === 0) memoryDb.pendingInvites.delete(cleanEmail);
        else memoryDb.pendingInvites.set(cleanEmail, filtered);
        scheduleMemoryDbSave();
      }
    }
  },

  getUserRooms: async (userId) => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT r.*, rm.role,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.room_id = r.id
                   AND m.sender_id != $1
                   AND NOT (COALESCE(m.deleted_for, '[]') ? $1)
                   AND NOT COALESCE(m.deleted_for_everyone, FALSE)
                   AND NOT (COALESCE(m.read_by, '[]') ? $1)) as unread_count,
                (SELECT JSON_BUILD_OBJECT('id', m.id, 'text', m.text, 'sender_id', m.sender_id, 'created_at', m.created_at, 'e2ee', COALESCE(m.e2ee, FALSE), 'type', COALESCE(m.type, 'text'))
                 FROM messages m
                 WHERE m.room_id = r.id AND NOT (COALESCE(m.deleted_for, '[]') ? $1)
                 ORDER BY m.created_at DESC LIMIT 1) as last_message
         FROM rooms r
         JOIN room_members rm ON r.id = rm.room_id
         WHERE rm.user_id = $1 AND NOT (COALESCE(r.cleared_by, '[]') ? $1)
         ORDER BY r.created_at DESC`,
        [userId]
      );

      const rooms = res.rows;

      // Pinned chats are persisted per-user in theme_preferences.pinned_rooms so
      // they survive server restarts (PostgreSQL), not just the in-memory set.
      const pinnedSet = await loadPinnedChatsForUser(userId);
      const mutedSet = await loadMutedChatsForUser(userId);
      const archivedSet = await loadArchivedChatsForUser(userId);
      const unreadSet = await loadMarkedUnreadForUser(userId);

      for (const room of rooms) {
        if (room.type === 'private') {
          const partnerRes = await pool.query(
            `SELECT u.id, u.username, u.avatar_url, u.status, u.last_seen, u.bio, u.privacy_preferences
             FROM users u
             JOIN room_members rm ON u.id = rm.user_id
             WHERE rm.room_id = $1 AND u.id != $2`,
            [room.id, userId]
          );
          const partner = partnerRes.rows[0] || null;
          if (partner) {
            const setting = (partner.privacy_preferences || {}).last_seen || 'everyone';
            const allowed = setting !== 'nobody';
            if (!allowed && partner.status !== 'online') {
              partner.status = 'offline';
              partner.last_seen = null;
            }
          }
          room.partner = partner;
        } else {
          const membersRes = await pool.query(
            `SELECT u.id, u.username, u.avatar_url, rm.role
             FROM users u
             JOIN room_members rm ON u.id = rm.user_id
             WHERE rm.room_id = $1`,
            [room.id]
          );
          room.members = membersRes.rows;
        }
        room.is_pinned = pinnedSet ? pinnedSet.has(room.id) : memoryDb.pinned_chats.has(`${userId}:${room.id}`);
        room.is_muted = mutedSet ? mutedSet.has(room.id) : memoryDb.muted_chats.has(`${userId}:${room.id}`);
        room.is_archived = archivedSet ? archivedSet.has(room.id) : memoryDb.archived_chats.has(`${userId}:${room.id}`);
        room.is_unread = unreadSet ? unreadSet.has(room.id) : memoryDb.marked_unread_chats.has(`${userId}:${room.id}`);
        room.disappearing_seconds = room.disappearing_timer || 0;
      }
      return rooms;
    } else {
      const userRooms = [];
      const userMemberEntries = memoryDb.room_members.filter(m => m.user_id === userId);

      for (const entry of userMemberEntries) {
        const room = memoryDb.rooms.get(entry.room_id);
        if (!room) continue;
        if (Array.isArray(room.cleared_by) && room.cleared_by.includes(userId)) continue;

        const roomCopy = { ...room, role: entry.role, is_pinned: memoryDb.pinned_chats.has(`${userId}:${room.id}`) };
        roomCopy.is_muted = memoryDb.muted_chats.has(`${userId}:${room.id}`);
        roomCopy.is_archived = memoryDb.archived_chats.has(`${userId}:${room.id}`);
        roomCopy.is_unread = memoryDb.marked_unread_chats.has(`${userId}:${room.id}`);
        roomCopy.disappearing_seconds = roomCopy.disappearing_timer || 0;

        const roomMsgs = Array.from(memoryDb.messages.values())
          .filter(m => m.room_id === room.id && (!Array.isArray(m.deleted_for) || !m.deleted_for.includes(userId)))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        roomCopy.last_message = roomMsgs[0] || null;
        roomCopy.unread_count = roomMsgs.filter(m =>
          m.sender_id !== userId &&
          !m.deleted_for_everyone &&
          (!Array.isArray(m.read_by) || !m.read_by.includes(userId))
        ).length;

        if (room.type === 'private') {
          const partnerEntry = memoryDb.room_members.find(m => m.room_id === room.id && m.user_id !== userId);
          if (partnerEntry) {
            const partnerUser = memoryDb.users.get(partnerEntry.user_id);
            if (partnerUser) {
              const { password_hash, ...safePartner } = partnerUser;
              const setting = (safePartner.privacy_preferences || {}).last_seen || 'everyone';
              const allowed = setting !== 'nobody';
              if (!allowed && safePartner.status !== 'online') {
                safePartner.status = 'offline';
                safePartner.last_seen = null;
              }
              roomCopy.partner = safePartner;
            }
          }
        } else {
          const roomMembers = memoryDb.room_members
            .filter(m => m.room_id === room.id)
            .map(m => {
              const u = memoryDb.users.get(m.user_id);
              return u ? { id: u.id, username: u.username, avatar_url: u.avatar_url, role: m.role } : null;
            })
            .filter(Boolean);
          roomCopy.members = roomMembers;
        }

        userRooms.push(roomCopy);
      }
      return userRooms;
    }
  },

  togglePinChat: async (userId, roomId) => {
    const key = `${userId}:${roomId}`;
    let isPinned = false;
    if (memoryDb.pinned_chats.has(key)) {
      memoryDb.pinned_chats.delete(key);
      isPinned = false;
    } else {
      memoryDb.pinned_chats.add(key);
      isPinned = true;
    }

    if (isPgConnected) {
      try {
        const res = await pool.query(`SELECT theme_preferences FROM users WHERE id = $1`, [userId]);
        let prefs = res.rows[0]?.theme_preferences || {};
        let pins = Array.isArray(prefs.pinned_rooms) ? prefs.pinned_rooms : [];
        if (isPinned) {
          if (!pins.includes(roomId)) pins.push(roomId);
        } else {
          pins = pins.filter(id => id !== roomId);
        }
        prefs.pinned_rooms = pins;
        await pool.query(`UPDATE users SET theme_preferences = $1 WHERE id = $2`, [JSON.stringify(prefs), userId]);
      } catch (e) {
        console.warn('Persist pinned chat error:', e.message);
      }
    } else {
      scheduleMemoryDbSave();
    }
    return isPinned;
  },

  // Toggle per-chat notification mute (persisted per-user like pinned chats)
  toggleMuteRoom: async (userId, roomId) => {
    const key = `${userId}:${roomId}`;
    let isMuted = false;
    if (memoryDb.muted_chats.has(key)) {
      memoryDb.muted_chats.delete(key);
      isMuted = false;
    } else {
      memoryDb.muted_chats.add(key);
      isMuted = true;
    }

    if (isPgConnected) {
      try {
        const res = await pool.query(`SELECT theme_preferences FROM users WHERE id = $1`, [userId]);
        let prefs = res.rows[0]?.theme_preferences || {};
        let muted = Array.isArray(prefs.muted_rooms) ? prefs.muted_rooms : [];
        if (isMuted) {
          if (!muted.includes(roomId)) muted.push(roomId);
        } else {
          muted = muted.filter(id => id !== roomId);
        }
        prefs.muted_rooms = muted;
        await pool.query(`UPDATE users SET theme_preferences = $1 WHERE id = $2`, [JSON.stringify(prefs), userId]);
      } catch (e) {
        console.warn('Persist muted chat error:', e.message);
      }
    } else {
      scheduleMemoryDbSave();
    }
    return isMuted;
  },

  // Is this room muted for this user? (used to skip push notifications)
  isRoomMuted: async (userId, roomId) => {
    if (!userId || !roomId) return false;
    if (isPgConnected) {
      const mutedSet = await loadMutedChatsForUser(userId);
      return mutedSet ? mutedSet.has(roomId) : memoryDb.muted_chats.has(`${userId}:${roomId}`);
    }
    return memoryDb.muted_chats.has(`${userId}:${roomId}`);
  },

  // Toggle per-user chat archive (WhatsApp-style: hidden from the main list).
  // Persisted per-user like pins/mutes so it survives server restarts.
  toggleArchiveRoom: async (userId, roomId) => {
    const key = `${userId}:${roomId}`;
    let isArchived = false;
    if (memoryDb.archived_chats.has(key)) {
      memoryDb.archived_chats.delete(key);
      isArchived = false;
    } else {
      memoryDb.archived_chats.add(key);
      isArchived = true;
    }

    if (isPgConnected) {
      try {
        const res = await pool.query(`SELECT theme_preferences FROM users WHERE id = $1`, [userId]);
        let prefs = res.rows[0]?.theme_preferences || {};
        let archived = Array.isArray(prefs.archived_rooms) ? prefs.archived_rooms : [];
        if (isArchived) {
          if (!archived.includes(roomId)) archived.push(roomId);
        } else {
          archived = archived.filter(id => id !== roomId);
        }
        prefs.archived_rooms = archived;
        await pool.query(`UPDATE users SET theme_preferences = $1 WHERE id = $2`, [JSON.stringify(prefs), userId]);
      } catch (e) {
        console.warn('Persist archived chat error:', e.message);
      }
    } else {
      scheduleMemoryDbSave();
    }
    return isArchived;
  },

  // Is this room archived for this user?
  isRoomArchived: async (userId, roomId) => {
    if (!userId || !roomId) return false;
    if (isPgConnected) {
      const archivedSet = await loadArchivedChatsForUser(userId);
      return archivedSet ? archivedSet.has(roomId) : memoryDb.archived_chats.has(`${userId}:${roomId}`);
    }
    return memoryDb.archived_chats.has(`${userId}:${roomId}`);
  },

  // Toggle a per-user manual "mark as unread / mark as read" flag. This is a
  // local badge override on top of the real unread count derived from messages.
  toggleUnreadRoom: async (userId, roomId) => {
    const key = `${userId}:${roomId}`;
    let isUnread = false;
    if (memoryDb.marked_unread_chats.has(key)) {
      memoryDb.marked_unread_chats.delete(key);
      isUnread = false;
    } else {
      memoryDb.marked_unread_chats.add(key);
      isUnread = true;
    }

    if (isPgConnected) {
      try {
        const res = await pool.query(`SELECT theme_preferences FROM users WHERE id = $1`, [userId]);
        let prefs = res.rows[0]?.theme_preferences || {};
        let unread = Array.isArray(prefs.marked_unread_rooms) ? prefs.marked_unread_rooms : [];
        if (isUnread) {
          if (!unread.includes(roomId)) unread.push(roomId);
        } else {
          unread = unread.filter(id => id !== roomId);
        }
        prefs.marked_unread_rooms = unread;
        await pool.query(`UPDATE users SET theme_preferences = $1 WHERE id = $2`, [JSON.stringify(prefs), userId]);
      } catch (e) {
        console.warn('Persist marked unread chat error:', e.message);
      }
    } else {
      scheduleMemoryDbSave();
    }
    return isUnread;
  },

  // Room Bridges
  createBridge: async (sourceRoomId, targetRoomId, createdBy) => {
    const id = uuidv4();
    if (isPgConnected) {
      const res = await pool.query(
        `INSERT INTO room_bridges (id, source_room_id, target_room_id, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, sourceRoomId, targetRoomId, createdBy]
      );
      return res.rows[0];
    } else {
      const bridge = {
        id,
        source_room_id: sourceRoomId,
        target_room_id: targetRoomId,
        created_by: createdBy,
        created_at: new Date().toISOString()
      };
      memoryDb.room_bridges.set(id, bridge);
      scheduleMemoryDbSave();
      return bridge;
    }
  },

  getRoomBridges: async (roomId) => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT rb.*, r.name as target_room_name, r.avatar_url as target_room_avatar
         FROM room_bridges rb
         JOIN rooms r ON rb.target_room_id = r.id
         WHERE rb.source_room_id = $1`,
        [roomId]
      );
      return res.rows;
    } else {
      const bridges = [];
      for (const b of memoryDb.room_bridges.values()) {
        if (b.source_room_id === roomId) {
          const targetRoom = memoryDb.rooms.get(b.target_room_id);
          bridges.push({
            ...b,
            target_room_name: targetRoom ? targetRoom.name : 'Linked Room',
            target_room_avatar: targetRoom ? targetRoom.avatar_url : ''
          });
        }
      }
      return bridges;
    }
  },

  // Message Operations
  createMessage: async ({ roomId, senderId, text, type = 'text', mediaUrl = '', replyToId = null, e2ee = false, forwarded = false, forwardedFrom = null }) => {
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    if (isPgConnected) {
      const res = await pool.query(
        `INSERT INTO messages (id, room_id, sender_id, text, type, media_url, reply_to_id, read_by, e2ee, forwarded, forwarded_from, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [id, roomId, senderId, text, type, mediaUrl, replyToId, JSON.stringify([senderId]), Boolean(e2ee), Boolean(forwarded), forwardedFrom || null, createdAt]
      );

      const senderRes = await pool.query(`SELECT username, avatar_url FROM users WHERE id = $1`, [senderId]);
      const sender = senderRes.rows[0];

      return {
        ...res.rows[0],
        sender_name: sender ? sender.username : 'Unknown',
        sender_avatar: sender ? sender.avatar_url : ''
      };
    } else {
      const sender = memoryDb.users.get(senderId);
      const message = {
        id,
        room_id: roomId,
        sender_id: senderId,
        sender_name: sender ? sender.username : 'User',
        sender_avatar: sender ? sender.avatar_url : '',
        text,
        type,
        media_url: mediaUrl,
        reactions: {},
        reply_to_id: replyToId,
        read_by: [senderId],
        read_timestamps: {},
        deleted_for: [],
        e2ee: Boolean(e2ee),
        forwarded: Boolean(forwarded),
        forwarded_from: forwardedFrom || null,
        edited_at: null,
        edit_count: 0,
        created_at: createdAt
      };
      memoryDb.messages.set(id, message);
      scheduleMemoryDbSave();
      return message;
    }
  },

  getMessageById: async (messageId) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT * FROM messages WHERE id = $1`, [messageId]);
      return res.rows[0] || null;
    } else {
      return memoryDb.messages.get(messageId) || null;
    }
  },

  // ---------- Edit a message (WhatsApp-style) ----------
  // Only the original sender may edit. E2EE messages are re-encrypted on the
  // client and arrive here as a fresh ciphertext envelope in `newText`.
  editMessage: async (messageId, userId, newText, newType = 'text') => {
    const now = new Date().toISOString();
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE messages
         SET text = $3, type = $4, edited_at = $5, edit_count = COALESCE(edit_count, 0) + 1
         WHERE id = $1 AND sender_id = $2
         RETURNING *`,
        [messageId, userId, newText, newType, now]
      );
      const row = res.rows[0];
      if (!row) return null;
      const senderRes = await pool.query(`SELECT username, avatar_url FROM users WHERE id = $1`, [row.sender_id]);
      const sender = senderRes.rows[0];
      return {
        ...row,
        sender_name: sender ? sender.username : 'Unknown',
        sender_avatar: sender ? sender.avatar_url : ''
      };
    } else {
      const msg = memoryDb.messages.get(messageId);
      if (!msg || msg.sender_id !== userId) return null;
      msg.text = newText;
      msg.type = newType;
      msg.edited_at = now;
      msg.edit_count = (msg.edit_count || 0) + 1;
      scheduleMemoryDbSave();
      return { ...msg };
    }
  },

  getRoomMessages: async (roomId, userId = null) => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar,
                (SELECT JSON_BUILD_OBJECT('id', rm.id, 'text', rm.text, 'sender_name', ru.username)
                 FROM messages rm
                 JOIN users ru ON rm.sender_id = ru.id
                 WHERE rm.id = m.reply_to_id) as reply_to
         FROM messages m
         LEFT JOIN users u ON m.sender_id = u.id
         WHERE m.room_id = $1 AND NOT (COALESCE(m.deleted_for, '[]') ? $2)
         ORDER BY m.created_at ASC`,
        [roomId, userId || '__none__']
      );
      return res.rows;
    } else {
      const roomMsgs = Array.from(memoryDb.messages.values())
        .filter(m => m.room_id === roomId && (!userId || !Array.isArray(m.deleted_for) || !m.deleted_for.includes(userId)))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      return roomMsgs.map(m => {
        let replyTo = null;
        if (m.reply_to_id) {
          const parent = memoryDb.messages.get(m.reply_to_id);
          if (parent) {
            const parentSender = memoryDb.users.get(parent.sender_id);
            replyTo = {
              id: parent.id,
              text: parent.text,
              sender_name: parentSender ? parentSender.username : 'User'
            };
          }
        }
        return {
          ...m,
          read_by: Array.isArray(m.read_by) ? m.read_by : [],
          read_timestamps: m.read_timestamps || {},
          reply_to: replyTo
        };
      });
    }
  },

  deleteMessage: async (messageId, userId) => {
    if (isPgConnected) {
      const res = await pool.query(`DELETE FROM messages WHERE id = $1 AND sender_id = $2 RETURNING room_id`, [messageId, userId]);
      return res.rows[0];
    } else {
      const msg = memoryDb.messages.get(messageId);
      if (msg && msg.sender_id === userId) {
        const roomId = msg.room_id;
        memoryDb.messages.delete(messageId);
        scheduleMemoryDbSave();
        return { room_id: roomId };
      }
      return null;
    }
  },

  // WhatsApp-style "Delete for me": hides the message ONLY for the requesting user.
  deleteMessageForMe: async (messageId, userId) => {
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE messages
         SET deleted_for = COALESCE(deleted_for, '[]') || $2::jsonb
         WHERE id = $1 AND NOT (COALESCE(deleted_for, '[]') ? $3)
         RETURNING id, room_id`,
        [messageId, JSON.stringify([userId]), userId]
      );
      return res.rows[0] || null;
    } else {
      const msg = memoryDb.messages.get(messageId);
      if (!msg) return null;
      if (!Array.isArray(msg.deleted_for)) msg.deleted_for = [];
      if (!msg.deleted_for.includes(userId)) {
        msg.deleted_for.push(userId);
        scheduleMemoryDbSave();
      }
      return { id: msg.id, room_id: msg.room_id };
    }
  },

  // WhatsApp-style "Clear chat": hides ALL messages in the room for the user, keeps the chat visible.
  clearChatForUser: async (roomId, userId) => {
    if (isPgConnected) {
      await pool.query(
        `UPDATE messages
         SET deleted_for = COALESCE(deleted_for, '[]') || $2::jsonb
         WHERE room_id = $1 AND NOT (COALESCE(deleted_for, '[]') ? $3)`,
        [roomId, JSON.stringify([userId]), userId]
      );
      return true;
    } else {
      let changed = false;
      for (const msg of memoryDb.messages.values()) {
        if (msg.room_id === roomId && (!Array.isArray(msg.deleted_for) || !msg.deleted_for.includes(userId))) {
          if (!Array.isArray(msg.deleted_for)) msg.deleted_for = [];
          msg.deleted_for.push(userId);
          changed = true;
        }
      }
      if (changed) scheduleMemoryDbSave();
      return true;
    }
  },

  // WhatsApp-style "Delete chat": hides ALL messages AND removes the chat from the user's list only.
  deleteChatForUser: async (roomId, userId) => {
    if (isPgConnected) {
      await pool.query(
        `UPDATE messages
         SET deleted_for = COALESCE(deleted_for, '[]') || $2::jsonb
         WHERE room_id = $1 AND NOT (COALESCE(deleted_for, '[]') ? $3)`,
        [roomId, JSON.stringify([userId]), userId]
      );
      const res = await pool.query(
        `UPDATE rooms
         SET cleared_by = COALESCE(cleared_by, '[]') || $2::jsonb
         WHERE id = $1 AND NOT (COALESCE(cleared_by, '[]') ? $3)
         RETURNING id`,
        [roomId, JSON.stringify([userId]), userId]
      );
      return res.rows[0] || null;
    } else {
      const room = memoryDb.rooms.get(roomId);
      if (!room) return null;
      if (!Array.isArray(room.cleared_by)) room.cleared_by = [];
      if (!room.cleared_by.includes(userId)) room.cleared_by.push(userId);
      for (const msg of memoryDb.messages.values()) {
        if (msg.room_id === roomId && (!Array.isArray(msg.deleted_for) || !msg.deleted_for.includes(userId))) {
          if (!Array.isArray(msg.deleted_for)) msg.deleted_for = [];
          msg.deleted_for.push(userId);
        }
      }
      scheduleMemoryDbSave();
      return { id: roomId };
    }
  },

  deleteUserByEmail: async (email) => {
    const cleanEmail = email.trim().toLowerCase();
    if (isPgConnected) {
      const res = await pool.query(
        `DELETE FROM users WHERE LOWER(email) = LOWER($1)
         RETURNING id, username, email`,
        [cleanEmail]
      );
      return res.rows[0] || null;
    } else {
      const removed = [];
      for (const u of memoryDb.users.values()) {
        if (u.email.toLowerCase() === cleanEmail) {
          removed.push({ id: u.id, username: u.username, email: u.email });
        }
      }
      for (const rec of removed) {
        memoryDb.users.delete(rec.id);
        memoryDb.room_members = memoryDb.room_members.filter(m => m.user_id !== rec.id);
        for (const [roomId, room] of memoryDb.rooms.entries()) {
          const remaining = memoryDb.room_members.filter(m => m.room_id === roomId);
          if (remaining.length === 0) memoryDb.rooms.delete(roomId);
        }
        for (const [id, msg] of memoryDb.messages.entries()) {
          if (msg.sender_id === rec.id) memoryDb.messages.delete(id);
        }
        for (const [id, st] of memoryDb.statuses.entries()) {
          if (st.user_id === rec.id) memoryDb.statuses.delete(id);
        }
        if (memoryDb.pendingInvites) {
          for (const [inviteeEmail, ids] of memoryDb.pendingInvites.entries()) {
            const filtered = ids.filter(id => id !== rec.id);
            if (filtered.length === 0) memoryDb.pendingInvites.delete(inviteeEmail);
            else memoryDb.pendingInvites.set(inviteeEmail, filtered);
          }
        }
        scheduleMemoryDbSave();
      }
      return removed[0] || null;
    }
  },

  toggleReaction: async (messageId, emoji, userId) => {
    if (isPgConnected) {
      const msgRes = await pool.query(`SELECT reactions FROM messages WHERE id = $1`, [messageId]);
      if (msgRes.rows.length === 0) return null;

      let reactions = msgRes.rows[0].reactions || {};
      if (!reactions[emoji]) reactions[emoji] = [];

      if (reactions[emoji].includes(userId)) {
        reactions[emoji] = reactions[emoji].filter(id => id !== userId);
        if (reactions[emoji].length === 0) delete reactions[emoji];
      } else {
        reactions[emoji].push(userId);
      }

      const updateRes = await pool.query(
        `UPDATE messages SET reactions = $1 WHERE id = $2 RETURNING *`,
        [JSON.stringify(reactions), messageId]
      );
      return updateRes.rows[0];
    } else {
      const msg = memoryDb.messages.get(messageId);
      if (!msg) return null;

      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
      if (msg.reactions[emoji].includes(userId)) {
        msg.reactions[emoji] = msg.reactions[emoji].filter(id => id !== userId);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      } else {
        msg.reactions[emoji].push(userId);
      }
      scheduleMemoryDbSave();
      return msg;
    }
  },

  // ---------- Starred Messages (per-user bookmark, WhatsApp-style) ----------
  toggleStar: async (messageId, userId) => {
    if (isPgConnected) {
      const msgRes = await pool.query(
        `SELECT room_id, COALESCE(starred_by, '[]'::jsonb) AS starred_by FROM messages WHERE id = $1`,
        [messageId]
      );
      if (msgRes.rows.length === 0) return null;
      const row = msgRes.rows[0];
      const list = Array.isArray(row.starred_by) ? row.starred_by : [];
      const exists = list.includes(userId);
      const next = exists ? list.filter(id => id !== userId) : list.concat(userId);
      await pool.query(`UPDATE messages SET starred_by = $1 WHERE id = $2`, [JSON.stringify(next), messageId]);
      return { id: messageId, room_id: row.room_id, starred_by: next, isStarred: !exists };
    } else {
      const msg = memoryDb.messages.get(messageId);
      if (!msg) return null;
      const list = Array.isArray(msg.starred_by) ? msg.starred_by : [];
      const exists = list.includes(userId);
      msg.starred_by = exists ? list.filter(id => id !== userId) : list.concat(userId);
      scheduleMemoryDbSave();
      return { id: messageId, room_id: msg.room_id, starred_by: msg.starred_by, isStarred: !exists };
    }
  },

  getStarredMessages: async (roomId, userId) => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT m.*, u.username AS sender_name, u.avatar_url AS sender_avatar
         FROM messages m
         LEFT JOIN users u ON m.sender_id = u.id
         WHERE m.room_id = $1
           AND COALESCE(m.starred_by, '[]'::jsonb) ? $2
           AND NOT COALESCE(m.deleted_for_everyone, FALSE)
           AND NOT (COALESCE(m.deleted_for, '[]'::jsonb) ? $2)
         ORDER BY m.created_at ASC`,
        [roomId, userId]
      );
      return res.rows;
    } else {
      return Array.from(memoryDb.messages.values())
        .filter(m =>
          m.room_id === roomId &&
          Array.isArray(m.starred_by) && m.starred_by.includes(userId) &&
          !m.deleted_for_everyone &&
          !(Array.isArray(m.deleted_for) && m.deleted_for.includes(userId))
        )
        .map(m => ({
          ...m,
          sender_name: m.sender_name || (memoryDb.users.get(m.sender_id) || {}).username,
          sender_avatar: m.sender_avatar || (memoryDb.users.get(m.sender_id) || {}).avatar_url
        }))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
  },

  // Statuses / Stories Operations
  createStatus: async ({ userId, text, mediaUrl, mediaType, bgColor }) => {
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    if (isPgConnected) {
      const userRes = await pool.query(`SELECT username, avatar_url FROM users WHERE id = $1`, [userId]);
      const user = userRes.rows[0];

      const res = await pool.query(
        `INSERT INTO user_statuses (id, user_id, text, media_url, media_type, bg_color, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [id, userId, text || '', mediaUrl || '', mediaType || 'image', bgColor || '#128c7e', createdAt]
      );

      return {
        ...res.rows[0],
        username: user ? user.username : 'User',
        avatar_url: user ? user.avatar_url : ''
      };
    } else {
      const user = memoryDb.users.get(userId);
      const statusObj = {
        id,
        user_id: userId,
        username: user ? user.username : 'User',
        avatar_url: user ? user.avatar_url : '',
        text: text || '',
        media_url: mediaUrl || '',
        media_type: mediaType || 'image',
        bg_color: bgColor || '#128c7e',
        reactions: {},
        created_at: createdAt
      };
      memoryDb.statuses.set(id, statusObj);
      scheduleMemoryDbSave();
      return statusObj;
    }
  },

  getAllActiveStatuses: async () => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT s.*, u.username, u.avatar_url
         FROM user_statuses s
         JOIN users u ON s.user_id = u.id
         WHERE s.created_at >= NOW() - INTERVAL '24 HOURS'
         ORDER BY s.created_at DESC`
      );
      return res.rows;
    } else {
      const now = new Date().getTime();
      const cutoff = now - 24 * 60 * 60 * 1000;
      const active = [];
      for (const s of memoryDb.statuses.values()) {
        if (new Date(s.created_at).getTime() >= cutoff) {
          const user = memoryDb.users.get(s.user_id);
          active.push({
            ...s,
            username: user ? user.username : (s.username || 'User'),
            avatar_url: user ? user.avatar_url : (s.avatar_url || '')
          });
        }
      }
      return active;
    }
  },

  deleteStatus: async (statusId, userId) => {
    if (isPgConnected) {
      const res = await pool.query(`DELETE FROM user_statuses WHERE id = $1 AND user_id = $2 RETURNING id`, [statusId, userId]);
      return res.rows[0];
    } else {
      const st = memoryDb.statuses.get(statusId);
      if (st && st.user_id === userId) {
        memoryDb.statuses.delete(statusId);
        scheduleMemoryDbSave();
        return { id: statusId };
      }
      return null;
    }
  },

  // Fetch a single status by id (used for reactions / replies)
  getStatusById: async (statusId) => {
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT s.*, u.username, u.avatar_url
         FROM user_statuses s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = $1`,
        [statusId]
      );
      return res.rows[0] || null;
    } else {
      const s = memoryDb.statuses.get(statusId);
      if (!s) return null;
      const user = memoryDb.users.get(s.user_id);
      return {
        ...s,
        username: user ? user.username : (s.username || 'User'),
        avatar_url: user ? user.avatar_url : (s.avatar_url || '')
      };
    }
  },

  // Status reactions (WhatsApp-style per-user emoji toggle, same shape as messages)
  toggleStatusReaction: async (statusId, emoji, userId) => {
    if (!emoji || !userId) return null;
    if (isPgConnected) {
      const res = await pool.query(`SELECT reactions FROM user_statuses WHERE id = $1`, [statusId]);
      if (res.rows.length === 0) return null;

      const reactions = res.rows[0].reactions || {};
      if (!reactions[emoji]) reactions[emoji] = [];
      if (reactions[emoji].includes(userId)) {
        reactions[emoji] = reactions[emoji].filter(id => id !== userId);
        if (reactions[emoji].length === 0) delete reactions[emoji];
      } else {
        reactions[emoji].push(userId);
      }

      await pool.query(
        `UPDATE user_statuses SET reactions = $1 WHERE id = $2`,
        [JSON.stringify(reactions), statusId]
      );
      return { id: statusId, reactions };
    } else {
      const st = memoryDb.statuses.get(statusId);
      if (!st) return null;

      if (!st.reactions) st.reactions = {};
      if (!st.reactions[emoji]) st.reactions[emoji] = [];
      if (st.reactions[emoji].includes(userId)) {
        st.reactions[emoji] = st.reactions[emoji].filter(id => id !== userId);
        if (st.reactions[emoji].length === 0) delete st.reactions[emoji];
      } else {
        st.reactions[emoji].push(userId);
      }
      scheduleMemoryDbSave();
      return { id: statusId, reactions: st.reactions };
    }
  },

  // WhatsApp-style reply: opens/creates a DM with the status author and sends a
  // message that quotes a snapshot of the status (text / media / color).
  createStatusReply: async ({ statusId, replierId, reply }) => {
    const status = await db.getStatusById(statusId);
    if (!status) return null;

    const ownerId = status.user_id;
    if (String(ownerId) === String(replierId)) {
      return { error: 'You cannot reply to your own status.' };
    }
    if (await db.isBlockedBetween(replierId, ownerId)) {
      return { error: 'You cannot reply to this user.' };
    }

    const room = await db.getOrCreatePrivateRoom(replierId, ownerId);
    const message = await db.createMessage({
      roomId: room.id,
      senderId: replierId,
      text: reply || '',
      type: 'status_reply',
      mediaUrl: '',
      replyToId: null
    });

    message.status_reply = {
      status_id: status.id,
      text: status.text || '',
      media_url: status.media_url || '',
      media_type: status.media_type || 'image',
      bg_color: status.bg_color || '#128c7e',
      username: status.username || 'User',
      avatar_url: status.avatar_url || '',
      created_at: status.created_at
    };

    if (isPgConnected) {
      await pool.query(
        `UPDATE messages SET status_reply = $1 WHERE id = $2`,
        [JSON.stringify(message.status_reply), message.id]
      );
    } else {
      const stored = memoryDb.messages.get(message.id);
      if (stored) {
        stored.status_reply = message.status_reply;
        scheduleMemoryDbSave();
      }
    }
    return { room, message };
  },

  // Server-side 24h status expiry job (returns removed status ids so clients
  // can be notified via socket).
  deleteExpiredStatuses: async () => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (isPgConnected) {
      const res = await pool.query(
        `DELETE FROM user_statuses WHERE created_at < $1 RETURNING id`,
        [cutoff]
      );
      return res.rows.map(r => r.id);
    } else {
      const removed = [];
      for (const [id, st] of memoryDb.statuses.entries()) {
        if (new Date(st.created_at).getTime() < new Date(cutoff).getTime()) {
          memoryDb.statuses.delete(id);
          removed.push(id);
        }
      }
      if (removed.length > 0) scheduleMemoryDbSave();
      return removed;
    }
  },

  // ---------- End-to-End Encryption (public keys only - private keys stay on the client) ----------
  setE2EEKey: async ({ userId, publicKey, signedPrekey, signPublicKey, signature }) => {
    if (!userId || !publicKey) return null;
    if (isPgConnected) {
      const res = await pool.query(
        `INSERT INTO e2ee_keys (user_id, public_key, signed_prekey, sign_public_key, signature)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET public_key = $2, signed_prekey = $3, sign_public_key = $4, signature = $5, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, publicKey, signedPrekey || null, signPublicKey || null, signature || null]
      );
      return res.rows[0];
    } else {
      const record = {
        user_id: userId,
        public_key: publicKey,
        signed_prekey: signedPrekey || '',
        sign_public_key: signPublicKey || '',
        signature: signature || '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      memoryDb.e2ee_keys.set(userId, record);
      scheduleMemoryDbSave();
      return record;
    }
  },

  getE2EEKey: async (userId) => {
    if (!userId) return null;
    if (isPgConnected) {
      const res = await pool.query(`SELECT user_id, public_key, signed_prekey, sign_public_key, signature FROM e2ee_keys WHERE user_id = $1`, [userId]);
      return res.rows[0] || null;
    } else {
      return memoryDb.e2ee_keys.get(userId) || null;
    }
  },

  hasE2EEKey: async (userId) => {
    const key = await db.getE2EEKey(userId);
    return Boolean(key && key.public_key);
  },

  // ---------- Group Administration ----------
  getRoomMemberRole: async (roomId, userId) => {
    if (isPgConnected) {
      const res = await pool.query(`SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
      return res.rows[0]?.role || null;
    } else {
      const entry = memoryDb.room_members.find(m => m.room_id === roomId && m.user_id === userId);
      return entry ? entry.role : null;
    }
  },

  setRoomMemberRole: async (roomId, userId, role) => {
    if (role !== 'admin' && role !== 'member') return null;
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE room_members SET role = $1 WHERE room_id = $2 AND user_id = $3 RETURNING room_id, user_id, role`,
        [role, roomId, userId]
      );
      return res.rows[0] || null;
    } else {
      const entry = memoryDb.room_members.find(m => m.room_id === roomId && m.user_id === userId);
      if (!entry) return null;
      entry.role = role;
      scheduleMemoryDbSave();
      return { room_id: roomId, user_id: userId, role };
    }
  },

  removeRoomMember: async (roomId, userId) => {
    if (isPgConnected) {
      const res = await pool.query(`DELETE FROM room_members WHERE room_id = $1 AND user_id = $2 RETURNING user_id`, [roomId, userId]);
      return res.rows[0] || null;
    } else {
      const before = memoryDb.room_members.length;
      memoryDb.room_members = memoryDb.room_members.filter(m => !(m.room_id === roomId && m.user_id === userId));
      if (memoryDb.room_members.length !== before) scheduleMemoryDbSave();
      return { user_id: userId };
    }
  },

  updateRoom: async (roomId, { name, description, avatarUrl, themeColor }) => {
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE rooms
         SET name = COALESCE($2, name),
             description = COALESCE($3, description),
             avatar_url = COALESCE($4, avatar_url),
             theme_color = COALESCE($5, theme_color)
         WHERE id = $1
         RETURNING *`,
        [roomId, name || null, description || null, avatarUrl || null, themeColor || null]
      );
      return res.rows[0] || null;
    } else {
      const room = memoryDb.rooms.get(roomId);
      if (!room) return null;
      if (name) room.name = name;
      if (description !== undefined) room.description = description;
      if (avatarUrl) room.avatar_url = avatarUrl;
      if (themeColor) room.theme_color = themeColor;
      scheduleMemoryDbSave();
      return room;
    }
  },

  // ---------- Message Search Within a Chat ----------
  searchRoomMessages: async (roomId, userId, query) => {
    if (!query || !String(query).trim()) return [];
    const q = String(query).trim();
    if (isPgConnected) {
      const res = await pool.query(
        `SELECT m.*, u.username as sender_name, u.avatar_url as sender_avatar
         FROM messages m
         LEFT JOIN users u ON m.sender_id = u.id
         WHERE m.room_id = $1
           AND NOT (COALESCE(m.deleted_for, '[]') ? $2)
           AND NOT COALESCE(m.deleted_for_everyone, FALSE)
           AND m.type = 'text'
           AND m.text ILIKE $3
         ORDER BY m.created_at DESC
         LIMIT 50`,
        [roomId, userId, `%${q}%`]
      );
      return res.rows;
    } else {
      return Array.from(memoryDb.messages.values())
        .filter(m =>
          m.room_id === roomId &&
          (!Array.isArray(m.deleted_for) || !m.deleted_for.includes(userId)) &&
          !m.deleted_for_everyone &&
          m.type === 'text' &&
          m.text && String(m.text).toLowerCase().includes(q.toLowerCase())
        )
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 50);
    }
  },

  // ---------- Delete for Everyone (WhatsApp-style) ----------
  deleteMessageForEveryone: async (messageId, userId) => {
    if (isPgConnected) {
      const res = await pool.query(
        `UPDATE messages
         SET deleted_for_everyone = TRUE,
             text = '',
             media_url = '',
             type = 'deleted'
         WHERE id = $1 AND sender_id = $2
         RETURNING id, room_id`,
        [messageId, userId]
      );
      return res.rows[0] || null;
    } else {
      const msg = memoryDb.messages.get(messageId);
      if (!msg || msg.sender_id !== userId) return null;
      msg.deleted_for_everyone = true;
      msg.text = '';
      msg.media_url = '';
      msg.type = 'deleted';
      scheduleMemoryDbSave();
      return { id: msg.id, room_id: msg.room_id };
    }
  },

  // ---------- Forward Messages ----------
  forwardMessage: async ({ roomId, senderId, text, type, mediaUrl, originalMessageId, e2ee }) => {
    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const payload = {
      roomId,
      senderId,
      text,
      type: type || 'text',
      mediaUrl: mediaUrl || '',
      replyToId: null,
      forwarded: true,
      forwardedFrom: originalMessageId || null,
      e2ee: Boolean(e2ee)
    };
    if (isPgConnected) {
      const res = await pool.query(
        `INSERT INTO messages (id, room_id, sender_id, text, type, media_url, reply_to_id, read_by, forwarded, forwarded_from, e2ee, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10, $11)
         RETURNING *`,
        [id, roomId, senderId, text, type || 'text', mediaUrl || '', null, JSON.stringify([senderId]), originalMessageId || null, Boolean(e2ee), createdAt]
      );
      const senderRes = await pool.query(`SELECT username, avatar_url FROM users WHERE id = $1`, [senderId]);
      const sender = senderRes.rows[0];
      return {
        ...res.rows[0],
        sender_name: sender ? sender.username : 'Unknown',
        sender_avatar: sender ? sender.avatar_url : '',
        forwarded: true
      };
    } else {
      const sender = memoryDb.users.get(senderId);
      const message = {
        id,
        room_id: roomId,
        sender_id: senderId,
        sender_name: sender ? sender.username : 'User',
        sender_avatar: sender ? sender.avatar_url : '',
        text,
        type: type || 'text',
        media_url: mediaUrl || '',
        reactions: {},
        reply_to_id: null,
        read_by: [senderId],
        read_timestamps: {},
        deleted_for: [],
        forwarded: true,
        forwarded_from: originalMessageId || null,
        e2ee: Boolean(e2ee),
        edited_at: null,
        edit_count: 0,
        created_at: createdAt
      };
      memoryDb.messages.set(id, message);
      scheduleMemoryDbSave();
      return message;
    }
  },

  // Delete the room membership row entirely for a group that was dissolved
  deleteGroupRoom: async (roomId) => {
    return db.deleteRoom(roomId);
  }
};
