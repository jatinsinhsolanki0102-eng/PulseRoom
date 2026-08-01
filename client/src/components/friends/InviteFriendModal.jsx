import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { UserPlus, Mail, X, CheckCircle, Send, Sparkles } from 'lucide-react';

export default function InviteFriendModal({ onClose, onChatInitiated }) {
  const { token } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [resultData, setResultData] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setErrorMsg('');
    setResultData(null);

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
      if (!res.ok) throw new Error(data.error || 'Failed to dispatch invitation.');

      setResultData(data);

      // If friend is ALREADY registered & confirmed, open their 1:1 chat room immediately!
      if (data.status === 'user_found' && data.room) {
        if (onChatInitiated) onChatInitiated(data.room);
        onClose();
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
        {/* Modal Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="brand-icon" style={{ width: '42px', height: '42px', background: 'linear-gradient(135deg, #10b981, #06b6d4)' }}>
              <UserPlus size={20} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.35rem', fontWeight: '700', margin: 0 }}>Add & Invite Friend</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>Connect with friends using their email address</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.25rem' }}>
            <X size={20} />
          </button>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#f87171',
            padding: '0.75rem 1rem',
            borderRadius: '12px',
            fontSize: '0.85rem',
            marginBottom: '1rem',
            textAlign: 'center'
          }}>
            {errorMsg}
          </div>
        )}

        {/* Result Message for Unregistered Friends */}
        {resultData && resultData.status === 'invited' ? (
          <div style={{
            padding: '1.5rem',
            textAlign: 'center',
            background: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: '16px',
            color: '#34d399'
          }}>
            <CheckCircle size={36} style={{ margin: '0 auto 0.75rem', color: '#10b981' }} />
            <div style={{ fontWeight: '700', fontSize: '1rem', marginBottom: '0.5rem' }}>Invitation Dispatched!</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>
              {resultData.message}
            </p>
            <button
              onClick={onClose}
              style={{
                marginTop: '1.25rem',
                padding: '0.6rem 1.5rem',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #10b981, #06b6d4)',
                color: 'white',
                border: 'none',
                fontWeight: '700',
                cursor: 'pointer'
              }}
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            <div className="search-box" style={{ padding: 0 }}>
              <Mail size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="email"
                placeholder="Friend's Email Address (e.g. friend@gmail.com)"
                className="search-input"
                style={{ paddingLeft: '2.6rem' }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div style={{
              fontSize: '0.8rem',
              color: 'var(--text-dim)',
              background: 'rgba(255, 255, 255, 0.03)',
              padding: '0.85rem 1rem',
              borderRadius: '12px',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              display: 'flex',
              gap: '0.5rem'
            }}>
              <Sparkles size={16} style={{ color: '#10b981', flexShrink: 0, marginTop: '2px' }} />
              <div>
                <strong>How it works:</strong>
                <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
                  <li>If your friend is registered, their 1:1 chat room opens instantly!</li>
                  <li>If they aren't registered, an email invite will be sent so they can sign up & start chatting.</li>
                </ul>
              </div>
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
                background: 'linear-gradient(135deg, #10b981, #06b6d4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem'
              }}
            >
              {loading ? (
                'Checking & Dispatching...'
              ) : (
                <>
                  <Send size={16} /> Add Friend / Send Email Invitation
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
