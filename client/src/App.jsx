import React, { useState, useEffect, Component } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider, useSocket } from './context/SocketContext';
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

function ChatAppContent() {
  const { user, token } = useAuth();
  const { socket, typingState, joinRoom } = useSocket();
  const { theme } = useTheme();

  const [activeRoom, setActiveRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [replyTo, setReplyTo] = useState(null);

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
    }
  }, [activeRoom, token]);

  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (msg) => {
      if (msg && msg.room_id === activeRoom?.id) {
        setMessages(prev => {
          const safePrev = Array.isArray(prev) ? prev : [];
          if (safePrev.some(m => m.id === msg.id)) return safePrev;
          return [...safePrev, msg];
        });
      }
    };

    const handleReactionUpdated = ({ messageId, reactions }) => {
      setMessages(prev => {
        const safePrev = Array.isArray(prev) ? prev : [];
        return safePrev.map(m => (m.id === messageId ? { ...m, reactions } : m));
      });
    };

    const handleMessageDeleted = (deletedMessageId) => {
      setMessages(prev => {
        const safePrev = Array.isArray(prev) ? prev : [];
        return safePrev.filter(m => m.id !== deletedMessageId);
      });
    };

    socket.on('new_message', handleNewMessage);
    socket.on('reaction_updated', handleReactionUpdated);
    socket.on('message_deleted', handleMessageDeleted);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('reaction_updated', handleReactionUpdated);
      socket.off('message_deleted', handleMessageDeleted);
    };
  }, [socket, activeRoom]);

  const fetchRoomMessages = async (roomId) => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/messages`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(Array.isArray(data) ? data : []);
      } else {
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
      setMessages([]);
    }
  };

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
            />

            <ChatComposer
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
          <ThemeProvider>
            <ChatAppContent />
          </ThemeProvider>
        </SocketProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
