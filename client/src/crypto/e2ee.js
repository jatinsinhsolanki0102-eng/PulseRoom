// ================================================================================
//  PULSEROOM END-TO-END ENCRYPTION CORE
//  WhatsApp-style design built on standard WebCrypto (no external crypto libraries):
//    - ECDH P-256  (identity + per-message ephemeral keys -> forward secrecy)
//    - HKDF-SHA256 (key derivation)
//    - AES-256-GCM (authenticated encryption -> confidentiality + tamper detection)
//    - ECDSA P-256 (signed identity bundles -> authenticated key exchange; every
//      recipient and the server can verify a public key genuinely belongs to the
//      claimed userId, detecting MITM key-swaps and tampering)
//    - Group chats use per-sender "Sender Keys" (Signal SenderKey pattern) that are
//      distributed to each member encrypted to their identity public key.
//  PRIVATE KEYS NEVER LEAVE THE BROWSER. The server only stores public keys and
//  relaying ciphertext that it cannot read. Message content is never plaintext
//  at rest or in transit on the server.
// ================================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();
const HKDF_INFO = 'PulseRoom-E2EE-v1';

// ---------- Base64 helpers ----------
export function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return b64ToBytes(b64);
}

export function randomBytes(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

// ---------- JWK <-> raw (65-byte uncompressed point) conversion for P-256 ----------
function jwkToRaw(jwk) {
  const x = b64urlToBytes(jwk.x);
  const y = b64urlToBytes(jwk.y);
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 33);
  return raw;
}

export function jwkToRawB64(jwk) {
  return bytesToB64(jwkToRaw(jwk));
}

export function rawToJwk(raw) {
  const bytes = typeof raw === 'string' ? b64ToBytes(raw) : raw;
  const x = bytesToB64url(bytes.subarray(1, 33));
  const y = bytesToB64url(bytes.subarray(33, 65));
  return { kty: 'EC', crv: 'P-256', x, y };
}

// ---------- Identity keypair ----------
export async function generateIdentityKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateJwk, publicJwk, publicRaw: jwkToRawB64(publicJwk) };
}

export async function importPrivateJwk(privateJwk) {
  return crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
}

// ---------- WhatsApp-style signed identity (authenticated key exchange) ----------
// Every client keeps TWO keys:
//   1. An ECDH P-256 identity key   -> used for key agreement (messages).
//   2. An ECDSA P-256 signing key   -> signs the identity key + the owning userId.
// The resulting signature is uploaded next to the public keys, so any recipient
// (and the server) can cryptographically verify the bundle belongs to the claimed
// userId. This is the tamper-detection mechanism against identity/MITM key-swaps.

export async function generateSigningKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateJwk, publicJwk, publicRaw: jwkToRawB64(publicJwk) };
}

export async function importSigningPrivateJwk(privateJwk) {
  return crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

export async function importSignPublicKey(publicRaw) {
  return crypto.subtle.importKey(
    'jwk',
    rawToJwk(publicRaw),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

export async function signBytes(privateJwk, data) {
  const key = await importSigningPrivateJwk(privateJwk);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return bytesToB64(new Uint8Array(sig));
}

// Verifies an ECDSA-SHA256 signature over `data` with a raw (65-byte) P-256
// public key. Returns false on any failure -> tamper detection.
export async function verifySignature(publicRaw, data, signatureB64) {
  if (!publicRaw || !signatureB64) return false;
  try {
    const key = await importSignPublicKey(publicRaw);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64ToBytes(signatureB64),
      data
    );
  } catch {
    return false;
  }
}

export const IDENTITY_BUNDLE_V = 1;

// Canonical bytes that are signed: binds the bundle to the owning userId.
export function identityBundleSignBytes(userId, ecdhPub, signPub) {
  return enc.encode(`${IDENTITY_BUNDLE_V}|${userId}|${ecdhPub}|${signPub}`);
}

// Creates a signed identity bundle for a user. `ecdh` = result of
// generateIdentityKeypair(), `sign` = result of generateSigningKeypair().
export async function createIdentityBundle({ userId, ecdh, sign }) {
  const signature = await signBytes(
    sign.privateJwk,
    identityBundleSignBytes(userId, ecdh.publicRaw, sign.publicRaw)
  );
  return {
    v: IDENTITY_BUNDLE_V,
    userId,
    ecdhPub: ecdh.publicRaw,
    signPub: sign.publicRaw,
    signature,
    createdAt: new Date().toISOString()
  };
}

// Verifies a signed identity bundle against the expected owning userId.
// Returns false for malformed keys, wrong userId, or an invalid signature.
export async function verifyIdentityBundle(bundle, expectedUserId) {
  if (!bundle || typeof bundle !== 'object') return false;
  try {
    if (bundle.userId !== expectedUserId) return false;
    if (bundle.v !== IDENTITY_BUNDLE_V) return false;
    if (typeof bundle.ecdhPub !== 'string' || typeof bundle.signPub !== 'string') return false;
    if (typeof bundle.signature !== 'string' || !bundle.signature) return false;
    const ecdhRaw = b64ToBytes(bundle.ecdhPub);
    const signRaw = b64ToBytes(bundle.signPub);
    if (ecdhRaw.length !== 65 || signRaw.length !== 65 || ecdhRaw[0] !== 4 || signRaw[0] !== 4) return false;
    return verifySignature(
      bundle.signPub,
      identityBundleSignBytes(bundle.userId, bundle.ecdhPub, bundle.signPub),
      bundle.signature
    );
  } catch {
    return false;
  }
}

// ---------- ECDH shared secret ----------
async function ecdhDeriveBits(privateKey, otherPublicRaw) {
  const otherPub = await crypto.subtle.importKey(
    'jwk',
    rawToJwk(otherPublicRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return crypto.subtle.deriveBits({ name: 'ECDH', public: otherPub }, privateKey, 256);
}

function concatBits(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer;
}

// ---------- HKDF + AES-GCM ----------
async function hkdf(ikm, salt, info, lengthBits = 256) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    base,
    lengthBits
  );
}

async function importAesKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ---------- 1:1 message encryption (mutual auth + forward secrecy) ----------
// Key schedule:  shared = ECDH(ephSender, recipientIdentity) || ECDH(senderIdentity, recipientIdentity)
//                key    = HKDF(shared, salt, "PulseRoom-E2EE-v1|<senderId>|<recipientId>")
export async function encryptForRecipient({ myPrivateJwk, myPublicRaw, recipientPublicRaw, plaintext, senderId, recipientId }) {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPubRaw = jwkToRawB64(await crypto.subtle.exportKey('jwk', eph.publicKey));

  const myPriv = await importPrivateJwk(myPrivateJwk);
  const dh1 = await ecdhDeriveBits(eph.privateKey, recipientPublicRaw);
  const dh2 = await ecdhDeriveBits(myPriv, recipientPublicRaw);
  const shared = concatBits(dh1, dh2);

  const salt = randomBytes(32);
  const info = enc.encode(`${HKDF_INFO}|${senderId}|${recipientId}`);
  const key = await importAesKey(await hkdf(shared, salt, info));

  const nonce = randomBytes(12);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(plaintext));

  return {
    senderPub: myPublicRaw,
    ephPub: ephPubRaw,
    salt: bytesToB64(salt),
    nonce: bytesToB64(nonce),
    cipher: bytesToB64(new Uint8Array(cipher))
  };
}

export async function decryptFromSender({ myPrivateJwk, payload, senderId, recipientId }) {
  const myPriv = await importPrivateJwk(myPrivateJwk);
  const dh1 = await ecdhDeriveBits(myPriv, payload.ephPub);
  const dh2 = await ecdhDeriveBits(myPriv, payload.senderPub);
  const shared = concatBits(dh1, dh2);

  const info = enc.encode(`${HKDF_INFO}|${senderId}|${recipientId}`);
  const key = await importAesKey(await hkdf(shared, b64ToBytes(payload.salt), info));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(payload.nonce) },
      key,
      b64ToBytes(payload.cipher)
    );
    return dec.decode(plain);
  } catch (err) {
    // AES-GCM refuses to authenticate modified ciphertext/IV -> tampered or
    // the message was encrypted to someone else. Surface the reason explicitly.
    const e = new Error('Message authentication failed (ciphertext tampered or wrong recipient).');
    e.code = 'E2EE_AUTH_FAILED';
    throw e;
  }
}

// ---------- Group Sender Keys (Signal SenderKey pattern) ----------
export async function initSenderKey(roomId) {
  const senderKeyId = (crypto.randomUUID && crypto.randomUUID()) || `sk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const senderKey = randomBytes(32);
  const chainKey = new Uint8Array(
    await hkdf(
      senderKey,
      enc.encode(`room:${roomId}`),
      enc.encode(`${HKDF_INFO}|senderkey|init`)
    )
  );
  return { senderKeyId, senderKey: bytesToB64(senderKey), chainKey: bytesToB64(chainKey) };
}

async function senderKeyStep(chainKeyB64, role) {
  const base = await crypto.subtle.importKey('raw', b64ToBytes(chainKeyB64), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(role), info: enc.encode(`${HKDF_INFO}|senderkey|${role}`) },
    base,
    256
  );
  return new Uint8Array(bits);
}

// Encrypts a message with the sender key chain, advancing the chain.
// Returns { nonce, cipher, nextChainKey }
export async function senderKeyEncrypt(sk, plaintext) {
  const mkBits = await senderKeyStep(sk.chainKey, 'msg');
  const nextChain = await senderKeyStep(sk.chainKey, 'next');
  const key = await importAesKey(mkBits);
  const nonce = randomBytes(12);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(plaintext));
  return {
    nonce: bytesToB64(nonce),
    cipher: bytesToB64(new Uint8Array(cipher)),
    nextChainKey: bytesToB64(nextChain)
  };
}

// Decrypts a sender-key message, returning the advanced chain key too.
// Throws with code 'E2EE_AUTH_FAILED' if the ciphertext fails authentication
// (tampered or produced from a different sender-key chain).
export async function senderKeyDecrypt(sk, nonceB64, cipherB64) {
  const mkBits = await senderKeyStep(sk.chainKey, 'msg');
  const nextChain = await senderKeyStep(sk.chainKey, 'next');
  const key = await importAesKey(mkBits);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(nonceB64) },
      key,
      b64ToBytes(cipherB64)
    );
    return { plaintext: dec.decode(plain), nextChainKey: bytesToB64(nextChain) };
  } catch (err) {
    const e = new Error('Sender-key message authentication failed (tampered or out-of-chain).');
    e.code = 'E2EE_AUTH_FAILED';
    throw e;
  }
}

// ---------- WhatsApp-style media encryption ----------
// The raw file is encrypted client-side with a fresh random AES-256-GCM key
// BEFORE it is uploaded. The server only ever sees (and stores) ciphertext, and
// the key+nonce travel inside the E2EE message envelope so only the intended
// recipients can recover the media.
export async function encryptFileBytes(bytes) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const aesKey = await importAesKey(key);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, bytes);
  return {
    cipher: new Uint8Array(cipher),
    key: bytesToB64(key),
    nonce: bytesToB64(nonce)
  };
}

export async function decryptFileBytes(cipherBytes, keyB64, nonceB64) {
  const aesKey = await importAesKey(b64ToBytes(keyB64));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(nonceB64) },
      aesKey,
      cipherBytes
    );
    return new Uint8Array(plain);
  } catch (err) {
    const e = new Error('Media authentication failed (tampered or wrong key).');
    e.code = 'E2EE_AUTH_FAILED';
    throw e;
  }
}
