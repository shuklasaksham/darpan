import { useEffect, useMemo, useRef, useState } from 'react';
import { editTake, getPlanTakes, getReel, keepTake, makeReel, posterUrl, reuploadTake, savePost, stripUrl, waitForUploads } from '../api.js';
import { Paywall, useBilling } from './Plan.jsx';
import Glyph from '../ui/Glyph.jsx';
import { BackBar, Poster, Switch, formatTime } from '../ui/parts.jsx';
import Player from '../ui/Player.jsx';
import { captionLines, editLine } from '../captions.js';

const secs = (n) => `${Math.max(0, n).toFixed(1)}s`;
const stamp = (n) => `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, '0')}`;

/**
 * Once every shot has a kept take: put the shots in order, trim them, swap
 * takes and fix caption words; then make the reel and post it. A finished reel
 * stays here, next to its shots, until a shot changes.
 */
export default function Reel({ planId, shots, kept, postCaption = '', hashtags = [], hookText: savedHook = '', hookOn: savedHookOn = false, onPostChange, onKeptChange, onBack, onDone, onReshoot, onMissing }) {
  const [order, setOrder] = useState(() => shots.map((_, i) => i));
  const [captions, setCaptions] = useState(true);
  const [hookText, setHookText] = useState(savedHook);
  const [hookOn, setHookOn] = useState(savedHookOn);
  const hookSaved = useRef({ text: savedHook, on: savedHookOn });
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

  // Each view (shots, one shot, making, finished) opens at its top; the screen scrolls itself, not the page.
  const screenRef = useRef(null);
  useEffect(() => {
    if (screenRef.current) screenRef.current.scrollTop = 0;
  }, [phase]);

  // The hook text is part of the plan; a change means the first shot (and so the reel) is made again.
  function saveHook(next) {
    const text = (next.text ?? hookText).trim();
    const on = next.on ?? hookOn;
    if (text === hookSaved.current.text && on === hookSaved.current.on) return;
    hookSaved.current = { text, on };
    setDirty(true);
    onPostChange?.({ hook_text: text, hook_on: on });
    if (planId) savePost(planId, { hookText: text, hookOn: on }).catch(() => {});
  }

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
      // Videos still uploading in the background have to arrive first.
      await waitForUploads(takeIds, (p) => setStatus({ progress: 0, stage: `Uploading your takes · ${Math.round(p * 100)}%` }));
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
    <div className="reel-screen studio" ref={screenRef}>
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
                <Glyph name="captions" /> Captions
              </Switch>
            </div>
            <div className="opt-row hook-row">
              <Switch
                checked={hookOn}
                onChange={(v) => {
                  setHookOn(v);
                  saveHook({ on: v });
                }}
              >
                <Glyph name="idea" /> Hook text for the first 2 seconds
              </Switch>
              {hookOn && (
                <input
                  value={hookText}
                  onChange={(e) => setHookText(e.target.value)}
                  onBlur={() => saveHook({ text: hookText })}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  maxLength={80}
                  placeholder="e.g. Sab chai mein yahi galti karte hain"
                  aria-label="Hook text"
                />
              )}
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
          hook={hookOn && hookText.trim() && order[0] === editing ? hookText.trim() : null}
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
        <Finished
          reel={reel}
          poster={firstPoster}
          captions={reel.captions ?? captions}
          planId={planId}
          postCaption={postCaption}
          hashtags={hashtags}
          onPostChange={onPostChange}
          onEdit={() => setPhase('review')}
          onDone={onDone}
        />
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

/** One shot: trim the take, switch to another take, fix its caption lines. */
function ShotEditor({ shot, index, hook, takes, keptTake, onSaved, onBack, onReshoot }) {
  const usable = takes.filter((t) => t.available);
  const [takeId, setTakeId] = useState(keptTake.takeId);
  const take = takes.find((t) => t.id === takeId) ?? null;
  const duration = take?.durationSeconds || 0;
  const [trim, setTrim] = useState(take?.trim ?? { start: 0, end: duration });
  const [edits, setEdits] = useState(take?.captionEdits ?? {});
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const videoRef = useRef(null);

  // Switching takes starts from that take's own trim and captions.
  useEffect(() => {
    if (!take) return;
    setTrim(take.trim);
    setEdits(take.captionEdits ?? {});
  }, [takeId]);

  const src = takeId === keptTake.takeId && keptTake.blob ? keptTake.url : `/api/takes/${takeId}/file`;
  const words = take?.words ?? [];
  // The same lines the reel will show, so the preview matches it.
  const lines = useMemo(() => captionLines(words, edits, trim), [words, edits, trim]);
  const liveCaption = lines.find((l) => l.start <= time && time < l.end)?.text ?? '';
  const dropped = words.filter((w, i) => w.filler && !Object.hasOwn(edits, i)).length;

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
            {hook && time - trim.start < 2.2 && <span className="hook-cap">{hook}</span>}
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
                {Object.keys(edits).length > 0 && (
                  <button className="link strong" style={{ minHeight: 0, padding: 0 }} onClick={() => setEdits({})}>
                    Undo my fixes
                  </button>
                )}
              </div>
              <div className="caption-lines">
                {lines.map((line) => (
                  <CaptionLine
                    key={`${line.indices[0]}|${line.text}`}
                    line={line}
                    live={line.start <= time && time < line.end}
                    onChange={(value) => setEdits((current) => editLine(words, current, line.indices, value))}
                    onSeek={() => {
                      if (videoRef.current) videoRef.current.currentTime = Math.max(trim.start, line.start);
                    }}
                  />
                ))}
              </div>
              <p className="tiny muted">
                Tap a line to fix it, exactly as it appears in the reel. Clear a line to drop it.
                {dropped > 0 && ` ${dropped} filler ${dropped === 1 ? 'word (“umm”) is' : 'words (“umm”) are'} left out.`}
              </p>
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

/** One caption line as it reads in the reel; tap to retype it. */
function CaptionLine({ line, live, onChange, onSeek }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <textarea
        className="caption-line editing"
        autoFocus
        rows={1}
        defaultValue={line.text}
        aria-label={`Fix the caption “${line.text}”. Leave it empty to drop it.`}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.preventDefault(), e.currentTarget.blur());
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={(e) => {
          if (e.currentTarget.value.trim() !== line.text) onChange(e.currentTarget.value);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      className={`caption-line ${live ? 'live' : ''}`}
      onClick={() => {
        onSeek();
        setEditing(true);
      }}
    >
      <span>{line.text}</span>
      <Glyph name="edit" size={16} />
    </button>
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
  { match: /caption/i, label: 'Writing your captions', captionsOnly: true },
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

// What Share sends along with the video.
const shareText = () => `I shot this on Darpan, try it now: ${window.location.origin}`;

/** The finished reel: save it or share it, with the post's caption and hashtags to edit and copy. */
function Finished({ reel, poster, captions, planId, postCaption, hashtags, onPostChange, onEdit, onDone }) {
  const src = `/api/reels/${reel.id}/file`;
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState('');

  // Have the file ready so Share opens instantly (browsers only allow the share
  // sheet right after a tap). Fetched a few seconds in, so the video starts
  // playing first instead of sharing the connection with a second download; the
  // server lets the phone cache it, so it usually comes from that cache.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      fetch(src, { priority: 'low' })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('download failed'))))
        .then((blob) => alive && setFile(new File([blob], `darpan-reel-${reel.id}.mp4`, { type: 'video/mp4' })))
        .catch(() => {});
    }, 3000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [src, reel.id]);

  const facts = [
    reel.durationSeconds && formatTime(reel.durationSeconds),
    reel.height && `${Math.min(reel.width, reel.height)}p`,
    captions && 'Captions',
  ].filter(Boolean);
  // Phones that can share files wait for the video; elsewhere Share sends the text alone.
  const sharesFiles = Boolean(navigator.canShare);

  async function share() {
    setMessage('');
    const text = shareText();
    try {
      if (file && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text });
      else if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        setMessage('Link copied. Save the reel to your phone to post the video.');
      }
    } catch (err) {
      if (err.name !== 'AbortError') setMessage('Couldn’t open sharing. Save it to your phone instead.');
    }
  }

  return (
    <main className="final with-bar">
      <div className="final-stage">
        <div className="final-video">
          <Player src={src} poster={poster} autoPlay loop fit="cover" />
        </div>
        <button className="cam-btn final-back" onClick={onEdit} aria-label="Back to your reel and its shots">
          <Glyph name="back" size={22} />
        </button>
      </div>

      <div className="final-body">
        <div className="final-head">
          <span className="ready-badge">
            <Glyph name="check" size={16} /> Ready to post
          </span>
          <h1>Your reel is ready</h1>
          {facts.length > 0 && (
            <ul className="facts" aria-label="About this reel">
              {facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>

        <PostCard planId={planId} postCaption={postCaption} hashtags={hashtags} onPostChange={onPostChange} />

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
        <button className="secondary" onClick={share} disabled={sharesFiles && !file}>
          {sharesFiles && !file ? 'Getting ready…' : 'Share'} <Glyph name="share" size={20} />
        </button>
        <a className="button primary" href={`${src}?download=1`} download={`darpan-reel-${reel.id}.mp4`}>
          Save to phone <Glyph name="save" size={20} />
        </a>
      </div>
    </main>
  );
}

// Letters (with Devanagari vowel signs), digits and underscores, as Instagram allows.
const cleanTag = (value) => value.replace(/^#+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '');

/** The post's caption and hashtags: edit them here, then copy them into Instagram. */
function PostCard({ planId, postCaption, hashtags, onPostChange }) {
  const [caption, setCaption] = useState(postCaption);
  const [tags, setTags] = useState(() => (hashtags ?? []).map((t) => `#${cleanTag(t)}`).filter((t) => t.length > 1));
  const [draft, setDraft] = useState('');
  const [state, setState] = useState(''); // '' | saving | saved | copied | error
  const saved = useRef({ caption: postCaption, tags: tags.join(' ') });
  const queue = useRef(Promise.resolve()); // one save at a time, so an older one never lands last

  function save(next = {}) {
    const post = { caption: next.caption ?? caption, hashtags: next.tags ?? tags };
    onPostChange?.(post);
    if (!planId) return;
    queue.current = queue.current.then(async () => {
      if (post.caption === saved.current.caption && post.hashtags.join(' ') === saved.current.tags) return;
      setState('saving');
      try {
        const result = await savePost(planId, post);
        saved.current = { caption: result.caption, tags: result.hashtags.join(' ') };
        setState('saved');
      } catch {
        setState('error');
      }
    });
  }

  // Adds what was typed or pasted: several hashtags at once when separated by spaces or commas.
  function addTag(value) {
    setDraft('');
    const next = [...tags];
    for (const word of value.split(/[\s,]+/)) {
      const tag = cleanTag(word);
      if (tag && !next.some((t) => t.toLowerCase() === `#${tag}`.toLowerCase())) next.push(`#${tag}`);
    }
    if (next.length === tags.length) return;
    setTags(next);
    save({ tags: next });
  }

  function removeTag(tag) {
    const next = tags.filter((t) => t !== tag);
    setTags(next);
    save({ tags: next });
  }

  async function copy() {
    const text = [caption.trim(), tags.join(' ')].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('error');
    }
  }

  const status = {
    saving: 'Saving…',
    saved: 'Saved',
    copied: 'Copied. Paste it when you post',
    error: 'Couldn’t do that. Check your connection and try again',
  }[state];
  return (
    <section className="post-card" aria-label="Caption and hashtags">
      <div className="row between">
        <h3>Caption</h3>
        <button className="copy-btn" onClick={copy}>
          <Glyph name={state === 'copied' ? 'check' : 'copy'} size={18} /> {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <textarea
        value={caption}
        onChange={(e) => {
          setCaption(e.target.value);
          setState('');
        }}
        onBlur={() => save()}
        placeholder="Write what goes under your reel"
        maxLength={2200}
        rows={3}
        aria-label="Caption"
      />
      <div className="tags" role="list" aria-label="Hashtags">
        {tags.map((t) => (
          <span key={t} className="tag-chip" role="listitem">
            {t}
            <button onClick={() => removeTag(t)} aria-label={`Remove ${t}`}>
              <Glyph name="x" size={14} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => (/[\s,]$/.test(e.target.value) ? addTag(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.preventDefault(), addTag(draft));
            if (e.key === 'Backspace' && !draft && tags.length) removeTag(tags.at(-1));
          }}
          onBlur={() => draft && addTag(draft)}
          placeholder={tags.length ? '#add' : '#add a hashtag'}
          aria-label="Add a hashtag"
          enterKeyHint="done"
        />
      </div>
      <p className="tiny muted" aria-live="polite">
        {status ?? 'Copy it, then paste it when you post on Instagram or Shorts.'}
      </p>
    </section>
  );
}
