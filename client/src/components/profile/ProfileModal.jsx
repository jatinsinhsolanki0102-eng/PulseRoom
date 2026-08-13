import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { X, Camera, User, Edit2, Sparkles, Check, ShieldCheck, Ban } from 'lucide-react';

const PRIVACY_OPTIONS = ['everyone', 'contacts', 'nobody'];
const PRIVACY_LABELS = { everyone: 'Everyone', contacts: 'My Contacts', nobody: 'Nobody' };

export default function ProfileModal({ isOpen, onClose }) {
  const { user, token, setUser } = useAuth();

  const [username, setUsername] = useState(user?.username || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [error, setError] = useState('');

  // Privacy + Blocking state
  const [privacy, setPrivacy] = useState({ last_seen: 'everyone', profile_photo: 'everyone', status: 'everyone' });
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [privacyMsg, setPrivacyMsg] = useState('');

  React.useEffect(() => {
    if (isOpen && user) {
      setUsername(user.username || '');
      setBio(user.bio || '');
      setAvatarUrl(user.avatar_url || '');
      setError('');
      setSuccessMsg('');
      loadPrivacy();
      loadBlockedUsers();
    }
  }, [isOpen, user]);

  const loadPrivacy = async () => {
    try {
      const res = await fetch('/api/users/privacy', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setPrivacy({ last_seen: 'everyone', profile_photo: 'everyone', status: 'everyone', ...(data || {}) });
      }
    } catch (err) {
      console.error('Failed to load privacy prefs:', err);
    }
  };

  const loadBlockedUsers = async () => {
    try {
      const res = await fetch('/api/users/blocked', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) setBlockedUsers(await res.json());
    } catch (err) {
      console.error('Failed to load blocked users:', err);
    }
  };

  const handlePrivacyChange = async (key, value) => {
    const next = { ...privacy, [key]: value };
    setPrivacy(next);
    setPrivacyMsg('');
    try {
      const res = await fetch('/api/users/privacy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [key]: value })
      });
      if (!res.ok) throw new Error('Failed to update privacy settings.');
      const updated = await res.json();
      setPrivacy({ last_seen: 'everyone', profile_photo: 'everyone', status: 'everyone', ...(updated || {}) });
      setPrivacyMsg('Privacy settings updated.');
      setTimeout(() => setPrivacyMsg(''), 2500);
    } catch (err) {
      setPrivacyMsg(err.message);
    }
  };

  const handleUnblock = async (userId) => {
    try {
      const res = await fetch(`/api/users/${userId}/block`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setBlockedUsers(prev => prev.filter(u => u.id !== userId));
      }
    } catch (err) {
      console.error('Failed to unblock user:', err);
    }
  };

  if (!isOpen) return null;

  // Handle Profile Photo Upload (WhatsApp Photo Picker)
  const handlePhotoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    setError('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (!res.ok) throw new Error('Failed to upload profile picture.');

      const data = await res.json();
      setAvatarUrl(data.mediaUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  // Handle Saving Profile (Username, Avatar Photo, Bio)
  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccessMsg('');

    try {
      const res = await fetch('/api/users/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          username: username.trim(),
          avatarUrl,
          bio: bio.trim()
        })
      });

      if (!res.ok) throw new Error('Failed to update profile.');

      const updatedUser = await res.json();
      setUser(updatedUser);
      setSuccessMsg('Profile updated successfully!');
      setTimeout(() => {
        setSuccessMsg('');
        onClose();
      }, 1200);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content glass-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '440px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ fontFamily: 'Outfit', fontSize: '1.5rem', fontWeight: '800', margin: 0 }}>
            Profile Settings
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            <X size={22} />
          </button>
        </div>

        {error && (
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
            {error}
          </div>
        )}

        {successMsg && (
          <div style={{
            background: 'rgba(16, 185, 129, 0.15)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            color: '#10b981',
            padding: '0.75rem 1rem',
            borderRadius: '12px',
            fontSize: '0.85rem',
            marginBottom: '1rem',
            textAlign: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px'
          }}>
            <Check size={16} /> {successMsg}
          </div>
        )}

        <form onSubmit={handleSaveProfile} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* WhatsApp Profile Picture Container with Camera Overlay */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ position: 'relative', width: '110px', height: '110px', margin: '0 auto 0.75rem' }}>
              <img
                src={avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`}
                alt={username}
                style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: '50%',
                  objectFit: 'cover',
                  background: '#0f172a',
                  border: '3px solid var(--primary-accent)',
                  boxShadow: '0 8px 24px rgba(18, 140, 126, 0.25)'
                }}
              />

              {/* WhatsApp Camera Overlay File Trigger */}
              <label
                htmlFor="profile-photo-input"
                style={{
                  position: 'absolute',
                  bottom: '2px',
                  right: '2px',
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  background: 'var(--primary-accent)',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                  border: '2px solid #0f172a'
                }}
                title="Change Profile Photo"
              >
                <Camera size={18} />
              </label>

              <input
                id="profile-photo-input"
                type="file"
                accept="image/*"
                onChange={handlePhotoUpload}
                style={{ display: 'none' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
              <button
                type="button"
                className="chip-btn"
                onClick={() => setAvatarUrl(`https://api.dicebear.com/7.x/bottts/svg?seed=${Math.random().toString(36).substring(7)}`)}
              >
                <Sparkles size={12} style={{ marginRight: '4px' }} /> Randomize Avatar
              </button>
            </div>
            {uploading && <span style={{ fontSize: '0.75rem', color: 'var(--primary-accent)', display: 'block', marginTop: '4px' }}>Uploading photo...</span>}
          </div>

          {/* Username Input */}
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem' }}>
              Your Name
            </label>
            <div className="search-box" style={{ padding: 0 }}>
              <User size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="text"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
          </div>

          {/* About / Status Bio Input */}
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem' }}>
              About / Status Bio
            </label>
            <div className="search-box" style={{ padding: 0 }}>
              <Edit2 size={18} className="search-icon" style={{ left: '1rem' }} />
              <input
                type="text"
                placeholder="e.g. Available, At work, In a meeting"
                className="search-input"
                style={{ paddingLeft: '2.5rem' }}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={saving || uploading}
            className="send-btn-gradient-circle"
            style={{ width: '100%', borderRadius: '12px', height: '48px', fontWeight: '700', fontSize: '1rem', marginTop: '0.5rem' }}
          >
            {saving ? 'Saving Changes...' : 'Save Profile Changes'}
          </button>
        </form>

        {/* Privacy & Security Settings */}
        <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--panel-border)', paddingTop: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem' }}>
            <ShieldCheck size={18} style={{ color: 'var(--primary-accent)' }} />
            <h3 style={{ fontFamily: 'Outfit', fontWeight: '700', fontSize: '1rem', margin: 0, color: 'var(--text-main)' }}>
              Privacy Settings
            </h3>
          </div>

          {privacyMsg && (
            <div style={{
              background: privacyMsg.includes('Failed') ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
              border: `1px solid ${privacyMsg.includes('Failed') ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`,
              color: privacyMsg.includes('Failed') ? '#f87171' : '#10b981',
              padding: '0.6rem 0.9rem',
              borderRadius: '10px',
              fontSize: '0.8rem',
              marginBottom: '0.9rem'
            }}>
              {privacyMsg}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            {[
              { key: 'last_seen', label: 'Last Seen & Online' },
              { key: 'profile_photo', label: 'Profile Photo' },
              { key: 'status', label: 'About / Status' }
            ].map(item => (
              <div key={item.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-main)', fontWeight: '600' }}>{item.label}</span>
                <div style={{ display: 'flex', gap: '0.3rem' }}>
                  {PRIVACY_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      onClick={() => handlePrivacyChange(item.key, opt)}
                      className="chip-btn"
                      style={{
                        padding: '0.35rem 0.7rem',
                        borderRadius: '99px',
                        fontSize: '0.72rem',
                        background: (privacy[item.key] || 'everyone') === opt ? 'var(--primary-accent)' : 'rgba(255,255,255,0.06)',
                        color: (privacy[item.key] || 'everyone') === opt ? 'white' : 'var(--text-muted)',
                        fontWeight: '600'
                      }}
                    >
                      {PRIVACY_LABELS[opt]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Blocked Users List */}
        <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--panel-border)', paddingTop: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem' }}>
            <Ban size={18} style={{ color: '#f87171' }} />
            <h3 style={{ fontFamily: 'Outfit', fontWeight: '700', fontSize: '1rem', margin: 0, color: 'var(--text-main)' }}>
              Blocked Users ({blockedUsers.length})
            </h3>
          </div>

          {blockedUsers.length === 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>No blocked users.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {blockedUsers.map(u => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.5rem', borderRadius: '10px', background: 'rgba(255,255,255,0.02)' }}>
                  <img src={u.avatar_url || `https://api.dicebear.com/7.x/identicon/svg?seed=${u.username}`} alt={u.username} style={{ width: '32px', height: '32px', borderRadius: '50%' }} />
                  <span style={{ flex: 1, fontWeight: '600', fontSize: '0.85rem' }}>{u.username}</span>
                  <button
                    onClick={() => handleUnblock(u.id)}
                    className="chip-btn"
                    style={{ padding: '0.35rem 0.7rem', borderRadius: '99px', fontSize: '0.72rem', background: 'rgba(16,185,129,0.12)', color: '#10b981', fontWeight: '700' }}
                  >
                    Unblock
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
