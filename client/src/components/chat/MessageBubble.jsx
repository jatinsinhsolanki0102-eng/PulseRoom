import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import VoicePlayer from './VoicePlayer';
import { Smile, Reply, CheckCheck, Trash2 } from 'lucide-react';

const QUICK_EMOJIS = ['❤️', '👍', '🔥', '😂', '🎉', '😮'];

export default function MessageBubble({ message, roomId, onReply, onDeleteMessage }) {
  const { user } = useAuth();
  const { toggleReaction } = useSocket();
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const isSentByMe = message.sender_id === user?.id;
  const reactions = message.reactions || {};

  const handleEmojiClick = (emoji) => {
    toggleReaction(message.id, roomId, emoji);
    setShowEmojiPicker(false);
  };

  const formattedTime = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  return (
    <div className={`message-row ${isSentByMe ? 'sent' : 'received'}`} style={{ position: 'relative' }}>
      {!isSentByMe && (
        <img
          src={message.sender_avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${message.sender_name}`}
          alt={message.sender_name}
          style={{ width: '32px', height: '32px', borderRadius: '10px', alignSelf: 'flex-end', marginBottom: '4px' }}
        />
      )}

      <div className="bubble" style={{ position: 'relative' }}>
        {/* Sender Name in Group Chats */}
        {!isSentByMe && message.sender_name && (
          <div className="sender-name-label">{message.sender_name}</div>
        )}

        {/* Reply Preview Header */}
        {message.reply_to && (
          <div style={{
            background: 'rgba(0, 0, 0, 0.25)',
            borderLeft: '3px solid var(--primary-accent)',
            padding: '0.35rem 0.6rem',
            borderRadius: '6px',
            marginBottom: '0.4rem',
            fontSize: '0.75rem',
            color: 'var(--text-muted)'
          }}>
            <strong style={{ color: 'var(--text-main)' }}>{message.reply_to.sender_name}</strong>: {message.reply_to.text}
          </div>
        )}

        {/* Media Content (Image Attachment) */}
        {message.type === 'image' && message.media_url && (
          <div style={{ marginBottom: '0.5rem' }}>
            <img
              src={message.media_url}
              alt="Attachment"
              style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: '12px', display: 'block' }}
            />
          </div>
        )}

        {/* Voice Note Audio Player */}
        {message.type === 'audio' && message.media_url ? (
          <VoicePlayer audioUrl={message.media_url} />
        ) : (
          <div>{message.text}</div>
        )}

        {/* Reactions List */}
        {Object.keys(reactions).length > 0 && (
          <div className="reactions-row">
            {Object.entries(reactions).map(([emoji, userIds]) => (
              <span
                key={emoji}
                className="reaction-pill"
                onClick={() => handleEmojiClick(emoji)}
                style={{
                  borderColor: userIds.includes(user?.id) ? 'var(--primary-accent)' : 'rgba(255, 255, 255, 0.1)'
                }}
              >
                <span>{emoji}</span>
                <span style={{ fontWeight: '700' }}>{userIds.length}</span>
              </span>
            ))}
          </div>
        )}

        {/* Bubble Timestamp & Status */}
        <div className="bubble-meta">
          <span>{formattedTime}</span>
          {isSentByMe && <CheckCheck size={14} style={{ color: '#38bdf8' }} />}
        </div>
      </div>

      {/* Message Hover Actions (Reply, React, Delete) */}
      <div style={{
        display: 'flex',
        gap: '0.2rem',
        opacity: 0.8,
        alignSelf: 'center',
        margin: '0 0.4rem'
      }}>
        <button
          className="action-icon-btn"
          style={{ width: '28px', height: '28px', border: 'none', background: 'transparent' }}
          title="React"
          onClick={() => setShowEmojiPicker(!showEmojiPicker)}
        >
          <Smile size={15} />
        </button>
        <button
          className="action-icon-btn"
          style={{ width: '28px', height: '28px', border: 'none', background: 'transparent' }}
          title="Reply"
          onClick={() => onReply(message)}
        >
          <Reply size={15} />
        </button>
        {isSentByMe && (
          <button
            className="action-icon-btn"
            style={{ width: '28px', height: '28px', border: 'none', background: 'transparent', color: '#ef4444' }}
            title="Delete message for me"
            onClick={() => onDeleteMessage(message.id)}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Quick Emoji Picker Drawer */}
      {showEmojiPicker && (
        <div style={{
          position: 'absolute',
          top: '-40px',
          [isSentByMe ? 'right' : 'left']: '40px',
          background: '#0f172a',
          border: '1px solid var(--panel-border)',
          borderRadius: '99px',
          padding: '0.25rem 0.5rem',
          display: 'flex',
          gap: '0.4rem',
          zIndex: 20,
          boxShadow: '0 10px 25px rgba(0,0,0,0.5)'
        }}>
          {QUICK_EMOJIS.map(emoji => (
            <button
              key={emoji}
              style={{ background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer' }}
              onClick={() => handleEmojiClick(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
