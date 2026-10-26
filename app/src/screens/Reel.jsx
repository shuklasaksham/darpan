import { useEffect, useMemo, useRef, useState } from 'react';
import { editTake, getPlanTakes, getReel, keepTake, makeReel, posterUrl, reuploadTake, stripUrl } from '../api.js';
import { Paywall, useBilling } from './Plan.jsx';
import Glyph from '../ui/Glyph.jsx';
import { BackBar, Poster, Switch, formatTime } from '../ui/parts.jsx';
import Player from '../ui/Player.jsx';

const secs = (n) => `${Math.max(0, n).toFixed(1)}s`;
const stamp = (n) => `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, '0')}`;

/**
 * Once every shot has a kept take: put the shots in order, trim them, swap
 * takes and fix caption words; then make the reel and post it. A finished reel
 * stays here, next to its shots, until a shot changes.
 */
export default function Reel({ planId, shots, kept, caption = '', onKeptChange, onBack, onDone, onReshoot, onMissing }) {
  const [order, setOrder] = useState(() => shots.map((_, i) => i));
  const [captions, setCaptions] = useState(true);
  const [phase, setPhase] = useState('review'); // review | edit | making | done | error
  const [editing, setEditing] = useState(null); // shot index
  const [takes, setTakes] = useState(null); // every take of this shoot, from the server
  const [status, setStatus] = useState({ progress: 0, stage: '' });
  const [error, setError] = useState('');
  const [reel, setReel] = useState(null); // last finished reel: { id, takeIds, captions, width, height, durationSeconds, stale }
  const [dirty, setDirty] = useState(false); // shots changed since that reel was made
  const [paywall, setPaywall] = useState(false);
  const [billing] = useBilling();
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false; // StrictMode mounts twice in development
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    if (!planId) return setTakes([]);
    getPlanTakes(planId)
      .then(({ takes, reel: saved }) => {
        setTakes(takes);
        if (!saved) return;
        setReel(saved);
        if (saved.stale) return;
        // Show the shots in the order the reel used.
        const indexOf = (id) => Number(Object.keys(kept).find((i) => kept[i].takeId === id));
        const savedOrder = saved.takeIds.map(indexOf);
        if (savedOrder.length === shots.length && savedOrder.every((i) => Number.isInteger(i))) setOrder(savedOrder);
        setCaptions(saved.captions);
      })
      .catch(() => setTakes([]));
  }, [planId]);

  const takeInfo = (id) => takes?.find((t) => t.id === id) ?? null;
  const lengthOf = (i) => {
    const t = takeInfo(kept[i].takeId);
    return t ? t.trim.end - t.trim.start : (kept[i].result?.durationSeconds ?? 0);
  };
  const total = order.reduce((n, i) => n + lengthOf(i), 0);
  const current = reel && !reel.stale && !dirty ? reel : null;

  async function start(withCaptions = captions) {
    setPhase('making');
    setError('');
    setStatus({ progress: 0, stage: 'Sending your takes' });
    const takeIds = order.map((i) => kept[i].takeId);
    try {
      let created;
      try {
        created = await makeReel({ takeIds, captions: withCaptions });
      } catch (err) {
        if (err.status !== 409 || !err.body?.missing) throw err;
        // The server lost some files (its disk is wiped on restart); this phone still has them.
        setStatus({ progress: 0, stage: 'Re-sending some takes' });
        for (const id of err.body.missing) {
          const entry = Object.values(kept).find((k) => k.takeId === id);
          if (!entry?.blob) {
            // Gone from the server and not on this phone: re-record those shots.
            onMissing(err.body.missing);
            return;
          }
          await reuploadTake(id, entry.blob);
        }
        created = await makeReel({ takeIds, captions: withCaptions });
      }
      await poll(created.reelId);
    } catch (err) {
      if (cancelled.current) return;
      if (err.status === 402) {
        setPhase('review');
        setPaywall(true);
        return;
      }
      setError(err.message);
      setPhase('error');
    }
  }

  async function poll(id) {
    for (;;) {
      if (cancelled.current) return;
      const s = await getReel(id);
      setStatus({ progress: s.progress ?? 0, stage: s.stage ?? '' });
      if (s.status === 'done') {
        setReel({ id, width: s.width, height: s.height, durationSeconds: s.durationSeconds, takeIds: order.map((i) => kept[i].takeId), captions, stale: false });
        setDirty(false);
        return setPhase('done');
      }
      if (s.status === 'error') throw new Error(s.error || 'Making the reel failed. Try again.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const firstPoster = posterUrl(kept[order[0]].takeId);

  return (
    <div className="reel-screen studio">
      {phase === 'review' && (
        <main className="screen with-bar">
          <BackBar onBack={onBack} title="Your reel" label="Back to the camera" />
          <div className="stack tight">
            <h1>
              {shots.length} {shots.length === 1 ? 'shot' : 'shots'} · {formatTime(total)}
            </h1>
            <p className="muted">
              {shots.length > 1 ? 'Drag to reorder. ' : ''}Tap a shot to trim it, pick another take or fix its captions.
            </p>
          </div>
          {current && (
            <section className="reel-now">
              <div className="reel-now-media">
                <Player src={`/api/reels/${current.id}/file`} poster={firstPoster} fit="cover" />
              </div>
              <div className="stack grow">
                <span className="eyebrow">Your reel{current.durationSeconds ? ` · ${formatTime(current.durationSeconds)}` : ''}</span>
                <p className="small muted">All {shots.length} shots, joined{current.captions ? ' and captioned' : ''}. Change a shot below to make a new one.</p>
                <button className="secondary" style={{ minHeight: 44 }} onClick={() => setPhase('done')}>
                  <Glyph name="share" size={18} /> Post it
                </button>
              </div>
            </section>
          )}
          {reel && !current && (
            <p className="notice">
              <Glyph name="alert" size={20} />
              You changed some shots. Make the reel again to include them.
            </p>
          )}
          {current && <h3>Shots</h3>}
          <ShotOrder
            order={order}
            onOrder={(o) => {
              setOrder(o);
              setDirty(true);
            }}
            renderRow={(i) => {
              const t = takeInfo(kept[i].takeId);
              const score = kept[i].result?.score ?? t?.score;
              return (
                <button className="main" onClick={() => planId && (setEditing(i), setPhase('edit'))} aria-label={`Edit shot ${i + 1}`}>
                  <Poster className="poster" src={posterUrl(kept[i].takeId)}>
                    {score != null && <b>{(score / 10).toFixed(1)}</b>}
                  </Poster>
                  <span className="grow">
                    <span className="eyebrow" style={{ display: 'block' }}>
                      Shot {i + 1} · {shots[i].title}
                    </span>
                    <span className="say" style={{ display: 'block' }}>
                      {shots[i].line}
                    </span>
                    <span className="meta" style={{ display: 'block' }}>
                      {[t?.takeNumber && `Take ${t.takeNumber}`, formatTime(lengthOf(i)), t?.trim.edited && 'trimmed', score != null && (score / 10).toFixed(1)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </button>
              );
            }}
          />
          <div className="stack">
            <div className="opt-row">
              <Switch
                checked={captions}
                onChange={(v) => {
                  setCaptions(v);
                  setDirty(true);
                }}
              >
                <Glyph name="captions" /> Hinglish captions
              </Switch>
            </div>
            <div className="opt-row">
              <Glyph name="pro" />
              <span className="grow">“Shot with Darpan” tag</span>
              {billing?.plan === 'pro' ? (
                <span className="small muted">Off with Pro</span>
              ) : (
                <button className="link" style={{ color: 'var(--text-brand)', fontWeight: 600 }} onClick={() => setPaywall(true)}>
                  Pro removes it
                </button>
              )}
            </div>
          </div>
          <div className="action-bar">
            {current ? (
              <button className="primary" onClick={() => setPhase('done')}>
                Post it <Glyph name="share" size={20} />
              </button>
            ) : (
              <button className="primary" onClick={() => start()}>
                {reel ? 'Make my reel again' : 'Make my reel'} <Glyph name="reel" size={20} />
              </button>
            )}
          </div>
        </main>
      )}

      {phase === 'edit' && editing != null && (
        <ShotEditor
          shot={shots[editing]}
          index={editing}
          takes={(takes ?? []).filter((t) => t.shotIndex === editing)}
          keptTake={kept[editing]}
          onSaved={(take, picked, changed) => {
            if (changed) setDirty(true);
            setTakes((list) => list.map((t) => (t.id === take.id ? { ...t, ...take } : t)));
            if (picked) {
              onKeptChange((k) => ({ ...k, [editing]: { takeId: take.id, blob: null, url: `/api/takes/${take.id}/file`, result: { id: take.id, score: take.score } } }));
              setTakes((list) => list.map((t) => (t.shotIndex === editing ? { ...t, kept: t.id === take.id } : t)));
            }
            setPhase('review');
          }}
          onBack={() => setPhase('review')}
          onReshoot={() => onReshoot(editing)}
        />
      )}

      {phase === 'making' && <Making status={status} captions={captions} shots={shots.length} title={shots[0]?.line} />}

      {phase === 'error' && (
        <Making
          status={status}
          captions={captions}
          shots={shots.length}
          title={shots[0]?.line}
          failed={error}
          onRetry={() => start()}
          onWithoutCaptions={
            captions
              ? () => {
                  setCaptions(false);
                  start(false);
                }
              : null
          }
          onBack={() => setPhase('review')}
        />
      )}

      {phase === 'done' && reel && (
        <Finished reel={reel} captions={reel.captions ?? captions} caption={caption} onEdit={() => setPhase('review')} onDone={onDone} />
      )}

      {paywall && <Paywall billing={billing} reason={billing && billing.plan !== 'pro' && billing.reelsThisMonth >= billing.reelsPerMonth ? 'limit' : 'upgrade'} posterSrc={firstPoster} onClose={() => setPaywall(false)} />}
    </div>
  );
}

/** A list the creator reorders by dragging a row's handle (or with the arrow keys on it). */
function ShotOrder({ order, onOrder, renderRow }) {
  const listRef = useRef(null);
  const [drag, setDrag] = useState(null); // { item, startY, dy }

  const move = (from, to) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onOrder(next);
  };

  function onPointerDown(e, item) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ item, startY: e.clientY, dy: 0 });
  }

  function onPointerMove(e) {
    if (!drag) return;
    const rows = [...listRef.current.children];
    const from = order.indexOf(drag.item);
    const rect = rows[from].getBoundingClientRect();
    const dy = e.clientY - drag.startY;
    // Swap with the neighbour once the row is dragged past its middle.
    if (dy > rect.height / 2 && from < order.length - 1) {
      move(from, from + 1);
      setDrag({ ...drag, startY: drag.startY + rows[from + 1].getBoundingClientRect().height, dy: dy - rect.height });
    } else if (dy < -rect.height / 2 && from > 0) {
      move(from, from - 1);
      setDrag({ ...drag, startY: drag.startY - rows[from - 1].getBoundingClientRect().height, dy: dy + rect.height });
    } else {
      setDrag({ ...drag, dy });
    }
  }

  return (
    <ol className="take-list" ref={listRef}>
      {order.map((i, pos) => (
        <li
          key={i}
          className={`take-row ${drag?.item === i ? 'dragging' : ''}`}
          style={drag?.item === i ? { transform: `translateY(${drag.dy}px)` } : undefined}
        >
          {renderRow(i)}
          {order.length > 1 && (
            <button
              className="icon-btn bare drag-handle"
              aria-label={`Move shot ${i + 1}. Use the up and down arrow keys.`}
              onPointerDown={(e) => onPointerDown(e, i)}
              onPointerMove={onPointerMove}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') (e.preventDefault(), move(pos, pos - 1));
                if (e.key === 'ArrowDown') (e.preventDefault(), move(pos, pos + 1));
              }}
            >
              <Glyph name="drag" />
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

/** One shot: trim the take, switch to another take, fix caption words. */
function ShotEditor({ shot, index, takes, keptTake, onSaved, onBack, onReshoot }) {
  const usable = takes.filter((t) => t.available);
  const [takeId, setTakeId] = useState(keptTake.takeId);
  const take = takes.find((t) => t.id === takeId) ?? null;
  const duration = take?.durationSeconds || 0;
  const [trim, setTrim] = useState(take?.trim ?? { start: 0, end: duration });
  const [edits, setEdits] = useState(take?.captionEdits ?? {});
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [wordAt, setWordAt] = useState(null); // index being typed into
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const videoRef = useRef(null);

  // Switching takes starts from that take's own trim and captions.
  useEffect(() => {
    if (!take) return;
    setTrim(take.trim);
    setEdits(take.captionEdits ?? {});
    setWordAt(null);
  }, [takeId]);

  const src = takeId === keptTake.takeId && keptTake.blob ? keptTake.url : `/api/takes/${takeId}/file`;
  const words = take?.words ?? [];
  const shown = (w, i) => (Object.hasOwn(edits, i) ? edits[i] : w.text);
  const included = (w, i) => (Object.hasOwn(edits, i) ? edits[i] !== '' : !w.filler);
  const live = words.findIndex((w) => w.start <= time && time < w.end + 0.3);
  const liveCaption = live >= 0 && included(words[live], live) ? shown(words[live], live) : '';

  function onTime() {
    const v = videoRef.current;
    if (!v) return;
    if (v.currentTime < trim.start - 0.05 || v.currentTime > trim.end) v.currentTime = trim.start;
    setTime(v.currentTime);
  }

  async function done() {
    if (!take) return onBack();
    setBusy(true);
    setError('');
    try {
      const patch = {};
      if (Math.abs(trim.start - take.trim.start) > 0.04 || Math.abs(trim.end - take.trim.end) > 0.04) {
        patch.trimStart = trim.start;
        patch.trimEnd = trim.end;
      }
      if (JSON.stringify(edits) !== JSON.stringify(take.captionEdits ?? {})) patch.captionEdits = edits;
      const saved = Object.keys(patch).length ? (await editTake(take.id, patch)).take : take;
      const picked = take.id !== keptTake.takeId;
      if (picked) await keepTake(take.id);
      onSaved({ ...take, ...saved }, picked, picked || Object.keys(patch).length > 0);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main className="screen with-bar" style={{ gap: 'var(--space-5)' }}>
      <BackBar onBack={onBack} title={`Shot ${index + 1} · ${shot.title}`} strong />
      {!take ? (
        <p className="muted">This take isn’t on the server any more. Re-shoot it to edit.</p>
      ) : (
        <>
          <div className="editor-preview">
            <video
              ref={videoRef}
              src={src}
              playsInline
              autoPlay
              muted={false}
              loop
              onLoadedMetadata={() => videoRef.current && (videoRef.current.currentTime = trim.start)}
              onTimeUpdate={onTime}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
            {liveCaption && <span className="cap">{liveCaption}</span>}
            {!playing && (
              <button className="icon-btn ink play" onClick={() => videoRef.current?.play()} aria-label="Play" style={{ background: 'rgb(10 10 10 / 0.6)', color: '#fff' }}>
                <Glyph name="play" />
              </button>
            )}
          </div>

          {duration > 0 && (
            <div className="stack">
              <div className="trim-times">
                <span>{stamp(trim.start)}</span>
                <b>
                  {secs(trim.end - trim.start)} kept of {secs(duration)}
                </b>
                <span>{stamp(trim.end)}</span>
              </div>
              <TrimBar takeId={take.id} duration={duration} trim={trim} time={time} onTrim={(t) => {
                setTrim(t);
                if (videoRef.current) videoRef.current.currentTime = t.start;
              }} />
            </div>
          )}

          {usable.length > 1 && (
            <section className="stack">
              <h3 className="row" style={{ gap: 8 }}>
                <Glyph name="take" size={22} /> Take
              </h3>
              <div className="take-picker">
                {takes.map((t) => (
                  <button key={t.id} aria-pressed={t.id === takeId} disabled={!t.available} onClick={() => setTakeId(t.id)}>
                    Take {t.takeNumber}
                    <b>{t.available ? (t.score / 10).toFixed(1) : '—'}</b>
                  </button>
                ))}
              </div>
            </section>
          )}

          {words.length > 0 && (
            <section className="stack">
              <div className="row between">
                <h3 className="row" style={{ gap: 8 }}>
                  <Glyph name="captions" size={22} /> Captions
                </h3>
                <span className="small muted">Tap a word to fix it</span>
              </div>
              <div className="word-chips">
                {words.map((w, i) =>
                  wordAt === i ? (
                    <input
                      key={i}
                      autoFocus
                      defaultValue={shown(w, i)}
                      aria-label={`Fix “${w.text}”. Leave empty to drop it.`}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                      onBlur={(e) => {
                        const value = e.currentTarget.value.trim();
                        setEdits((current) => {
                          const next = { ...current };
                          if (value === w.text && !w.filler) delete next[i];
                          else next[i] = value;
                          return next;
                        });
                        setWordAt(null);
                      }}
                    />
                  ) : (
                    <button
                      key={i}
                      className={!included(w, i) ? 'filler' : Object.hasOwn(edits, i) ? 'edited' : ''}
                      onClick={() => setWordAt(i)}
                      title={!included(w, i) ? 'Left out of the captions' : undefined}
                    >
                      {shown(w, i) || w.text}
                    </button>
                  ),
                )}
              </div>
              <p className="tiny muted">Dashed words are left out of the captions. Clear a word to drop it.</p>
            </section>
          )}
          {error && <p className="error">{error}</p>}
        </>
      )}
      <div className="action-bar">
        <button className="secondary" onClick={onReshoot}>
          Re-shoot <Glyph name="reshoot" size={20} />
        </button>
        <button className="primary" onClick={done} disabled={busy}>
          {busy ? 'Saving…' : 'Done'} <Glyph name="check" size={20} />
        </button>
      </div>
    </main>
  );
}

/** Frames of the take with two handles; what's between them goes in the reel. */
function TrimBar({ takeId, duration, trim, time, onTrim }) {
  const barRef = useRef(null);
  const [dragging, setDragging] = useState(null); // 'start' | 'end'
  const pct = (t) => `${(t / duration) * 100}%`;
  const MIN = 0.5;

  const at = (clientX) => {
    const r = barRef.current.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const set = (which, t) =>
    onTrim(which === 'start' ? { ...trim, start: Math.min(t, trim.end - MIN) } : { ...trim, end: Math.max(t, trim.start + MIN) });

  const handle = (which) => ({
    className: 'handle',
    style: { left: pct(trim[which]) },
    'aria-label': which === 'start' ? 'Start of the trim' : 'End of the trim',
    role: 'slider',
    'aria-valuemin': 0,
    'aria-valuemax': Number(duration.toFixed(1)),
    'aria-valuenow': Number(trim[which].toFixed(1)),
    onPointerDown: (e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(which);
    },
    onPointerMove: (e) => dragging === which && set(which, at(e.clientX)),
    onPointerUp: () => setDragging(null),
    onPointerCancel: () => setDragging(null),
    onKeyDown: (e) => {
      const step = e.shiftKey ? 1 : 0.1;
      if (e.key === 'ArrowLeft') (e.preventDefault(), set(which, trim[which] - step));
      if (e.key === 'ArrowRight') (e.preventDefault(), set(which, trim[which] + step));
    },
  });

  return (
    <div className="trim" ref={barRef} style={{ backgroundImage: `url(${stripUrl(takeId)})`, backgroundSize: '100% 100%' }}>
      <span className="dim" style={{ left: 0, width: pct(trim.start) }} />
      <span className="dim" style={{ left: pct(trim.end), right: 0 }} />
      <span className="window" style={{ left: pct(trim.start), width: `calc(${pct(trim.end - trim.start)})` }} />
      {time >= trim.start && time <= trim.end && <span className="head" style={{ left: pct(time) }} />}
      <button {...handle('start')} />
      <button {...handle('end')} />
    </div>
  );
}

const STAGES = [
  { match: /caption/i, label: 'Writing your Hinglish captions', captionsOnly: true },
  { match: /editing shot|getting/i, label: 'Trimming each take to your words' },
  { match: /joining|ready/i, label: (n) => `Joining ${n} shots into one video` },
];

function Making({ status, captions, shots, title, failed, onRetry, onWithoutCaptions, onBack }) {
  const steps = STAGES.filter((s) => captions || !s.captionsOnly);
  const nowIndex = Math.max(0, steps.findIndex((s) => s.match.test(status.stage)));
  const pct = Math.round(status.progress * 100);
  return (
    <main className={`screen ${failed ? 'with-bar' : ''}`}>
      {failed && <BackBar onBack={onBack} title={title ? `${title.split(/\s+/).slice(0, 5).join(' ')}…` : 'Your reel'} />}
      <div className="making" style={{ paddingTop: failed ? 0 : 'var(--space-12)' }}>
        <h1>{failed ? 'Your reel didn’t finish' : 'Making your reel'}</h1>
        <p className="pct" aria-live="polite">
          {pct}%
        </p>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="muted">{failed ? `Stopped at ${pct}% · your takes are safe` : status.stage}</p>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i} className={i < nowIndex ? 'done' : i === nowIndex ? 'now' : ''}>
              {typeof s.label === 'function' ? s.label(shots) : s.label}
            </li>
          ))}
        </ol>
        {failed ? <p className="error">{failed}</p> : <p className="small muted">Keep this screen open. It usually takes under a minute.</p>}
      </div>
      {failed && (
        <div className="action-bar">
          {onWithoutCaptions && (
            <button className="secondary" onClick={onWithoutCaptions}>
              Without captions
            </button>
          )}
          <button className="primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </main>
  );
}

const TARGETS = [
  { id: 'instagram', label: 'Instagram Reels' },
  { id: 'whatsapp', label: 'WhatsApp Status' },
  { id: 'youtube', label: 'YouTube Shorts' },
];

/** The finished reel: where to post it, with the caption already copied. */
function Finished({ reel, captions, caption, onEdit, onDone }) {
  const src = `/api/reels/${reel.id}/file`;
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);

  // Fetch the file up front so Share opens instantly (browsers only allow the
  // share sheet right after a tap).
  useEffect(() => {
    let alive = true;
    fetch(src)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('download failed'))))
      .then((blob) => alive && setFile(new File([blob], `darpan-reel-${reel.id}.mp4`, { type: 'video/mp4' })))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [src, reel.id]);

  const canShare = Boolean(file && navigator.canShare?.({ files: [file] }));
  const meta = useMemo(
    () =>
      [
        reel.durationSeconds && formatTime(reel.durationSeconds),
        reel.width && `${reel.width} × ${reel.height}`,
        captions && 'Hinglish captions',
        copied && 'caption copied',
      ]
        .filter(Boolean)
        .join(' · '),
    [reel, captions, copied],
  );

  async function share(target) {
    setMessage('');
    if (caption) {
      await navigator.clipboard
        ?.writeText(caption)
        .then(() => setCopied(true))
        .catch(() => {});
    }
    if (!canShare) {
      setMessage(`This browser can’t send videos straight to ${target.label}. Save it to your phone, then post it from your gallery.`);
      return;
    }
    try {
      await navigator.share({ files: [file], title: 'My reel', text: caption || undefined });
    } catch (err) {
      if (err.name !== 'AbortError') setMessage('Couldn’t open sharing. Save it to your phone instead.');
    }
  }

  return (
    <main className="with-bar" style={{ paddingBottom: 'calc(var(--bar-h) + var(--safe-b) + 24px)' }}>
      <div className="final-media">
        <Player src={src} autoPlay loop />
        <div className="over">
          <button className="cam-btn" onClick={onEdit} aria-label="Back to your reel and its shots">
            <Glyph name="back" size={22} />
          </button>
        </div>
      </div>
      <div className="review-body">
        <div className="stack tight">
          <h1>Your reel is ready</h1>
          <p className="small muted">{meta}</p>
        </div>
        <div className="targets">
          {TARGETS.map((t) => (
            <button key={t.id} onClick={() => share(t)} disabled={!file}>
              <Glyph name="share" />
              {t.label}
            </button>
          ))}
        </div>
        {!file && <p className="small muted pulse">Getting your reel ready to share…</p>}
        {caption && <p className="tiny muted">Your caption is copied when you tap a button: paste it into the post.</p>}
        {message && <p className="notice">{message}</p>}
        <div className="row between">
          <button className="link strong" onClick={onEdit}>
            See shots
          </button>
          <button className="link strong" onClick={onDone}>
            Start a new reel
          </button>
        </div>
      </div>
      <div className="action-bar">
        <a className="button primary" href={`${src}?download=1`} download={`darpan-reel-${reel.id}.mp4`}>
          Save to my phone <Glyph name="save" size={20} />
        </a>
      </div>
    </main>
  );
}
