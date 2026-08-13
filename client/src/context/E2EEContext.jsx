import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';
import {
  generateIdentityKeypair,
  generateSigningKeypair,
  createIdentityBundle,
  verifyIdentityBundle,
  encryptForRecipient,
  decryptFromSender,
  initSenderKey,
  senderKeyEncrypt,
  senderKeyDecrypt
} from '../crypto/e2ee';

const E2EEContext = createContext();

const privKeyName = (userId) => `pulseroom_e2ee_priv_${userId}`;
const roomStateName = (userId) => `pulseroom_e2ee_rooms_${userId}`;

function loadRoomState(userId) {
  try {
    const raw = localStorage.getItem(roomStateName(userId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRoomState(userId, state) {
  try {
    localStorage.setItem(roomStateName(userId), JSON.stringify(state));
  } catch (err) {
    console.warn('E2EE room state save failed:', err.message);
  }
}

export function E2EEProvider({ children }) {
  const { user, token } = useAuth();
  const { socket } = useSocket();
  const [ready, setReady] = useState(false);
  const [identity, setIdentity] = useState(null);
  const [keysUploaded, setKeysUploaded] = useState(false);

  const identityRef = useRef(null);
  identityRef.current = identity;
  const keyCacheRef = useRef(new Map());

  // ---------- Ensure signed identity exists + upload ONLY public keys ----------
  // Each client keeps an ECDH identity key (for key agreement) and an ECDSA
  // signing key. The signing key signs (userId + identity public key) so every
  // recipient and the server can cryptographically verify the key belongs to the
  // claimed user (WhatsApp-style tamper detection). Private keys NEVER leave the
  // browser; the server stores public keys and relays ciphertext only.
  useEffect(() => {
    if (!user || !token) {
      setReady(false);
      setIdentity(null);
      setKeysUploaded(false);
      return;
    }
    let cancelled = false;

    const ensureKeys = async () => {
      try {
        let stored = null;
        try {
          const raw = localStorage.getItem(privKeyName(user.id));
          stored = raw ? JSON.parse(raw) : null;
        } catch { stored = null; }

        // The ECDH private key may live in the modern nested shape (stored.ecdh)
        // OR the legacy flat shape (stored.privateJwk/publicRaw). Preserve it in
        // EITHER case - regenerating when only the format differs is what made
        // old messages undecryptable after a relogin ("failed authentication").
        const hasEcdhKey = Boolean(stored && (stored.ecdh?.privateJwk || stored.privateJwk));

        if (!stored || !hasEcdhKey) {
          // Truly fresh client (or a corrupted entry with no usable private key):
          // generate a new signed identity bundle.
          const ecdh = await generateIdentityKeypair();
          const sign = await generateSigningKeypair();
          const bundle = await createIdentityBundle({ userId: user.id, ecdh, sign });
          const fresh = { v: 2, ecdh, sign, bundle };
          try {
            // Tab-race guard: if another tab generated a key while we were working,
            // adopt it instead of overwriting (last-writer-wins would orphan one tab).
            const rawNow = localStorage.getItem(privKeyName(user.id));
            if (rawNow) {
              const parsed = JSON.parse(rawNow);
              if (parsed?.ecdh?.privateJwk) {
                stored = parsed;
              } else {
                localStorage.setItem(privKeyName(user.id), JSON.stringify(fresh));
                stored = fresh;
              }
            } else {
              localStorage.setItem(privKeyName(user.id), JSON.stringify(fresh));
              stored = fresh;
            }
          } catch (err) {
            console.warn('E2EE identity persistence failed:', err.message);
            stored = fresh;
          }
        } else if (!stored.sign || !stored.bundle) {
          // Legacy identity (ECDH only, with or without the nested `ecdh` object):
          // keep the existing ECDH key so old messages still decrypt, and add the
          // signing key + signed bundle.
          const ecdh = stored.ecdh || { privateJwk: stored.privateJwk, publicRaw: stored.publicRaw };
          const sign = await generateSigningKeypair();
          const bundle = await createIdentityBundle({ userId: user.id, ecdh, sign });
          stored = { v: 2, ecdh, sign, bundle };
          try {
            localStorage.setItem(privKeyName(user.id), JSON.stringify(stored));
          } catch (err) {
            console.warn('E2EE identity persistence failed:', err.message);
          }
        }
        if (cancelled) return;
        setIdentity(stored);
        identityRef.current = stored;

        // Idempotently ensure the server has our public keys + identity signature.
        await fetch('/api/e2ee/keys', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            publicKey: stored.ecdh.publicRaw,
            signPublicKey: stored.sign.publicRaw,
            signature: stored.bundle.signature
          })
        }).catch(() => {});
        if (!cancelled) setKeysUploaded(true);
        setReady(true);
      } catch (err) {
        console.warn('E2EE key setup failed (messages will fall back to plaintext):', err.message);
        if (!cancelled) setReady(true);
      }
    };

    ensureKeys();
    return () => { cancelled = true; };
  }, [user, token]);

  // ---------- Fetch (verify + cache) a user's identity public key ----------
  // Returns { public_key, sign_public_key, signature, verified } where `verified`
  // is true only when the signed identity bundle passes cryptographic verification
  // for that userId (false = tampered/swapped, null = legacy key without a bundle).
  const fetchRecipientKey = useCallback(async (userId) => {
    if (!userId) return null;
    const cache = keyCacheRef.current;
    const cached = cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const res = await fetch(`/api/e2ee/keys/${userId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        cache.set(userId, { value: null, expiresAt: Date.now() + 30 * 1000 });
        return null;
      }
      const data = await res.json();
      let verified = null;
      if (data?.sign_public_key && data?.signature && data?.public_key) {
        verified = await verifyIdentityBundle(
          {
            v: 1,
            userId,
            ecdhPub: data.public_key,
            signPub: data.sign_public_key,
            signature: data.signature
          },
          userId
        );
      }
      const value = {
        public_key: data.public_key || null,
        sign_public_key: data.sign_public_key || null,
        signature: data.signature || null,
        verified
      };
      cache.set(userId, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
      return value;
    } catch {
      return null;
    }
  }, [token]);

  const sendRaw = useCallback((roomId, text, type) => {
    if (socket && socket.connected && user) {
      socket.emit('send_message', { roomId, text, type, e2ee: true });
    } else if (token) {
      fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ roomId, text, type, e2ee: true })
      }).catch(() => {});
    }
  }, [socket, token, user]);

  // ---------- Group sender-key management ----------
  const ensureGroupKey = useCallback(async (room) => {
    if (!user) return;
    const roomState = loadRoomState(user.id);
    const st = roomState[room.id] || { my: null, others: {}, seenCounters: {} };

    const memberIds = (room.members || [])
      .map(m => m.id)
      .filter(id => String(id) !== String(user.id));
    const membersKey = [...memberIds].sort().join(',');

    if (!st.my || (st.my.lastMembers && st.my.lastMembers !== membersKey)) {
      const fresh = await initSenderKey(room.id);
      // Keep the previous message counter (if any) so recipients' replay tracking
      // stays monotonic across a sender-key rotation.
      st.my = { ...fresh, lastMembers: membersKey, sentTo: [], counter: st.my?.counter || 0 };
      roomState[room.id] = st;
      saveRoomState(user.id, roomState);
    } else if (!st.my.lastMembers) {
      st.my.lastMembers = membersKey;
      st.my.sentTo = st.my.sentTo || [];
      st.my.counter = st.my.counter || 0;
      roomState[room.id] = st;
      saveRoomState(user.id, roomState);
    }

    // Distribute the sender key to members who have not received it yet.
    const my = st.my;
    const toSend = memberIds.filter(id => !(my.sentTo || []).includes(id));
    if (toSend.length > 0) {
      for (const mid of toSend) {
        const key = await fetchRecipientKey(mid);
        if (!key || !key.public_key) continue; // retry on a later send once they have keys
        try {
          const enc = await encryptForRecipient({
            myPrivateJwk: identityRef.current.ecdh.privateJwk,
            myPublicRaw: identityRef.current.ecdh.publicRaw,
            recipientPublicRaw: key.public_key,
            plaintext: JSON.stringify({ senderKeyId: my.senderKeyId, senderKey: my.senderKey, chainKey: my.chainKey }),
            senderId: user.id,
            recipientId: mid
          });
          const dist = {
            v: 1,
            kind: 'sender_key',
            senderPub: identityRef.current.ecdh.publicRaw,
            senderKeyId: my.senderKeyId,
            forMembers: { [mid]: enc }
          };
          sendRaw(room.id, JSON.stringify(dist), 'e2ee_sender_key');
          my.sentTo.push(mid);
        } catch (err) {
          console.warn('Sender-key distribution failed for member', mid, err.message);
        }
      }
      roomState[room.id] = st;
      saveRoomState(user.id, roomState);
    }
  }, [user, fetchRecipientKey, sendRaw]);

  // ---------- Encrypt a message for a room before sending ----------
  // Adds a per-sender message counter (inner.c) so recipients can detect replay.
  const encryptForSend = useCallback(async (room, payload) => {
    const id = identityRef.current;
    if (!ready || !id) return { e2ee: false, ...payload };

    try {
      if (room?.type === 'private') {
        const partnerId = room.partner?.id;
        if (!partnerId) return { e2ee: false, ...payload };
        const key = await fetchRecipientKey(partnerId);
        if (!key || !key.public_key) return { e2ee: false, ...payload };

        const roomState = loadRoomState(user.id);
        if (!roomState[room.id]) roomState[room.id] = { my: null, others: {}, seenCounters: {} };
        if (!roomState[room.id].my) roomState[room.id].my = { counter: 0 };
        // Monotonic counter: based on wall-clock so a cleared room state (or a
        // device change) can never restart below a counter the recipient already saw.
        roomState[room.id].my.counter = Math.max((roomState[room.id].my.counter || 0) + 1, Date.now());
        saveRoomState(user.id, roomState);
        const inner = { ...payload, c: roomState[room.id].my.counter };

        const enc = await encryptForRecipient({
          myPrivateJwk: id.ecdh.privateJwk,
          myPublicRaw: id.ecdh.publicRaw,
          recipientPublicRaw: key.public_key,
          plaintext: JSON.stringify(inner),
          senderId: user.id,
          recipientId: partnerId
        });
        // Encrypt a copy back to myself so I can decrypt my own echoed message.
        const me = await encryptForRecipient({
          myPrivateJwk: id.ecdh.privateJwk,
          myPublicRaw: id.ecdh.publicRaw,
          recipientPublicRaw: id.ecdh.publicRaw,
          plaintext: JSON.stringify(inner),
          senderId: user.id,
          recipientId: partnerId
        });
        return {
          e2ee: true,
          text: JSON.stringify({ v: 1, kind: 'msg', ...enc, me: { ...me, senderId: user.id, recipientId: partnerId } }),
          type: 'e2ee',
          mediaUrl: ''
        };
      }

      if (room?.type === 'group') {
        await ensureGroupKey(room);
        const roomState = loadRoomState(user.id);
        const mySk = roomState[room.id]?.my;
        if (!mySk) return { e2ee: false, ...payload };
        mySk.counter = Math.max((mySk.counter || 0) + 1, Date.now());
        const inner = { ...payload, c: mySk.counter };
        const result = await senderKeyEncrypt(mySk, JSON.stringify(inner));
        roomState[room.id].my.chainKey = result.nextChainKey;
        saveRoomState(user.id, roomState);
        // Self copy so the sender can read back their own sender-key message.
        const me = await encryptForRecipient({
          myPrivateJwk: id.ecdh.privateJwk,
          myPublicRaw: id.ecdh.publicRaw,
          recipientPublicRaw: id.ecdh.publicRaw,
          plaintext: JSON.stringify(inner),
          senderId: user.id,
          recipientId: user.id
        });
        return {
          e2ee: true,
          text: JSON.stringify({ v: 1, kind: 'msg', senderKeyId: mySk.senderKeyId, nonce: result.nonce, cipher: result.cipher, me: { ...me, senderId: user.id, recipientId: user.id } }),
          type: 'e2ee',
          mediaUrl: ''
        };
      }
      return { e2ee: false, ...payload };
    } catch (err) {
      console.warn('E2EE encryption fallback to plaintext:', err.message);
      return { e2ee: false, ...payload };
    }
  }, [ready, user, fetchRecipientKey, ensureGroupKey]);

  // ---------- Handle an incoming sender-key distribution message ----------
  const handleSenderKeyMessage = useCallback(async (message, roomId) => {
    if (!user) return;
    let payload;
    try { payload = JSON.parse(message.text); } catch { return; }
    const myCopy = payload.forMembers?.[user.id];
    if (!myCopy || !identityRef.current) return;
    try {
      // Only accept a sender key from the sender's server-registered identity
      // public key, so a spoofed distribution message is rejected.
      const senderKey = await fetchRecipientKey(message.sender_id);
      if (!senderKey?.public_key || payload.senderPub !== senderKey.public_key) return;
      const plain = await decryptFromSender({
        myPrivateJwk: identityRef.current.ecdh.privateJwk,
        payload: myCopy,
        senderId: message.sender_id,
        recipientId: user.id
      });
      const { senderKeyId, senderKey: sk, chainKey } = JSON.parse(plain);
      const roomState = loadRoomState(user.id);
      if (!roomState[roomId]) roomState[roomId] = { my: null, others: {}, seenCounters: {} };
      roomState[roomId].others[message.sender_id] = { senderKeyId, senderKey: sk, chainKey };
      // A fresh sender key restarts that sender's message counter, so reset the
      // replay counter for them - otherwise the first new-key messages would be
      // flagged as "replayed or duplicate" against the old counter value.
      roomState[roomId].seenCounters = roomState[roomId].seenCounters || {};
      delete roomState[roomId].seenCounters[message.sender_id];
      saveRoomState(user.id, roomState);
    } catch (err) {
      console.warn('E2EE sender-key receive failed:', err.message);
    }
  }, [user, fetchRecipientKey]);

  // ---------- Decrypt a message for display (with verification + replay checks) ----------
  // opts.maxSeen: when decrypting a batch of history in order, this is the running
  // counter for the sender so reloaded messages are NOT compared against the
  // persisted live counter (which would falsely flag every old message as a
  // "replayed or duplicate copy"). Omit it for a single live delivery.
  const decryptMessage = useCallback(async (message, roomId, opts = {}) => {
    if (!message) return message;
    if (!message.e2ee) return message;

    if (message.type === 'e2ee_sender_key') {
      await handleSenderKeyMessage(message, roomId);
      return { ...message, __system: 'sender_key' };
    }

    let payload;
    try { payload = JSON.parse(message.text); } catch {
      return { ...message, __undecryptable: true };
    }

    try {
      // My own echoed messages are decrypted via the embedded self-copy.
      if (payload.kind === 'msg' && String(message.sender_id) === String(user.id) && payload.me) {
        const plain = await decryptFromSender({
          myPrivateJwk: identityRef.current.ecdh.privateJwk,
          payload: payload.me,
          senderId: payload.me.senderId || message.sender_id,
          recipientId: payload.me.recipientId || user.id
        });
        const inner = JSON.parse(plain);
        return {
          ...message,
          decryptedText: inner.text,
          decryptedMediaUrl: inner.mediaUrl,
          decryptedMediaKey: inner.mediaKey,
          decryptedMediaNonce: inner.mediaNonce,
          decryptedMime: inner.mime,
          decryptedType: inner.type,
          verified: true
        };
      }

      let inner;
      if (payload.kind === 'msg' && payload.senderKeyId) {
        const roomState = loadRoomState(user.id);
        const sk = roomState[roomId]?.others?.[message.sender_id];
        if (!sk || sk.senderKeyId !== payload.senderKeyId) {
          return { ...message, __undecryptable: true, __reason: 'missing_sender_key' };
        }
        const res = await senderKeyDecrypt(sk, payload.nonce, payload.cipher);
        roomState[roomId].others[message.sender_id].chainKey = res.nextChainKey;
        saveRoomState(user.id, roomState);
        inner = JSON.parse(res.plaintext);
      } else if (payload.kind === 'msg' && identityRef.current) {
        const plain = await decryptFromSender({
          myPrivateJwk: identityRef.current.ecdh.privateJwk,
          payload,
          senderId: message.sender_id,
          recipientId: user.id
        });
        inner = JSON.parse(plain);
      } else {
        return { ...message, __undecryptable: true };
      }

      // Sender-identity verification (tamper detection): the message's sender
      // public key must match the server-registered, signature-verified key for
      // that sender id. Possession of ANY valid keypair is not enough.
      let verified = false;
      if (String(message.sender_id) === String(user.id)) {
        verified = true;
      } else {
        const senderKey = await fetchRecipientKey(message.sender_id);
        verified = senderKey?.verified === true && Boolean(payload.senderPub) && payload.senderPub === senderKey.public_key;
      }

      // Replay protection: per-sender counters must strictly increase per room.
      // A batch (history) decrypt compares against the batch's own running counter
      // (opts.maxSeen); a single live delivery compares against the persisted one.
      if (typeof inner.c === 'number' && String(message.sender_id) !== String(user.id)) {
        const seen = opts.maxSeen ?? loadRoomState(user.id)[roomId]?.seenCounters?.[message.sender_id] ?? 0;
        if (inner.c <= seen) {
          return { ...message, __replay: true, verified, __counter: inner.c };
        }
        if (opts.maxSeen === undefined) {
          const roomState = loadRoomState(user.id);
          if (!roomState[roomId]) roomState[roomId] = { my: null, others: {}, seenCounters: {} };
          roomState[roomId].seenCounters = { ...(roomState[roomId].seenCounters || {}), [message.sender_id]: inner.c };
          saveRoomState(user.id, roomState);
        }
        return {
          ...message,
          decryptedText: inner.text,
          decryptedMediaUrl: inner.mediaUrl,
          decryptedMediaKey: inner.mediaKey,
          decryptedMediaNonce: inner.mediaNonce,
          decryptedMime: inner.mime,
          decryptedType: inner.type,
          verified,
          __counter: inner.c
        };
      }

      return {
        ...message,
        decryptedText: inner.text,
        decryptedMediaUrl: inner.mediaUrl,
        decryptedMediaKey: inner.mediaKey,
        decryptedMediaNonce: inner.mediaNonce,
        decryptedMime: inner.mime,
        decryptedType: inner.type,
        verified
      };
    } catch (err) {
      console.warn('E2EE decrypt failed:', err.message);
      return {
        ...message,
        __undecryptable: true,
        __reason: err.code === 'E2EE_AUTH_FAILED' ? 'auth' : 'error'
      };
    }
  }, [user, handleSenderKeyMessage, fetchRecipientKey]);

  // ---------- Decrypt a list in order (sender-key dependencies preserved) ----------
  const decryptMessages = useCallback(async (messages, roomId) => {
    // Oldest first so per-sender counters increase monotonically through the batch
    // (the server already returns history ASC, but sort defensively anyway).
    const list = (Array.isArray(messages) ? messages : []).slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const running = {}; // sender_id -> highest counter decrypted in this batch
    const out = [];
    for (const m of list) {
      const d = await decryptMessage(m, roomId, { maxSeen: running[m.sender_id] || 0 });
      if (typeof d.__counter === 'number') running[m.sender_id] = d.__counter;
      out.push(d);
    }
    // Persist the highest counters so live replay detection stays continuous.
    if (Object.keys(running).length > 0) {
      try {
        const roomState = loadRoomState(user.id);
        if (!roomState[roomId]) roomState[roomId] = { my: null, others: {}, seenCounters: {} };
        const seen = { ...(roomState[roomId].seenCounters || {}) };
        let changed = false;
        for (const [sid, c] of Object.entries(running)) {
          if (c > (seen[sid] || 0)) { seen[sid] = c; changed = true; }
        }
        if (changed) {
          roomState[roomId].seenCounters = seen;
          saveRoomState(user.id, roomState);
        }
      } catch (err) {
        console.warn('E2EE seen-counter sync failed:', err.message);
      }
    }
    return out;
  }, [decryptMessage, user]);

  // ---------- Regenerate my sender key on any group membership change ----------
  useEffect(() => {
    if (!socket || !user) return;
    const onRoomMembersUpdated = (room) => {
      if (!room?.id) return;
      const roomState = loadRoomState(user.id);
      if (roomState[room.id]?.my) {
        roomState[room.id].my = null;
        saveRoomState(user.id, roomState);
      }
    };
    const onRemovedFromRoom = ({ roomId }) => {
      const roomState = loadRoomState(user.id);
      if (roomState[roomId]) {
        delete roomState[roomId];
        saveRoomState(user.id, roomState);
      }
    };
    socket.on('room_members_updated', onRoomMembersUpdated);
    socket.on('removed_from_room', onRemovedFromRoom);
    return () => {
      socket.off('room_members_updated', onRoomMembersUpdated);
      socket.off('removed_from_room', onRemovedFromRoom);
    };
  }, [socket, user]);

  const value = {
    ready,
    keysUploaded,
    encryptForSend,
    decryptMessage,
    decryptMessages,
    fetchRecipientKey
  };

  return <E2EEContext.Provider value={value}>{children}</E2EEContext.Provider>;
}

export const useE2EE = () => useContext(E2EEContext);
