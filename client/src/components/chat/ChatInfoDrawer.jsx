import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { X, Pin, Users, Image as ImageIcon, Shield, Heart } from 'lucide-react';

export default function ChatInfoDrawer({ room, onClose, onTogglePin }) {
  const { user } = useAuth();
  if (!room) return null;

  const isPrivate = room.type === 'private';
  const name = isPrivate ? room.partner?.username || 'Private Chat' : room.name || 'Group Room';
  const avatar = isPrivate ? room.partner?.avatar_url : room.avatar_url;
  const bio = isPrivate ? room.partner?.bio : room.description;

  return (
    <div style={{
      width: '320px',
      height: '100%',
      borderLeft: '1px solid var(--panel-border)',
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(20px)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
      animation: 'slideIn 0.25s ease-out'
    }}>
      {/* Header */}
      <div style={{
        padding: '1.25rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--panel-border)'
      }}>
        <span style={{ fontWeight: '700', fontSize: '1rem', color: 'var(--text-main)' }}>Chat Details</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={20} />
        </button>
      </div>

      {/* Profile Overview */}
      <div style={{ padding: '1.5rem', textAlign: 'center', borderBottom: '1px solid var(--panel-border)' }}>
        <img
          src={avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`}
          alt={name}
          style={{ width: '84px', height: '84px', borderRadius: '24px', margin: '0 auto 0.75rem', objectFit: 'cover' }}
        />
        <h3 style={{ fontFamily: 'Outfit', fontWeight: '700', fontSize: '1.25rem', color: 'var(--text-main)' }}>{name}</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{bio || 'No description provided'}</p>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1rem' }}>
          <button
            onClick={onTogglePin}
            className="chip-btn"
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '99px',
              background: room.is_pinned ? 'var(--primary-accent)' : 'rgba(255,255,255,0.06)',
              color: room.is_pinned ? 'white' : 'var(--text-main)',
              fontWeight: '600'
            }}
          >
            <Pin size={14} style={{ display: 'inline', marginRight: '4px' }} />
            {room.is_pinned ? 'Unpin Chat' : 'Pin Chat'}
          </button>
        </div>
      </div>

      {/* Group Members Roster */}
      {!isPrivate && (
        <div style={{ padding: '1.25rem', flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: '700', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            <Users size={16} /> Group Participants ({room.members?.length || 0})
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {(room.members || []).map(m => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0.5rem', borderRadius: '10px', background: 'rgba(255,255,255,0.02)' }}>
                <img src={m.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${m.username}`} alt={m.username} style={{ width: '32px', height: '32px', borderRadius: '10px' }} />
                <span style={{ flex: 1, fontWeight: '600', fontSize: '0.9rem' }}>{m.username}</span>
                {m.role === 'admin' && (
                  <span className="badge-tag badge-group" style={{ fontSize: '0.6rem' }}>Admin</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
