import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useE2EE } from '../../context/E2EEContext';
import { X, Star } from 'lucide-react';

export default function StarredMessagesModal({ roomId, onClose }) {
  const { token } = useAuth();
  const { decryptMessage } = useE2EE();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/rooms/${roomId}/starred`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('fetch failed');
        const rows = await res.json();
        const decrypted = await Promise.all(
          rows.map(m => (m.e2ee ? decryptMessage(m, roomId).catch(() => ({ ...m, __undecryptable: true })) : m))
        );
        if (!cancelled) setMessages(decrypted);
      } catch (err) {
        console.error('Failed to load starred messages:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [roomId, token, decryptMessage]);

  const preview = (m) => {
    if (m.type === 'deleted' || m.deleted_for_everyone) return 'This message was deleted.';
    if (m.__undecryptable) return 'Encrypted message (key unavailable)';
    if (m.e2ee) {
      if (m.decryptedMediaUrl) return m.decryptedType === 'video' ? 'Video' : m.decryptedType === 'audio' ? 'Voice note' : 'Photo';
      return m.decryptedText || 'Encrypted message';
    }
    if (m.media_url) return m.type === 'video' ? 'Video' : m.type === 'audio' ? 'Voice note' : 'Photo';
    return m.text || '';
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel" style={{ maxWidth: '520px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontFamily: 'Outfit', fontSize: '1.25rem', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Star size={18} style={{ color: '#facc15' }} /> Starred Messages <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>({messages.length})</span>
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-dim)' }}>Loading starred messages...</p>
        ) : messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-dim)' }}>
            <Star size={32} style={{ margin: '0 auto 0.75rem', opacity: 0.4 }} />
            <p>No starred messages yet. Tap the star on a message to bookmark it.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '55vh', overflowY: 'auto' }}>
            {messages.map(m => (
              <div key={m.id} style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--panel-border)',
                borderRadius: '12px',
                padding: '0.75rem 1rem'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                  <strong style={{ color: 'var(--primary-accent)' }}>{m.sender_name}</strong>
                  <span>{new Date(m.created_at).toLocaleString()}</span>
                </div>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-main)', wordBreak: 'break-word' }}>{preview(m)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
