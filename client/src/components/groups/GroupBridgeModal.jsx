import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { GitMerge, X, ArrowRight, Check } from 'lucide-react';

export default function GroupBridgeModal({ onClose, onBridgeCreated }) {
  const { token } = useAuth();
  const [rooms, setRooms] = useState([]);
  const [sourceRoomId, setSourceRoomId] = useState('');
  const [targetRoomId, setTargetRoomId] = useState('');
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    fetchRooms();
  }, []);

  const fetchRooms = async () => {
    try {
      const res = await fetch('/api/rooms', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const groupRooms = data.filter(r => r.type === 'group');
        setRooms(groupRooms);
        if (groupRooms.length >= 2) {
          setSourceRoomId(groupRooms[0].id);
          setTargetRoomId(groupRooms[1].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateBridge = async (e) => {
    e.preventDefault();
    if (!sourceRoomId || !targetRoomId || sourceRoomId === targetRoomId) {
      alert('Please select two distinct group rooms to establish a room bridge.');
      return;
    }
    setLoading(true);

    try {
      const res = await fetch('/api/rooms/bridge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ sourceRoomId, targetRoomId })
      });

      if (res.ok) {
        setSuccessMsg('⚡ Group-to-Group Bridge established! Messages in source group will broadcast to target group.');
        setTimeout(() => {
          if (onBridgeCreated) onBridgeCreated();
          onClose();
        }, 1500);
      }
    } catch (err) {
      console.error('Failed to create bridge:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-panel" style={{ maxWidth: '480px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="brand-icon" style={{ width: '40px', height: '40px', background: 'linear-gradient(135deg, #06b6d4, #3b82f6)' }}>
              <GitMerge size={20} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.35rem', fontWeight: '700' }}>Group-to-Group Bridge</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Link two group rooms for cross-channel broadcasting</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {successMsg ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid #10b981', borderRadius: '14px', color: '#34d399' }}>
            {successMsg}
          </div>
        ) : (
          <form onSubmit={handleCreateBridge} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {rooms.length < 2 ? (
              <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                You need at least 2 group rooms to establish a bridge link. Please create another group room first!
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.4rem', color: 'var(--text-muted)' }}>
                      Source Group:
                    </label>
                    <select
                      className="search-input"
                      value={sourceRoomId}
                      onChange={(e) => setSourceRoomId(e.target.value)}
                      style={{ paddingLeft: '0.85rem' }}
                    >
                      {rooms.map(r => (
                        <option key={r.id} value={r.id} style={{ background: '#0f172a' }}>{r.name}</option>
                      ))}
                    </select>
                  </div>

                  <ArrowRight size={20} style={{ color: 'var(--primary-accent)', marginTop: '1.25rem' }} />

                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.4rem', color: 'var(--text-muted)' }}>
                      Target Broadcast Group:
                    </label>
                    <select
                      className="search-input"
                      value={targetRoomId}
                      onChange={(e) => setTargetRoomId(e.target.value)}
                      style={{ paddingLeft: '0.85rem' }}
                    >
                      {rooms.map(r => (
                        <option key={r.id} value={r.id} style={{ background: '#0f172a' }}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', background: 'rgba(255,255,255,0.03)', padding: '0.75rem 1rem', borderRadius: '10px' }}>
                  💡 <strong>How Group-to-Group Bridge works:</strong> Any announcement or message sent in the Source Group will instantly sync into the Target Group via real-time WebSocket connection.
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="send-btn-gradient-circle"
                  style={{ width: '100%', borderRadius: '12px', height: '46px', fontWeight: '700', background: 'linear-gradient(135deg, #06b6d4, #3b82f6)' }}
                >
                  {loading ? 'Establishing Link...' : 'Establish Group-to-Group Bridge'}
                </button>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
