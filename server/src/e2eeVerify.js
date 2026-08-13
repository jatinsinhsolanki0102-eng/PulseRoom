// ================================================================================
//  PULSEROOM SERVER-SIDE IDENTITY BUNDLE VERIFICATION
//  Mirrors the client crypto (client/src/crypto/e2ee.js) using Node's built-in
//  WebCrypto. The server verifies the signed identity bundle a client uploads so
//  it only ever stores authenticated public keys. It NEVER sees or stores private
//  keys or message plaintext - it only relays ciphertext.
// ================================================================================

const enc = new TextEncoder();
const IDENTITY_BUNDLE_V = 1;

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return Buffer.from(bin, 'binary').toString('base64');
}

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function bytesToB64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return b64ToBytes(b64);
}

// Convert a 65-byte uncompressed P-256 point into a JWK public key.
function rawToJwk(rawBytes) {
  const x = b64urlToBytes(bytesToB64url(rawBytes.subarray(1, 33)));
  const y = b64urlToBytes(bytesToB64url(rawBytes.subarray(33, 65)));
  return { kty: 'EC', crv: 'P-256', x: bytesToB64url(x), y: bytesToB64url(y) };
}

function identityBundleSignBytes(userId, ecdhPub, signPub) {
  return enc.encode(`${IDENTITY_BUNDLE_V}|${userId}|${ecdhPub}|${signPub}`);
}

export async function importEcPublicKey(publicRaw) {
  const bytes = typeof publicRaw === 'string' ? b64ToBytes(publicRaw) : publicRaw;
  if (bytes.length !== 65 || bytes[0] !== 4) return null;
  return globalThis.crypto.subtle.importKey(
    'jwk',
    rawToJwk(bytes),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

export async function verifySignature(publicRaw, data, signatureB64) {
  if (!publicRaw || !signatureB64) return false;
  try {
    const key = await importEcPublicKey(publicRaw);
    if (!key) return false;
    const sigBytes = b64ToBytes(signatureB64);
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sigBytes,
      data
    );
  } catch {
    return false;
  }
}

// Verifies a signed identity bundle: { v, userId, ecdhPub, signPub, signature }.
// Returns false on malformed keys, a userId mismatch, or an invalid signature.
export async function verifySignedIdentity(bundle) {
  if (!bundle || typeof bundle !== 'object') return false;
  const { userId, ecdhPub, signPub, signature } = bundle;
  if (!userId || typeof userId !== 'string') return false;
  if (typeof ecdhPub !== 'string' || typeof signPub !== 'string' || typeof signature !== 'string') return false;
  return verifySignature(
    signPub,
    identityBundleSignBytes(userId, ecdhPub, signPub),
    signature
  );
}
