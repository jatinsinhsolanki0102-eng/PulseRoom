import React from 'react';
import { useSocket } from '../../context/SocketContext';
import { Info, ArrowLeft, Lock, Search, Phone, Video, Image as ImageIcon } from 'lucide-react';
import { formatLastSeen } from '../../lib/time';

export default function ChatHeader({ room, onToggleInfo, onBack, onSearch, onCall, onOpenGallery }) {
  const { onlineUsers } = useSocket();

  if (!room) return null;

  const isPrivate = room.type === 'private';
  const name = isPrivate ? room.partner?.username || 'Private Chat' : room.name;
  const avatar = isPrivate ? room.partner?.avatar_url : room.avatar_url;
  const isOnline = isPrivate && onlineUsers.has(room.partner?.id);

  return (
    <div className="chat-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: 0 }}>
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

        <div className="chat-header-info" onClick={onToggleInfo} style={{ cursor: 'pointer', minWidth: 0 }}>
          <div className="avatar-wrapper" style={{ width: '42px', height: '42px', flexShrink: 0 }}>
            <img src={avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`} alt={name} className="avatar-img" />
            {isPrivate && isOnline && <span className="online-dot" />}
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="chat-header-name">
              {name}
              <Lock
                size={13}
                style={{ color: 'var(--primary-accent)', verticalAlign: '1px', marginLeft: '6px', cursor: 'default' }}
                title="Messages are end-to-end encrypted"
              />
            </div>
            <div className="chat-header-status">
              {isPrivate ? (
                isOnline ? (
                  <span>● Online</span>
                ) : (
                  <span style={{ color: 'var(--text-dim)' }}>
                    {formatLastSeen(room.partner?.last_seen) || 'Offline'}
                  </span>
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
        {onSearch && (
          <button className="action-icon-btn" title="Search in this chat" onClick={onSearch}>
            <Search size={18} />
          </button>
        )}
        {onOpenGallery && (
          <button className="action-icon-btn header-action-gallery" title="Media gallery" onClick={onOpenGallery}>
            <ImageIcon size={18} />
          </button>
        )}
        {isPrivate && onCall && (
          <>
            <button className="action-icon-btn header-action-call" title="Voice call" onClick={() => onCall('audio')}>
              <Phone size={18} />
            </button>
            <button className="action-icon-btn header-action-call" title="Video call" onClick={() => onCall('video')}>
              <Video size={18} />
            </button>
          </>
        )}
        <button className="action-icon-btn" title="Chat Info & Details" onClick={onToggleInfo}>
          <Info size={18} />
        </button>
      </div>
    </div>
  );
}
