import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import StatusTray from '../status/StatusTray';
import ProfileModal from '../profile/ProfileModal';
import { MessageSquare, Users, GitMerge, Search, Plus, Palette, LogOut, UserCheck, Pin, UserPlus, Layers, Camera, Settings } from 'lucide-react';

export default function Sidebar({ activeRoom, onSelectRoom, onOpenGroupModal, onOpenBridgeModal, onOpenThemeStudio, onOpenCreateStatus, onOpenInviteModal }) {
  const { user, token, logout } = useAuth();
  const { socket, onlineUsers } = useSocket();
  
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'chats' | 'groups' | 'directory'
  const [searchQuery, setSearchQuery] = useState('');
  const [rooms, setRooms] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  useEffect(() => {
    if (token) {
      fetchRooms(true); // Initial fetch
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

    return () => {
      socket.off('room_created', handleRealTimeRoomUpdate);
      socket.off('new_message', handleRealTimeRoomUpdate);
      socket.off('room_deleted', handleRealTimeRoomUpdate);
      socket.off('room_deleted_for_me', handleRealTimeRoomUpdate);
      socket.off('room_cleared', handleRealTimeRoomUpdate);
      socket.off('room_members_updated', handleRealTimeRoomUpdate);
    };
  }, [socket]);

  const fetchRooms = async (isInitial = false) => {
    try {
      const res = await fetch('/api/rooms', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const roomsArray = Array.isArray(data) ? data : [];
        setRooms(roomsArray);
        
        if (isInitial && roomsArray.length > 0 && !activeRoom) {
          onSelectRoom(roomsArray[0]);
        }
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

  const sortedRooms = [...safeRooms].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return b.is_pinned ? 1 : -1;
    const timeA = new Date(a.last_message?.created_at || a.created_at).getTime();
    const timeB = new Date(b.last_message?.created_at || b.created_at).getTime();
    return timeB - timeA;
  });

  const filteredRooms = sortedRooms.filter(r => {
    if (!r) return false;
    if (activeTab === 'groups' && r.type !== 'group') return false;
    if (activeTab === 'chats' && r.type === 'group') return false;

    const name = r.type === 'private' ? r.partner?.username : r.name;
    return (name || '').toLowerCase().includes((searchQuery || '').toLowerCase());
  });

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

        <div style={{ display: 'flex', gap: '0.35rem' }}>
          <button
            className="action-icon-btn"
            title="Edit WhatsApp Profile Picture & Bio"
            onClick={() => setIsProfileOpen(true)}
          >
            <Camera size={18} />
          </button>
          <button
            className="action-icon-btn"
            title="Add / Invite Friend by Email"
            onClick={onOpenInviteModal}
          >
            <UserPlus size={18} />
          </button>
          <button
            className="action-icon-btn"
            title="Theme Studio"
            onClick={onOpenThemeStudio}
          >
            <Palette size={18} />
          </button>
          <button
            className="action-icon-btn"
            title="New Group"
            onClick={onOpenGroupModal}
          >
            <Plus size={18} />
          </button>
          <button
            className="action-icon-btn"
            title="Sign Out"
            onClick={logout}
          >
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* Status Tray */}
      <StatusTray onOpenCreateStatus={onOpenCreateStatus} />

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
          filteredRooms.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
              No chats found. Select 'Users' tab or click '+' to start a conversation!
            </div>
          ) : (
            filteredRooms.map(room => {
              const isPrivate = room.type === 'private';
              const name = isPrivate ? room.partner?.username || 'Private Chat' : room.name || 'Group Room';
              const avatar = isPrivate ? room.partner?.avatar_url : room.avatar_url;
              const isOnline = isPrivate && (onlineUsers.has(room.partner?.id) || room.partner?.status === 'online');
              const lastMsgText = room.last_message?.text || 'No messages yet';

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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        {room.is_pinned && <Pin size={12} style={{ color: 'var(--primary-accent)', transform: 'rotate(45deg)' }} />}
                        <span className="room-name">{name}</span>
                      </div>
                      {room.type === 'group' && <span className="badge-tag badge-group">Group</span>}
                      {room.type === 'bridge' && <span className="badge-tag badge-bridge">Bridge</span>}
                    </div>
                    <div className="room-last-msg">{lastMsgText}</div>
                  </div>
                </div>
              );
            })
          )
        ) : (
          filteredUsers.map(u => {
            const isOnline = onlineUsers.has(u.id) || u.status === 'online';
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
                      {isOnline ? 'Online' : 'Offline'}
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
