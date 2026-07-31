import { db } from './db.js';

// Active connected sockets tracking
const userSockets = new Map(); // userId -> Set<socketId>

export function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    let currentUserId = null;

    // 1. Authenticate & Bind User Session
    socket.on('user_connected', async (userId) => {
      if (!userId) return;
      currentUserId = userId;
      socket.userId = userId;

      if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
      }
      userSockets.get(userId).add(socket.id);

      // Join personal user room for direct user notifications
      socket.join(`user:${userId}`);

      // Update online status in database
      await db.updateUserStatus(userId, 'online');

      // Join user to all their room channels
      const rooms = await db.getUserRooms(userId);
      for (const room of rooms) {
        socket.join(room.id);
      }

      // Broadcast presence update to all connected clients
      io.emit('user_presence', { userId, status: 'online' });
      console.log(`🔌 User connected socket: ${userId} (${socket.id})`);
    });

    // 2. Join specific room dynamic channel
    socket.on('join_room', (roomId) => {
      socket.join(roomId);
      console.log(`👤 Socket ${socket.id} joined room ${roomId}`);
    });

    // 3. Handle Real-Time Messaging (Direct 1:1 & Group)
    socket.on('send_message', async (data) => {
      try {
        const { roomId, senderId, text, type, mediaUrl, replyToId } = data;
        if (!roomId || !senderId || (!text && !mediaUrl)) return;

        // Persist message to database
        const message = await db.createMessage({
          roomId,
          senderId,
          text,
          type: type || 'text',
          mediaUrl: mediaUrl || '',
          replyToId: replyToId || null
        });

        // Fetch all members of this room to guarantee real-time delivery
        const memberIds = await db.getRoomMemberIds(roomId);

        // Broadcast to target room channel
        io.to(roomId).emit('new_message', message);

        // Also emit directly to every member's user channel to update unread counts and sidebar
        for (const memberId of memberIds) {
          io.to(`user:${memberId}`).emit('new_message', message);
        }

        // 🌟 KEY DIFFERENTIATOR: Group-to-Group Room Bridging!
        const bridges = await db.getRoomBridges(roomId);
        if (bridges && bridges.length > 0) {
          for (const bridge of bridges) {
            const bridgedText = `[Bridged Message]: ${text || ''}`;
            const bridgedMsg = await db.createMessage({
              roomId: bridge.target_room_id,
              senderId,
              text: bridgedText,
              type: type || 'text',
              mediaUrl: mediaUrl || '',
              replyToId: null
            });
            io.to(bridge.target_room_id).emit('new_message', bridgedMsg);
            const targetMembers = await db.getRoomMemberIds(bridge.target_room_id);
            for (const tmId of targetMembers) {
              io.to(`user:${tmId}`).emit('new_message', bridgedMsg);
            }
          }
        }
      } catch (err) {
        console.error('Error handling send_message socket event:', err);
        socket.emit('error_message', { error: 'Failed to send real-time message.' });
      }
    });

    // 4. Typing Indicators
    socket.on('typing_start', ({ roomId, username }) => {
      socket.to(roomId).emit('user_typing', { roomId, username, isTyping: true });
    });

    socket.on('typing_stop', ({ roomId, username }) => {
      socket.to(roomId).emit('user_typing', { roomId, username, isTyping: false });
    });

    // 5. Message Reactions
    socket.on('toggle_reaction', async ({ messageId, roomId, emoji, userId }) => {
      try {
        const updatedMsg = await db.toggleReaction(messageId, emoji, userId);
        if (updatedMsg) {
          io.to(roomId).emit('reaction_updated', { messageId, reactions: updatedMsg.reactions });
        }
      } catch (err) {
        console.error('Error handling reaction event:', err);
      }
    });

    // 6. Theme Updates Notification
    socket.on('update_theme', async ({ userId, themePreferences }) => {
      const updated = await db.updateUserTheme(userId, themePreferences);
      socket.emit('theme_updated', updated);
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
            console.log(`❌ User disconnected: ${currentUserId}`);
          }
        }
      }
    });
  });
}

// Function to notify participants when a new room (private or group) is created
export function notifyRoomCreated(io, room, memberIds) {
  for (const memberId of memberIds) {
    io.to(`user:${memberId}`).emit('room_created', room);
  }
}
