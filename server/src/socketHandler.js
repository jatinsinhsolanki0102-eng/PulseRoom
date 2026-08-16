import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { getJwtSecret } from './auth.js';
import { sendPushToRoom } from './push.js';

// Active connected sockets tracking
const userSockets = new Map(); // userId -> Set<socketId>

// Active WebRTC calls: callId -> { mediaType, users: Set<userId> }
const activeCalls = new Map();

export function setupSocketHandlers(io) {
  // Authentication Middleware for Socket.IO Handshake
  // A socket WITHOUT a valid JWT is rejected outright. The client can never
  // choose its own identity - it is always derived from the verified token.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Authentication required.'));
    }
    try {
      const decoded = jwt.verify(token, getJwtSecret());
      if (!decoded || !decoded.id) {
        return next(new Error('Invalid authentication token.'));
      }
      socket.userId = decoded.id;
      return next();
    } catch (e) {
      console.warn('Socket auth token verify failed:', e.message);
      return next(new Error('Invalid or expired authentication token.'));
    }
  });

  io.on('connection', (socket) => {
    const currentUserId = socket.userId;

    // 1. Bind User Session - identity comes ONLY from the verified JWT.
    socket.on('user_connected', async () => {
      if (!currentUserId) return;

      if (!userSockets.has(currentUserId)) {
        userSockets.set(currentUserId, new Set());
      }
      userSockets.get(currentUserId).add(socket.id);

      // Join personal user room for direct notifications
      socket.join(`user:${currentUserId}`);

      // Update online status in database
      await db.updateUserStatus(currentUserId, 'online');

      // Join user to all their room channels (only rooms they are a member of)
      const rooms = await db.getUserRooms(currentUserId);
      for (const room of rooms) {
        socket.join(room.id);
      }

      // Broadcast presence update to all connected clients
      io.emit('user_presence', { userId: currentUserId, status: 'online' });

      // Send a full snapshot of currently-online users so a newly connected
      // client doesn't have to wait for other users' events.
      socket.emit('presence_snapshot', { onlineUserIds: Array.from(userSockets.keys()) });
      console.log(`🔌 User connected socket: ${currentUserId} (${socket.id})`);
    });

    // 2. Join specific room dynamic channel - membership verified server-side.
    socket.on('join_room', async (roomId) => {
      if (!currentUserId || !roomId) return;
      const isMember = await db.isRoomMember(roomId, currentUserId);
      if (!isMember) {
        socket.emit('error_message', { error: 'You are not a member of this room.' });
        return;
      }
      socket.join(roomId);
      console.log(`👤 Socket ${socket.id} joined room ${roomId}`);
    });

    // 3. Handle Real-Time Messaging (identity always from verified JWT).
    socket.on('send_message', async (data) => {
      try {
        const { roomId, text, type, mediaUrl, replyToId, e2ee, forwarded, forwardedFrom } = data;
        if (!currentUserId || !roomId || (!text && !mediaUrl)) return;

        const isMember = await db.isRoomMember(roomId, currentUserId);
        if (!isMember) {
          socket.emit('error_message', { error: 'You are not a member of this room.' });
          return;
        }

        // Blocked-user enforcement for 1-to-1 (2-member) rooms
        const memberIds = await db.getRoomMemberIds(roomId);
        if (memberIds.length === 2) {
          const otherId = memberIds.find(id => id !== currentUserId);
          if (otherId && (await db.isBlockedBetween(currentUserId, otherId))) {
            socket.emit('error_message', { error: 'You cannot send messages to this user.' });
            return;
          }
        }

        // Persist message to database with the authenticated sender id
        const message = await db.createMessage({
          roomId,
          senderId: currentUserId,
          text,
          type: type || 'text',
          mediaUrl: mediaUrl || '',
          replyToId: replyToId || null,
          e2ee: Boolean(e2ee),
          forwarded: Boolean(forwarded),
          forwardedFrom: forwardedFrom || null
        });

        // Deliver exactly once per member socket. Every member socket joins its
        // `user:<id>` channel on connect, so emitting only there (instead of also
        // broadcasting to the room channel) prevents duplicate delivery - which
        // previously made clients flag legitimate messages as "replayed".
        for (const memberId of memberIds) {
          io.to(`user:${memberId}`).emit('new_message', message);
        }

        // Push notification to offline members (never leak encrypted content)
        sendPushToRoom(io, roomId, { id: currentUserId, username: message.sender_name }, message);

        // Room Bridging Logic - skipped for E2EE messages. The sender's client
        // re-encrypts a fresh copy to the target room (the server cannot decrypt).
        if (!message.e2ee) {
          const bridges = await db.getRoomBridges(roomId);
          if (bridges && bridges.length > 0) {
            for (const bridge of bridges) {
              const bridgedText = `[Bridged Message]: ${text || ''}`;
              const bridgedMsg = await db.createMessage({
                roomId: bridge.target_room_id,
                senderId: currentUserId,
                text: bridgedText,
                type: type || 'text',
                mediaUrl: mediaUrl || '',
                replyToId: null
              });
              // Single delivery per member socket (see note above on duplicate emits).
              const targetMembers = await db.getRoomMemberIds(bridge.target_room_id);
              for (const tmId of targetMembers) {
                io.to(`user:${tmId}`).emit('new_message', bridgedMsg);
              }
            }
          }
        }
      } catch (err) {
        console.error('Error handling send_message socket event:', err);
        socket.emit('error_message', { error: 'Failed to send real-time message.' });
      }
    });

    // 4. Typing Indicators (membership verified)
    socket.on('typing_start', async ({ roomId, username }) => {
      if (!currentUserId || !roomId) return;
      if (!(await db.isRoomMember(roomId, currentUserId))) return;
      socket.to(roomId).emit('user_typing', { roomId, username, isTyping: true });
    });

    socket.on('typing_stop', async ({ roomId, username }) => {
      if (!currentUserId || !roomId) return;
      if (!(await db.isRoomMember(roomId, currentUserId))) return;
      socket.to(roomId).emit('user_typing', { roomId, username, isTyping: false });
    });

    // 5. Message Reactions (membership verified)
    socket.on('toggle_reaction', async ({ messageId, roomId, emoji }) => {
      try {
        if (!currentUserId || !messageId || !roomId || !emoji) return;
        if (!(await db.isRoomMember(roomId, currentUserId))) return;
        const updatedMsg = await db.toggleReaction(messageId, emoji, currentUserId);
        if (updatedMsg) {
          io.to(roomId).emit('reaction_updated', { messageId, reactions: updatedMsg.reactions });
        }
      } catch (err) {
        console.error('Error handling reaction event:', err);
      }
    });

    // 5b. Read Receipts (WhatsApp-style: recipient marks messages as read)
    socket.on('mark_read', async ({ roomId }) => {
      if (!currentUserId || !roomId) return;
      if (!(await db.isRoomMember(roomId, currentUserId))) return;
      try {
        const result = await db.markRoomMessagesRead(roomId, currentUserId);
        if (result.messageIds && result.messageIds.length > 0) {
          io.to(roomId).emit('read_receipt', result);
        }
      } catch (err) {
        console.error('Error handling mark_read event:', err);
      }
    });

    // 6. Theme Updates Notification
    socket.on('update_theme', async ({ themePreferences }) => {
      if (!currentUserId) return;
      const updated = await db.updateUserTheme(currentUserId, themePreferences);
      socket.emit('theme_updated', updated);
    });

    // ---------- WebRTC Voice / Video Call Signaling ----------
    // Media flows peer-to-peer in the browser; the server only relays signals.
    const isInActiveCall = (userId) => {
      for (const call of activeCalls.values()) {
        if (call.users.has(String(userId))) return true;
      }
      return false;
    };

    socket.on('call_offer', async ({ callId, roomId, targetUserId, mediaType, offer }) => {
      if (!currentUserId || !callId || !roomId || !targetUserId || !offer) return;
      const callerInRoom = await db.isRoomMember(roomId, currentUserId);
      const targetInRoom = await db.isRoomMember(roomId, String(targetUserId));
      if (!callerInRoom || !targetInRoom) {
        socket.emit('call_unavailable', { callId, targetUserId, reason: 'not_in_room' });
        return;
      }
      if (!userSockets.has(String(targetUserId))) {
        socket.emit('call_unavailable', { callId, targetUserId, reason: 'offline' });
        return;
      }
      if (isInActiveCall(currentUserId) || isInActiveCall(targetUserId)) {
        socket.emit('call_busy', { callId, targetUserId });
        return;
      }
      const caller = await db.findUserById(currentUserId);
      activeCalls.set(callId, { mediaType, users: new Set([String(currentUserId), String(targetUserId)]) });
      io.to(`user:${targetUserId}`).emit('call_incoming', {
        callId,
        fromUserId: currentUserId,
        fromName: caller ? (caller.username || 'User') : 'User',
        fromAvatar: caller ? (caller.avatar_url || '') : '',
        roomId,
        mediaType,
        offer
      });
    });

    socket.on('call_answer', ({ callId, targetUserId, answer }) => {
      const call = activeCalls.get(callId);
      if (!call || !answer) return;
      if (!call.users.has(String(currentUserId))) return;
      io.to(`user:${targetUserId}`).emit('call_answer', { callId, fromUserId: currentUserId, answer });
    });

    socket.on('call_ice', ({ callId, targetUserId, candidate }) => {
      const call = activeCalls.get(callId);
      if (!call || !candidate) return;
      if (!call.users.has(String(currentUserId))) return;
      io.to(`user:${targetUserId}`).emit('call_ice', { callId, fromUserId: currentUserId, candidate });
    });

    socket.on('call_reject', ({ callId, targetUserId }) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      activeCalls.delete(callId);
      io.to(`user:${targetUserId}`).emit('call_rejected', { callId, fromUserId: currentUserId, reason: 'declined' });
    });

    socket.on('call_end', ({ callId, targetUserId }) => {
      activeCalls.delete(callId);
      if (targetUserId) {
        io.to(`user:${targetUserId}`).emit('call_ended', { callId, fromUserId: currentUserId });
      }
    });

    socket.on('call_cancel', ({ callId, targetUserId }) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      activeCalls.delete(callId);
      io.to(`user:${targetUserId}`).emit('call_cancelled', { callId, fromUserId: currentUserId });
    });

    // 7. Disconnect Handler
    socket.on('disconnect', async () => {
      if (currentUserId) {
        const userSet = userSockets.get(currentUserId);
        if (userSet) {
          userSet.delete(socket.id);
          if (userSet.size === 0) {
            userSockets.delete(currentUserId);
            await db.updateUserStatus(currentUserId, 'offline');
            io.emit('user_presence', { userId: currentUserId, status: 'offline' });
            // Hang up any call this user was part of
            for (const [callId, call] of activeCalls) {
              if (call.users.has(String(currentUserId))) {
                const peer = Array.from(call.users).find(u => u !== String(currentUserId));
                activeCalls.delete(callId);
                if (peer) io.to(`user:${peer}`).emit('call_ended', { callId, fromUserId: currentUserId, reason: 'disconnected' });
              }
            }
            console.log(`❌ User disconnected: ${currentUserId}`);
          }
        }
      }
    });
  });
}

// Function to notify participants when a new room is created
export function notifyRoomCreated(io, room, memberIds) {
  for (const memberId of memberIds) {
    io.to(`user:${memberId}`).emit('room_created', room);
  }
}
