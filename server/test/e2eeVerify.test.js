// ================================================================================
//  PULSEROOM SERVER IDENTITY-BUNDLE VERIFICATION TESTS
//  Uses Node's built-in test runner (node --test) + WebCrypto, mirroring what the
//  PUT /api/e2ee/keys endpoint enforces: only cryptographically valid signed
//  identity bundles are accepted/stored.
// ================================================================================

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignedIdentity } from '../src/e2eeVerify.js';

const enc = new TextEncoder();
const IDENTITY_BUNDLE_V = 1;

const b64urlToBytes = (s) => {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return new Uint8Array(Buffer.from(b64, 'base64'));
};

const bytesToB64 = (bytes) => Buffer.from(bytes).toString('base64');

function jwkToRaw(jwk) {
  const x = b64urlToBytes(jwk.x);
  const y = b64urlToBytes(jwk.y);
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 33);
  return raw;
}

async function makeKeys() {
  const ecdh = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const sign = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const ecdhJwk = await globalThis.crypto.subtle.exportKey('jwk', ecdh.publicKey);
  const signJwk = await globalThis.crypto.subtle.exportKey('jwk', sign.publicKey);
  return {
    ecdhPub: bytesToB64(jwkToRaw(ecdhJwk)),
    signPub: bytesToB64(jwkToRaw(signJwk)),
    signPriv: sign.privateKey
  };
}

const bundleBytes = (userId, ecdhPub, signPub) =>
  enc.encode(`${IDENTITY_BUNDLE_V}|${userId}|${ecdhPub}|${signPub}`);

describe('server: verifySignedIdentity', () => {
  let alice;

  before(async () => {
    alice = await makeKeys();
  });

  it('accepts a validly signed identity bundle for the owning userId', async () => {
    const data = bundleBytes('alice-uuid', alice.ecdhPub, alice.signPub);
    const sig = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, alice.signPriv, data);
    const ok = await verifySignedIdentity({
      userId: 'alice-uuid',
      ecdhPub: alice.ecdhPub,
      signPub: alice.signPub,
      signature: bytesToB64(new Uint8Array(sig))
    });
    assert.equal(ok, true);
  });

  it('rejects a bundle claiming a different userId', async () => {
    const data = bundleBytes('mallory-uuid', alice.ecdhPub, alice.signPub);
    const sig = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, alice.signPriv, data);
    const ok = await verifySignedIdentity({
      userId: 'alice-uuid',
      ecdhPub: alice.ecdhPub,
      signPub: alice.signPub,
      signature: bytesToB64(new Uint8Array(sig))
    });
    assert.equal(ok, false);
  });

  it('rejects a tampered signature', async () => {
    const data = bundleBytes('alice-uuid', alice.ecdhPub, alice.signPub);
    const sig = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, alice.signPriv, data);
    const sigBytes = new Uint8Array(sig);
    sigBytes[0] ^= 0xff;
    const ok = await verifySignedIdentity({
      userId: 'alice-uuid',
      ecdhPub: alice.ecdhPub,
      signPub: alice.signPub,
      signature: bytesToB64(sigBytes)
    });
    assert.equal(ok, false);
  });

  it('rejects a tampered identity public key', async () => {
    const data = bundleBytes('alice-uuid', alice.ecdhPub, alice.signPub);
    const sig = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, alice.signPriv, data);
    // Flip a byte inside the 65-byte ECDH public key.
    const ecdhBytes = Buffer.from(alice.ecdhPub, 'base64');
    ecdhBytes[10] ^= 0x01;
    const ok = await verifySignedIdentity({
      userId: 'alice-uuid',
      ecdhPub: ecdhBytes.toString('base64'),
      signPub: alice.signPub,
      signature: bytesToB64(new Uint8Array(sig))
    });
    assert.equal(ok, false);
  });

  it('rejects malformed or missing inputs', async () => {
    assert.equal(await verifySignedIdentity({ userId: 'alice-uuid', ecdhPub: 'AAAA', signPub: alice.signPub, signature: 'AAAA' }), false);
    assert.equal(await verifySignedIdentity({ userId: '', ecdhPub: alice.ecdhPub, signPub: alice.signPub, signature: 'AAAA' }), false);
    assert.equal(await verifySignedIdentity({}), false);
    assert.equal(await verifySignedIdentity(null), false);
  });
});
