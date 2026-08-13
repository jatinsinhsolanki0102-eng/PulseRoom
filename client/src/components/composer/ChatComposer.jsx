import React, { useState, useRef, useEffect } from 'react';
import { useSocket } from '../../context/SocketContext';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useE2EE } from '../../context/E2EEContext';
import { encryptFileBytes } from '../../crypto/e2ee';
import { Send, Mic, Square, Paperclip, Smile, X, Lock, Video } from 'lucide-react';

export default function ChatComposer({ room, roomId, replyTo, onCancelReply }) {
  const { sendMessage, setTyping } = useSocket();
  const { theme } = useTheme();
  const { token } = useAuth();
  const { ready: e2eeReady, encryptForSend, fetchRecipientKey } = useE2EE();

  const [text, setText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordTimer, setRecordTimer] = useState(0);
  const [pendingMedia, setPendingMedia] = useState(null); // { file, type, mime, previewUrl }
  const [showEmojiDrawer, setShowEmojiDrawer] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerIntervalRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoInputRef = useRef(null);

  // Typing debounce timer
  const typingTimeoutRef = useRef(null);

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
    sendMessage({
      roomId,
      text: encrypted.text,
      type: encrypted.type || 'text',
      mediaUrl: encrypted.mediaUrl || '',
      replyToId: replyTo?.id || null,
      e2ee: Boolean(encrypted.e2ee)
    });
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
            sendMessage({
              roomId,
              text: encrypted.text,
              type: encrypted.type,
              mediaUrl: '',
              replyToId: replyTo?.id || null,
              e2ee: true
            });
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
      sendMessage({
        roomId,
        text: textValue || mediaLabel,
        type: media.type,
        mediaUrl: data.mediaUrl,
        replyToId: replyTo?.id || null,
        e2ee: false
      });
    }
  };

  const handleSend = async () => {
    if (!text.trim() && !pendingMedia) return;

    if (pendingMedia) {
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
    if (!file) return;

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
            placeholder="Type your real-time message..."
            value={text}
            onChange={handleTextChange}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
        )}

        <div className="composer-actions">
          {isRecording ? (
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
    </div>
  );
}
