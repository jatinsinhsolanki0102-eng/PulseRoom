import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import VoicePlayer from './VoicePlayer';
import DecryptedMedia from './DecryptedMedia';
import { Smile, Reply, CheckCheck, Trash2, Flag, Lock, ShieldCheck, AlertTriangle } from 'lucide-react';

const QUICK_EMOJIS = ['❤️', '👍', '🔥', '😂', '🎉', '😮'];

export default function MessageBubble({ message, roomId, onReply, onDeleteMessage, onReportMessage }) {
  const { user } = useAuth();
  const { toggleReaction } = useSocket();
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Internal sender-key distribution/system messages are never rendered.
  if (message.__system === 'sender_key') return null;

  const isSentByMe = message.sender_id === user?.id;
  const reactions = message.reactions || {};

  // Decrypted view of an E2EE message (falls back to raw fields for plaintext).
  const e2ee = Boolean(message.e2ee);
  const bodyText = e2ee ? (message.decryptedText || (message.__undecryptable ? '' : '')) : message.text;
  const mediaType = e2ee ? (message.decryptedType || null) : message.type;
  const mediaUrl = e2ee ? (message.decryptedMediaUrl || null) : (message.media_url || null);
  const mediaKey = e2ee ? (message.decryptedMediaKey || null) : null;
  const mediaNonce = e2ee ? (message.decryptedMediaNonce || null) : null;
  const mediaMime = e2ee ? (message.decryptedMime || null) : null;

  const isReplyToEncrypted = message.reply_to && /"kind"\s*:\s*"msg"/.test(message.reply_to.text || '');

  // WhatsApp-style read receipts: blue double-check once someone else read it
  const readByOthers = (message.read_by || []).some(id => String(id) !== String(user?.id));

  const handleEmojiClick = (emoji) => {
    toggleReaction(message.id, roomId, emoji);
    setShowEmojiPicker(false);
  };

  const handleReport = () => {
    if (!onReportMessage) return;
    const reason = window.prompt('Report this message. Please describe why it should be reviewed:', '');
    if (!reason) return;
    onReportMessage(message.id, reason.trim()).then(ok => {
      if (ok) alert('Thanks! The message has been reported for review.');
    });
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
            <strong style={{ color: 'var(--text-main)' }}>{message.reply_to.sender_name}</strong>: {isReplyToEncrypted ? '🔒 Encrypted message' : message.reply_to.text}
          </div>
        )}

        {/* Undecryptable E2EE placeholder (e.g. key not yet received) */}
        {e2ee && message.__undecryptable && (
          <div style={{ fontSize: '0.85rem', fontStyle: 'italic', color: 'var(--text-muted)' }}>
            {message.__reason === 'auth' ? (
              <span>
                <Lock size={13} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
                This message can't be displayed because it was sent with a different encryption key.
              </span>
            ) : (
              <span><Lock size={13} style={{ verticalAlign: '-2px', marginRight: '4px' }} /> Encrypted message</span>
            )}
          </div>
        )}

        {/* Replay / duplicate message warning */}
        {e2ee && message.__replay && (
          <div style={{ fontSize: '0.8rem', fontStyle: 'italic', color: '#fbbf24', marginBottom: '0.25rem' }}>
            <AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
            This message appears to be a replayed or duplicate copy and is not displayed.
          </div>
        )}

        {/* Encrypted media - fetch + decrypt in the browser */}
        {!message.__undecryptable && mediaUrl && mediaKey && mediaNonce && (
          <DecryptedMedia
            mediaUrl={mediaUrl}
            mediaKey={mediaKey}
            mediaNonce={mediaNonce}
            mime={mediaMime}
            type={mediaType}
            text={bodyText}
          />
        )}

        {/* Plaintext media content (Image Attachment) */}
        {!mediaKey && mediaType === 'image' && mediaUrl && (
          <div style={{ marginBottom: '0.5rem' }}>
            <img
              src={mediaUrl}
              alt="Attachment"
              style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: '12px', display: 'block' }}
            />
          </div>
        )}

        {/* Plaintext Video Attachment */}
        {!mediaKey && mediaType === 'video' && mediaUrl && (
          <div style={{ marginBottom: '0.5rem' }}>
            <video
              src={mediaUrl}
              controls
              style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: '12px', display: 'block' }}
            />
          </div>
        )}

        {/* Plaintext Voice Note Audio Player */}
        {!mediaKey && mediaType === 'audio' && mediaUrl && (
          <VoicePlayer audioUrl={mediaUrl} />
        )}

        {/* Text Body (plaintext + decrypted E2EE messages) */}
        {!mediaUrl && !message.__undecryptable && (
          <div>{bodyText || ''}</div>
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
          {e2ee && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }} title={message.verified ? 'End-to-end encrypted · sender identity verified' : 'End-to-end encrypted'}>
              {message.verified ? (
                <ShieldCheck size={12} style={{ color: '#10b981', verticalAlign: '-2px' }} />
              ) : (
                <Lock size={12} style={{ color: 'var(--text-dim)', verticalAlign: '-2px' }} />
              )}
            </span>
          )}
          <span>{formattedTime}</span>
          {isSentByMe && (
            <CheckCheck size={14} style={{ color: readByOthers ? '#34b7f1' : '#8696a0' }} />
          )}
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
        {!isSentByMe && (
          <button
            className="action-icon-btn"
            style={{ width: '28px', height: '28px', border: 'none', background: 'transparent', color: '#f59e0b' }}
            title="Report message"
            onClick={handleReport}
          >
            <Flag size={14} />
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
