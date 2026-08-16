import React, { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';

export default function MessageList({
  messages,
  roomId,
  typingUser,
  onReply,
  onEditMessage,
  onDeleteMessage,
  onDeleteForEveryone,
  onForwardMessage,
  onReportMessage,
  onToggleStar,
  highlightQuery,
  searchMode
}) {
  const bottomRef = useRef(null);

  const visibleMessages = (Array.isArray(messages) ? messages : []).filter(m => m && m.__system !== 'sender_key');

  // Only auto-scroll to the newest message when not searching results.
  useEffect(() => {
    if (searchMode) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingUser, searchMode]);

  return (
    <div className="message-feed">
      {visibleMessages.length === 0 ? (
        <div style={{
          margin: 'auto',
          textAlign: 'center',
          color: 'var(--text-dim)',
          background: 'rgba(15, 23, 42, 0.6)',
          padding: '1.5rem 2.5rem',
          borderRadius: '20px',
          border: '1px solid var(--panel-border)'
        }}>
          <h4 style={{ color: 'var(--text-main)', marginBottom: '0.25rem' }}>
            {searchMode ? 'No matching messages' : 'No messages in this room yet'}
          </h4>
          <p style={{ fontSize: '0.85rem' }}>
            {searchMode ? 'Try a different search term.' : 'Send a message or voice note to initiate real-time chat!'}
          </p>
        </div>
      ) : (
        visibleMessages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            roomId={roomId}
            onReply={onReply}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
            onDeleteForEveryone={onDeleteForEveryone}
            onForwardMessage={onForwardMessage}
            onReportMessage={onReportMessage}
            onToggleStar={onToggleStar}
            highlightQuery={highlightQuery}
          />
        ))
      )}

      {/* Live Typing Indicator */}
      {!searchMode && typingUser && (
        <div className="message-row received" style={{ opacity: 0.8 }}>
          <div className="bubble" style={{ fontSize: '0.8rem', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>{typingUser} is typing</span>
            <span style={{ display: 'inline-flex', gap: '2px' }}>
              <span style={{ animation: 'wave 1s infinite' }}>.</span>
              <span style={{ animation: 'wave 1s infinite 0.2s' }}>.</span>
              <span style={{ animation: 'wave 1s infinite 0.4s' }}>.</span>
            </span>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
