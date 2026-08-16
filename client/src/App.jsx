import React, { useState, useEffect, useRef, useMemo, useCallback, Component } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider, useSocket } from './context/SocketContext';
import { E2EEProvider, useE2EE } from './context/E2EEContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { CallProvider, useCall } from './context/CallContext';

import AuthModal from './components/auth/AuthModal';
import Sidebar from './components/sidebar/Sidebar';
import ChatHeader from './components/chat/ChatHeader';
import MessageList from './components/chat/MessageList';
import ChatSearchBar from './components/chat/ChatSearchBar';
import ChatComposer from './components/composer/ChatComposer';
import ChatInfoDrawer from './components/chat/ChatInfoDrawer';
import ForwardMessageModal from './components/chat/ForwardMessageModal';
import MediaGalleryModal from './components/chat/MediaGalleryModal';
import StarredMessagesModal from './components/chat/StarredMessagesModal';
import ScheduledMessagesModal from './components/chat/ScheduledMessagesModal';
import CreateGroupModal from './components/groups/CreateGroupModal';
import GroupBridgeModal from './components/groups/GroupBridgeModal';
import ThemeStudio from './components/theme/ThemeStudio';
import CreateStatusModal from './components/status/CreateStatusModal';
import InviteFriendModal from './components/friends/InviteFriendModal';
import ModerationDashboard from './components/moderation/ModerationDashboard';

import { loadSchedules, saveSchedules, makeScheduleId } from './lib/schedule';
import { playNotificationSound } from './lib/notifications';

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
                sessionStorage.removeItem('pulseroom_token');
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
  const { socket, typingState, joinRoom, markRead, sendMessage } = useSocket();
  const { theme } = useTheme();
  const { ready: e2eeReady, decryptMessage, decryptMessages, encryptForSend } = useE2EE();
  const { startCall } = useCall();

  const [activeRoom, setActiveRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [replyTo, setReplyTo] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [forwardMessage, setForwardMessage] = useState(null);
  const [chatSearchActive, setChatSearchActive] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [chatSearchIndex, setChatSearchIndex] = useState(0);

  const decryptingRef = useRef(new Set());
  // Permanently tracks message ids already received live so a duplicate delivery
  // (e.g. server retransmit) is dropped BEFORE decryption - this prevents the
  // replay counter from flagging a legitimate message as "replayed or duplicate".
  const processedIdsRef = useRef(new Set());
  // Latest refs so the socket handlers can trigger a history re-sync without
  // churning their useEffect dependency array.
  const fetchRoomMessagesRef = useRef(null);
  const lastE2eeResyncRef = useRef(0);

  // Notification state: per-room unread counts + per-room mute set.
  // unreadCounts is the authoritative count (synced from the server's
  // unread_count on every room fetch, zeroed when the chat is opened).
  const [unreadCounts, setUnreadCounts] = useState({});
  const [mutedRooms, setMutedRooms] = useState(() => new Set());
  const mutedRoomsRef = useRef(new Set());
  useEffect(() => { mutedRoomsRef.current = mutedRooms; }, [mutedRooms]);

  // Per-user archived chats (hidden from the main inbox) + manual "mark as
  // unread" overrides. Both are synced from the server's room payloads and
  // survive reloads (persisted per-user like pins/mutes).
  const [archivedRooms, setArchivedRooms] = useState(() => new Set());
  const archivedRoomsRef = useRef(new Set());
  useEffect(() => { archivedRoomsRef.current = archivedRooms; }, [archivedRooms]);
  const [unreadMarkedRooms, setUnreadMarkedRooms] = useState(() => new Set());
  const unreadMarkedRef = useRef(new Set());
  useEffect(() => { unreadMarkedRef.current = unreadMarkedRooms; }, [unreadMarkedRooms]);

  // Modals & Panels state
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showBridgeModal, setShowBridgeModal] = useState(false);
  const [showThemeStudio, setShowThemeStudio] = useState(false);
  const [showCreateStatus, setShowCreateStatus] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showChatInfo, setShowChatInfo] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [showStarred, setShowStarred] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);
  const [showModeration, setShowModeration] = useState(false);

  // Scheduled messages (persisted per-user in localStorage)
  const [scheduled, setScheduled] = useState([]);
  const scheduledRef = useRef([]);
  const firingRef = useRef(new Set());

  // Reset active room when user account changes or logs out
  useEffect(() => {
    setActiveRoom(null);
    setMessages([]);
    setReplyTo(null);
    setEditingMessage(null);
    setForwardMessage(null);
    setChatSearchActive(false);
    setChatSearchQuery('');
  }, [user?.id]);

  // Clear ephemeral state when switching chats
  useEffect(() => {
    setReplyTo(null);
    setEditingMessage(null);
    setChatSearchActive(false);
    setChatSearchQuery('');
  }, [activeRoom?.id]);

  useEffect(() => {
    if (activeRoom && token) {
      joinRoom(activeRoom.id);
      fetchRoomMessages(activeRoom.id);
      markRead(activeRoom.id);
    }
  }, [activeRoom, token]);

  // Re-fetch the full /api/rooms payload for one room so the active chat's
  // members, roles and metadata stay fresh after admin actions (promote/demote,
  // remove, group edit, leave). Declared before the socket effect below because
  // its dependency array references this callback.
  const refreshActiveRoom = useCallback(async (roomId = activeRoom?.id) => {
    if (!roomId || !token) return;
    try {
      const res = await fetch('/api/rooms', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      const rooms = Array.isArray(data) ? data : [];
      const fresh = rooms.find(r => r.id === roomId);
      if (fresh) setActiveRoom(fresh);
    } catch (err) {
      console.error('Failed to refresh active room:', err);
    }
  }, [token, activeRoom?.id]);

  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (msg) => {
      if (!msg) return;

      const isOwn = msg.sender_id === user?.id;
      const isActive = msg.room_id === activeRoom?.id;

      // Unread badge: count messages that arrive outside the open chat.
      // Your own echoes are never counted as unread.
      if (!isActive && !isOwn) {
        setUnreadCounts(prev => ({
          ...prev,
          [msg.room_id]: (Number(prev[msg.room_id]) || 0) + 1
        }));
      }

      // Notification sound for background rooms, or the open chat while the
      // tab is hidden. Muted chats are silent; own echoes never play a sound.
      const isMuted = mutedRoomsRef.current.has(msg.room_id);
      if (!isMuted && !isOwn && (!isActive || document.hidden)) {
        playNotificationSound();
      }

      if (!isActive) return;
      if (processedIdsRef.current.has(msg.id)) return;
      processedIdsRef.current.add(msg.id);
      if (decryptingRef.current.has(msg.id)) return;
      decryptingRef.current.add(msg.id);
      // Decrypt in place so the bubble can render the plaintext immediately.
      // The sender's own echo is decrypted via its embedded self-copy, so the
      // person who sent the message sees it appear in real-time like WhatsApp.
      decryptMessage(msg, activeRoom.id).then(decrypted => {
        decryptingRef.current.delete(msg.id);
        // Self-heal: a live group message that could not be decrypted means the
        // sender-key chain has drifted. Re-fetch history so the batch re-derive
        // in E2EEContext can resync the chain (throttled to avoid a refetch storm).
        if (
          decrypted?.e2ee &&
          decrypted.__undecryptable &&
          activeRoom?.type === 'group' &&
          Date.now() - lastE2eeResyncRef.current > 3000
        ) {
          lastE2eeResyncRef.current = Date.now();
          fetchRoomMessagesRef.current?.(activeRoom.id);
        }
        setMessages(cur => {
          const safeCur = Array.isArray(cur) ? cur : [];
          if (safeCur.some(m => m.id === msg.id)) return safeCur;
          return [...safeCur, decrypted];
        });
      }).catch(() => decryptingRef.current.delete(msg.id));
      if (!isOwn) markRead(activeRoom.id); // auto-mark incoming messages as read
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

    const handleMessageDeletedEveryone = ({ messageId }) => {
      setMessages(prev => {
        const safePrev = Array.isArray(prev) ? prev : [];
        return safePrev.map(m => (
          m.id === messageId
            ? { ...m, type: 'deleted', deleted_for_everyone: true, text: '', media_url: '', decryptedText: '', decryptedMediaUrl: null }
            : m
        ));
      });
    };

    const handleMessageEdited = (updated) => {
      if (!updated || updated.room_id !== activeRoom?.id) return;
      // E2EE edits arrive as a fresh ciphertext envelope - decrypt it in place.
      decryptMessage(updated, activeRoom.id).then(dec => {
        setMessages(prev => {
          const safePrev = Array.isArray(prev) ? prev : [];
          return safePrev.map(m => (m.id === dec.id ? { ...m, ...dec } : m));
        });
      }).catch(() => {
        setMessages(prev => {
          const safePrev = Array.isArray(prev) ? prev : [];
          return safePrev.map(m => (m.id === updated.id ? { ...m, ...updated } : m));
        });
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
      if (!updatedRoom || !updatedRoom.id) return;
      if (updatedRoom.id !== activeRoom?.id) return;
      // Full room payloads (e.g. after adding members) can be applied directly;
      // minimal `{ id }` payloads (admin actions) trigger a fresh server fetch.
      if (updatedRoom.members || updatedRoom.name) {
        setActiveRoom(updatedRoom);
      } else {
        refreshActiveRoom(updatedRoom.id);
      }
    };

    const handleRoomUpdated = (updated) => {
      if (updated && updated.id === activeRoom?.id) {
        setActiveRoom(prev => (prev ? { ...prev, ...updated } : prev));
      }
    };

    const handleGroupRoleUpdated = ({ roomId }) => {
      if (roomId === activeRoom?.id) refreshActiveRoom(roomId);
    };

    const handleRemovedFromRoom = ({ roomId, removedUserId }) => {
      if (roomId === activeRoom?.id) {
        if (String(removedUserId) === String(user?.id)) {
          setShowChatInfo(false);
          setActiveRoom(null);
          setMessages([]);
        } else {
          refreshActiveRoom(roomId);
        }
      }
    };

    const handleLeftRoom = ({ roomId, userId }) => {
      if (roomId === activeRoom?.id && String(userId) === String(user?.id)) {
        setShowChatInfo(false);
        setActiveRoom(null);
        setMessages([]);
      }
    };

    const handleRoomDeleted = ({ roomId }) => {
      if (roomId === activeRoom?.id) {
        setShowChatInfo(false);
        setActiveRoom(null);
        setMessages([]);
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
    socket.on('message_deleted_everyone', handleMessageDeletedEveryone);
    socket.on('message_edited', handleMessageEdited);
    socket.on('room_deleted_for_me', handleRoomDeletedForMe);
    socket.on('room_cleared', handleRoomCleared);
    socket.on('room_members_updated', handleRoomMembersUpdated);
    socket.on('room_updated', handleRoomUpdated);
    socket.on('group_role_updated', handleGroupRoleUpdated);
    socket.on('removed_from_room', handleRemovedFromRoom);
    socket.on('left_room', handleLeftRoom);
    socket.on('room_deleted', handleRoomDeleted);

    return () => {
      socket.off('connect', handleSocketConnected);
      socket.off('new_message', handleNewMessage);
      socket.off('reaction_updated', handleReactionUpdated);
      socket.off('read_receipt', handleReadReceipt);
      socket.off('messages_expired', handleMessagesExpired);
      socket.off('disappearing_timer_updated', handleDisappearingTimerUpdated);
      socket.off('user_blocked', handleUserBlocked);
      socket.off('message_deleted_for_me', handleMessageDeletedForMe);
      socket.off('message_deleted_everyone', handleMessageDeletedEveryone);
      socket.off('message_edited', handleMessageEdited);
      socket.off('room_deleted_for_me', handleRoomDeletedForMe);
      socket.off('room_cleared', handleRoomCleared);
      socket.off('room_members_updated', handleRoomMembersUpdated);
      socket.off('room_updated', handleRoomUpdated);
      socket.off('group_role_updated', handleGroupRoleUpdated);
      socket.off('removed_from_room', handleRemovedFromRoom);
      socket.off('left_room', handleLeftRoom);
      socket.off('room_deleted', handleRoomDeleted);
    };
  }, [socket, activeRoom, user?.id, decryptMessage, refreshActiveRoom]);

  // Render a message the user sent via the REST fallback (no Socket.IO on
  // serverless deployments), so their own message appears without waiting for
  // an echo. Mirrors the decrypt-and-append part of the socket 'new_message'
  // handler; own messages never bump unread counts or play sounds.
  const handleRestDeliveredMessage = useCallback((msg) => {
    if (!msg) return;
    if (msg.room_id !== activeRoom?.id) return;
    if (processedIdsRef.current.has(msg.id)) return;
    processedIdsRef.current.add(msg.id);
    if (decryptingRef.current.has(msg.id)) return;
    decryptingRef.current.add(msg.id);
    decryptMessage(msg, activeRoom.id).then(decrypted => {
      decryptingRef.current.delete(msg.id);
      setMessages(cur => {
        const safeCur = Array.isArray(cur) ? cur : [];
        if (safeCur.some(m => m.id === msg.id)) return safeCur;
        return [...safeCur, decrypted];
      });
    }).catch(() => decryptingRef.current.delete(msg.id));
  }, [activeRoom?.id, decryptMessage]);

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
  fetchRoomMessagesRef.current = fetchRoomMessages;

  // Sync unread counts + muted/archived/marked-unread sets from the server's
  // room list (authoritative).
  const handleRoomsSynced = (roomsArray) => {
    if (!Array.isArray(roomsArray)) return;
    const counts = {};
    const muted = new Set(mutedRoomsRef.current);
    const archived = new Set(archivedRoomsRef.current);
    const unreadMarked = new Set(unreadMarkedRef.current);
    for (const r of roomsArray) {
      if (!r || !r.id) continue;
      counts[r.id] = Number(r.unread_count) || 0;
      if (r.is_muted) muted.add(r.id);
      else muted.delete(r.id);
      if (r.is_archived) archived.add(r.id);
      else archived.delete(r.id);
      if (r.is_unread) unreadMarked.add(r.id);
      else unreadMarked.delete(r.id);
    }
    setUnreadCounts(counts);
    setMutedRooms(muted);
    setArchivedRooms(archived);
    setUnreadMarkedRooms(unreadMarked);
  };

  // Opening a chat clears its unread badge.
  const markRoomRead = (roomId) => {
    if (!roomId) return;
    setUnreadCounts(prev => {
      if (!prev[roomId]) return prev;
      const next = { ...prev, [roomId]: 0 };
      return next;
    });
  };

  const handleSelectRoom = (room) => {
    setActiveRoom(room);
    markRoomRead(room?.id);
  };

  const handleMuteChanged = (roomId, isMuted) => {
    setMutedRooms(prev => {
      const next = new Set(prev);
      if (isMuted) next.add(roomId);
      else next.delete(roomId);
      return next;
    });
  };

  const handleLeaveGroup = async () => {
    if (!activeRoom) return;
    try {
      const res = await fetch(`/api/rooms/${activeRoom.id}/leave`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setShowChatInfo(false);
        setActiveRoom(null);
        setMessages([]);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to leave group.');
      }
    } catch (err) {
      console.error('Failed to leave group:', err);
    }
  };

  // Open a specific room from a notification (deep-link). Fetches the user's
  // room list and selects the matching room so messages load automatically.
  const openRoomById = async (roomId) => {
    if (!roomId || !token || !user) return;
    try {
      const res = await fetch('/api/rooms', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return;
      const rooms = await res.json();
      const room = (Array.isArray(rooms) ? rooms : []).find(r => r.id === roomId);
      if (room) handleSelectRoom(room);
    } catch (err) {
      console.error('Failed to open room from notification:', err);
    }
  };

  // Deep-link: a notification click can open the app with ?room=<id>, or the
  // service worker posts OPEN_ROOM to an already-open window.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      window.history.replaceState({}, '', window.location.pathname);
      if (user && token) openRoomById(roomParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, token]);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !user) return;
    const handler = (event) => {
      if (event.data && event.data.type === 'OPEN_ROOM' && event.data.roomId) {
        openRoomById(event.data.roomId);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, token]);

  // Document title + PWA app badge reflect the total unread count. Manually
  // marked-unread chats count as one unread when they have no real unread msgs.
  const totalUnread = useMemo(() => {
    const real = Object.values(unreadCounts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    const marked = Array.from(unreadMarkedRooms).filter(id => !(Number(unreadCounts[id]) || 0)).length;
    return real + marked;
  }, [unreadCounts, unreadMarkedRooms]);

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) PulseRoom` : 'PulseRoom';
    try {
      if (totalUnread > 0 && navigator.setAppBadge) {
        navigator.setAppBadge(totalUnread).catch(() => {});
      } else if (navigator.clearAppBadge) {
        navigator.clearAppBadge().catch(() => {});
      }
    } catch (e) { /* badge API unavailable */ }
  }, [totalUnread]);

  // Once E2EE keys are ready, re-fetch so messages that arrived while the key
  // was still being generated get decrypted properly.
  useEffect(() => {
    if (e2eeReady && activeRoom?.id) {
      fetchRoomMessages(activeRoom.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e2eeReady]);

  // ---- Scheduled messages: load on login, persist on change ----
  useEffect(() => {
    if (!user?.id) return;
    setScheduled(loadSchedules(user.id));
  }, [user?.id]);

  useEffect(() => {
    scheduledRef.current = scheduled;
  }, [scheduled]);

  useEffect(() => {
    if (!user?.id) return;
    saveSchedules(user.id, scheduled);
  }, [user?.id, scheduled]);

  const handleScheduleMessage = (payload) => {
    if (!user?.id) return;
    const item = { id: makeScheduleId(), ...payload };
    setScheduled(prev => [...prev, item]);
    alert('Message scheduled!');
  };

  const handleCancelSchedule = (id) => {
    setScheduled(prev => prev.filter(s => s.id !== id));
  };

  // Scheduler: every 10s, deliver anything whose time has come through the normal
  // E2EE send path (a fresh envelope keeps encryption counters monotonic).
  useEffect(() => {
    if (!user?.id || !socket) return;
    const tick = async () => {
      const now = Date.now();
      const due = scheduledRef.current.filter(s =>
        s.scheduledAt && new Date(s.scheduledAt).getTime() <= now && !firingRef.current.has(s.id)
      );
      if (due.length === 0) return;
      const dueIds = new Set(due.map(d => d.id));
      setScheduled(prev => prev.filter(s => !dueIds.has(s.id)));
      for (const s of due) {
        if (firingRef.current.has(s.id)) continue;
        firingRef.current.add(s.id);
        try {
          const room = s.roomType === 'private'
            ? { id: s.roomId, type: 'private', partner: { id: s.partnerId } }
            : { id: s.roomId, type: 'group' };
          let inner;
          if (s.mediaUrl) {
            inner = { text: s.text || '', type: s.mediaType || 'image', mediaUrl: s.mediaUrl };
            if (s.mediaKey && s.mediaNonce) {
              inner.mediaKey = s.mediaKey;
              inner.mediaNonce = s.mediaNonce;
              inner.mime = s.mime || 'application/octet-stream';
            }
          } else {
            inner = { text: s.text || '', type: 'text' };
          }
          const encrypted = await encryptForSend(room, inner);
          const delivered = await sendMessage({
            roomId: s.roomId,
            text: encrypted.text,
            type: encrypted.type || 'text',
            mediaUrl: encrypted.mediaUrl || '',
            replyToId: null,
            e2ee: Boolean(encrypted.e2ee)
          });
          if (delivered && handleRestDeliveredMessage) handleRestDeliveredMessage(delivered);
        } catch (err) {
          console.error('Scheduled message delivery failed:', err);
        } finally {
          firingRef.current.delete(s.id);
          setScheduled(prev => prev.filter(x => x.id !== s.id));
        }
      }
    };
    const interval = setInterval(tick, 10000);
    return () => clearInterval(interval);
  }, [user?.id, socket, encryptForSend, sendMessage, handleRestDeliveredMessage]);

  // Star / unstar a message and update it in place.
  const handleStarToggle = async (message) => {
    if (!message) return;
    try {
      const res = await fetch(`/api/messages/${message.id}/star`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(prev => prev.map(m => (m.id === message.id ? { ...m, starred_by: data.starred_by || [] } : m)));
      }
    } catch (err) {
      console.error('Failed to star message:', err);
    }
  };

  const handleStartCall = (mediaType) => {
    const partner = activeRoom?.type === 'private' ? activeRoom.partner : null;
    if (!activeRoom || !partner) return;
    startCall({
      roomId: activeRoom.id,
      peerId: partner.id,
      peerName: partner.username || 'User',
      peerAvatar: partner.avatar_url || '',
      mediaType
    });
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

  const handleDeleteForEveryone = async (messageId) => {
    try {
      const res = await fetch(`/api/messages/${messageId}/delete-everyone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setMessages(prev => prev.map(m => (
          m.id === messageId
            ? { ...m, type: 'deleted', deleted_for_everyone: true, text: '', media_url: '', decryptedText: '', decryptedMediaUrl: null }
            : m
        )));
      }
    } catch (err) {
      console.error('Failed to delete message for everyone:', err);
    }
  };

  const handleEditMessage = async (message, newText) => {
    if (!activeRoom || !message || !newText || newText === (message.decryptedText || message.text)) {
      setEditingMessage(null);
      return;
    }
    try {
      // E2EE messages are re-encrypted client-side before hitting the server.
      const encrypted = await encryptForSend(activeRoom, { text: newText, type: 'text' });
      const res = await fetch(`/api/messages/${message.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          text: encrypted.text,
          type: encrypted.type || 'text',
          e2ee: Boolean(encrypted.e2ee)
        })
      });
      if (res.ok) {
        const updated = await res.json();
        decryptMessage(updated, activeRoom.id).then(dec => {
          setMessages(prev => prev.map(m => (m.id === dec.id ? { ...m, ...dec } : m)));
        }).catch(() => {
          setMessages(prev => prev.map(m => (m.id === updated.id ? { ...m, ...updated } : m)));
        });
      }
    } catch (err) {
      console.error('Failed to edit message:', err);
    } finally {
      setEditingMessage(null);
    }
  };

  const handleForwardMessage = (message) => {
    setForwardMessage(message);
  };

  // ----- In-chat message search (client-side over decrypted messages) -----
  const searchResults = useMemo(() => {
    if (!chatSearchActive || !chatSearchQuery.trim()) return [];
    const q = chatSearchQuery.trim().toLowerCase();
    const list = Array.isArray(messages) ? messages : [];
    return list.filter(m => {
      if (!m || m.__system === 'sender_key' || m.type === 'deleted' || m.deleted_for_everyone) return false;
      const text = String(m.e2ee ? m.decryptedText || '' : m.text || '').toLowerCase();
      const reply = m.reply_to ? String(m.reply_to.text || '').toLowerCase() : '';
      return text.includes(q) || reply.includes(q);
    });
  }, [messages, chatSearchActive, chatSearchQuery]);

  useEffect(() => {
    setChatSearchIndex(0);
    if (chatSearchQuery.trim() && searchResults.length > 0) {
      const t = setTimeout(() => scrollToSearchResult(0), 60);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSearchQuery]);

  const scrollToSearchResult = (index) => {
    const result = searchResults[index];
    if (!result) return;
    const el = document.querySelector(`[data-msg-id="${result.id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleSearchChange = (q) => {
    setChatSearchQuery(q);
    setChatSearchIndex(0);
  };

  const handleSearchNav = (delta) => {
    const total = searchResults.length;
    if (total === 0) return;
    const next = (chatSearchIndex + delta + total) % total;
    setChatSearchIndex(next);
    scrollToSearchResult(next);
  };

  const closeSearch = () => {
    setChatSearchActive(false);
    setChatSearchQuery('');
    setChatSearchIndex(0);
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

  // Archive / unarchive a chat (WhatsApp-style). Keeps the archivedRooms set and
  // the active room's flag in sync so the sidebar + drawer re-render instantly.
  const handleToggleArchive = async (roomId) => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/archive`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setArchivedRooms(prev => {
          const next = new Set(prev);
          if (data.is_archived) next.add(roomId);
          else next.delete(roomId);
          return next;
        });
        setActiveRoom(prev => prev && prev.id === roomId ? { ...prev, is_archived: data.is_archived } : prev);
      }
    } catch (err) {
      console.error('Failed to toggle archive:', err);
    }
  };

  // Opening an archived chat unarchives it (WhatsApp behaviour).
  const handleUnarchiveRoom = async (roomId) => {
    if (!roomId) return;
    if (archivedRoomsRef.current.has(roomId)) {
      await handleToggleArchive(roomId);
    }
  };

  // Toggle the per-user "mark as unread / mark as read" flag. Marking as unread
  // forces the unread badge to show at least 1 until the user toggles it off.
  const handleToggleUnread = async (roomId) => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/unread`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUnreadMarkedRooms(prev => {
          const next = new Set(prev);
          if (data.is_unread) next.add(roomId);
          else next.delete(roomId);
          return next;
        });
        setActiveRoom(prev => prev && prev.id === roomId ? { ...prev, is_unread: data.is_unread } : prev);
      }
    } catch (err) {
      console.error('Failed to toggle unread:', err);
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

  // After replying to a story, jump straight into the DM with the status author
  const handleReplyToStatus = (room) => {
    if (room) setActiveRoom(room);
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
        onSelectRoom={handleSelectRoom}
        onRoomsSynced={handleRoomsSynced}
        unreadCounts={unreadCounts}
        unreadMarkedRooms={unreadMarkedRooms}
        mutedRooms={mutedRooms}
        archivedRooms={archivedRooms}
        onToggleArchive={handleToggleArchive}
        onUnarchiveRoom={handleUnarchiveRoom}
        onOpenGroupModal={() => setShowGroupModal(true)}
        onOpenBridgeModal={() => setShowBridgeModal(true)}
        onOpenThemeStudio={() => setShowThemeStudio(true)}
        onOpenCreateStatus={() => setShowCreateStatus(true)}
        onOpenInviteModal={() => setShowInviteModal(true)}
        onOpenModeration={() => setShowModeration(true)}
        onReplyToStatus={handleReplyToStatus}
      />

      {/* Main Real-Time Messaging View */}
      <div className="chat-view">
        {activeRoom ? (
          <>
            <ChatHeader
              room={activeRoom}
              onToggleInfo={() => setShowChatInfo(!showChatInfo)}
              onBack={() => setActiveRoom(null)}
              onSearch={() => setChatSearchActive(prev => !prev)}
              onCall={handleStartCall}
              onOpenGallery={() => setShowGallery(true)}
            />

            {chatSearchActive && (
              <ChatSearchBar
                query={chatSearchQuery}
                count={searchResults.length}
                index={chatSearchIndex}
                onChange={handleSearchChange}
                onNav={handleSearchNav}
                onClose={closeSearch}
              />
            )}

            <MessageList
              messages={chatSearchActive && chatSearchQuery.trim() ? searchResults : messages}
              roomId={activeRoom.id}
              typingUser={typingUser}
              onReply={setReplyTo}
              onEditMessage={setEditingMessage}
              onDeleteMessage={handleDeleteMessage}
              onDeleteForEveryone={handleDeleteForEveryone}
              onForwardMessage={handleForwardMessage}
              onReportMessage={handleReportMessage}
              onToggleStar={handleStarToggle}
              highlightQuery={chatSearchActive ? chatSearchQuery : ''}
              searchMode={chatSearchActive && Boolean(chatSearchQuery.trim())}
            />

            <ChatComposer
              room={activeRoom}
              roomId={activeRoom.id}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              editingMessage={editingMessage}
              onCancelEdit={() => setEditingMessage(null)}
              onEditSubmit={handleEditMessage}
              onSchedule={handleScheduleMessage}
              onMessageDelivered={handleRestDeliveredMessage}
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
          onToggleMute={handleMuteChanged}
          onToggleArchive={handleToggleArchive}
          onToggleUnread={handleToggleUnread}
          onDeleteChat={handleDeleteChat}
          onClearChat={handleClearChat}
          onMembersAdded={handleMembersAdded}
          onBlockUser={handleBlockUser}
          onRoomChanged={refreshActiveRoom}
          onLeaveGroup={handleLeaveGroup}
          onOpenGallery={() => { setShowGallery(true); setShowChatInfo(false); }}
          onOpenStarred={() => { setShowStarred(true); setShowChatInfo(false); }}
          onOpenScheduled={() => { setShowScheduled(true); setShowChatInfo(false); }}
        />
      )}

      {/* Media Gallery Modal */}
      {showGallery && activeRoom && (
        <MediaGalleryModal
          messages={messages}
          onClose={() => setShowGallery(false)}
        />
      )}

      {/* Starred Messages Modal */}
      {showStarred && activeRoom && (
        <StarredMessagesModal
          roomId={activeRoom.id}
          onClose={() => setShowStarred(false)}
        />
      )}

      {/* Scheduled Messages Modal */}
      {showScheduled && user && (
        <ScheduledMessagesModal
          items={scheduled}
          onCancel={handleCancelSchedule}
          onClose={() => setShowScheduled(false)}
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

      {showModeration && (
        <ModerationDashboard
          onClose={() => setShowModeration(false)}
        />
      )}

      {showInviteModal && (
        <InviteFriendModal
          onClose={() => setShowInviteModal(false)}
          onChatInitiated={(room) => setActiveRoom(room)}
        />
      )}

      {forwardMessage && (
        <ForwardMessageModal
          message={forwardMessage}
          excludeRoomId={activeRoom?.id}
          onClose={() => setForwardMessage(null)}
          onForwarded={(count) => alert(`Message forwarded to ${count} chat${count === 1 ? '' : 's'}.`)}
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
              <CallProvider>
                <ChatAppContent />
              </CallProvider>
            </ThemeProvider>
          </E2EEProvider>
        </SocketProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
