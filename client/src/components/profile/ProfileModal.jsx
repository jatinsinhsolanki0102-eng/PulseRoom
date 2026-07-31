import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { X, Camera, User, Edit2, Sparkles, Check } from 'lucide-react';

export default function ProfileModal({ isOpen, onClose }) {
  const { user, token, setUser } = useAuth();

  const [username, setUsername] = useState(user?.username || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [error, setError] = useState('');

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
      </div>
    </div>
  );
}
