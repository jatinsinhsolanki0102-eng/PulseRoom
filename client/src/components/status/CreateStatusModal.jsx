import React, { useState, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { X, Send, Image as ImageIcon, Video as VideoIcon, Paperclip, Sparkles } from 'lucide-react';

const STATUS_COLORS = ['#128c7e', '#6366f1', '#ec4899', '#f59e0b', '#8b5cf6', '#090d16'];

export default function CreateStatusModal({ onClose }) {
  const { token } = useAuth();
  const [text, setText] = useState('');
  const [bgColor, setBgColor] = useState('#128c7e');
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [mediaType, setMediaType] = useState('image'); // 'image' | 'video'
  const [loading, setLoading] = useState(false);

  const fileInputRef = useRef(null);

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setMediaType(file.type.startsWith('video') ? 'video' : 'image');
  };

  const handleRemoveMedia = () => {
    setSelectedFile(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!text.trim() && !selectedFile) return;
    setLoading(true);

    try {
      const formData = new FormData();
      if (text) formData.append('text', text);
      if (bgColor) formData.append('bgColor', bgColor);
      if (selectedFile) {
        formData.append('media', selectedFile);
        formData.append('mediaType', mediaType);
      }

      const res = await fetch('/api/statuses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });

      if (res.ok) {
        onClose();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to upload status.');
      }
    } catch (err) {
      console.error('Failed to create status:', err);
      alert('Failed to upload status. Please try again.');
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
          <h3 style={{ fontFamily: 'Outfit', color: 'white', fontWeight: '700', margin: 0 }}>Add Photo/Video Status</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', padding: '0.25rem' }}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/*,video/*"
            style={{ display: 'none' }}
          />

          {/* Media Preview */}
          {previewUrl ? (
            <div style={{ position: 'relative', borderRadius: '16px', overflow: 'hidden', maxHeight: '220px', background: 'rgba(0,0,0,0.3)' }}>
              {mediaType === 'video' ? (
                <video src={previewUrl} controls style={{ width: '100%', maxHeight: '220px', objectFit: 'contain' }} />
              ) : (
                <img src={previewUrl} alt="Status Preview" style={{ width: '100%', maxHeight: '220px', objectFit: 'cover' }} />
              )}
              <button
                type="button"
                onClick={handleRemoveMedia}
                style={{ position: 'absolute', top: '8px', right: '8px', background: '#ef4444', border: 'none', borderRadius: '50%', color: 'white', width: '28px', height: '28px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={16} />
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
                gap: '0.5rem',
                transition: 'all 0.2s ease'
              }}
            >
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <ImageIcon size={24} />
                <VideoIcon size={24} />
              </div>
              <span style={{ fontWeight: '600', fontSize: '0.9rem' }}>Click to select Photo or Video</span>
              <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>Supports JPG, PNG, MP4, WEBM</span>
            </button>
          )}

          {/* Text Caption Input */}
          <textarea
            placeholder="Write a status caption..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            style={{
              width: '100%',
              background: 'rgba(255,255,255,0.15)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '12px',
              padding: '0.75rem',
              color: 'white',
              fontSize: '1rem',
              resize: 'none',
              outline: 'none',
              fontFamily: 'inherit'
            }}
          />

          {/* Color Palette Selector */}
          <div>
            <label style={{ color: 'rgba(255,255,255,0.9)', fontSize: '0.8rem', fontWeight: '600', display: 'block', marginBottom: '0.5rem' }}>
              Background Color
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {STATUS_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setBgColor(c)}
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: c,
                    border: bgColor === c ? '3px solid white' : '1px solid rgba(255,255,255,0.3)',
                    cursor: 'pointer',
                    transform: bgColor === c ? 'scale(1.1)' : 'scale(1)',
                    transition: 'all 0.2s ease'
                  }}
                />
              ))}
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
              color: 'white',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem'
            }}
          >
            {loading ? (
              'Uploading Status...'
            ) : (
              <>
                <Send size={16} /> Share Status
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
