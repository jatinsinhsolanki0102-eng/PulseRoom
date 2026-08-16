import React, { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext();

export function SocketProvider({ children }) {
  const { user, token } = useAuth();
  const [socket, setSocket] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [typingState, setTypingState] = useState({});

  useEffect(() => {
    if (!user) {
      if (socket) socket.disconnect();
      return;
    }

    const socketUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
      ? 'http://localhost:5000' 
      : undefined;

    const newSocket = io(socketUrl, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
    });

    newSocket.on('connect', () => {
      console.log('⚡ Real-time Socket Connected');
      newSocket.emit('user_connected', user.id);
    });

    newSocket.on('user_presence', ({ userId, status }) => {
      setOnlineUsers(prev => {
        const next = new Set(prev);
        if (status === 'online') next.add(userId);
        else next.delete(userId);
        return next;
      });
    });

    // Full snapshot of currently-online users (sent on our connect)
    newSocket.on('presence_snapshot', ({ onlineUserIds }) => {
      if (Array.isArray(onlineUserIds)) {
        setOnlineUsers(new Set(onlineUserIds.filter(id => id !== user.id)));
      }
    });

    newSocket.on('user_typing', ({ roomId, username, isTyping }) => {
      setTypingState(prev => ({
        ...prev,
        [roomId]: isTyping ? username : null
      }));
    });

    setSocket(newSocket);

    return () => newSocket.disconnect();
  }, [user, token]);

  const joinRoom = (roomId) => {
    if (socket && roomId && socket.connected) {
      socket.emit('join_room', roomId);
    }
  };

  const sendMessage = async ({ roomId, text, type, mediaUrl, replyToId, e2ee }) => {
    if (socket && socket.connected && user) {
      socket.emit('send_message', {
        roomId,
        senderId: user.id,
        text,
        type: type || 'text',
        mediaUrl,
        replyToId,
        e2ee: Boolean(e2ee)
      });
      // The sender's echo arrives via the socket's own 'new_message' event.
      return null;
    } else if (token) {
      // REST HTTP Message Fallback when Socket.IO server is disconnected (e.g. Vercel Serverless environment)
      try {
        const res = await fetch('/api/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ roomId, text, type: type || 'text', mediaUrl, replyToId, e2ee: Boolean(e2ee) })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.error('REST sendMessage fallback failed:', errData.error || res.status);
          return null;
        }
        // Return the created message so the caller can render the sender's own
        // message (there is no socket echo to do it on a serverless deployment).
        return await res.json();
      } catch (err) {
        console.error('HTTP REST sendMessage fallback error:', err);
        return null;
      }
    }
    return null;
  };

  const setTyping = (roomId, isTyping) => {
    if (socket && socket.connected && user) {
      if (isTyping) {
        socket.emit('typing_start', { roomId, username: user.username });
      } else {
        socket.emit('typing_stop', { roomId, username: user.username });
      }
    }
  };

  const toggleReaction = (messageId, roomId, emoji) => {
    if (socket && socket.connected && user) {
      socket.emit('toggle_reaction', { messageId, roomId, emoji, userId: user.id });
    }
  };

  // WhatsApp-style read receipt: tell the server the active room is open
  const markRead = (roomId) => {
    if (socket && socket.connected && user && roomId) {
      socket.emit('mark_read', { roomId, userId: user.id });
    }
  };

  return (
    <SocketContext.Provider value={{
      socket,
      onlineUsers,
      typingState,
      joinRoom,
      sendMessage,
      setTyping,
      toggleReaction,
      markRead
    }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);
