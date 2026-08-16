import React from 'react';
import { X, Clock, Trash2 } from 'lucide-react';

export default function ScheduledMessagesModal({ items, onCancel, onClose }) {
  const sorted = [...items].sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel" style={{ maxWidth: '480px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontFamily: 'Outfit', fontSize: '1.25rem', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Clock size={18} /> Scheduled Messages <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>({items.length})</span>
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-dim)' }}>
            <Clock size={32} style={{ margin: '0 auto 0.75rem', opacity: 0.4 }} />
            <p>No scheduled messages. Use the clock button in the composer to schedule one.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '55vh', overflowY: 'auto' }}>
            {sorted.map(s => (
              <div key={s.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--panel-border)',
                borderRadius: '12px',
                padding: '0.75rem 1rem'
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                    {new Date(s.scheduledAt).toLocaleString()}
                  </div>
                  <p style={{ fontSize: '0.9rem', color: 'var(--text-main)', wordBreak: 'break-word', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.mediaUrl ? (s.mediaType === 'video' ? 'Video' : s.mediaType === 'audio' ? 'Voice note' : 'Photo') : (s.text || '')}
                  </p>
                </div>
                <button
                  onClick={() => onCancel(s.id)}
                  style={{ background: 'rgba(239,68,68,0.15)', border: 'none', color: '#ef4444', borderRadius: '8px', padding: '0.4rem 0.6rem', cursor: 'pointer' }}
                  title="Cancel scheduled message"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
