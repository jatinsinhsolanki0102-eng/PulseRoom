import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { UserPlus, Mail, X, CheckCircle, Send } from 'lucide-react';

export default function InviteFriendModal({ onClose, onChatInitiated }) {
  const { token } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [resultMsg, setResultMsg] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setErrorMsg('');
    setResultMsg(null);

    try {
      const res = await fetch('/api/friends/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ email: email.trim() })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to invite friend.');

      setResultMsg(data);

      if (data.status === 'user_found' && data.room) {
        setTimeout(() => {
          if (onChatInitiated) onChatInitiated(data.room);
          onClose();
        }, 1500);
      }
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-panel" style={{ maxWidth: '440px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="brand-icon" style={{ width: '40px', height: '40px', background: 'linear-gradient(135deg, #10b981, #06b6d4)' }}>
              <UserPlus size={20} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.35rem', fontWeight: '700' }}>Add & Invite Friend</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Connect with friends via email address</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {errorMsg && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#f87171',
            padding: '0.75rem',
            borderRadius: '12px',
            fontSize: '0.85rem',
            marginBottom: '1rem',
            textAlign: 'center'
          }}>
            {errorMsg}
          </div>
        )}

        {resultMsg ? (
          <div style={{
            padding: '1.5rem',
            textAlign: 'center',
            background: resultMsg.status === 'user_found' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(14, 165, 233, 0.15)',
            border: `1px solid ${resultMsg.status === 'user_found' ? '#10b981' : '#06b6d4'}`,
            borderRadius: '16px',
            color: resultMsg.status === 'user_found' ? '#34d399' : '#38bdf8'}
          }>
            <CheckCircle size={32} style={{ margin: '0 auto 0.5rem' }} />
            <div style={{ fontWeight: '700', fontSize: '0.95rem' }}>{resultMsg.message}</div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="search-box" style={{ padding: 0 }}>
              <Mail size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="email"
                placeholder="Friend's Email (e.g. friend@gmail.com)"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', background: 'rgba(255,255,255,0.03)', padding: '0.75rem 1rem', borderRadius: '10px' }}>
              💡 If your friend is already on PulseRoom, a chat will open instantly! If they aren't registered, an invitation email will be sent automatically.
            </div>

            <button
              type="submit"
              disabled={loading}
              className="send-btn-gradient-circle"
              style={{
                width: '100%',
                borderRadius: '12px',
                height: '46px',
                fontWeight: '700',
                background: 'linear-gradient(135deg, #10b981, #06b6d4)'
              }}
            >
              {loading ? 'Searching & Sending...' : 'Add / Send Email Invitation'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
