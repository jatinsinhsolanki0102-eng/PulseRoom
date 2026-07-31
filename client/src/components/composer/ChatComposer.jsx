import React, { useState, useRef } from 'react';
import { useSocket } from '../../context/SocketContext';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { Send, Mic, Square, Paperclip, Smile, X, Sparkles } from 'lucide-react';

export default function ChatComposer({ roomId, replyTo, onCancelReply }) {
  const { sendMessage, setTyping } = useSocket();
  const { theme } = useTheme();
  const { token } = useAuth();

  const [text, setText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordTimer, setRecordTimer] = useState(0);
  const [mediaUrl, setMediaUrl] = useState('');
  const [showEmojiDrawer, setShowEmojiDrawer] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerIntervalRef = useRef(null);
  const fileInputRef = useRef(null);

  // Typing debounce timer
  const typingTimeoutRef = useRef(null);

  const handleTextChange = (e) => {
    setText(e.target.value);
    setTyping(roomId, true);

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      setTyping(roomId, false);
    }, 2000);
  };

  const handleSend = () => {
    if (!text.trim() && !mediaUrl) return;

    sendMessage({
      roomId,
      text: text.trim(),
      type: mediaUrl ? (mediaUrl.includes('.webm') || mediaUrl.includes('.ogg') ? 'audio' : 'image') : 'text',
      mediaUrl,
      replyToId: replyTo?.id || null
    });

    setText('');
    setMediaUrl('');
    setTyping(roomId, false);
    if (onCancelReply) onCancelReply();
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
        const formData = new FormData();
        formData.append('file', audioBlob, 'voicenote.webm');

        // Upload voice note
        try {
          const res = await fetch('/api/upload', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
          });
          if (res.ok) {
            const data = await res.json();
            sendMessage({
              roomId,
              text: '🎤 Voice Message',
              type: 'audio',
              mediaUrl: data.mediaUrl,
              replyToId: replyTo?.id || null
            });
            if (onCancelReply) onCancelReply();
          }
        } catch (err) {
          console.error('Failed to upload voice note:', err);
        }
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

  // Image Upload File Handler
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      if (res.ok) {
        const data = await res.json();
        setMediaUrl(data.mediaUrl);
      }
    } catch (err) {
      console.error('File upload failed:', err);
    }
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
            <span style={{ color: 'var(--text-muted)' }}>{replyTo.text}</span>
          </div>
          <button onClick={onCancelReply} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Media Attachment Preview */}
      {mediaUrl && (
        <div style={{ position: 'relative', display: 'inline-block', marginBottom: '0.5rem' }}>
          <img src={mediaUrl} alt="Preview" style={{ width: '80px', height: '80px', borderRadius: '12px', objectFit: 'cover' }} />
          <button
            onClick={() => setMediaUrl('')}
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
          ) : text.trim() || mediaUrl ? (
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
