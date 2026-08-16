import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { useE2EE } from '../../context/E2EEContext';
import StatusTray from '../status/StatusTray';
import ProfileModal from '../profile/ProfileModal';
import { formatLastSeen } from '../../lib/time';
import { MessageSquare, Users, GitMerge, Search, Plus, Palette, LogOut, UserCheck, Pin, UserPlus, Layers, Camera, Settings, BellOff, Archive, Mail, ShieldCheck, Menu, Download } from 'lucide-react';

export default function Sidebar({ activeRoom, onSelectRoom, onRoomsSynced, unreadCounts, unreadMarkedRooms, mutedRooms, archivedRooms, onToggleArchive, onUnarchiveRoom, onOpenGroupModal, onOpenBridgeModal, onOpenThemeStudio, onOpenCreateStatus, onOpenInviteModal, onOpenModeration, onReplyToStatus }) {
  const { user, token, logout } = useAuth();
  const { socket, onlineUsers } = useSocket();
  const { ready: e2eeReady, decryptMessage } = useE2EE();

  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'chats' | 'groups' | 'directory'
  const [searchQuery, setSearchQuery] = useState('');
  const [rooms, setRooms] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [lastPreviews, setLastPreviews] = useState({});
  const [menuOpen, setMenuOpen] = useState(false);
  const decryptedIdsRef = useRef(new Set());
  const menuRef = useRef(null);
  // PWA install prompt (Chrome/Edge fire beforeinstallprompt once eligible).
  const deferredPromptRef = useRef(null);
  const [installable, setInstallable] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
      setIsStandalone(true);
    }
    const beforeInstallPromptHandler = (e) => {
      e.preventDefault();
      deferredPromptRef.current = e;
      setInstallable(true);
    };
    const appInstalledHandler = () => {
      deferredPromptRef.current = null;
      setInstallable(false);
      setIsStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', beforeInstallPromptHandler);
    window.addEventListener('appinstalled', appInstalledHandler);
    return () => {
      window.removeEventListener('beforeinstallprompt', beforeInstallPromptHandler);
      window.removeEventListener('appinstalled', appInstalledHandler);
    };
  }, []);

  const handleInstall = async () => {
    const prompt = deferredPromptRef.current;
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice.catch(() => ({}));
    deferredPromptRef.current = null;
    if (outcome === 'accepted') setInstallable(false);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (token) {
      fetchRooms(); // Initial fetch
      fetchUsers();
    }
  }, [token]);

  useEffect(() => {
    if (!socket) return;

    const handleRealTimeRoomUpdate = () => {
      fetchRooms(false); // Background update
    };

    socket.on('room_created', handleRealTimeRoomUpdate);
    socket.on('new_message', handleRealTimeRoomUpdate);
    socket.on('room_deleted', handleRealTimeRoomUpdate);
    socket.on('room_deleted_for_me', handleRealTimeRoomUpdate);
    socket.on('room_cleared', handleRealTimeRoomUpdate);
    socket.on('room_members_updated', handleRealTimeRoomUpdate);
    socket.on('user_blocked', handleRealTimeRoomUpdate);
    socket.on('disappearing_timer_updated', handleRealTimeRoomUpdate);
    socket.on('message_edited', handleRealTimeRoomUpdate);
    socket.on('message_deleted_everyone', handleRealTimeRoomUpdate);

    return () => {
      socket.off('room_created', handleRealTimeRoomUpdate);
      socket.off('new_message', handleRealTimeRoomUpdate);
      socket.off('room_deleted', handleRealTimeRoomUpdate);
      socket.off('room_deleted_for_me', handleRealTimeRoomUpdate);
      socket.off('room_cleared', handleRealTimeRoomUpdate);
      socket.off('room_members_updated', handleRealTimeRoomUpdate);
      socket.off('user_blocked', handleRealTimeRoomUpdate);
      socket.off('disappearing_timer_updated', handleRealTimeRoomUpdate);
      socket.off('message_edited', handleRealTimeRoomUpdate);
      socket.off('message_deleted_everyone', handleRealTimeRoomUpdate);
    };
  }, [socket]);

  const fetchRooms = async () => {
    try {
      const res = await fetch('/api/rooms', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const roomsArray = Array.isArray(data) ? data : [];
        setRooms(roomsArray);
        if (onRoomsSynced) onRoomsSynced(roomsArray);
        // NOTE: no auto-select here - after login the welcome screen stays
        // visible until the user clicks a chat/group/user themselves.
      } else {
        setRooms([]);
      }
    } catch (err) {
      console.error('Failed to fetch rooms:', err);
      setRooms([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAllUsers(Array.isArray(data) ? data : []);
      } else {
        setAllUsers([]);
      }
    } catch (err) {
      console.error('Failed to fetch users:', err);
      setAllUsers([]);
    }
  };

  // Decrypt e2ee last-message previews so raw ciphertext (which leaks sender
  // public keys / ids) is never rendered in the chat list.
  useEffect(() => {
    if (!e2eeReady || !token) return;
    let cancelled = false;
    const work = async () => {
      const updates = {};
      for (const room of Array.isArray(rooms) ? rooms : []) {
        const lm = room.last_message;
        if (!lm || !lm.e2ee) continue;
        if (decryptedIdsRef.current.has(lm.id)) continue;
        const dec = await decryptMessage(lm, room.id);
        if (cancelled) return;
        decryptedIdsRef.current.add(lm.id);
        updates[lm.id] = { text: dec?.decryptedText || '', type: dec?.decryptedType || lm.type };
      }
      if (Object.keys(updates).length > 0) {
        setLastPreviews(prev => ({ ...prev, ...updates }));
      }
    };
    work();
    return () => { cancelled = true; };
  }, [rooms, token, e2eeReady, decryptMessage]);

  const startPrivateChat = async (targetUser) => {
    if (!targetUser?.id) return;
    try {
      const res = await fetch('/api/rooms/private', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ targetUserId: targetUser.id })
      });
      if (res.ok) {
        const room = await res.json();
        await fetchRooms(false);
        onSelectRoom(room);
      }
    } catch (err) {
      console.error('Failed to start private chat:', err);
    }
  };

  const safeRooms = Array.isArray(rooms) ? rooms : [];
  const safeUsers = Array.isArray(allUsers) ? allUsers : [];

  const sortByTime = (a, b) => {
    const timeA = new Date(a.last_message?.created_at || a.created_at).getTime();
    const timeB = new Date(b.last_message?.created_at || b.created_at).getTime();
    return timeB - timeA;
  };

  const isRoomArchived = (r) => archivedRooms?.has(r.id) || Boolean(r.is_archived);

  const allSortedRooms = [...safeRooms].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return b.is_pinned ? 1 : -1;
    return sortByTime(a, b);
  });

  const activeRooms = allSortedRooms.filter(r => !isRoomArchived(r));
  const archivedRoomList = allSortedRooms.filter(r => isRoomArchived(r)).sort(sortByTime);

  const matchesTabAndSearch = (r) => {
    if (!r) return false;
    if (activeTab === 'groups' && r.type !== 'group') return false;
    if (activeTab === 'chats' && r.type === 'group') return false;

    const name = r.type === 'private' ? r.partner?.username : r.name;
    return (name || '').toLowerCase().includes((searchQuery || '').toLowerCase());
  };

  const filteredRooms = activeRooms.filter(matchesTabAndSearch);
  const filteredArchived = archivedRoomList.filter(matchesTabAndSearch);

  const filteredUsers = safeUsers.filter(u =>
    u && u.username && (
      u.username.toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      (u.email || '').toLowerCase().includes((searchQuery || '').toLowerCase())
    )
  );

  return (
    <div className="sidebar">
      {/* Sidebar Header */}
      <div className="sidebar-header">
        <div className="brand-badge">
          <div className="brand-icon">
            <MessageSquare size={20} />
          </div>
          <span>PulseRoom</span>
        </div>

        <div style={{ position: 'relative' }} ref={menuRef}>
          <button
            className="action-icon-btn"
            title="Menu"
            aria-label="Open menu"
            onClick={() => setMenuOpen(prev => !prev)}
          >
            <Menu size={18} />
          </button>

          {menuOpen && (
            <div className="sidebar-menu">
              <button
                className="sidebar-menu-item"
                onClick={() => { setIsProfileOpen(true); setMenuOpen(false); }}
              >
                <Camera size={16} /> Profile Setting
              </button>
              <button
                className="sidebar-menu-item"
                onClick={() => { onOpenInviteModal(); setMenuOpen(false); }}
              >
                <UserPlus size={16} /> Add / Invite Friend
              </button>
              <button
                className="sidebar-menu-item"
                onClick={() => { onOpenThemeStudio(); setMenuOpen(false); }}
              >
                <Palette size={16} /> Theme Studio
              </button>
              <button
                className="sidebar-menu-item"
                onClick={() => { onOpenGroupModal(); setMenuOpen(false); }}
              >
                <Plus size={16} /> New Group
              </button>
              {user?.is_moderator && (
                <button
                  className="sidebar-menu-item"
                  onClick={() => { onOpenModeration(); setMenuOpen(false); }}
                >
                  <ShieldCheck size={16} /> Moderation Dashboard
                </button>
              )}
              {installable && !isStandalone && (
                <button
                  className="sidebar-menu-item"
                  onClick={() => { handleInstall(); setMenuOpen(false); }}
                >
                  <Download size={16} /> Install App
                </button>
              )}
              <div className="sidebar-menu-divider" />
              <button
                className="sidebar-menu-item sidebar-menu-danger"
                onClick={logout}
              >
                <LogOut size={16} /> Sign Out
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Status Tray */}
      <StatusTray onOpenCreateStatus={onOpenCreateStatus} onReplyToStatus={onReplyToStatus} />

      {/* Search Input */}
      <div className="search-box">
        <Search size={16} className="search-icon" />
        <input
          type="text"
          placeholder="Search chats, groups or users..."
          className="search-input"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Tabs Bar */}
      <div className="sidebar-tabs">
        <button
          className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          <Layers size={14} /> All
        </button>
        <button
          className={`tab-btn ${activeTab === 'chats' ? 'active' : ''}`}
          onClick={() => setActiveTab('chats')}
        >
          <MessageSquare size={14} /> Direct
        </button>
        <button
          className={`tab-btn ${activeTab === 'groups' ? 'active' : ''}`}
          onClick={() => setActiveTab('groups')}
        >
          <Users size={14} /> Groups
        </button>
        <button
          className={`tab-btn ${activeTab === 'directory' ? 'active' : ''}`}
          onClick={() => setActiveTab('directory')}
        >
          <UserCheck size={14} /> Users
        </button>
      </div>

      {/* Room List or User Directory */}
      <div className="room-list">
        {activeTab !== 'directory' ? (
          <>
          {filteredRooms.length === 0 && filteredArchived.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
              No chats found. Select 'Users' tab or click '+' to start a conversation!
            </div>
          ) : (
            filteredRooms.map(room => {
              const isPrivate = room.type === 'private';
              const name = isPrivate ? room.partner?.username || 'Private Chat' : room.name || 'Group Room';
              const avatar = isPrivate ? room.partner?.avatar_url : room.avatar_url;
              const isOnline = isPrivate && onlineUsers.has(room.partner?.id);
              const lm = room.last_message;
              const preview = lm ? lastPreviews[lm.id] : null;
              const isEncrypted = Boolean(lm?.e2ee);
              const lastMsgText = !lm
                ? 'No messages yet'
                : isEncrypted
                  ? (preview?.text ? (preview.type !== 'text' && preview.type !== 'e2ee' ? `📎 ${preview.type}` : preview.text) : '🔒 Encrypted message')
                  : (lm.text || 'No messages yet');
              const unreadCount = Math.max((unreadCounts?.[room.id] || 0), unreadMarkedRooms?.has(room.id) ? 1 : 0);

              return (
                <div
                  key={room.id}
                  className={`room-item ${activeRoom?.id === room.id ? 'active' : ''}`}
                  onClick={() => onSelectRoom(room)}
                >
                  <div className="avatar-wrapper">
                    <img src={avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`} alt={name} className="avatar-img" />
                    {isPrivate && isOnline && <span className="online-dot" />}
                  </div>

                  <div className="room-info">
                    <div className="room-title-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', minWidth: 0 }}>
                        {room.is_pinned && <Pin size={12} style={{ color: 'var(--primary-accent)', transform: 'rotate(45deg)', flexShrink: 0 }} />}
                        <span className="room-name">{name}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                        {mutedRooms?.has(room.id) && <BellOff size={12} style={{ color: 'var(--text-dim)' }} />}
                        {unreadCount > 0 && (
                          <span className="unread-badge">{unreadCount}</span>
                        )}
                        {room.type === 'group' && <span className="badge-tag badge-group">Group</span>}
                        {room.type === 'bridge' && <span className="badge-tag badge-bridge">Bridge</span>}
                      </div>
                    </div>
                    <div className="room-last-msg">{lastMsgText}</div>
                  </div>
                </div>
              );
            })
          )}
          {filteredArchived.length > 0 && (
            <div className="archived-section">
              <button
                className="archived-toggle"
                onClick={() => setShowArchived(prev => !prev)}
                title={showArchived ? 'Hide archived chats' : 'Show archived chats'}
              >
                <Archive size={15} />
                <span style={{ flex: 1, textAlign: 'left', fontWeight: '700' }}>Archived ({filteredArchived.length})</span>
                <span className="archived-chevron" style={{ transform: showArchived ? 'rotate(180deg)' : 'none' }}>▾</span>
              </button>
              {showArchived && filteredArchived.map(room => {
                const isPrivate = room.type === 'private';
                const name = isPrivate ? room.partner?.username || 'Private Chat' : room.name || 'Group Room';
                const avatar = isPrivate ? room.partner?.avatar_url : room.avatar_url;
                const isOnline = isPrivate && onlineUsers.has(room.partner?.id);
                const lm = room.last_message;
                const preview = lm ? lastPreviews[lm.id] : null;
                const isEncrypted = Boolean(lm?.e2ee);
                const lastMsgText = !lm
                  ? 'No messages yet'
                  : isEncrypted
                    ? (preview?.text ? (preview.type !== 'text' && preview.type !== 'e2ee' ? `📎 ${preview.type}` : preview.text) : '🔒 Encrypted message')
                    : (lm.text || 'No messages yet');
                const unreadCount = Math.max((unreadCounts?.[room.id] || 0), unreadMarkedRooms?.has(room.id) ? 1 : 0);

                return (
                  <div
                    key={room.id}
                    className={`room-item ${activeRoom?.id === room.id ? 'active' : ''}`}
                    onClick={() => {
                      if (onUnarchiveRoom) onUnarchiveRoom(room.id);
                      onSelectRoom(room);
                    }}
                  >
                    <div className="avatar-wrapper">
                      <img src={avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`} alt={name} className="avatar-img" />
                      {isPrivate && isOnline && <span className="online-dot" />}
                    </div>

                    <div className="room-info">
                      <div className="room-title-row">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', minWidth: 0 }}>
                          <span className="room-name">{name}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                          {mutedRooms?.has(room.id) && <BellOff size={12} style={{ color: 'var(--text-dim)' }} />}
                          {unreadCount > 0 && (
                            <span className="unread-badge">{unreadCount}</span>
                          )}
                          {room.type === 'group' && <span className="badge-tag badge-group">Group</span>}
                          {room.type === 'bridge' && <span className="badge-tag badge-bridge">Bridge</span>}
                        </div>
                      </div>
                      <div className="room-last-msg">{lastMsgText}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </>
        ) : (
          filteredUsers.map(u => {
            const isOnline = onlineUsers.has(u.id);
            return (
              <div
                key={u.id}
                className="room-item"
                onClick={() => startPrivateChat(u)}
              >
                <div className="avatar-wrapper">
                  <img src={u.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${u.username}`} alt={u.username} className="avatar-img" />
                  {isOnline && <span className="online-dot" />}
                </div>

                <div className="room-info">
                  <div className="room-title-row">
                    <span className="room-name">{u.username}</span>
                    <span style={{ fontSize: '0.7rem', color: isOnline ? 'var(--status-online)' : 'var(--text-dim)' }}>
                      {isOnline ? 'Online' : (formatLastSeen(u.last_seen) || 'Offline')}
                    </span>
                  </div>
                  <div className="room-last-msg">{u.bio || u.email}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* WhatsApp Profile Footer (Click to edit Profile Photo & Status) */}
      <div
        onClick={() => setIsProfileOpen(true)}
        style={{
          padding: '0.85rem 1.25rem',
          borderTop: '1px solid var(--panel-border)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          background: 'rgba(0,0,0,0.2)',
          cursor: 'pointer',
          transition: 'all 0.2s ease'
        }}
        title="Click to change WhatsApp Profile Photo & Status Bio"
      >
        <div style={{ position: 'relative' }}>
          <img
            src={user?.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${user?.username}`}
            alt={user?.username}
            style={{ width: '42px', height: '42px', borderRadius: '50%', objectFit: 'cover', background: '#0f172a', border: '2px solid var(--primary-accent)' }}
          />
          <Camera size={12} style={{ position: 'absolute', bottom: '0', right: '0', background: 'var(--primary-accent)', color: 'white', borderRadius: '50%', padding: '2px' }} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: '700', fontSize: '0.9rem', color: 'var(--text-main)' }}>{user?.username}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.bio || 'Click to edit profile photo & bio'}
          </div>
        </div>
      </div>

      {/* WhatsApp Profile Settings Modal */}
      <ProfileModal
        isOpen={isProfileOpen}
        onClose={() => setIsProfileOpen(false)}
      />
    </div>
  );
}
