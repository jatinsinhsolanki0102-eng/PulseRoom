import React, { useState, useRef, useEffect } from 'react';
import { useSocket } from '../../context/SocketContext';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useE2EE } from '../../context/E2EEContext';
import { encryptFileBytes } from '../../crypto/e2ee';
import EmojiPicker from './EmojiPicker';
import { Send, Mic, Square, Paperclip, Smile, X, Lock, Video, Clock } from 'lucide-react';

export default function ChatComposer({ room, roomId, replyTo, onCancelReply, editingMessage, onCancelEdit, onEditSubmit, onSchedule, onMessageDelivered }) {
  const { sendMessage, setTyping } = useSocket();
  const { theme } = useTheme();
  const { token } = useAuth();
  const { ready: e2eeReady, encryptForSend, fetchRecipientKey } = useE2EE();

  const [text, setText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordTimer, setRecordTimer] = useState(0);
  const [pendingMedia, setPendingMedia] = useState(null); // { file, type, mime, previewUrl }
  const [showEmojiDrawer, setShowEmojiDrawer] = useState(false);
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerIntervalRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const composerInputRef = useRef(null);

  // Typing debounce timer
  const typingTimeoutRef = useRef(null);

  // Preload the message being edited into the composer
  useEffect(() => {
    if (editingMessage) {
      setText(editingMessage.decryptedText || editingMessage.text || '');
    }
  }, [editingMessage?.id]);

  // Revoke object URLs when a pending media preview is replaced/removed
  useEffect(() => {
    return () => {
      if (pendingMedia?.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
    };
  }, [pendingMedia]);

  const handleTextChange = (e) => {
    setText(e.target.value);
    setTyping(roomId, true);

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      setTyping(roomId, false);
    }, 2000);
  };

  const resetComposer = () => {
    setText('');
    if (pendingMedia?.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
    setPendingMedia(null);
    setTyping(roomId, false);
    if (onCancelReply) onCancelReply();
    if (onCancelEdit) onCancelEdit();
  };

  // Can we encrypt media? 1:1 needs the partner's identity key; groups need our keys ready.
  const canEncryptMedia = async () => {
    if (room?.type === 'private') {
      const key = await fetchRecipientKey(room.partner?.id);
      return Boolean(key && key.public_key);
    }
    return Boolean(e2eeReady);
  };

  const sendTextMessage = async (textValue) => {
    const inner = {
      text: textValue,
      type: 'text'
    };
    const encrypted = await encryptForSend(room, inner);
    const delivered = await sendMessage({
      roomId,
      text: encrypted.text,
      type: encrypted.type || 'text',
      mediaUrl: encrypted.mediaUrl || '',
      replyToId: replyTo?.id || null,
      e2ee: Boolean(encrypted.e2ee)
    });
    if (delivered && onMessageDelivered) onMessageDelivered(delivered);
  };

  const sendMediaMessage = async (textValue, media) => {
    // WhatsApp-style: encrypt the file bytes client-side, then upload ONLY the
    // ciphertext. The media key/nonce travel inside the E2EE message envelope.
    const useEncryption = await canEncryptMedia();
    const mediaLabel = media.type === 'audio' ? 'Voice Message' : media.type === 'video' ? 'Video' : 'Photo';

    if (useEncryption) {
      try {
        const fileBytes = await media.file.arrayBuffer();
        const enc = await encryptFileBytes(fileBytes);
        const formData = new FormData();
        formData.append('file', new Blob([enc.cipher], { type: 'application/octet-stream' }), `encrypted_${media.file.name || 'media.bin'}`);
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData
        });
        if (res.ok) {
          const data = await res.json();
          const inner = {
            text: textValue || mediaLabel,
            type: media.type,
            mediaUrl: data.mediaUrl,
            mediaKey: enc.key,
            mediaNonce: enc.nonce,
            mime: media.mime || 'application/octet-stream'
          };
          const encrypted = await encryptForSend(room, inner);
          if (encrypted.e2ee) {
            const delivered = await sendMessage({
              roomId,
              text: encrypted.text,
              type: encrypted.type,
              mediaUrl: '',
              replyToId: replyTo?.id || null,
              e2ee: true
            });
            if (delivered && onMessageDelivered) onMessageDelivered(delivered);
            return;
          }
        }
      } catch (err) {
        console.warn('E2EE media send failed, falling back to plaintext:', err.message);
      }
    }

    // Plaintext media path (used when the recipient is not E2EE-capable yet)
    const formData = new FormData();
    formData.append('file', media.file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    if (res.ok) {
      const data = await res.json();
      const delivered = await sendMessage({
        roomId,
        text: textValue || mediaLabel,
        type: media.type,
        mediaUrl: data.mediaUrl,
        replyToId: replyTo?.id || null,
        e2ee: false
      });
      if (delivered && onMessageDelivered) onMessageDelivered(delivered);
    }
  };

  // Prepare a scheduled payload: media is encrypted + uploaded NOW, but nothing
  // is sent. The scheduler re-encrypts a fresh envelope when the time arrives.
  const prepareScheduledPayload = async (textValue, mediaObj) => {
    let mediaUrl = '';
    let mediaKey = null;
    let mediaNonce = null;
    let mime = mediaObj?.mime || '';
    let mediaType = mediaObj?.type || 'text';

    if (mediaObj) {
      if (await canEncryptMedia()) {
        try {
          const fileBytes = await mediaObj.file.arrayBuffer();
          const enc = await encryptFileBytes(fileBytes);
          const formData = new FormData();
          formData.append('file', new Blob([enc.cipher], { type: 'application/octet-stream' }), `encrypted_${mediaObj.file.name || 'media.bin'}`);
          const res = await fetch('/api/upload', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
          });
          if (res.ok) {
            const data = await res.json();
            mediaUrl = data.mediaUrl;
            mediaKey = enc.key;
            mediaNonce = enc.nonce;
            mime = mediaObj.mime || 'application/octet-stream';
          }
        } catch (err) {
          console.warn('E2EE scheduled media upload failed, using plaintext:', err.message);
        }
      }
      if (!mediaUrl) {
        const formData = new FormData();
        formData.append('file', mediaObj.file);
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData
        });
        if (res.ok) {
          const data = await res.json();
          mediaUrl = data.mediaUrl;
          mediaType = data.mediaType || mediaObj.type;
        }
      }
    }

    return { text: textValue, mediaUrl, mediaKey, mediaNonce, mime, mediaType };
  };

  const handleScheduleConfirm = async () => {
    if (!scheduleTime) return;
    const when = new Date(scheduleTime);
    if (isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      alert('Please pick a future time for the scheduled message.');
      return;
    }
    if (!text.trim() && !pendingMedia) return;
    if (!onSchedule) return;
    try {
      const payload = await prepareScheduledPayload(text.trim(), pendingMedia || undefined);
      onSchedule({
        ...payload,
        scheduledAt: when.toISOString(),
        roomId,
        roomType: room?.type || 'group',
        partnerId: room?.type === 'private' ? room?.partner?.id : null
      });
      if (pendingMedia?.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
      setPendingMedia(null);
      setScheduleTime('');
      setShowSchedulePicker(false);
      resetComposer();
    } catch (err) {
      console.error('Schedule error:', err);
      alert('Failed to schedule the message.');
    }
  };

  const handleSend = async () => {
    if (!text.trim() && !pendingMedia) return;

    if (editingMessage) {
      if (!text.trim()) return;
      await onEditSubmit(editingMessage, text.trim());
    } else if (pendingMedia) {
      await sendMediaMessage(text.trim(), pendingMedia);
    } else {
      await sendTextMessage(text.trim());
    }

    resetComposer();
  };

  // Handle Voice Note Recording via Web Audio API
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const audioFile = new File([audioBlob], 'voicenote.webm', { type: 'audio/webm' });
        await sendMediaMessage('', { file: audioFile, type: 'audio', mime: 'audio/webm' });
        resetComposer();
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setRecordTimer(0);
      timerIntervalRef.current = setInterval(() => {
        setRecordTimer(prev => prev + 1);
      }, 1000);
    } catch (err) {
      alert('Microphone access is required to record voice notes.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
      clearInterval(timerIntervalRef.current);
    }
  };

  // Media Upload File Handler (image via paperclip, video via the video button)
  const handleFileUpload = (e, mediaType) => {
    const file = e.target.files[0];
    if (!file || editingMessage) return;

    const resolvedType = mediaType
      || (file.type.startsWith('video/') ? 'video'
        : file.type.startsWith('audio/') ? 'audio'
        : 'image');

    if (pendingMedia?.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
    setPendingMedia({
      file,
      type: resolvedType,
      mime: file.type
        || (resolvedType === 'video' ? 'video/mp4'
          : resolvedType === 'audio' ? 'audio/webm'
          : 'image/jpeg'),
      previewUrl: URL.createObjectURL(file)
    });
    e.target.value = '';
  };

  const shapeClass = `composer-shape-${theme.chatBarShape || 'floating-pill'}`;
  const sendBtnClass = `send-btn-${theme.sendButtonStyle || 'gradient-circle'}`;

  const insertEmoji = (emoji) => {
    const el = composerInputRef.current;
    if (el) {
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? text.length;
      const next = text.slice(0, start) + emoji + text.slice(end);
      setText(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + emoji.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      setText(prev => (prev ? prev + emoji : emoji));
    }
    setShowEmojiDrawer(false);
  };

  return (
    <div className="composer-wrapper">
      {/* Quick Reply Chips Bar */}
      <div className="quick-chips-bar">
        {['👋 Hello', '🚀 Sounds great!', '👍 Got it', '🔥 Awesome'].map(chip => (
          <button
            key={chip}
            className="chip-btn"
            onClick={() => setText(prev => (prev ? `${prev} ${chip}` : chip))}
          >
            {chip}
          </button>
        ))}
      </div>

      {/* Editing Message Header */}
      {editingMessage && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(56, 189, 248, 0.15)',
          borderLeft: '3px solid #38bdf8',
          padding: '0.5rem 1rem',
          borderRadius: '10px',
          marginBottom: '0.5rem',
          fontSize: '0.85rem'
        }}>
          <div>
            <span style={{ fontWeight: '700', color: '#38bdf8' }}>Editing message: </span>
            <span style={{ color: 'var(--text-muted)' }}>
              {editingMessage.decryptedText || (editingMessage.e2ee ? '🔒 Encrypted message' : editingMessage.text)}
            </span>
          </div>
          <button onClick={onCancelEdit} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Reply Thread Header */}
      {replyTo && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(99, 102, 241, 0.15)',
          borderLeft: '3px solid var(--primary-accent)',
          padding: '0.5rem 1rem',
          borderRadius: '10px',
          marginBottom: '0.5rem',
          fontSize: '0.85rem'
        }}>
          <div>
            <span style={{ fontWeight: '700', color: 'var(--primary-accent)' }}>Replying to {replyTo.sender_name}: </span>
            <span style={{ color: 'var(--text-muted)' }}>
              {replyTo.decryptedText || (replyTo.e2ee ? '🔒 Encrypted message' : replyTo.text)}
            </span>
          </div>
          <button onClick={onCancelReply} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Media Attachment Preview */}
      {pendingMedia && (
        <div style={{ position: 'relative', display: 'inline-block', marginBottom: '0.5rem' }}>
          {pendingMedia.type === 'video' ? (
            <video
              src={pendingMedia.previewUrl}
              muted
              controls
              style={{ width: '140px', height: '80px', borderRadius: '12px', objectFit: 'cover', background: '#000' }}
            />
          ) : (
            <img src={pendingMedia.previewUrl} alt="Preview" style={{ width: '80px', height: '80px', borderRadius: '12px', objectFit: 'cover' }} />
          )}
          <div style={{ position: 'absolute', bottom: '-6px', right: '-6px', background: '#0f172a', border: '1px solid var(--panel-border)', borderRadius: '50%', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a855f7' }} title="Will be end-to-end encrypted">
            <Lock size={11} />
          </div>
          <button
            onClick={() => {
              if (pendingMedia.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
              setPendingMedia(null);
            }}
            style={{ position: 'absolute', top: '-6px', right: '-6px', background: '#ef4444', border: 'none', borderRadius: '50%', color: 'white', width: '20px', height: '20px', cursor: 'pointer' }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Schedule Message Picker */}
      {showSchedulePicker && (
        <div className="schedule-picker glass-panel">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-main)' }}>
              <Clock size={14} /> Schedule Message
            </span>
            <button
              onClick={() => setShowSchedulePicker(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              <X size={14} />
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="datetime-local"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              style={{
                flex: 1,
                padding: '0.45rem 0.6rem',
                borderRadius: '10px',
                border: '1px solid var(--panel-border)',
                background: 'rgba(15,23,42,0.8)',
                color: 'var(--text-main)',
                fontSize: '0.85rem'
              }}
            />
            <button
              onClick={handleScheduleConfirm}
              disabled={!scheduleTime}
              style={{
                padding: '0.45rem 0.9rem',
                borderRadius: '10px',
                border: 'none',
                background: 'linear-gradient(135deg, #6366f1, #a855f7)',
                color: 'white',
                fontWeight: '700',
                cursor: scheduleTime ? 'pointer' : 'not-allowed',
                opacity: scheduleTime ? 1 : 0.5,
                fontSize: '0.85rem'
              }}
            >
              Schedule
            </button>
          </div>
          <p style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
            The message (and any attachment) is encrypted on your device and sent automatically at the selected time.
          </p>
        </div>
      )}

      {/* Dynamic Composer Shape Container */}
      <div className={shapeClass}>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          accept="image/*"
          style={{ display: 'none' }}
        />

        <input
          type="file"
          ref={videoInputRef}
          onChange={(e) => handleFileUpload(e, 'video')}
          accept="video/*"
          style={{ display: 'none' }}
        />

        {!editingMessage && (
          <>
            <button
              className="action-icon-btn"
              style={{ border: 'none', background: 'transparent' }}
              onClick={() => fileInputRef.current?.click()}
              title="Attach Image"
            >
              <Paperclip size={20} />
            </button>

            <button
              className="action-icon-btn"
              style={{ border: 'none', background: 'transparent' }}
              onClick={() => videoInputRef.current?.click()}
              title="Attach Video"
            >
              <Video size={20} />
            </button>

            <button
              className="action-icon-btn"
              style={{ border: 'none', background: 'transparent' }}
              onClick={() => setShowSchedulePicker(!showSchedulePicker)}
              title="Schedule message"
            >
              <Clock size={20} />
            </button>
          </>
        )}

        <button
          className="action-icon-btn"
          style={{ border: 'none', background: 'transparent' }}
          onClick={() => setShowEmojiDrawer(!showEmojiDrawer)}
          title="Emoji"
        >
          <Smile size={20} />
        </button>

        {isRecording ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#ef4444', fontWeight: '700' }}>
            <span style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ef4444', animation: 'pulse 1s infinite' }} />
            <span>Recording Voice Note... {recordTimer}s</span>
          </div>
        ) : (
          <input
            type="text"
            className="composer-input"
            ref={composerInputRef}
            placeholder={editingMessage ? 'Edit your message...' : 'Type your real-time message...'}
            value={text}
            onChange={handleTextChange}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
        )}

        <div className="composer-actions">
          {editingMessage ? (
            <button className={sendBtnClass} onClick={handleSend} title="Save changes">
              <Send size={18} />
            </button>
          ) : isRecording ? (
            <button className="send-btn-gradient-circle" style={{ background: '#ef4444' }} onClick={stopRecording}>
              <Square size={18} />
            </button>
          ) : text.trim() || pendingMedia ? (
            <button className={sendBtnClass} onClick={handleSend}>
              <Send size={18} />
            </button>
          ) : (
            <button className={sendBtnClass} onClick={startRecording} title="Hold to record voice note">
              <Mic size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Emoji Picker Drawer */}
      {showEmojiDrawer && (
        <EmojiPicker
          onPick={insertEmoji}
          onClose={() => setShowEmojiDrawer(false)}
        />
      )}
    </div>
  );
}
