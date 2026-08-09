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
  pendingInvites: new Map(),
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
    pendingInvites: Object.fromEntries(memoryDb.pendingInvites)
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
  memoryDb.pendingInvites = new Map(Object.entries(data.pendingInvites || {}));
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
  if (memoryDb.pendingInvites) memoryDb.pendingInvites.clear();

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
        status VARCHAR(20) DEFAULT 'online',
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

    // 6. Status / Stories Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_statuses (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
        text TEXT DEFAULT '',
        media_url TEXT DEFAULT '',
        media_type VARCHAR(20) DEFAULT 'image',
        bg_color VARCHAR(30) DEFAULT '#128c7e',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

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

    client.release();
    console.log('✅ PostgreSQL Schema & Indexes Verified.');
  } catch (err) {
    console.warn('⚠️ Could not connect to external PostgreSQL server:', err.message);
    console.log('🚀 Operating in High-Performance Resilient Dual Database Mode (In-Memory Postgres Emulation active).');
    isPgConnected = false;
    await loadMemoryDatabase();
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
        status: 'online',
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
      const res = await pool.query(
        `SELECT id, username, email, avatar_url, bio, status, last_seen, theme_preferences, email_confirmed FROM users WHERE id != $1 ORDER BY username ASC`,
        [currentUserId]
      );
      return res.rows;
    } else {
      const users = [];
      for (const u of memoryDb.users.values()) {
        if (u.id !== currentUserId) {
          const { password_hash, ...safeUser } = u;
          users.push(safeUser);
        }
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
                (SELECT JSON_BUILD_OBJECT('id', m.id, 'text', m.text, 'sender_id', m.sender_id, 'created_at', m.created_at)
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
      for (const room of rooms) {
        if (room.type === 'private') {
          const partnerRes = await pool.query(
            `SELECT u.id, u.username, u.avatar_url, u.status, u.bio
             FROM users u
             JOIN room_members rm ON u.id = rm.user_id
             WHERE rm.room_id = $1 AND u.id != $2`,
            [room.id, userId]
          );
          room.partner = partnerRes.rows[0] || null;
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
        room.is_pinned = memoryDb.pinned_chats.has(`${userId}:${room.id}`);
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

        const roomMsgs = Array.from(memoryDb.messages.values())
          .filter(m => m.room_id === room.id && (!Array.isArray(m.deleted_for) || !m.deleted_for.includes(userId)))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        roomCopy.last_message = roomMsgs[0] || null;

        if (room.type === 'private') {
          const partnerEntry = memoryDb.room_members.find(m => m.room_id === room.id && m.user_id !== userId);
          if (partnerEntry) {
            const partnerUser = memoryDb.users.get(partnerEntry.user_id);
            if (partnerUser) {
              const { password_hash, ...safePartner } = partnerUser;
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
  createMessage: async ({ roomId, senderId, text, type = 'text', mediaUrl = '', replyToId = null }) => {
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    if (isPgConnected) {
      const res = await pool.query(
        `INSERT INTO messages (id, room_id, sender_id, text, type, media_url, reply_to_id, read_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [id, roomId, senderId, text, type, mediaUrl, replyToId, JSON.stringify([senderId]), createdAt]
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
        deleted_for: [],
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
        return { ...m, reply_to: replyTo };
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
  }
};
