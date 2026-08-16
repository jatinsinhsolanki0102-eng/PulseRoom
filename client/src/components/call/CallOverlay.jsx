import React, { useEffect, useRef } from 'react';
import { PhoneOff, Mic, MicOff, Video, VideoOff, Phone, Volume2 } from 'lucide-react';

export default function CallOverlay({
  call,
  localStream,
  remoteStream,
  muted,
  cameraOff,
  callSeconds,
  onAccept,
  onDecline,
  onHangup,
  onToggleMute,
  onToggleCamera
}) {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  useEffect(() => {
    if (localVideoRef.current && localStream && localVideoRef.current.srcObject !== localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream && remoteVideoRef.current.srcObject !== remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const isVideo = call.mediaType === 'video';
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const avatarEl = (size) => (
    <div className="call-avatar" style={{ width: size, height: size }}>
      {call.peerAvatar ? (
        <img src={call.peerAvatar} alt={call.peerName} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
      ) : (
        <span style={{ fontSize: '3rem', fontWeight: '800' }}>{call.peerName?.charAt(0)?.toUpperCase() || '?'}</span>
      )}
    </div>
  );

  return (
    <div className="call-overlay">
      {call.mode === 'incoming' && (
        <div className="call-card">
          {avatarEl(110)}
          <h2 className="call-name">{call.peerName}</h2>
          <p className="call-status">Incoming {isVideo ? 'video' : 'voice'} call...</p>
          <div className="call-actions">
            <button className="call-btn call-btn-decline" onClick={onDecline} title="Decline">
              <PhoneOff size={22} />
            </button>
            <button className="call-btn call-btn-accept" onClick={onAccept} title="Accept">
              <Phone size={22} />
            </button>
          </div>
        </div>
      )}

      {call.mode === 'outgoing' && (
        <div className="call-card">
          {avatarEl(110)}
          <h2 className="call-name">{call.peerName}</h2>
          <p className="call-status">
            <Volume2 size={14} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
            Calling {isVideo ? 'video' : 'voice'}...
          </p>
          <div className="call-actions">
            <button className="call-btn call-btn-decline" onClick={onHangup} title="Cancel">
              <PhoneOff size={22} />
            </button>
          </div>
        </div>
      )}

      {call.mode === 'active' && (
        <div className="call-active">
          <div className="call-remote-wrap">
            {isVideo && remoteStream ? (
              <video ref={remoteVideoRef} autoPlay playsInline className="call-remote-video" />
            ) : (
              avatarEl(140)
            )}
          </div>

          <div className="call-top-bar">
            <h2 className="call-name">{call.peerName}</h2>
            <p className="call-status">{fmt(callSeconds)}</p>
          </div>

          {isVideo && localStream && (
            <div className="call-local-pip">
              <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '14px' }} />
              {cameraOff && <div className="call-local-off">Camera off</div>}
            </div>
          )}

          <div className="call-actions call-actions-active">
            <button className={`call-btn ${muted ? 'call-btn-on' : ''}`} onClick={onToggleMute} title={muted ? 'Unmute' : 'Mute'}>
              {muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
            {isVideo && (
              <button className={`call-btn ${cameraOff ? 'call-btn-on' : ''}`} onClick={onToggleCamera} title={cameraOff ? 'Camera on' : 'Camera off'}>
                {cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
            )}
            <button className="call-btn call-btn-decline" onClick={onHangup} title="End call">
              <PhoneOff size={22} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
