import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Pencil, X, Camera } from 'lucide-react';

export default function EditGroupModal({ room, onClose, onGroupUpdated }) {
  const { token } = useAuth();
  const [name, setName] = useState(room?.name || '');
  const [description, setDescription] = useState(room?.description || '');
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState(room?.avatar_url || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    const reader = new FileReader();
    reader.onload = () => setAvatarPreview(reader.result);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Group name is required.');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('description', description || '');
      if (avatarFile) {
        formData.append('avatar', avatarFile);
      } else if (!avatarPreview && !room?.avatar_url) {
        formData.append('avatarUrl', `https://api.dicebear.com/7.x/identicon/svg?seed=${name.trim()}`);
      }

      const res = await fetch(`/api/rooms/${room.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (res.ok) {
        const updated = await res.json();
        if (onGroupUpdated) onGroupUpdated(updated);
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to update group.');
      }
    } catch (err) {
      console.error('Failed to update group:', err);
      setError('Failed to update group.');
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
              <Pencil size={20} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.35rem', fontWeight: '700' }}>Edit Group</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Rename the group, change its photo or description</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Group Photo */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ position: 'relative' }}>
              <img
                src={avatarPreview || `https://api.dicebear.com/7.x/identicon/svg?seed=${name || room?.name || 'group'}`}
                alt="Group"
                style={{ width: '84px', height: '84px', borderRadius: '24px', objectFit: 'cover', background: '#0f172a', border: '2px solid var(--primary-accent)' }}
              />
              <label
                htmlFor="group-avatar-upload"
                style={{ position: 'absolute', bottom: '-4px', right: '-4px', background: 'var(--primary-accent)', color: 'white', borderRadius: '50%', padding: '5px', cursor: 'pointer', display: 'flex', boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}
              >
                <Camera size={14} />
              </label>
              <input
                id="group-avatar-upload"
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </div>
            {avatarFile && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                New photo selected — press Save to apply.
              </span>
            )}
          </div>

          <input
            type="text"
            placeholder="Group Name"
            className="search-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <textarea
            placeholder="Group Description (Optional)"
            className="search-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ resize: 'vertical', minHeight: '72px', fontFamily: 'inherit', padding: '0.75rem 1rem' }}
          />

          {error && (
            <p style={{ fontSize: '0.8rem', color: '#f87171' }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="send-btn-gradient-circle"
            style={{ width: '100%', borderRadius: '12px', height: '46px', fontWeight: '700', marginTop: '0.5rem' }}
          >
            {loading ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>
    </div>
  );
}
