import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { X, ShieldAlert, Check, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '../../lib/time';

const TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'dismissed', label: 'Dismissed' }
];

export default function ModerationDashboard({ onClose }) {
  const { token } = useAuth();
  const [tab, setTab] = useState('pending');
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/moderation/reports?status=${tab}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setReports(Array.isArray(data) ? data : []);
      } else {
        setReports([]);
      }
    } catch (err) {
      console.error('Failed to load reports:', err);
      setReports([]);
    } finally {
      setLoading(false);
    }
  }, [token, tab]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (reportId, action) => {
    setBusyId(reportId);
    try {
      const res = await fetch(`/api/moderation/reports/${reportId}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error(`Failed to ${action} report:`, data.error || res.statusText);
        return;
      }
      await load();
    } catch (err) {
      console.error(`Failed to ${action} report:`, err);
    } finally {
      setBusyId(null);
    }
  };

  const messagePreview = (r) => {
    if (r.message_e2ee) return '🔒 Encrypted message (content is end-to-end encrypted)';
    if (r.message_type === 'image') return '📷 Photo message';
    if (r.message_type === 'video') return '🎥 Video message';
    if (r.message_type === 'audio') return '🎤 Voice note';
    if (r.message_type === 'deleted' || r.deleted_for_everyone) return 'This message was deleted.';
    return r.message_text || '(no text)';
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel" style={{ maxWidth: '600px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontFamily: 'Outfit', fontSize: '1.25rem', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ShieldAlert size={18} style={{ color: '#f87171' }} /> Moderation Dashboard
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                flex: 1,
                padding: '0.5rem 0.75rem',
                borderRadius: '10px',
                border: 'none',
                cursor: 'pointer',
                fontWeight: '700',
                fontSize: '0.85rem',
                background: tab === t.key ? 'var(--primary-accent)' : 'rgba(255,255,255,0.06)',
                color: tab === t.key ? 'white' : 'var(--text-muted)'
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-dim)' }}>Loading reports...</p>
        ) : reports.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-dim)' }}>
            <ShieldAlert size={32} style={{ margin: '0 auto 0.75rem', opacity: 0.4 }} />
            <p>No {tab} reports.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: '55vh', overflowY: 'auto' }}>
            {reports.map(r => (
              <div key={r.id} style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--panel-border)',
                borderRadius: '12px',
                padding: '0.85rem 1rem'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.35rem' }}>
                  <img
                    src={r.sender_avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${r.sender_username}`}
                    alt={r.sender_username}
                    style={{ width: '32px', height: '32px', borderRadius: '10px', objectFit: 'cover' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ color: 'var(--text-main)', fontSize: '0.9rem' }}>{r.sender_username}</strong>
                    {r.room_type === 'group' && (
                      <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>in {r.room_name || 'group'}</span>
                    )}
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                      Reported by {r.reporter_username} • {formatRelativeTime(r.created_at)}
                    </div>
                  </div>
                  {r.status === 'pending' && (
                    <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                      <button
                        onClick={() => act(r.id, 'resolve')}
                        disabled={busyId === r.id}
                        title="Resolve (no action needed)"
                        style={{
                          padding: '0.4rem 0.7rem',
                          borderRadius: '8px',
                          border: 'none',
                          cursor: 'pointer',
                          fontWeight: '700',
                          fontSize: '0.75rem',
                          background: 'rgba(16,185,129,0.2)',
                          color: '#34d399',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem'
                        }}
                      >
                        <Check size={13} /> Resolve
                      </button>
                      <button
                        onClick={() => act(r.id, 'dismiss')}
                        disabled={busyId === r.id}
                        title="Dismiss (invalid report)"
                        style={{
                          padding: '0.4rem 0.7rem',
                          borderRadius: '8px',
                          border: 'none',
                          cursor: 'pointer',
                          fontWeight: '700',
                          fontSize: '0.75rem',
                          background: 'rgba(239,68,68,0.15)',
                          color: '#f87171',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem'
                        }}
                      >
                        <Trash2 size={13} /> Dismiss
                      </button>
                    </div>
                  )}
                </div>
                <p style={{ fontSize: '0.88rem', color: 'var(--text-main)', wordBreak: 'break-word', marginBottom: '0.35rem' }}>
                  {messagePreview(r)}
                </p>
                <div style={{ fontSize: '0.8rem', color: '#fbbf24', background: 'rgba(245,158,11,0.1)', borderRadius: '8px', padding: '0.4rem 0.6rem' }}>
                  <strong>Reason:</strong> {r.reason || 'No reason provided'}
                </div>
                {r.status !== 'pending' && (
                  <div style={{ marginTop: '0.4rem', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                    {r.status === 'resolved' ? '✓ Resolved' : '✕ Dismissed'} by {r.resolved_by || 'moderator'} on {r.resolved_at ? new Date(r.resolved_at).toLocaleString() : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
