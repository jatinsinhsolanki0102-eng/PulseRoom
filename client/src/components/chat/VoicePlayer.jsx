import React, { useState, useRef } from 'react';
import { Play, Pause } from 'lucide-react';

export default function VoicePlayer({ audioUrl }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1); // 1x, 1.5x, 2x
  const audioRef = useRef(null);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.playbackRate = playbackRate;
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const toggleSpeed = () => {
    const nextRate = playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 2 : 1;
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  return (
    <div className="voice-player">
      <button className="play-pause-btn" onClick={togglePlay}>
        {isPlaying ? <Pause size={18} /> : <Play size={18} style={{ marginLeft: '2px' }} />}
      </button>

      <div className="waveform-bars">
        {[40, 70, 30, 90, 50, 100, 60, 80, 40, 90, 30, 60].map((h, idx) => (
          <div
            key={idx}
            className="wave-bar"
            style={{
              height: `${h}%`,
              animationPlayState: isPlaying ? 'running' : 'paused'
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={toggleSpeed}
        style={{
          background: 'rgba(255,255,255,0.15)',
          border: 'none',
          borderRadius: '99px',
          padding: '0.2rem 0.5rem',
          fontSize: '0.7rem',
          fontWeight: '700',
          color: 'white',
          cursor: 'pointer'
        }}
        title="Playback Speed"
      >
        {playbackRate}x
      </button>

      <audio
        ref={audioRef}
        src={audioUrl}
        onEnded={() => setIsPlaying(false)}
      />
    </div>
  );
}
