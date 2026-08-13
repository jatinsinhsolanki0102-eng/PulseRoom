import React, { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { decryptFileBytes } from '../../crypto/e2ee';
import VoicePlayer from './VoicePlayer';

// Renders end-to-end encrypted media. The stored URL only points to AES-256-GCM
// ciphertext; we fetch the bytes, decrypt them in the browser with the key that
// was delivered inside the encrypted message envelope, then show the result.
export default function DecryptedMedia({ mediaUrl, mediaKey, mediaNonce, mime, type, text }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let url = null;
    setObjectUrl(null);
    setFailed(false);

    const load = async () => {
      try {
        if (!mediaUrl || !mediaKey || !mediaNonce) {
          setFailed(true);
          return;
        }
        const res = await fetch(mediaUrl);
        if (!res.ok) throw new Error('Media download failed');
        const cipherBytes = await res.arrayBuffer();
        const plain = await decryptFileBytes(cipherBytes, mediaKey, mediaNonce);
        const blob = new Blob([plain], { type: mime || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        if (revoked) return;
        setObjectUrl(url);
      } catch (err) {
        console.warn('Media decrypt failed:', err.message);
        setFailed(true);
      }
    };

    load();

    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [mediaUrl, mediaKey, mediaNonce, mime]);

  if (failed) {
    return (
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.25rem 0' }}>
        🔒 Encrypted {type === 'audio' ? 'voice note' : 'media'} could not be loaded.
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.25rem 0' }}>
        <Lock size={12} style={{ verticalAlign: '-2px' }} /> Decrypting {type === 'audio' ? 'voice note' : 'media'}...
      </div>
    );
  }

  if (type === 'audio') {
    return <VoicePlayer audioUrl={objectUrl} />;
  }

  if (type === 'video') {
    return (
      <div style={{ marginBottom: '0.5rem' }}>
        <video src={objectUrl} controls style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: '12px', display: 'block' }} />
      </div>
    );
  }

  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <img
        src={objectUrl}
        alt={text || 'Encrypted attachment'}
        style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: '12px', display: 'block' }}
      />
    </div>
  );
}
