import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useE2EE } from '../../context/E2EEContext';
import { X, Pin, Users, Trash2, Eraser, UserPlus, Image as ImageIcon, Shield, Heart, Timer, Ban, ShieldOff, ShieldCheck, Star, Clock, Bell, BellOff, Pencil, LogOut, UserX, Crown, Archive, Mail } from 'lucide-react';
import AddMembersModal from '../groups/AddMembersModal';
import EditGroupModal from '../groups/EditGroupModal';

const DISAPPEARING_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 24 * 3600, label: '24 hours' },
  { value: 7 * 24 * 3600, label: '7 days' },
  { value: 90 * 24 * 3600, label: '90 days' }
];

export default function ChatInfoDrawer({ room, onClose, onTogglePin, onToggleMute, onToggleArchive, onToggleUnread, onDeleteChat, onClearChat, onMembersAdded, onBlockUser, onOpenGallery, onOpenStarred, onOpenScheduled, onRoomChanged, onLeaveGroup }) {
  const { user, token } = useAuth();
  const { fetchRecipientKey } = useE2EE();
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [showEditGroup, setShowEditGroup] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [disappearing, setDisappearing] = useState(room?.disappearing_seconds || 0);
  const [savingTimer, setSavingTimer] = useState(false);
  const [verification, setVerification] = useState(null); // null | true | false | 'legacy'
  const [isMuted, setIsMuted] = useState(Boolean(room?.is_muted));
  const [busyMemberId, setBusyMemberId] = useState(null);

  useEffect(() => {
    setDisappearing(room?.disappearing_seconds || 0);
    setIsMuted(Boolean(room?.is_muted));
  }, [room?.id]);

  useEffect(() => {
    let cancelled = false;
    setVerification(null);
    if (room?.type === 'private' && room.partner?.id) {
      fetchRecipientKey(room.partner.id).then(key => {
        if (cancelled) return;
        if (!key?.public_key) setVerification(null);
        else if (key.verified === true) setVerification(true);
        else if (key.verified === false) setVerification(false);
        else setVerification('legacy');
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [room?.id, room?.type, room?.partner?.id, fetchRecipientKey]);

  if (!room) return null;

  const isPrivate = room.type === 'private';
  const name = isPrivate ? room.partner?.username || 'Private Chat' : room.name || 'Group Room';
  const avatar = isPrivate ? room.partner?.avatar_url : room.avatar_url;
  const bio = isPrivate ? room.partner?.bio : room.description;

  const handleDelete = () => {
    if (confirmDelete) {
      onDeleteChat();
    } else {
      setConfirmDelete(true);
    }
  };

  const handleClear = () => {
    if (confirmClear) {
      onClearChat();
      setConfirmClear(false);
    } else {
      setConfirmClear(true);
    }
  };

  const handleBlock = () => {
    if (confirmBlock) {
      if (onBlockUser) onBlockUser();
    } else {
      setConfirmBlock(true);
    }
  };

  const handleToggleMute = async () => {
    const target = !isMuted;
    try {
      const res = await fetch(`/api/rooms/${room.id}/mute`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setIsMuted(Boolean(data.is_muted));
        if (onToggleMute) onToggleMute(room.id, Boolean(data.is_muted));
      }
    } catch (err) {
      console.error('Failed to toggle mute:', err);
    }
  };

  const handleSetDisappearing = async (seconds) => {
    setSavingTimer(true);
    try {
      const res = await fetch(`/api/rooms/${room.id}/disappearing`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ seconds })
      });
      if (res.ok) {
        setDisappearing(seconds);
      }
    } catch (err) {
      console.error('Failed to update disappearing timer:', err);
    } finally {
      setSavingTimer(false);
    }
  };

  const handleRoleChange = async (member, newRole) => {
    setBusyMemberId(member.id);
    try {
      const res = await fetch(`/api/rooms/${room.id}/members/${member.id}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: newRole })
      });
      if (res.ok) {
        if (onRoomChanged) onRoomChanged();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to update role.');
      }
    } catch (err) {
      console.error('Failed to update role:', err);
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleRemoveMember = async (member) => {
    if (!window.confirm(`Remove ${member.username} from this group?`)) return;
    setBusyMemberId(member.id);
    try {
      const res = await fetch(`/api/rooms/${room.id}/members/${member.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        if (onRoomChanged) onRoomChanged();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to remove member.');
      }
    } catch (err) {
      console.error('Failed to remove member:', err);
    } finally {
      setBusyMemberId(null);
    }
  };

  const handleLeaveGroup = () => {
    if (window.confirm(`Leave "${room.name || 'this group'}"? You can be re-added by an admin later.`)) {
      if (onLeaveGroup) onLeaveGroup();
    }
  };

  const isGroupAdmin = !isPrivate && room.role === 'admin';

  return (
    <div className="chat-info-drawer" style={{
      width: '320px',
      height: '100%',
      borderLeft: '1px solid var(--panel-border)',
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(20px)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 10,
      animation: 'slideIn 0.25s ease-out'
    }}>
      {/* Header */}
      <div style={{
        padding: '1.25rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--panel-border)'
      }}>
        <span style={{ fontWeight: '700', fontSize: '1rem', color: 'var(--text-main)' }}>Chat Details</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={20} />
        </button>
      </div>

      {/* Profile Overview */}
      <div style={{ padding: '1.5rem', textAlign: 'center', borderBottom: '1px solid var(--panel-border)' }}>
        <img
          src={avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`}
          alt={name}
          style={{ width: '84px', height: '84px', borderRadius: '24px', margin: '0 auto 0.75rem', objectFit: 'cover' }}
        />
        <h3 style={{ fontFamily: 'Outfit', fontWeight: '700', fontSize: '1.25rem', color: 'var(--text-main)' }}>{name}</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{bio || 'No description provided'}</p>

        <div className="chip-action-row" style={{
          display: 'flex',
          gap: '0.5rem',
          marginTop: '1rem',
          overflowX: 'auto',
          overflowY: 'hidden',
          flexWrap: 'nowrap',
          justifyContent: 'flex-start',
          padding: '0 0 0.4rem',
          scrollbarWidth: 'thin',
          WebkitOverflowScrolling: 'touch'
        }}>
          <button
            onClick={onTogglePin}
            className="chip-btn"
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '99px',
              background: room.is_pinned ? 'var(--primary-accent)' : 'rgba(255,255,255,0.06)',
              color: room.is_pinned ? 'white' : 'var(--text-main)',
              fontWeight: '600',
              flex: '0 0 auto',
              whiteSpace: 'nowrap'
            }}
          >
            <Pin size={14} style={{ display: 'inline', marginRight: '4px' }} />
            {room.is_pinned ? 'Unpin Chat' : 'Pin Chat'}
          </button>

          <button
            onClick={handleToggleMute}
            className="chip-btn"
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '99px',
              background: isMuted ? 'var(--primary-accent)' : 'rgba(255,255,255,0.06)',
              color: isMuted ? 'white' : 'var(--text-main)',
              fontWeight: '600',
              flex: '0 0 auto',
              whiteSpace: 'nowrap'
            }}
          >
            {isMuted
              ? <BellOff size={14} style={{ display: 'inline', marginRight: '4px' }} />
              : <Bell size={14} style={{ display: 'inline', marginRight: '4px' }} />}
            {isMuted ? 'Unmute' : 'Mute'}
          </button>

          <button
            onClick={() => onToggleArchive(room.id)}
            className="chip-btn"
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '99px',
              background: room.is_archived ? 'var(--primary-accent)' : 'rgba(255,255,255,0.06)',
              color: room.is_archived ? 'white' : 'var(--text-main)',
              fontWeight: '600',
              flex: '0 0 auto',
              whiteSpace: 'nowrap'
            }}
          >
            <Archive size={14} style={{ display: 'inline', marginRight: '4px' }} />
            {room.is_archived ? 'Unarchive' : 'Archive'}
          </button>

          <button
            onClick={() => onToggleUnread(room.id)}
            className="chip-btn"
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '99px',
              background: room.is_unread ? 'var(--primary-accent)' : 'rgba(255,255,255,0.06)',
              color: room.is_unread ? 'white' : 'var(--text-main)',
              fontWeight: '600',
              flex: '0 0 auto',
              whiteSpace: 'nowrap'
            }}
          >
            <Mail size={14} style={{ display: 'inline', marginRight: '4px' }} />
            {room.is_unread ? 'Mark as read' : 'Mark as unread'}
          </button>

          {isGroupAdmin && (
            <button
              onClick={() => setShowAddMembers(true)}
              className="chip-btn"
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '99px',
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--text-main)',
                fontWeight: '600',
                flex: '0 0 auto',
                whiteSpace: 'nowrap'
              }}
            >
              <UserPlus size={14} style={{ display: 'inline', marginRight: '4px' }} />
              Add Members
            </button>
          )}

          {isPrivate && (
            <button
              onClick={handleBlock}
              className="chip-btn"
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '99px',
                background: confirmBlock ? '#ef4444' : 'rgba(255,255,255,0.06)',
                color: confirmBlock ? 'white' : '#f87171',
                fontWeight: '600',
                flex: '0 0 auto',
                whiteSpace: 'nowrap'
              }}
            >
              {confirmBlock ? <ShieldOff size={14} style={{ display: 'inline', marginRight: '4px' }} /> : <Ban size={14} style={{ display: 'inline', marginRight: '4px' }} />}
              {confirmBlock ? 'Confirm Block?' : 'Block User'}
            </button>
          )}

          <button
            onClick={handleClear}
            className="chip-btn"
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '99px',
              background: confirmClear ? '#f59e0b' : 'rgba(255,255,255,0.06)',
              color: confirmClear ? 'white' : '#fbbf24',
              fontWeight: '600',
              flex: '0 0 auto',
              whiteSpace: 'nowrap'
            }}
          >
            <Eraser size={14} style={{ display: 'inline', marginRight: '4px' }} />
            {confirmClear ? 'Confirm Clear?' : 'Clear Chat'}
          </button>

          <button
            onClick={handleDelete}
            className="chip-btn"
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '99px',
              background: confirmDelete ? '#ef4444' : 'rgba(255,255,255,0.06)',
              color: confirmDelete ? 'white' : '#f87171',
              fontWeight: '600',
              flex: '0 0 auto',
              whiteSpace: 'nowrap'
            }}
          >
            <Trash2 size={14} style={{ display: 'inline', marginRight: '4px' }} />
            {confirmDelete ? 'Confirm Delete?' : 'Delete Chat'}
          </button>
        </div>

        {confirmClear && (
          <p style={{ fontSize: '0.75rem', color: '#fbbf24', marginTop: '0.6rem' }}>
            This clears all messages for you only. Others in the chat will not be affected.
          </p>
        )}
        {confirmDelete && (
          <p style={{ fontSize: '0.75rem', color: '#f87171', marginTop: '0.6rem' }}>
            This removes the chat from your account only. Other people will still see it.
          </p>
        )}
        {confirmBlock && (
          <p style={{ fontSize: '0.75rem', color: '#f87171', marginTop: '0.6rem' }}>
            They will no longer be able to message you or see your online status.
          </p>
        )}
      </div>

      {/* End-to-End Encryption Banner */}
      <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--panel-border)' }}>
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.6rem',
          padding: '0.75rem 0.9rem',
          borderRadius: '12px',
          background: 'rgba(16, 185, 129, 0.08)',
          border: '1px solid rgba(16, 185, 129, 0.25)'
        }}>
          <Shield size={18} style={{ color: '#10b981', flexShrink: 0, marginTop: '1px' }} />
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            <span style={{ fontWeight: '700', color: 'var(--text-main)' }}>
              {isPrivate ? `Messages are end-to-end encrypted.` : 'Messages in this chat are end-to-end encrypted.'}
            </span>{' '}
            {isPrivate
              ? `Only you and ${name} can read or listen to them. Neither PulseRoom nor anyone else can.`
              : 'Each message is encrypted on your device and can only be read by the chat participants.'}
            {isPrivate && verification === true && (
              <span style={{ display: 'block', marginTop: '0.35rem', color: '#10b981', fontWeight: '600' }}>
                <ShieldCheck size={12} style={{ verticalAlign: '-2px', marginRight: '3px' }} />
                {name}&apos;s identity key is verified.
              </span>
            )}
            {isPrivate && verification === false && (
              <span style={{ display: 'block', marginTop: '0.35rem', color: '#fbbf24', fontWeight: '600' }}>
                <ShieldOff size={12} style={{ verticalAlign: '-2px', marginRight: '3px' }} />
                {name}&apos;s identity key could not be verified. Be careful — this may indicate tampering.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Shortcuts: Media / Starred / Scheduled */}
      <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--panel-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: '700', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          <ImageIcon size={16} /> Shortcuts
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {onOpenGallery && (
            <button
              onClick={onOpenGallery}
              className="chip-btn"
              style={{ padding: '0.5rem 0.9rem', borderRadius: '12px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-main)', fontWeight: '600', textAlign: 'left', fontSize: '0.85rem' }}
            >
              <ImageIcon size={14} style={{ display: 'inline', marginRight: '6px' }} /> Media Gallery
            </button>
          )}
          {onOpenStarred && (
            <button
              onClick={onOpenStarred}
              className="chip-btn"
              style={{ padding: '0.5rem 0.9rem', borderRadius: '12px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-main)', fontWeight: '600', textAlign: 'left', fontSize: '0.85rem' }}
            >
              <Star size={14} style={{ display: 'inline', marginRight: '6px', color: '#facc15' }} /> Starred Messages
            </button>
          )}
          {onOpenScheduled && (
            <button
              onClick={onOpenScheduled}
              className="chip-btn"
              style={{ padding: '0.5rem 0.9rem', borderRadius: '12px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-main)', fontWeight: '600', textAlign: 'left', fontSize: '0.85rem' }}
            >
              <Clock size={14} style={{ display: 'inline', marginRight: '6px' }} /> Scheduled Messages
            </button>
          )}
        </div>
      </div>

      {/* Disappearing Messages Setting */}
      <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--panel-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: '700', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          <Timer size={16} /> Disappearing Messages
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {DISAPPEARING_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => handleSetDisappearing(opt.value)}
              disabled={savingTimer}
              className="chip-btn"
              style={{
                padding: '0.4rem 0.85rem',
                borderRadius: '99px',
                background: disappearing === opt.value ? 'var(--primary-accent)' : 'rgba(255,255,255,0.06)',
                color: disappearing === opt.value ? 'white' : 'var(--text-main)',
                fontWeight: '600',
                fontSize: '0.75rem'
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.6rem' }}>
          {disappearing > 0
            ? `New messages in this chat will disappear after ${DISAPPEARING_OPTIONS.find(o => o.value === disappearing)?.label.toLowerCase()}.`
            : 'New messages in this chat will stay until you delete them.'}
        </p>
      </div>

      {/* Group Management: edit info / leave group */}
      {!isPrivate && (
        <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--panel-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: '700', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            <Users size={16} /> Group Management
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {isGroupAdmin && (
              <button
                onClick={() => setShowEditGroup(true)}
                className="chip-btn"
                style={{ padding: '0.5rem 0.9rem', borderRadius: '12px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-main)', fontWeight: '600', textAlign: 'left', fontSize: '0.85rem' }}
              >
                <Pencil size={14} style={{ display: 'inline', marginRight: '6px', color: 'var(--primary-accent)' }} /> Edit Group Info
              </button>
            )}
            <button
              onClick={handleLeaveGroup}
              className="chip-btn"
              style={{ padding: '0.5rem 0.9rem', borderRadius: '12px', background: 'rgba(255,255,255,0.06)', color: '#f87171', fontWeight: '600', textAlign: 'left', fontSize: '0.85rem' }}
            >
              <LogOut size={14} style={{ display: 'inline', marginRight: '6px' }} /> Leave Group
            </button>
          </div>
        </div>
      )}

      {/* Group Members Roster */}
      {!isPrivate && (
        <div style={{ padding: '1.25rem', flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', fontWeight: '700', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            <Users size={16} /> Group Participants ({room.members?.length || 0})
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {(room.members || []).map(m => {
              const isSelf = String(m.id) === String(user?.id);
              const isMemberAdmin = m.role === 'admin';
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0.5rem', borderRadius: '10px', background: 'rgba(255,255,255,0.02)' }}>
                  <img src={m.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${m.username}`} alt={m.username} style={{ width: '32px', height: '32px', borderRadius: '10px' }} />
                  <span style={{ flex: 1, fontWeight: '600', fontSize: '0.9rem' }}>
                    {m.username}{isSelf ? ' (You)' : ''}
                  </span>
                  {isMemberAdmin && (
                    <span className="badge-tag badge-group" style={{ fontSize: '0.6rem' }}>
                      <Crown size={10} style={{ display: 'inline', verticalAlign: '-1px', marginRight: '2px' }} /> Admin
                    </span>
                  )}
                  {isGroupAdmin && !isSelf && (
                    <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0 }}>
                      <button
                        title={isMemberAdmin ? 'Demote from admin' : 'Promote to admin'}
                        onClick={() => handleRoleChange(m, isMemberAdmin ? 'member' : 'admin')}
                        disabled={busyMemberId === m.id}
                        style={{
                          background: isMemberAdmin ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                          border: 'none',
                          color: isMemberAdmin ? '#fbbf24' : '#10b981',
                          borderRadius: '8px',
                          padding: '0.3rem 0.4rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                      >
                        {isMemberAdmin ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                      </button>
                      <button
                        title="Remove from group"
                        onClick={() => handleRemoveMember(m)}
                        disabled={busyMemberId === m.id}
                        style={{
                          background: 'rgba(239,68,68,0.15)',
                          border: 'none',
                          color: '#f87171',
                          borderRadius: '8px',
                          padding: '0.3rem 0.4rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                      >
                        <UserX size={13} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showAddMembers && (
        <AddMembersModal
          room={room}
          onClose={() => setShowAddMembers(false)}
          onMembersAdded={(updatedRoom) => {
            onMembersAdded(updatedRoom);
            setShowAddMembers(false);
          }}
        />
      )}

      {showEditGroup && (
        <EditGroupModal
          room={room}
          onClose={() => setShowEditGroup(false)}
          onGroupUpdated={(updated) => {
            if (onRoomChanged) onRoomChanged(room.id);
            setShowEditGroup(false);
          }}
        />
      )}
    </div>
  );
}
