import React from 'react';
import { useSocket } from '../../context/SocketContext';
import { Info, ArrowLeft } from 'lucide-react';

export default function ChatHeader({ room, onToggleInfo, onBack }) {
  const { onlineUsers } = useSocket();

  if (!room) return null;

  const isPrivate = room.type === 'private';
  const name = isPrivate ? room.partner?.username || 'Private Chat' : room.name;
  const avatar = isPrivate ? room.partner?.avatar_url : room.avatar_url;
  const isOnline = isPrivate && (onlineUsers.has(room.partner?.id) || room.partner?.status === 'online');

  return (
    <div className="chat-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {/* Mobile Back Button */}
        {onBack && (
          <button
            className="action-icon-btn mobile-back-btn"
            onClick={onBack}
            title="Back to Chats"
          >
            <ArrowLeft size={20} />
          </button>
        )}

        <div className="chat-header-info" onClick={onToggleInfo} style={{ cursor: 'pointer' }}>
          <div className="avatar-wrapper" style={{ width: '42px', height: '42px' }}>
            <img src={avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`} alt={name} className="avatar-img" />
            {isPrivate && isOnline && <span className="online-dot" />}
          </div>

          <div>
            <div className="chat-header-name">{name}</div>
            <div className="chat-header-status">
              {isPrivate ? (
                isOnline ? (
                  <span>● Online</span>
                ) : (
                  <span style={{ color: 'var(--text-dim)' }}>Offline</span>
                )
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>
                  {room.members?.length || 1} members {room.role === 'admin' && '• (You are Admin)'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="header-actions">
        <button className="action-icon-btn" title="Chat Info & Details" onClick={onToggleInfo}>
          <Info size={18} />
        </button>
      </div>
    </div>
  );
}
