import React, { useState, useEffect } from 'react';
import { decryptFileBytes } from '../../crypto/e2ee';
import { X, Image as ImageIcon, Film, FileWarning } from 'lucide-react';

// Decrypts E2EE media into a blob URL (revoked on unmount) and renders a thumbnail.
function GalleryThumb({ item }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let blobUrl = '';
    const load = async () => {
      try {
        const src = item.e2ee ? item.decryptedMediaUrl : item.media_url;
        if (!src) return;
        blobUrl = item.e2ee
          ? await decryptFileBytes(src, item.decryptedMediaKey, item.decryptedMediaNonce)
          : src;
        if (!cancelled) setUrl(blobUrl);
      } catch (err) {
        if (!cancelled) setError(true);
      }
    };
    load();
    return () => { cancelled = true; if (blobUrl && item.e2ee) URL.revokeObjectURL(blobUrl); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  if (error) {
    return <div className="gallery-thumb gallery-thumb-error"><FileWarning size={18} /></div>;
  }
  if (!url) {
    return <div className="gallery-thumb gallery-thumb-skeleton" />;
  }
  const mediaType = item.e2ee ? item.decryptedType : item.type;
  return mediaType === 'video' ? (
    <video src={url} preload="metadata" muted className="gallery-thumb" />
  ) : (
    <img src={url} alt="" className="gallery-thumb" />
  );
}

export default function MediaGalleryModal({ messages, onClose }) {
  const [selected, setSelected] = useState(null); // { item, url }
  const [selectedUrl, setSelectedUrl] = useState('');

  const items = (Array.isArray(messages) ? messages : []).filter(m => {
    if (!m || m.type === 'deleted' || m.deleted_for_everyone || m.__system === 'sender_key' || m.__undecryptable) return false;
    const t = m.e2ee ? (m.decryptedType || '') : (m.type || '');
    const url = m.e2ee ? (m.decryptedMediaUrl || '') : (m.media_url || '');
    return (t === 'image' || t === 'video') && Boolean(url);
  });

  const openLightbox = async (item) => {
    setSelected(item);
    try {
      if (item.e2ee) {
        const blobUrl = await decryptFileBytes(item.decryptedMediaUrl, item.decryptedMediaKey, item.decryptedMediaNonce);
        setSelectedUrl(blobUrl);
      } else {
        setSelectedUrl(item.media_url);
      }
    } catch (err) {
      setSelectedUrl('');
    }
  };

  const closeLightbox = () => {
    if (selected?.e2ee && selectedUrl) URL.revokeObjectURL(selectedUrl);
    setSelected(null);
    setSelectedUrl('');
  };

  const mediaType = (m) => (m.e2ee ? m.decryptedType : m.type);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel" style={{ maxWidth: '720px' }} onClick={(e) => e.stopPropagation()}>
        {!selected && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontFamily: 'Outfit', fontSize: '1.25rem', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Film size={18} /> Media Gallery <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>({items.length})</span>
              </h3>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <X size={20} />
              </button>
            </div>
            {items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-dim)' }}>
                <ImageIcon size={36} style={{ margin: '0 auto 0.75rem', opacity: 0.5 }} />
                <p>No photos or videos shared in this chat yet.</p>
              </div>
            ) : (
              <div className="gallery-grid">
                {items.map(m => (
                  <button key={m.id} className="gallery-cell" onClick={() => openLightbox(m)} title={mediaType(m) === 'video' ? 'Video' : 'Photo'}>
                    <GalleryThumb item={m} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {selected && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                {mediaType(selected) === 'video' ? 'Video' : 'Photo'} · {new Date(selected.created_at).toLocaleString()}
              </span>
              <button onClick={closeLightbox} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <X size={20} />
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', borderRadius: '16px', overflow: 'hidden', minHeight: '260px' }}>
              {selectedUrl && mediaType(selected) === 'video' ? (
                <video src={selectedUrl} controls autoPlay style={{ maxWidth: '100%', maxHeight: '65vh' }} />
              ) : selectedUrl ? (
                <img src={selectedUrl} alt="" style={{ maxWidth: '100%', maxHeight: '65vh' }} />
              ) : (
                <p style={{ padding: '2rem', color: 'var(--text-dim)' }}>Could not load media.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
