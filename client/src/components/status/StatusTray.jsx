import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { Plus, X, Trash2, ChevronLeft, ChevronRight, Send } from 'lucide-react';

const QUICK_STATUS_EMOJIS = ['❤️', '👍', '😂', '🔥', '🎉', '😮'];

export default function StatusTray({ onOpenCreateStatus, onReplyToStatus }) {
  const { token, user } = useAuth();
  const { socket } = useSocket();
  const [statuses, setStatuses] = useState([]);
  
  // WhatsApp Viewed Statuses Tracking (Persisted in localStorage)
  const [seenStatusIds, setSeenStatusIds] = useState(() => {
    try {
      const saved = localStorage.getItem('pulseroom_seen_statuses');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  // Story Viewer Queue & Index
  const [viewingQueue, setViewingQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [progress, setProgress] = useState(0);

  // Status reactions & replies
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  const progressIntervalRef = useRef(null);

  useEffect(() => {
    if (token) fetchStatuses();
  }, [token]);

  useEffect(() => {
    if (!socket) return;
    const handleNewStatus = (status) => {
      setStatuses(prev => [status, ...prev.filter(s => s.id !== status.id)]);
    };
    const handleStatusDeleted = (statusId) => {
      setStatuses(prev => prev.filter(s => s.id !== statusId));
      setViewingQueue(prev => prev.filter(s => s.id !== statusId));
    };
    const handleStatusReaction = ({ statusId, reactions }) => {
      setStatuses(prev => prev.map(s => (s.id === statusId ? { ...s, reactions } : s)));
      setViewingQueue(prev => prev.map(s => (s.id === statusId ? { ...s, reactions } : s)));
    };

    socket.on('new_status', handleNewStatus);
    socket.on('status_deleted', handleStatusDeleted);
    socket.on('status_reaction', handleStatusReaction);

    return () => {
      socket.off('new_status', handleNewStatus);
      socket.off('status_deleted', handleStatusDeleted);
      socket.off('status_reaction', handleStatusReaction);
    };
  }, [socket]);

  // Save seen statuses to localStorage (capped at 200 max)
  const markStatusSeen = (statusId) => {
    setSeenStatusIds(prev => {
      const arr = Array.from(new Set(prev).add(statusId)).slice(-200);
      const updated = new Set(arr);
      try {
        localStorage.setItem('pulseroom_seen_statuses', JSON.stringify(arr));
      } catch (e) {
        console.warn('LocalStorage save warning:', e);
      }
      return updated;
    });
  };

  const fetchStatuses = async () => {
    try {
      const res = await fetch('/api/statuses', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setStatuses(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch statuses:', err);
    }
  };

  const handleDeleteStatus = async (statusId) => {
    try {
      const res = await fetch(`/api/statuses/${statusId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setStatuses(prev => prev.filter(s => s.id !== statusId));
        closeStoryViewer();
      }
    } catch (err) {
      console.error('Failed to delete status:', err);
    }
  };

  // Toggle a reaction on the currently-viewed status
  const toggleStatusReaction = async (emoji) => {
    if (!activeStatus) return;
    try {
      const res = await fetch(`/api/statuses/${activeStatus.id}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ emoji })
      });
      if (res.ok) {
        const data = await res.json();
        setStatuses(prev => prev.map(s => (s.id === data.id ? { ...s, reactions: data.reactions } : s)));
        setViewingQueue(prev => prev.map(s => (s.id === data.id ? { ...s, reactions: data.reactions } : s)));
      }
    } catch (err) {
      console.error('Failed to react to status:', err);
    }
  };

  // Reply to a status -> opens a DM with the author carrying the status quote
  const submitStatusReply = async () => {
    if (!activeStatus || !replyText.trim() || sendingReply) return;
    setSendingReply(true);
    try {
      const res = await fetch(`/api/statuses/${activeStatus.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reply: replyText.trim() })
      });
      if (res.ok) {
        const data = await res.json();
        const replyMessage = replyText.trim();
        setReplyText('');
        closeStoryViewer();
        if (onReplyToStatus) onReplyToStatus(data.room, replyMessage);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to send reply.');
      }
    } catch (err) {
      console.error('Failed to reply to status:', err);
      alert('Failed to send reply.');
    } finally {
      setSendingReply(false);
    }
  };

  // Group active statuses by User ID for WhatsApp status tray ordering
  const userStatusGroups = React.useMemo(() => {
    const groups = new Map();
    for (const st of statuses) {
      const uid = st.user_id;
      if (!groups.has(uid)) {
        groups.set(uid, []);
      }
      groups.get(uid).push(st);
    }
    return Array.from(groups.entries()).map(([userId, userStatuses]) => {
      const isMine = userId === user?.id;
      const allSeen = userStatuses.every(s => seenStatusIds.has(s.id));
      const latest = userStatuses[0];
      return {
        userId,
        username: latest.username || latest.user?.username || (isMine ? 'My Status' : 'User'),
        avatar_url: latest.avatar_url || latest.user?.avatar_url,
        statuses: userStatuses,
        isMine,
        allSeen
      };
    });
  }, [statuses, seenStatusIds, user]);

  // Open Story Viewer with all statuses ordered (Unseen first, then seen)
  const openStoryViewer = (startStatuses, initialIndex = 0) => {
    // Construct full queue of all user status stories
    let fullQueue = [];
    const targetGroup = startStatuses;
    
    // Put target group first, then all remaining groups
    fullQueue = [...targetGroup];
    for (const group of userStatusGroups) {
      if (group.statuses[0].user_id !== targetGroup[0].user_id) {
        fullQueue.push(...group.statuses);
      }
    }

    setViewingQueue(fullQueue);
    setCurrentIndex(initialIndex);
    setProgress(0);
  };

  const closeStoryViewer = () => {
    setViewingQueue([]);
    setCurrentIndex(0);
    setProgress(0);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
  };

  // Current Active Viewing Status
  const activeStatus = viewingQueue[currentIndex];

  // Auto-fill progress timer & Auto-advance status stories (WhatsApp Style)
  useEffect(() => {
    if (!activeStatus) return;

    // Mark current status as seen
    markStatusSeen(activeStatus.id);

    setProgress(0);
    const startTime = Date.now();
    const duration = activeStatus.media_type === 'video' ? 10000 : 5000;
    const stepTime = 50;
    const increment = (stepTime / duration) * 100;

    progressIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(100, (elapsed / duration) * 100);
      setProgress(pct);

      if (elapsed >= duration) {
        clearInterval(progressIntervalRef.current);
        handleNextStory();
      }
    }, stepTime);

    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, [currentIndex, activeStatus?.id]);

  const handleNextStory = () => {
    if (currentIndex < viewingQueue.length - 1) {
      setCurrentIndex(prev => prev + 1);
      setProgress(0);
    } else {
      closeStoryViewer();
    }
  };

  const handlePrevStory = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
      setProgress(0);
    }
  };

  // WhatsApp My Status Click Handler
  const myGroup = userStatusGroups.find(g => g.isMine);
  const handleMyStatusClick = () => {
    if (myGroup && myGroup.statuses.length > 0) {
      openStoryViewer(myGroup.statuses);
    } else {
      onOpenCreateStatus();
    }
  };

  return (
    <div className="status-tray" style={{
      padding: '0.75rem 1.25rem',
      borderBottom: '1px solid var(--panel-border)',
      background: 'rgba(0,0,0,0.15)'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '0.6rem'
      }}>
        <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          WhatsApp Status Stories
        </span>
        <button
          onClick={onOpenCreateStatus}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--primary-accent)',
            fontSize: '0.75rem',
            fontWeight: '700',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.2rem'
          }}
        >
          <Plus size={14} /> Add Status
        </button>
      </div>

      {/* WhatsApp Status Circles Horizontal Tray */}
      <div className="status-tray-scroll" style={{ display: 'flex', gap: '0.85rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
        
        {/* WhatsApp My Status Circle */}
        <div
          onClick={handleMyStatusClick}
          style={{ textAlign: 'center', cursor: 'pointer', flexShrink: 0 }}
          title={myGroup?.statuses.length > 0 ? "View My WhatsApp Status Story" : "Add New Status Story"}
        >
          <div style={{
            position: 'relative',
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            padding: '2px',
            background: myGroup
              ? (myGroup.allSeen ? '#475569' : 'linear-gradient(135deg, #10b981, #06b6d4, #a855f7)')
              : 'transparent',
            border: myGroup ? 'none' : '2px dashed var(--primary-accent)',
            boxShadow: myGroup && !myGroup.allSeen ? '0 0 12px rgba(16, 185, 129, 0.4)' : 'none'
          }}>
            <img
              src={user?.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${user?.username}`}
              alt="My Status"
              style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', background: '#0f172a' }}
            />
            {(!myGroup || myGroup.statuses.length === 0) && (
              <Plus size={14} style={{ position: 'absolute', bottom: '0', right: '0', color: 'white', background: 'var(--primary-accent)', borderRadius: '50%', border: '2px solid #0f172a' }} />
            )}
          </div>
          <span style={{ fontSize: '0.7rem', display: 'block', marginTop: '0.25rem', color: 'var(--text-main)', fontWeight: '600' }}>
            My Status
          </span>
        </div>

        {/* Other Users' WhatsApp Status Stories */}
        {userStatusGroups.filter(g => !g.isMine).map(group => {
          return (
            <div
              key={group.userId}
              onClick={() => openStoryViewer(group.statuses)}
              style={{ textAlign: 'center', cursor: 'pointer', flexShrink: 0 }}
              title={`${group.username} (${group.statuses.length} status${group.statuses.length > 1 ? 'es' : ''})`}
            >
              <div style={{
                position: 'relative',
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                padding: '2.5px',
                // Unseen = Glowing WhatsApp Green ring; Viewed = Gray ring
                background: group.allSeen
                  ? '#475569'
                  : 'linear-gradient(135deg, #10b981, #06b6d4, #a855f7)',
                boxShadow: group.allSeen ? 'none' : '0 0 12px rgba(16, 185, 129, 0.5)',
                transition: 'all 0.3s ease'
              }}>
                <img
                  src={group.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${group.username}`}
                  alt={group.username}
                  style={{ width: '100%', height: '100%', borderRadius: '50%', background: '#0f172a', objectFit: 'cover' }}
                />
              </div>
              <span style={{
                fontSize: '0.7rem',
                display: 'block',
                marginTop: '0.25rem',
                color: group.allSeen ? 'var(--text-muted)' : 'var(--text-main)',
                maxWidth: '56px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: group.allSeen ? '500' : '700'
              }}>
                {group.username}
              </span>
            </div>
          );
        })}
      </div>

      {/* WhatsApp Fullscreen Auto-Advancing Story Viewer Modal */}
      {activeStatus && (
        <div className="modal-overlay" onClick={closeStoryViewer}>
          <div
            className="modal-content glass-panel"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '400px',
              width: '100%',
              height: 'min(580px, 82dvh)',
              background: activeStatus.bg_color || '#128c7e',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              position: 'relative',
              borderRadius: '24px',
              overflowY: 'auto',
              overflowX: 'hidden',
              userSelect: 'none',
              scrollbarWidth: 'thin'
            }}
          >
            {/* Top Multi-Segment WhatsApp Progress Bars */}
            <div style={{
              display: 'flex',
              gap: '4px',
              padding: '10px 12px 0 12px',
              zIndex: 20
            }}>
              {viewingQueue.map((st, idx) => {
                let barWidth = 0;
                if (idx < currentIndex) barWidth = 100;
                else if (idx === currentIndex) barWidth = progress;
                else barWidth = 0;

                return (
                  <div
                    key={st.id || idx}
                    style={{
                      flex: 1,
                      height: '3px',
                      background: 'rgba(255,255,255,0.3)',
                      borderRadius: '2px',
                      overflow: 'hidden'
                    }}
                  >
                    <div style={{
                      width: `${barWidth}%`,
                      height: '100%',
                      background: '#ffffff',
                      transition: idx === currentIndex ? 'width 50ms linear' : 'none'
                    }} />
                  </div>
                );
              })}
            </div>

            {/* Header with User Info & Actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 20, padding: '8px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <img
                  src={activeStatus.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${activeStatus.username}`}
                  alt=""
                  style={{ width: '38px', height: '38px', borderRadius: '50%', objectFit: 'cover', border: '1.5px solid white' }}
                />
                <div>
                  <span style={{ fontWeight: '700', color: 'white', display: 'block', fontSize: '0.95rem' }}>
                    {activeStatus.username || activeStatus.user?.username || 'User'}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.75)' }}>
                    {new Date(activeStatus.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {activeStatus.user_id === user?.id && (
                  <>
                    <button
                      onClick={() => { closeStoryViewer(); onOpenCreateStatus(); }}
                      style={{ background: 'rgba(255, 255, 255, 0.2)', border: 'none', color: 'white', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      title="Add Another Status"
                    >
                      <Plus size={18} />
                    </button>
                    <button
                      onClick={() => handleDeleteStatus(activeStatus.id)}
                      style={{ background: 'rgba(239, 68, 68, 0.3)', border: 'none', color: 'white', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      title="Delete Status"
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
                <button onClick={closeStoryViewer} style={{ background: 'rgba(0,0,0,0.2)', border: 'none', color: 'white', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Clickable Tap Zones (Left 30% = Previous, Right 70% = Next) */}
            <div
              onClick={handlePrevStory}
              style={{ position: 'absolute', top: '60px', left: 0, width: '30%', height: 'calc(100% - 100px)', zIndex: 15, cursor: 'pointer' }}
            />
            <div
              onClick={handleNextStory}
              style={{ position: 'absolute', top: '60px', right: 0, width: '70%', height: 'calc(100% - 100px)', zIndex: 15, cursor: 'pointer' }}
            />

            {/* Media Content (Photo, Video, or Text) */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '0 1rem', zIndex: 10 }}>
              {activeStatus.media_url ? (
                activeStatus.media_type === 'video' ? (
                  <video src={activeStatus.media_url} controls autoPlay style={{ width: '100%', maxHeight: 'min(360px, 38dvh)', objectFit: 'contain', borderRadius: '16px' }} />
                ) : (
                  <img src={activeStatus.media_url} alt="Story Media" style={{ width: '100%', maxHeight: 'min(360px, 38dvh)', objectFit: 'contain', borderRadius: '16px' }} />
                )
              ) : null}

              {activeStatus.text && (
                <div style={{ textAlign: 'center', padding: '1rem 0', fontSize: '1.25rem', fontWeight: '700', color: 'white', textShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
                  {activeStatus.text}
                </div>
              )}
            </div>

            {/* Status Reactions Display */}
            {activeStatus.reactions && Object.keys(activeStatus.reactions).length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '0.4rem', zIndex: 20, padding: '0 16px 4px' }}>
                {Object.entries(activeStatus.reactions).map(([emoji, userIds]) => (
                  <button
                    key={emoji}
                    onClick={() => toggleStatusReaction(emoji)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      background: (userIds || []).includes(user?.id) ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.25)',
                      border: (userIds || []).includes(user?.id) ? '1.5px solid #ffffff' : '1px solid rgba(255,255,255,0.45)',
                      borderRadius: '99px',
                      padding: '0.25rem 0.7rem',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '0.85rem'
                    }}
                  >
                    <span>{emoji}</span>
                    <span style={{ fontWeight: '700' }}>{userIds.length}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Status Quick Reaction Bar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', zIndex: 20, padding: '8px 16px 6px' }}>
              {QUICK_STATUS_EMOJIS.map(emoji => (
                <button
                  key={emoji}
                  onClick={() => toggleStatusReaction(emoji)}
                  title="React to status"
                  style={{
                    background: 'rgba(0,0,0,0.25)',
                    border: 'none',
                    borderRadius: '50%',
                    width: '34px',
                    height: '34px',
                    fontSize: '1.05rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'transform 0.15s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.15)'}
                  onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                >
                  {emoji}
                </button>
              ))}
            </div>

            {/* Status Reply Box (only for others' statuses) */}
            {activeStatus.user_id !== user?.id && (
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0 16px 10px', zIndex: 20 }}>
                <input
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitStatusReply()}
                  placeholder="Reply to this status..."
                  style={{
                    flex: 1,
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.45)',
                    borderRadius: '99px',
                    padding: '0.5rem 0.9rem',
                    color: 'white',
                    outline: 'none',
                    fontSize: '0.85rem'
                  }}
                />
                <button
                  onClick={submitStatusReply}
                  disabled={!replyText.trim() || sendingReply}
                  title="Send reply"
                  style={{
                    background: 'linear-gradient(135deg, #10b981, #06b6d4)',
                    border: 'none',
                    borderRadius: '99px',
                    color: 'white',
                    width: '38px',
                    height: '38px',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: replyText.trim() && !sendingReply ? 'pointer' : 'not-allowed',
                    opacity: replyText.trim() && !sendingReply ? 1 : 0.5
                  }}
                >
                  <Send size={16} />
                </button>
              </div>
            )}

            {/* Bottom Footer Navigator Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', zIndex: 20, background: 'rgba(0,0,0,0.15)' }}>
              <button
                onClick={handlePrevStory}
                disabled={currentIndex === 0}
                style={{ background: 'none', border: 'none', color: currentIndex === 0 ? 'rgba(255,255,255,0.3)' : 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '2px', fontSize: '0.8rem' }}
              >
                <ChevronLeft size={18} /> Previous
              </button>

              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.7)' }}>
                {currentIndex + 1} of {viewingQueue.length}
              </span>

              <button
                onClick={handleNextStory}
                style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '2px', fontSize: '0.8rem' }}
              >
                Next <ChevronRight size={18} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
