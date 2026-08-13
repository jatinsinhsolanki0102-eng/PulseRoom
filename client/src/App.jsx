import React, { useState, useEffect, useRef, Component } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider, useSocket } from './context/SocketContext';
import { E2EEProvider, useE2EE } from './context/E2EEContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';

import AuthModal from './components/auth/AuthModal';
import Sidebar from './components/sidebar/Sidebar';
import ChatHeader from './components/chat/ChatHeader';
import MessageList from './components/chat/MessageList';
import ChatComposer from './components/composer/ChatComposer';
import ChatInfoDrawer from './components/chat/ChatInfoDrawer';
import CreateGroupModal from './components/groups/CreateGroupModal';
import GroupBridgeModal from './components/groups/GroupBridgeModal';
import ThemeStudio from './components/theme/ThemeStudio';
import CreateStatusModal from './components/status/CreateStatusModal';
import InviteFriendModal from './components/friends/InviteFriendModal';

import { MessageSquare, RefreshCw } from 'lucide-react';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('PulseRoom App Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#090d16',
          color: '#f8fafc',
          fontFamily: 'system-ui, sans-serif'
        }}>
          <div className="glass-panel" style={{ padding: '2.5rem', borderRadius: '24px', textAlign: 'center', maxWidth: '440px' }}>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem', color: '#ef4444' }}>Something went wrong</h2>
            <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
              A UI rendering error occurred. Please click below to refresh.
            </p>
            <button
              onClick={() => {
                localStorage.removeItem('pulseroom_token');
                window.location.reload();
              }}
              style={{
                padding: '0.75rem 1.5rem',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #6366f1, #a855f7)',
                color: 'white',
                border: 'none',
                fontWeight: '700',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <RefreshCw size={16} /> Reset & Reload Session
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function ChatAppContent() {
  const { user, token } = useAuth();
  const { socket, typingState, joinRoom, markRead } = useSocket();
  const { theme } = useTheme();
  const { ready: e2eeReady, decryptMessage, decryptMessages } = useE2EE();

  const [activeRoom, setActiveRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [replyTo, setReplyTo] = useState(null);

  const decryptingRef = useRef(new Set());
  // Permanently tracks message ids already received live so a duplicate delivery
  // (e.g. server retransmit) is dropped BEFORE decryption - this prevents the
  // replay counter from flagging a legitimate message as "replayed or duplicate".
  const processedIdsRef = useRef(new Set());

  // Modals & Panels state
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showBridgeModal, setShowBridgeModal] = useState(false);
  const [showThemeStudio, setShowThemeStudio] = useState(false);
  const [showCreateStatus, setShowCreateStatus] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showChatInfo, setShowChatInfo] = useState(false);

  // Reset active room when user account changes or logs out
  useEffect(() => {
    setActiveRoom(null);
    setMessages([]);
    setReplyTo(null);
  }, [user?.id]);

  useEffect(() => {
    if (activeRoom && token) {
      joinRoom(activeRoom.id);
      fetchRoomMessages(activeRoom.id);
      markRead(activeRoom.id);
    }
  }, [activeRoom, token]);

  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (msg) => {
      if (!msg || msg.room_id !== activeRoom?.id) return;
      if (processedIdsRef.current.has(msg.id)) return;
      processedIdsRef.current.add(msg.id);
      if (decryptingRef.current.has(msg.id)) return;
      decryptingRef.current.add(msg.id);
      // Decrypt in place so the bubble can render the plaintext immediately.
      decryptMessage(msg, activeRoom.id).then(decrypted => {
        decryptingRef.current.delete(msg.id);
        setMessages(cur => {
          const safeCur = Array.isArray(cur) ? cur : [];
          if (safeCur.some(m => m.id === msg.id)) return safeCur;
          return [...safeCur, decrypted];
        });
      }).catch(() => decryptingRef.current.delete(msg.id));
      markRead(activeRoom.id); // auto-mark incoming messages as read
    };

    const handleReactionUpdated = ({ messageId, reactions }) => {
      setMessages(prev => {
        const safePrev = Array.isArray(prev) ? prev : [];
        return safePrev.map(m => (m.id === messageId ? { ...m, reactions } : m));
      });
    };

    const handleReadReceipt = ({ roomId, userId, timestamp, messageIds }) => {
      if (roomId !== activeRoom?.id || !Array.isArray(messageIds)) return;
      const ids = new Set(messageIds);
      setMessages(prev => {
        const safePrev = Array.isArray(prev) ? prev : [];
        return safePrev.map(m => {
          if (!ids.has(m.id)) return m;
          const readBy = new Set(m.read_by || []);
          readBy.add(userId);
          return {
            ...m,
            read_by: Array.from(readBy),
            read_timestamps: { ...(m.read_timestamps || {}), [userId]: timestamp }
          };
        });
      });
    };

    const handleMessagesExpired = ({ roomId, messageIds }) => {
      if (roomId !== activeRoom?.id || !Array.isArray(messageIds)) return;
      const ids = new Set(messageIds);
      setMessages(prev => {
        const safePrev = Array.isArray(prev) ? prev : [];
        return safePrev.filter(m => !ids.has(m.id));
      });
    };

    const handleDisappearingTimerUpdated = ({ roomId, disappearing_seconds }) => {
      if (roomId === activeRoom?.id) {
        setActiveRoom(prev => prev ? { ...prev, disappearing_seconds } : prev);
      }
    };

    const handleUserBlocked = ({ blockerId, blockedId }) => {
      if (blockerId === user?.id || blockedId === user?.id) {
        const partnerId = activeRoom?.type === 'private' ? activeRoom.partner?.id : null;
        if (partnerId && (partnerId === blockerId || partnerId === blockedId)) {
          setActiveRoom(null);
          setMessages([]);
        }
      }
    };

    const handleMessageDeletedForMe = ({ messageId, userId }) => {
      if (userId !== user?.id) return;
      setMessages(prev => {
        const safePrev = Array.isArray(prev) ? prev : [];
        return safePrev.filter(m => m.id !== messageId);
      });
    };

    const handleRoomDeletedForMe = ({ roomId, userId }) => {
      if (userId !== user?.id) return;
      if (roomId === activeRoom?.id) {
        setActiveRoom(null);
        setMessages([]);
      }
    };

    const handleRoomCleared = ({ roomId, userId }) => {
      if (userId !== user?.id) return;
      if (roomId === activeRoom?.id) {
        setMessages([]);
      }
    };

    const handleRoomMembersUpdated = (updatedRoom) => {
      if (updatedRoom && updatedRoom.id === activeRoom?.id) {
        setActiveRoom(updatedRoom);
      }
    };

    // If the socket was still connecting when the room was opened, mark_read was
    // skipped - re-mark on connect so read receipts reach the other user.
    const handleSocketConnected = () => {
      if (activeRoom?.id && token) markRead(activeRoom.id);
    };

    socket.on('connect', handleSocketConnected);
    socket.on('new_message', handleNewMessage);
    socket.on('reaction_updated', handleReactionUpdated);
    socket.on('read_receipt', handleReadReceipt);
    socket.on('messages_expired', handleMessagesExpired);
    socket.on('disappearing_timer_updated', handleDisappearingTimerUpdated);
    socket.on('user_blocked', handleUserBlocked);
    socket.on('message_deleted_for_me', handleMessageDeletedForMe);
    socket.on('room_deleted_for_me', handleRoomDeletedForMe);
    socket.on('room_cleared', handleRoomCleared);
    socket.on('room_members_updated', handleRoomMembersUpdated);

    return () => {
      socket.off('connect', handleSocketConnected);
      socket.off('new_message', handleNewMessage);
      socket.off('reaction_updated', handleReactionUpdated);
      socket.off('read_receipt', handleReadReceipt);
      socket.off('messages_expired', handleMessagesExpired);
      socket.off('disappearing_timer_updated', handleDisappearingTimerUpdated);
      socket.off('user_blocked', handleUserBlocked);
      socket.off('message_deleted_for_me', handleMessageDeletedForMe);
      socket.off('room_deleted_for_me', handleRoomDeletedForMe);
      socket.off('room_cleared', handleRoomCleared);
      socket.off('room_members_updated', handleRoomMembersUpdated);
    };
  }, [socket, activeRoom, user?.id]);

  const fetchRoomMessages = async (roomId) => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/messages`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const decrypted = await decryptMessages(Array.isArray(data) ? data : [], roomId);
        // Merge with the current list by id: keep an already-decrypted good copy
        // instead of replacing it with a re-decrypted one. Re-decrypting messages
        // that were already seen live trips the replay counter on the latest one
        // (e.g. during the e2ee-ready refetch) and would show false replays.
        setMessages(prev => {
          const prevArr = Array.isArray(prev) ? prev : [];
          const prevById = new Map(prevArr.map(m => [m.id, m]));
          const out = [];
          for (const m of decrypted) {
            const existing = prevById.get(m.id);
            if (existing && !existing.__replay && !existing.__undecryptable) {
              out.push(existing);
            } else {
              out.push(m);
            }
          }
          return out;
        });
      } else {
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      setMessages([]);
    }
  };

  // Once E2EE keys are ready, re-fetch so messages that arrived while the key
  // was still being generated get decrypted properly.
  useEffect(() => {
    if (e2eeReady && activeRoom?.id) {
      fetchRoomMessages(activeRoom.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e2eeReady]);

  const handleDeleteMessage = async (messageId) => {
    try {
      const res = await fetch(`/api/messages/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setMessages(prev => prev.filter(m => m.id !== messageId));
      }
    } catch (err) {
      console.error('Failed to delete message:', err);
    }
  };

  const handleTogglePin = async () => {
    if (!activeRoom) return;
    try {
      const res = await fetch(`/api/rooms/${activeRoom.id}/pin`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setActiveRoom(prev => prev ? { ...prev, is_pinned: data.is_pinned } : null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteChat = async () => {
    if (!activeRoom) return;
    try {
      const res = await fetch(`/api/rooms/${activeRoom.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setActiveRoom(null);
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to delete chat:', err);
    }
  };

  const handleClearChat = async () => {
    if (!activeRoom) return;
    try {
      const res = await fetch(`/api/rooms/${activeRoom.id}/clear`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to clear chat:', err);
    }
  };

  const handleMembersAdded = (updatedRoom) => {
    setActiveRoom(updatedRoom);
    setShowChatInfo(false);
  };

  const handleReportMessage = async (messageId, reason) => {
    try {
      const res = await fetch(`/api/messages/${messageId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason })
      });
      return res.ok;
    } catch (err) {
      console.error('Failed to report message:', err);
      return false;
    }
  };

  const handleBlockUser = async () => {
    const partnerId = activeRoom?.type === 'private' ? activeRoom.partner?.id : null;
    if (!partnerId) return;
    try {
      await fetch(`/api/users/${partnerId}/block`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      setActiveRoom(null);
      setMessages([]);
    } catch (err) {
      console.error('Failed to block user:', err);
    }
  };

  // Web Push notification registration + subscription
  useEffect(() => {
    if (!user || !token) return;
    let cancelled = false;
    const enablePush = async () => {
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        const reg = await navigator.serviceWorker.register('/sw.js');
        if (Notification.permission === 'denied') return;
        if (Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
        const vapidRes = await fetch('/api/push/vapid-public-key');
        if (!vapidRes.ok) return;
        const { publicKey } = await vapidRes.json();
        if (!publicKey) return;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const applicationServerKey = urlBase64ToUint8Array(publicKey);
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        }
        if (cancelled) return;
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ subscription: sub.toJSON() })
        });
      } catch (err) {
        console.warn('Push notification setup skipped:', err.message);
      }
    };
    enablePush();
    return () => { cancelled = true; };
  }, [user, token]);

  if (!user) {
    return <AuthModal />;
  }

  const wallpaperClass = theme?.backgroundWallpaper || 'wallpaper-mesh-dark';
  const typingUser = activeRoom && typingState ? typingState[activeRoom.id] : null;

  return (
    <div className={`app-container ${wallpaperClass} ${activeRoom ? 'has-active-room' : 'no-active-room'}`}>
      {/* Sidebar Inbox */}
      <Sidebar
        activeRoom={activeRoom}
        onSelectRoom={setActiveRoom}
        onOpenGroupModal={() => setShowGroupModal(true)}
        onOpenBridgeModal={() => setShowBridgeModal(true)}
        onOpenThemeStudio={() => setShowThemeStudio(true)}
        onOpenCreateStatus={() => setShowCreateStatus(true)}
        onOpenInviteModal={() => setShowInviteModal(true)}
      />

      {/* Main Real-Time Messaging View */}
      <div className="chat-view">
        {activeRoom ? (
          <>
            <ChatHeader
              room={activeRoom}
              onToggleInfo={() => setShowChatInfo(!showChatInfo)}
              onBack={() => setActiveRoom(null)}
            />

            <MessageList
              messages={messages}
              roomId={activeRoom.id}
              typingUser={typingUser}
              onReply={setReplyTo}
              onDeleteMessage={handleDeleteMessage}
              onReportMessage={handleReportMessage}
            />

            <ChatComposer
              room={activeRoom}
              roomId={activeRoom.id}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
            />
          </>
        ) : (
          <div className="empty-chat-state" style={{
            margin: 'auto',
            textAlign: 'center',
            color: 'var(--text-muted)'
          }}>
            <div className="brand-icon" style={{ width: '64px', height: '64px', margin: '0 auto 1rem' }}>
              <MessageSquare size={32} />
            </div>
            <h2 style={{ fontFamily: 'Outfit', fontSize: '1.75rem', fontWeight: '800', color: 'var(--text-main)' }}>
              Welcome to PulseRoom
            </h2>
            <p style={{ marginTop: '0.5rem', maxWidth: '360px' }}>
              Select a 1:1 direct chat, group room, or user from the sidebar to begin messaging in real-time.
            </p>
          </div>
        )}
      </div>

      {/* Right-Side Chat Details Drawer */}
      {showChatInfo && activeRoom && (
        <ChatInfoDrawer
          room={activeRoom}
          onClose={() => setShowChatInfo(false)}
          onTogglePin={handleTogglePin}
          onDeleteChat={handleDeleteChat}
          onClearChat={handleClearChat}
          onMembersAdded={handleMembersAdded}
          onBlockUser={handleBlockUser}
        />
      )}

      {/* Modals */}
      {showGroupModal && (
        <CreateGroupModal
          onClose={() => setShowGroupModal(false)}
          onGroupCreated={(group) => setActiveRoom(group)}
        />
      )}

      {showBridgeModal && (
        <GroupBridgeModal
          onClose={() => setShowBridgeModal(false)}
        />
      )}

      {showThemeStudio && (
        <ThemeStudio
          onClose={() => setShowThemeStudio(false)}
        />
      )}

      {showCreateStatus && (
        <CreateStatusModal
          onClose={() => setShowCreateStatus(false)}
        />
      )}

      {showInviteModal && (
        <InviteFriendModal
          onClose={() => setShowInviteModal(false)}
          onChatInitiated={(room) => setActiveRoom(room)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <SocketProvider>
          <E2EEProvider>
            <ThemeProvider>
              <ChatAppContent />
            </ThemeProvider>
          </E2EEProvider>
        </SocketProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
