import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';
import CallOverlay from '../components/call/CallOverlay';

const CallContext = createContext();

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export function CallProvider({ children }) {
  const { user } = useAuth();
  const { socket } = useSocket();

  const [call, setCall] = useState(null); // { id, mode, mediaType, peerId, peerName, peerAvatar, roomId, offer? }
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [notice, setNotice] = useState('');

  const pcRef = useRef(null);
  const callRef = useRef(null);
  const localStreamRef = useRef(null);
  const timerRef = useRef(null);
  const ringRef = useRef(null);
  const audioCtxRef = useRef(null);

  const stopRing = useCallback(() => {
    if (ringRef.current) clearInterval(ringRef.current);
    ringRef.current = null;
    try { audioCtxRef.current?.close(); } catch (e) { /* ignore */ }
    audioCtxRef.current = null;
  }, []);

  const startRing = useCallback((pattern) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ctx;
      const play = () => {
        if (!callRef.current) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = pattern === 'incoming' ? 820 : 480;
        gain.gain.setValueAtTime(0.07, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.9);
      };
      play();
      ringRef.current = setInterval(play, 2200);
    } catch (e) { /* audio unavailable */ }
  }, []);

  const createPc = useCallback((callId, peerId) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate && callRef.current) {
        socket?.emit('call_ice', { callId, targetUserId: peerId, candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) setRemoteStream(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        stopRing();
        if (callRef.current) {
          callRef.current.mode = 'active';
          setCall(prev => (prev ? { ...prev, mode: 'active' } : prev));
        }
      } else if (pc.connectionState === 'failed') {
        endCall('failed');
      }
    };
    return pc;
  }, [socket, stopRing]);

  const getUserMedia = useCallback(async (mediaType) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: mediaType === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  const endCall = useCallback((reason = '') => {
    const c = callRef.current;
    stopRing();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    try { pcRef.current?.close(); } catch (e) { /* ignore */ }
    pcRef.current = null;
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setMuted(false);
    setCameraOff(false);
    callRef.current = null;
    setCall(null);
    setCallSeconds(0);
    if (reason) {
      const msg =
        reason === 'declined' ? 'Call declined.' :
        reason === 'busy' ? 'User is busy in another call.' :
        reason === 'unavailable' ? 'User is unavailable right now.' :
        reason === 'failed' ? 'Call failed to connect.' :
        'Call ended.';
      setNotice(msg);
      setTimeout(() => setNotice(''), 4000);
    }
  }, [stopRing]);

  const startCall = useCallback(async ({ roomId, peerId, peerName, peerAvatar, mediaType = 'audio' }) => {
    if (!socket || !user) return;
    if (callRef.current) return;
    const callId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    callRef.current = { id: callId, peerId, mediaType, roomId, mode: 'outgoing' };
    setCall({ id: callId, mode: 'outgoing', mediaType, peerId, peerName, peerAvatar, roomId });
    setCallSeconds(0);
    startRing('outgoing');
    try {
      const stream = await getUserMedia(mediaType);
      const pc = createPc(callId, peerId);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call_offer', { callId, roomId, targetUserId: peerId, mediaType, offer: pc.localDescription });
    } catch (err) {
      console.error('startCall error:', err);
      endCall('failed');
    }
  }, [socket, user, getUserMedia, createPc, endCall, startRing]);

  const acceptCall = useCallback(async () => {
    const c = callRef.current;
    if (!c || !c.offer) return;
    try {
      const stream = await getUserMedia(c.mediaType);
      const pc = createPc(c.id, c.peerId);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      await pc.setRemoteDescription(new RTCSessionDescription(c.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket?.emit('call_answer', { callId: c.id, targetUserId: c.peerId, answer: pc.localDescription });
      stopRing();
      callRef.current.mode = 'active';
      setCall(prev => (prev ? { ...prev, mode: 'active' } : prev));
    } catch (err) {
      console.error('acceptCall error:', err);
      endCall('failed');
    }
  }, [socket, getUserMedia, createPc, stopRing, endCall]);

  const declineCall = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    if (c.mode === 'incoming') {
      socket?.emit('call_reject', { callId: c.id, targetUserId: c.peerId });
    } else if (c.mode === 'outgoing') {
      socket?.emit('call_cancel', { callId: c.id, targetUserId: c.peerId });
    } else {
      socket?.emit('call_end', { callId: c.id, targetUserId: c.peerId });
    }
    endCall();
  }, [socket, endCall]);

  const hangup = useCallback(() => {
    const c = callRef.current;
    if (c && (c.mode === 'active' || c.mode === 'outgoing')) {
      const evt = c.mode === 'active' ? 'call_end' : 'call_cancel';
      socket?.emit(evt, { callId: c.id, targetUserId: c.peerId });
      endCall('ended');
    } else {
      endCall();
    }
  }, [socket, endCall]);

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks();
    if (tracks?.length) {
      const next = !tracks[0].enabled;
      tracks.forEach(t => { t.enabled = next; });
      setMuted(!next);
    }
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = localStreamRef.current?.getVideoTracks();
    if (tracks?.length) {
      const next = !tracks[0].enabled;
      tracks.forEach(t => { t.enabled = next; });
      setCameraOff(!next);
    }
  }, []);

  // Incoming/outgoing signaling listeners
  useEffect(() => {
    if (!socket) return;

    const onIncoming = (data) => {
      if (callRef.current) {
        socket.emit('call_reject', { callId: data.callId, targetUserId: data.fromUserId });
        return;
      }
      callRef.current = {
        id: data.callId,
        peerId: data.fromUserId,
        mediaType: data.mediaType,
        roomId: data.roomId,
        offer: data.offer,
        mode: 'incoming'
      };
      setCall({
        id: data.callId,
        mode: 'incoming',
        mediaType: data.mediaType,
        peerId: data.fromUserId,
        peerName: data.fromName,
        peerAvatar: data.fromAvatar,
        roomId: data.roomId
      });
      setCallSeconds(0);
      startRing('incoming');
    };

    const onAnswer = (data) => {
      const c = callRef.current;
      if (!c || c.id !== data.callId) return;
      try {
        pcRef.current?.setRemoteDescription(new RTCSessionDescription(data.answer));
        if (callRef.current) callRef.current.mode = 'active';
        setCall(prev => (prev ? { ...prev, mode: 'active' } : prev));
        stopRing();
      } catch (err) {
        console.error('Error setting remote answer:', err);
      }
    };

    const onIce = (data) => {
      const c = callRef.current;
      if (!c || c.id !== data.callId) return;
      try {
        pcRef.current?.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) { /* ignore late candidates */ }
    };

    const onRejected = (data) => {
      if (callRef.current?.id === data.callId) endCall('declined');
    };
    const onBusy = (data) => {
      if (callRef.current?.id === data.callId) endCall('busy');
    };
    const onUnavailable = (data) => {
      if (callRef.current?.id === data.callId) endCall('unavailable');
    };
    const onEnded = (data) => {
      if (callRef.current?.id === data.callId) endCall('ended');
    };
    const onCancelled = (data) => {
      if (callRef.current?.id === data.callId) endCall('ended');
    };

    socket.on('call_incoming', onIncoming);
    socket.on('call_answer', onAnswer);
    socket.on('call_ice', onIce);
    socket.on('call_rejected', onRejected);
    socket.on('call_busy', onBusy);
    socket.on('call_unavailable', onUnavailable);
    socket.on('call_ended', onEnded);
    socket.on('call_cancelled', onCancelled);

    return () => {
      socket.off('call_incoming', onIncoming);
      socket.off('call_answer', onAnswer);
      socket.off('call_ice', onIce);
      socket.off('call_rejected', onRejected);
      socket.off('call_busy', onBusy);
      socket.off('call_unavailable', onUnavailable);
      socket.off('call_ended', onEnded);
      socket.off('call_cancelled', onCancelled);
    };
  }, [socket, startRing, stopRing, endCall]);

  // Active-call timer
  useEffect(() => {
    if (call?.mode === 'active') {
      timerRef.current = setInterval(() => setCallSeconds(s => s + 1), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [call?.mode]);

  // Cleanup on unmount
  useEffect(() => () => endCall(), [endCall]);

  const value = {
    call,
    localStream,
    remoteStream,
    muted,
    cameraOff,
    callSeconds,
    notice,
    startCall,
    acceptCall,
    declineCall,
    hangup,
    toggleMute,
    toggleCamera,
    endCall
  };

  return (
    <CallContext.Provider value={value}>
      {children}
      {call && (
        <CallOverlay
          call={call}
          localStream={localStream}
          remoteStream={remoteStream}
          muted={muted}
          cameraOff={cameraOff}
          callSeconds={callSeconds}
          onAccept={acceptCall}
          onDecline={declineCall}
          onHangup={hangup}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera}
        />
      )}
      {notice && (
        <div className="call-notice">
          <span>{notice}</span>
        </div>
      )}
    </CallContext.Provider>
  );
}

export const useCall = () => useContext(CallContext);
