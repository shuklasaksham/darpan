import { useEffect, useRef, useState } from 'react';
import Glyph from './Glyph.jsx';

/** A video with Darpan's own controls: tap to play or pause, sound toggle and a progress line. */
export default function Player({ src, poster, autoPlay = false, loop = false, className = '', fit = 'contain' }) {
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!autoPlay || !ref.current) return;
    // Browsers only autoplay muted; start muted and let the creator turn sound on.
    ref.current.muted = true;
    setMuted(true);
    ref.current.play().catch(() => {});
  }, [src, autoPlay]);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  return (
    <div className={`player ${className}`}>
      <video
        ref={ref}
        src={src}
        poster={poster}
        playsInline
        loop={loop}
        muted={muted}
        preload="metadata"
        style={{ objectFit: fit }}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setProgress(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
      />
      {!playing && (
        <button className="player-play" onClick={toggle} aria-label="Play">
          <Glyph name="play" />
        </button>
      )}
      <button
        className="player-sound"
        onClick={() => {
          setMuted((m) => !m);
          if (ref.current?.paused) ref.current.play().catch(() => {});
        }}
        aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
      >
        <Glyph name={muted ? 'muted' : 'speaker'} size={20} />
      </button>
      <span className="player-progress" aria-hidden="true">
        <i style={{ width: `${progress * 100}%` }} />
      </span>
    </div>
  );
}
