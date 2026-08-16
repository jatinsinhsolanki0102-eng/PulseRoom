import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useE2EE } from '../../context/E2EEContext';
import { Forward, X, Check } from 'lucide-react';

export default function ForwardMessageModal({ message, excludeRoomId, onClose, onForwarded }) {
  const { token } = useAuth();
  const { encryptForSend } = useE2EE();

  const [rooms, setRooms] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchRooms = async () => {
    try {
      const res = await fetch('/api/rooms', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setRooms((Array.isArray(data) ? data : []).filter(r => r && r.id !== excludeRoomId));
      }
    } catch (err) {
      console.error('Failed to fetch rooms for forward:', err);
    }
  };

  const toggleRoom = (id) => {
    setSelected(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const isE2ee = Boolean(message.e2ee);
  const sourceText = isE2ee ? (message.decryptedText || '') : (message.text || '');
  const sourceType = isE2ee ? (message.decryptedType || 'text') : (message.type || 'text');
  const sourceMediaUrl = isE2ee ? (message.decryptedMediaUrl || '') : (message.media_url || '');
  const hasMedia = Boolean(sourceMediaUrl);

  const buildEnvelope = async (room) => {
    if (isE2ee) {
      const inner = {
        text: sourceText,
        type: sourceType,
        ...(hasMedia ? {
          mediaUrl: sourceMediaUrl,
          mediaKey: message.decryptedMediaKey || '',
          mediaNonce: message.decryptedMediaNonce || '',
          mime: message.decryptedMime || 'application/octet-stream'
        } : {})
      };
      const encrypted = await encryptForSend(room, inner);
      return {
        text: encrypted.text,
        type: encrypted.type || 'text',
        mediaUrl: encrypted.mediaUrl || '',
        e2ee: Boolean(encrypted.e2ee)
      };
    }
    return {
      text: sourceText,
      type: sourceType,
      mediaUrl: sourceMediaUrl,
      e2ee: false
    };
  };

  const handleSubmit = async () => {
    if (selected.length === 0) return;
    setLoading(true);
    setError('');
    let forwardedCount = 0;

    try {
      for (const roomId of selected) {
        const target = rooms.find(r => r.id === roomId);
        if (!target) continue;
        const envelope = await buildEnvelope(target);
        const res = await fetch('/api/messages/forward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            targetRoomIds: [roomId],
            text: envelope.text,
            type: envelope.type,
            mediaUrl: envelope.mediaUrl,
            originalMessageId: message.id,
            e2ee: envelope.e2ee
          })
        });
        if (res.ok) forwardedCount += 1;
      }

      if (forwardedCount === 0) {
        setError('Could not forward to any of the selected chats.');
      } else {
        onForwarded(forwardedCount);
        onClose();
      }
    } catch (err) {
      console.error('Forward error:', err);
      setError('Failed to forward the message.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !loading && onClose()}>
      <div className="modal-content glass-panel" style={{ maxWidth: '460px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="brand-icon" style={{ width: '40px', height: '40px' }}>
              <Forward size={20} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.25rem', fontWeight: '700' }}>Forward message</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {hasMedia ? 'Photo / video / voice note' : (sourceText || '')} · select {selected.length} chat{selected.length === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          <button onClick={() => !loading && onClose()} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ maxHeight: '45vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '1rem' }}>
          {rooms.length === 0 && (
            <p style={{ color: 'var(--text-dim)', textAlign: 'center', padding: '1rem 0' }}>No other chats available to forward to.</p>
          )}
          {rooms.map(r => {
            const name = r.type === 'private' ? r.partner?.username || 'Private Chat' : r.name;
            const avatar = r.type === 'private' ? r.partner?.avatar_url : r.avatar_url;
            const isChecked = selected.includes(r.id);
            return (
              <button
                key={r.id}
                onClick={() => toggleRoom(r.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.6rem 0.75rem',
                  borderRadius: '12px',
                  background: isChecked ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                  border: `1px solid ${isChecked ? 'var(--primary-accent)' : 'var(--panel-border)'}`,
                  color: 'var(--text-main)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontWeight: '600'
                }}
              >
                <img
                  src={avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`}
                  alt={name}
                  style={{ width: '34px', height: '34px', borderRadius: '10px' }}
                />
                <span style={{ flex: 1 }}>{name}</span>
                {isChecked && <Check size={16} style={{ color: 'var(--primary-accent)' }} />}
              </button>
            );
          })}
        </div>

        {error && <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={selected.length === 0 || loading}
          style={{
            width: '100%',
            padding: '0.8rem',
            borderRadius: '12px',
            border: 'none',
            background: selected.length === 0 || loading ? 'rgba(255,255,255,0.1)' : 'linear-gradient(135deg, #6366f1, #a855f7)',
            color: selected.length === 0 || loading ? 'var(--text-dim)' : 'white',
            fontWeight: '700',
            cursor: selected.length === 0 || loading ? 'not-allowed' : 'pointer'
          }}
        >
          {loading ? 'Forwarding...' : `Forward to ${selected.length} chat${selected.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
