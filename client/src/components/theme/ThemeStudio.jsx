import React from 'react';
import { useTheme } from '../../context/ThemeContext';
import { Palette, X, Sparkles, Layout, Send, Image as ImageIcon } from 'lucide-react';

const PRESET_ACCENTS = [
  '#6366f1', '#ec4899', '#06b6d4', '#10b981', '#f59e0b', '#8b5cf6'
];

export default function ThemeStudio({ onClose }) {
  const { theme, updateTheme } = useTheme();

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-panel" style={{ maxWidth: '540px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="brand-icon" style={{ width: '40px', height: '40px', background: 'linear-gradient(135deg, #a855f7, #ec4899)' }}>
              <Palette size={20} />
            </div>
            <div>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.35rem', fontWeight: '700' }}>Customization & Theme Studio</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Personalize your chat bar, bubbles, wallpapers, and styles</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxHeight: '70vh', overflowY: 'auto', paddingRight: '0.5rem' }}>
          {/* 1. Custom Chat Bar Shape Picker */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: '700', marginBottom: '0.5rem', color: 'var(--text-main)' }}>
              <Layout size={16} style={{ color: 'var(--primary-accent)' }} /> Custom Chat Bar Shape:
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
              {[
                { id: 'floating-pill', label: 'Floating Pill' },
                { id: 'sleek-docked', label: 'Sleek Docked' },
                { id: 'rounded-glass', label: 'Rounded Glass' }
              ].map(item => (
                <button
                  key={item.id}
                  className={`chip-btn ${theme.chatBarShape === item.id ? 'active' : ''}`}
                  onClick={() => updateTheme({ chatBarShape: item.id })}
                  style={{
                    padding: '0.6rem 0.4rem',
                    borderRadius: '10px',
                    textAlign: 'center',
                    justifyContent: 'center',
                    background: theme.chatBarShape === item.id ? 'var(--primary-accent)' : 'rgba(255,255,255,0.05)',
                    color: theme.chatBarShape === item.id ? 'white' : 'var(--text-muted)'
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Sender Bubble Color Accent */}
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: '700', marginBottom: '0.5rem', color: 'var(--text-main)' }}>
              Sender Bubble Color:
            </label>
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
              {PRESET_ACCENTS.map(color => (
                <button
                  key={color}
                  onClick={() => updateTheme({ bubbleColorSender: color })}
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: color,
                    border: theme.bubbleColorSender === color ? '3px solid white' : 'none',
                    cursor: 'pointer',
                    transform: theme.bubbleColorSender === color ? 'scale(1.15)' : 'scale(1)',
                    transition: 'var(--transition-fast)'
                  }}
                />
              ))}
            </div>
          </div>

          {/* 3. Send Button Style */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: '700', marginBottom: '0.5rem', color: 'var(--text-main)' }}>
              <Send size={16} style={{ color: 'var(--primary-accent)' }} /> Send Button Style:
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
              {[
                { id: 'gradient-circle', label: 'Gradient Circle' },
                { id: 'minimal-icon', label: 'Minimal Box' },
                { id: 'neon-glow', label: 'Neon Glow' }
              ].map(item => (
                <button
                  key={item.id}
                  className="chip-btn"
                  onClick={() => updateTheme({ sendButtonStyle: item.id })}
                  style={{
                    padding: '0.6rem 0.4rem',
                    borderRadius: '10px',
                    textAlign: 'center',
                    justifyContent: 'center',
                    background: theme.sendButtonStyle === item.id ? 'var(--primary-accent)' : 'rgba(255,255,255,0.05)',
                    color: theme.sendButtonStyle === item.id ? 'white' : 'var(--text-muted)'
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* 4. Background Wallpaper Presets */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: '700', marginBottom: '0.5rem', color: 'var(--text-main)' }}>
              <ImageIcon size={16} style={{ color: 'var(--primary-accent)' }} /> Background Wallpaper:
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem' }}>
              {[
                { id: 'wallpaper-mesh-dark', label: 'Mesh Dark Aura' },
                { id: 'wallpaper-gradient-glow', label: 'Purple Gradient' },
                { id: 'wallpaper-minimal-slate', label: 'Minimal Slate' },
                { id: 'wallpaper-cyberpunk', label: 'Neon Cyberpunk' }
              ].map(wp => (
                <button
                  key={wp.id}
                  onClick={() => updateTheme({ backgroundWallpaper: wp.id })}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '12px',
                    border: theme.backgroundWallpaper === wp.id ? '2px solid var(--primary-accent)' : '1px solid var(--panel-border)',
                    background: 'rgba(255,255,255,0.03)',
                    color: 'var(--text-main)',
                    fontSize: '0.85rem',
                    fontWeight: '600',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  {wp.label}
                </button>
              ))}
            </div>
          </div>

          {/* 5. Font Scale */}
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: '700', marginBottom: '0.5rem', color: 'var(--text-main)' }}>
              Message Font Size:
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {['small', 'medium', 'large'].map(size => (
                <button
                  key={size}
                  onClick={() => updateTheme({ fontSize: size })}
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: '1px solid var(--panel-border)',
                    background: theme.fontSize === size ? 'var(--primary-accent)' : 'rgba(255,255,255,0.05)',
                    color: theme.fontSize === size ? 'white' : 'var(--text-muted)',
                    fontWeight: '600',
                    textTransform: 'capitalize',
                    cursor: 'pointer'
                  }}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
