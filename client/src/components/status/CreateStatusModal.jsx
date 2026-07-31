import React, { useState, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { X, Send, Image as ImageIcon, Video as VideoIcon, Paperclip } from 'lucide-react';

const STATUS_COLORS = ['#128c7e', '#6366f1', '#ec4899', '#f59e0b', '#8b5cf6', '#090d16'];

export default function CreateStatusModal({ onClose }) {
  const { token } = useAuth();
  const [text, setText] = useState('');
  const [bgColor, setBgColor] = useState('#128c7e');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState('image'); // 'image' | 'video'
  const [loading, setLoading] = useState(false);

  const fileInputRef = useRef(null);

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      setLoading(true);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (res.ok) {
        const data = await res.json();
        setMediaUrl(data.mediaUrl);
        setMediaType(data.mediaType || (file.type.startsWith('video') ? 'video' : 'image'));
      }
    } catch (err) {
      console.error('File upload failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!text.trim() && !mediaUrl) return;
    setLoading(true);

    try {
      const res = await fetch('/api/statuses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ text, mediaUrl, mediaType, bgColor })
      });

      if (res.ok) {
        onClose();
      }
    } catch (err) {
      console.error('Failed to create status:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal-content glass-panel"
        style={{
          maxWidth: '440px',
          background: bgColor,
          transition: 'background 0.3s ease',
          borderRadius: '24px'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontFamily: 'Outfit', color: 'white', fontWeight: '700' }}>Add Photo/Video Status</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept="image/*,video/*"
            style={{ display: 'none' }}
          />

          {/* Media Preview */}
          {mediaUrl ? (
            <div style={{ position: 'relative', borderRadius: '16px', overflow: 'hidden', maxHeight: '200px' }}>
              {mediaType === 'video' ? (
                <video src={mediaUrl} controls style={{ width: '100%', maxHeight: '200px', objectFit: 'cover' }} />
              ) : (
                <img src={mediaUrl} alt="Status Preview" style={{ width: '100%', maxHeight: '200px', objectFit: 'cover' }} />
              )}
              <button
                type="button"
                onClick={() => setMediaUrl('')}
                style={{ position: 'absolute', top: '8px', right: '8px', background: '#ef4444', border: 'none', borderRadius: '50%', color: 'white', width: '24px', height: '24px', cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{
                padding: '1.5rem',
                border: '2px dashed rgba(255,255,255,0.4)',
                borderRadius: '16px',
                background: 'rgba(0,0,0,0.15)',
                color: 'white',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <ImageIcon size={24} />
                <VideoIcon size={24} />
              </div>
              <span style={{ fontSize: '0.9rem', fontWeight: '600' }}>Click to upload Photo or Video Story</span>
            </button>
          )}

          <textarea
            rows={3}
            placeholder="Add a caption or text update..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '16px',
              padding: '0.85rem',
              color: 'white',
              fontSize: '1rem',
              outline: 'none',
              resize: 'none'
            }}
          />

          {/* Color Picker */}
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'rgba(255,255,255,0.8)', marginBottom: '0.4rem', fontWeight: '600' }}>
              Choose Status Color:
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {STATUS_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setBgColor(c)}
                  style={{
                    width: '30px',
                    height: '30px',
                    borderRadius: '50%',
                    background: c,
                    border: bgColor === c ? '3px solid white' : 'none',
                    cursor: 'pointer'
                  }}
                />
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '0.75rem',
              borderRadius: '12px',
              background: 'white',
              color: 'black',
              border: 'none',
              fontWeight: '700',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem'
            }}
          >
            <Send size={16} /> {loading ? 'Posting...' : 'Post Status'}
          </button>
        </form>
      </div>
    </div>
  );
}
