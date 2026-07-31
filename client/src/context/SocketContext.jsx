import React, { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext();

export function SocketProvider({ children }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [typingState, setTypingState] = useState({}); // { roomId: username }

  useEffect(() => {
    if (!user) {
      if (socket) socket.disconnect();
      return;
    }

    // Connect to backend port 5000 directly or via proxy
    const socketUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
      ? 'http://localhost:5000' 
      : undefined;

    const newSocket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
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

    newSocket.on('user_typing', ({ roomId, username, isTyping }) => {
      setTypingState(prev => ({
        ...prev,
        [roomId]: isTyping ? username : null
      }));
    });

    setSocket(newSocket);

    return () => newSocket.disconnect();
  }, [user]);

  const joinRoom = (roomId) => {
    if (socket && roomId) {
      socket.emit('join_room', roomId);
    }
  };

  const sendMessage = ({ roomId, text, type, mediaUrl, replyToId }) => {
    if (socket && user) {
      socket.emit('send_message', {
        roomId,
        senderId: user.id,
        text,
        type: type || 'text',
        mediaUrl,
        replyToId
      });
    }
  };

  const setTyping = (roomId, isTyping) => {
    if (socket && user) {
      if (isTyping) {
        socket.emit('typing_start', { roomId, username: user.username });
      } else {
        socket.emit('typing_stop', { roomId, username: user.username });
      }
    }
  };

  const toggleReaction = (messageId, roomId, emoji) => {
    if (socket && user) {
      socket.emit('toggle_reaction', { messageId, roomId, emoji, userId: user.id });
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
      toggleReaction
    }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);
