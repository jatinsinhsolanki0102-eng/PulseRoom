import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { UserPlus, X, Check } from 'lucide-react';

export default function AddMembersModal({ room, onClose, onMembersAdded }) {
  const { token, user } = useAuth();
  const [allUsers, setAllUsers] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const existingIds = new Set((room?.members || []).map(m => m.id));
        const available = Array.isArray(data) ? data.filter(u => u.id !== user?.id && !existingIds.has(u.id)) : [];
        setAllUsers(available);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const toggleUser = (userId) => {
    if (selectedUsers.includes(userId)) {
      setSelectedUsers(selectedUsers.filter(id => id !== userId));
    } else {
      setSelectedUsers([...selectedUsers, userId]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (selectedUsers.length === 0) return;
    setLoading(true);

    try {
      const res = await fetch(`/api/rooms/${room.id}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ memberIds: selectedUsers })
      });

      if (res.ok) {
        const updatedRoom = await res.json();
        onMembersAdded(updatedRoom);
        onClose();
      }
    } catch (err) {
      console.error('Failed to add members:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-panel" style={{ maxWidth: '460px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="brand-icon" style={{ width: '40px', height: '40px' }}>
              <UserPlus size={20} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.35rem', fontWeight: '700' }}>Add Members</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Add friends to "{room?.name || 'this group'}"</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: '600', marginBottom: '0.5rem', color: 'var(--text-muted)' }}>
              Select Members ({selectedUsers.length} selected):
            </label>
            <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.35rem', paddingRight: '0.25rem' }}>
              {allUsers.length === 0 ? (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', textAlign: 'center', padding: '1rem 0' }}>
                  No other users available. Invite friends via the '+' button in the sidebar first.
                </p>
              ) : (
                allUsers.map(u => {
                  const isSelected = selectedUsers.includes(u.id);
                  return (
                    <div
                      key={u.id}
                      className={`room-item ${isSelected ? 'active' : ''}`}
                      onClick={() => toggleUser(u.id)}
                      style={{ padding: '0.6rem 0.85rem' }}
                    >
                      <img src={u.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${u.username}`} alt={u.username} style={{ width: '32px', height: '32px', borderRadius: '10px' }} />
                      <span style={{ flex: 1, fontWeight: '600', fontSize: '0.9rem' }}>{u.username}</span>
                      {isSelected && <Check size={18} style={{ color: 'var(--primary-accent)' }} />}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || selectedUsers.length === 0}
            className="send-btn-gradient-circle"
            style={{ width: '100%', borderRadius: '12px', height: '46px', fontWeight: '700', marginTop: '0.5rem' }}
          >
            {loading ? 'Adding Members...' : `Add ${selectedUsers.length} Member${selectedUsers.length === 1 ? '' : 's'}`}
          </button>
        </form>
      </div>
    </div>
  );
}
