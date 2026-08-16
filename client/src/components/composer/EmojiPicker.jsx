import React from 'react';

const EMOJI_CATEGORIES = [
  {
    label: 'Smileys',
    items: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃',
      '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜',
      '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏', '😒', '😞', '😔', '😟', '😕',
      '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡',
      '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔',
      '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮',
      '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷',
      '🤒', '🤕', '🤑', '🤠', '😈', '👿', '🤡', '💩', '👻', '💀', '☠️', '👽'
    ]
  },
  {
    label: 'Gestures',
    items: [
      '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇',
      '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👏', '🙌', '🤝', '🙏', '💪', '🦵',
      '👂', '👃', '👀', '🧠', '🫀', '💋', '👄', '🦷', '👅', '💅', '🤳', '💃',
      '🕺', '👨‍💻', '👩‍💻', '🙋', '🤦', '🤷', '💆', '💇', '👯', '🛀', '🏃', '🚶'
    ]
  },
  {
    label: 'Hearts & Love',
    items: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕',
      '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '💌', '💋', '👩‍❤️‍👨', '💑',
      '🌹', '🌷', '🌸', '💐', '💍', '🎁', '🥰', '😍', '☺️', '🥹', '💫', '✨'
    ]
  },
  {
    label: 'Animals',
    items: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮',
      '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺',
      '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐢', '🐍', '🦎',
      '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈'
    ]
  },
  {
    label: 'Food & Drink',
    items: [
      '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑',
      '🥭', '🍍', '🥥', '🥝', '🍅', '🥑', '🌽', '🥕', '🌶️', '🥦', '🧄', '🍄',
      '🍞', '🥐', '🥨', '🥯', '🧀', '🥚', '🍳', '🥞', '🧇', '🥓', '🥩', '🍔',
      '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🥙', '🍜', '🍝', '🍣', '🍤', '🍦',
      '🍰', '🎂', '🍪', '🍫', '🍬', '🍭', '☕', '🍵', '🧋', '🥤', '🍺', '🍷'
    ]
  },
  {
    label: 'Activity',
    items: [
      '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🥎', '🎱', '🏓', '🏸', '🥊',
      '🥋', '⛳', '🏹', '🎣', '🥌', '🎽', '🛹', '🛼', '⛸️', '🏂', '⛷️', '🎿',
      '🚴', '🚵', '🏊', '🤽', '🤸', '🧘', '🎯', '🎳', '🎮', '🎲', '🎪', '🎤',
      '🎧', '🎼', '🎹', '🥁', '🎸', '🎺', '🎻', '🪗', '🎬', '🏆', '🥇', '🎗️'
    ]
  },
  {
    label: 'Travel & Places',
    items: [
      '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚',
      '🚜', '🛵', '🏍️', '🚲', '🛴', '🚨', '🚔', '✈️', '🚀', '🛸', '🚁', '🛶',
      '⛵', '🚤', '🛳️', '🚢', '🗺️', '🗿', '🏖️', '🏝️', '🏜️', '🌋', '🏔️', '⛰️',
      '🏠', '🏡', '🏢', '🏰', '🗼', '🎡', '🎢', '🎠', '⛲', '🌃', '🌉', '🌆'
    ]
  },
  {
    label: 'Objects & Symbols',
    items: [
      '💡', '🔦', '🕯️', '📱', '💻', '⌚', '💾', '📷', '📺', '📞', '🔔', '🔑',
      '🔒', '🔓', '✂️', '📌', '📍', '📎', '📚', '📖', '📝', '✏️', '🖊️', '💼',
      '💰', '💎', '⚖️', '🔧', '🧰', '🎁', '🎈', '🎀', '🧸', '🔮', '💿', '🎯',
      '✅', '❌', '⚠️', '🚫', '🔞', '❓', '❗', '💯', '🔥', '⚡', '💧', '🌈'
    ]
  }
];

export default function EmojiPicker({ onPick, onClose }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 40,
          background: 'transparent'
        }}
      />
      <div
        className="emoji-picker glass-panel"
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 10px)',
          left: 0,
          right: 0,
          zIndex: 41,
          maxHeight: 'min(320px, 45dvh)',
          overflowY: 'auto',
          borderRadius: '16px',
          padding: '0.6rem',
          background: 'rgba(15, 23, 42, 0.98)',
          border: '1px solid var(--panel-border)',
          boxShadow: '0 20px 50px rgba(0,0,0,0.55)',
          webkitOverflowScrolling: 'touch'
        }}
      >
        {EMOJI_CATEGORIES.map(cat => (
          <div key={cat.label} style={{ marginBottom: '0.25rem' }}>
            <div style={{ fontSize: '0.65rem', fontWeight: '700', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '0.25rem 0.4rem' }}>
              {cat.label}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '2px' }}>
              {cat.items.map(emoji => (
                <button
                  key={emoji}
                  onClick={() => onPick(emoji)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '1.3rem',
                    padding: '0.3rem 0',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'background 0.12s ease'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
