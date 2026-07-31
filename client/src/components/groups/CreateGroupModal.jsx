import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Users, X, Check, Sparkles } from 'lucide-react';

export default function CreateGroupModal({ onClose, onGroupCreated }) {
  const { token, user } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [allUsers, setAllUsers] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [themeColor, setThemeColor] = useState('#6366f1');
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
        setAllUsers(data);
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
    if (!name.trim()) return;
    setLoading(true);

    try {
      const avatarUrl = `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`;
      const res = await fetch('/api/rooms/group', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          name,
          description,
          avatarUrl,
          themeColor,
          members: selectedUsers
        })
      });

      if (res.ok) {
        const newGroup = await res.json();
        onGroupCreated(newGroup);
        onClose();
      }
    } catch (err) {
      console.error('Failed to create group:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-panel" style={{ maxWidth: '480px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="brand-icon" style={{ width: '40px', height: '40px' }}>
              <Users size={20} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.35rem', fontWeight: '700' }}>Create Group Chat</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Collaborate with multiple members in real-time</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <input
            type="text"
            placeholder="Group Name (e.g. Design Squad, Core Devs)"
            className="search-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <input
            type="text"
            placeholder="Group Description (Optional)"
            className="search-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: '600', marginBottom: '0.5rem', color: 'var(--text-muted)' }}>
              Select Members ({selectedUsers.length} selected):
            </label>
            <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.35rem', paddingRight: '0.25rem' }}>
              {allUsers.map(u => {
                const isSelected = selectedUsers.includes(u.id);
                return (
                  <div
                    key={u.id}
                    className={`room-item ${isSelected ? 'active' : ''}`}
                    onClick={() => toggleUser(u.id)}
                    style={{ padding: '0.6rem 0.85rem' }}
                  >
                    <img src={u.avatar_url} alt={u.username} style={{ width: '32px', height: '32px', borderRadius: '10px' }} />
                    <span style={{ flex: 1, fontWeight: '600', fontSize: '0.9rem' }}>{u.username}</span>
                    {isSelected && <Check size={18} style={{ color: 'var(--primary-accent)' }} />}
                  </div>
                );
              })}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="send-btn-gradient-circle"
            style={{ width: '100%', borderRadius: '12px', height: '46px', fontWeight: '700', marginTop: '0.5rem' }}
          >
            {loading ? 'Creating Group...' : 'Create Group'}
          </button>
        </form>
      </div>
    </div>
  );
}
