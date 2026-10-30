// Turns raw check results into one tip at a time, on screen and out loud,
// following "How Darpan speaks" in the Shooting Standards.

import { CHECKS, lineFor, rank } from './standards.js';

export const PERSIST_MS = 1500; // rule 5: a problem must last this long before a tip
const MIN_SHOW_MS = 2000; // rule 6: a tip stays on screen at least this long
const ACT_MS = 3000; // rule 6: after a spoken tip, give the creator this long to act
const REPEAT_MS = 9000; // before the same tip is said a second time
const MAX_SAYS = 2; // rule 8: said twice and still ignored, stop repeating it
const FIXED_MS = 1500; // gone this long counts as fixed (rule 5, the other way round)
const PRAISE_SHOW_MS = 2000;
const WAIT_FIRST_MS = 8000; // the loop waits this long for a stop that is still being looked at (Claude)

// The order the voice goes round, one tip per stop, then round again: so no one
// thing (a tilt, say) takes over. A stop with nothing to fix is skipped. Within
// a stop, the standards' order picks the tip.
export const LOOP = ['background', 'light', 'frame', 'sound'];
const STOP = {
  background: 'background',
  outfit: 'background',
  light: 'light',
  orientation: 'frame',
  steady: 'frame',
  framing: 'frame',
  angle: 'frame',
  lens: 'frame',
  sound: 'sound',
  delivery: 'sound',
};
export const stopFor = (id) => STOP[CHECKS[id]?.area] ?? 'frame';
// The line each stop says once when it's checked and fine: the praise of its first check.
const FINE = { background: 'B1', light: 'L1', frame: 'F1' };

/**
 * One coach per camera session. Each tick, `update` gets the failing checks
 * ({ id, fill? }) and returns what to show; it speaks through the Speaker.
 */
export class Coach {
  constructor(speaker) {
    this.speaker = speaker;
    this.reset();
  }

  /** New shot, or back from a take: forget what was said. */
  reset() {
    this.since = new Map(); // id -> first seen
    this.gone = new Map(); // id -> first not seen (for praise)
    this.said = new Map(); // id -> { count, at }: counts the whole shot, fixed or not
    this.praised = new Set(); // rule 7: praise each fix once
    this.ignored = new Map(); // id -> shown text, for the notes after the take
    this.shown = null; // { id, at, text }
    this.praise = null; // { id, text, until }
    this.allPassSaid = false;
    this.lastPraiseAt = -Infinity;
    this.lastSaidAt = -Infinity;
    this.turn = 0; // the next stop in LOOP
    this.confirmed = new Set(); // stops already said to be fine this shot
    this.fineSince = {}; // stop -> when it was last found fine (checked, nothing failing)
    this.startedAt = null; // first update this shot
  }

  /** Tips the creator didn't act on after hearing them twice (rule 8). */
  ignoredTips() {
    return [...this.ignored].map(([id, text]) => ({ id, text }));
  }

  update(problems, { now, recording, language, quiet = false, checked = {}, pending = {} }) {
    this.startedAt ??= now;
    this.pending = pending;
    const failing = new Map();
    for (const p of problems) if (CHECKS[p.id] && !failing.has(p.id)) failing.set(p.id, p);

    for (const id of [...this.since.keys()]) {
      if (!failing.has(id)) {
        this.since.delete(id);
        if (this.said.has(id) && !this.gone.has(id)) this.gone.set(id, now);
      }
    }
    for (const id of failing.keys()) {
      if (!this.since.has(id)) this.since.set(id, now);
      this.gone.delete(id);
    }

    // Rule 7: once a tip the creator heard is fixed, praise it once.
    for (const [id, at] of [...this.gone]) {
      if (now - at < FIXED_MS) continue;
      this.gone.delete(id);
      this.ignored.delete(id);
      if (recording || !CHECKS[id].praise || this.praised.has(id)) continue;
      this.praised.add(id);
      const line = lineFor(id, language, null, 'praise');
      this.praise = { id, text: line.text, until: now + PRAISE_SHOW_MS };
      this.lastPraiseAt = now;
      this.say(line, now);
    }

    // A stop counts as fine once it has been checked and clean for 1.5 s, the
    // same wait problems get, so a problem that is just appearing isn't missed.
    for (const stop of LOOP) {
      const clean = checked[stop] && ![...failing.keys()].some((id) => stopFor(id) === stop);
      this.fineSince[stop] = clean ? (this.fineSince[stop] ?? now) : null;
    }

    // Candidates: lasted 1.5 s and allowed now, in the standards' order. Tips
    // given up on (rule 8) are only shown, quietly, when nothing else is left.
    const lasting = [...failing.values()]
      .filter((p) => now - this.since.get(p.id) >= PERSIST_MS)
      .filter((p) => !recording || CHECKS[p.id].tag === 'recording')
      .sort((a, b) => rank(a.id) - rank(b.id));
    const candidates = lasting.filter((p) => !this.ignored.has(p.id));

    if (recording) {
      // Rule 10: while recording, speak only when the take is being ruined.
      const top = candidates[0] ?? null;
      this.show(top, now, failing);
      if (top && !quiet && CHECKS[top.id].ruin && this.canSpeak(now)) this.tell(top, now, language);
    } else if (!quiet && this.canSpeak(now)) {
      // Between takes: the next stop in the loop that has something to say.
      const next = this.nextInLoop(candidates, now, language);
      if (next?.fine) this.confirm(next.stop, now, language);
      else if (next) this.tell(next, now, language);
    }
    if (!recording) {
      // On screen: the tip just said while it still needs fixing, else what comes next.
      const said = this.shown && failing.get(this.shown.id);
      this.show(said && !this.ignored.has(said.id) ? said : this.peek(candidates), now, failing);
    }
    const top = this.shown && failing.get(this.shown.id);

    // Section 6: every check passes: say the final line once.
    // Not before everything has been looked at (the background by Claude).
    if (!recording && failing.size === 0 && !quiet && !Object.values(pending).some(Boolean)) {
      this.allSince ??= now;
      if (!this.allPassSaid && now - this.allSince >= PERSIST_MS) {
        this.allPassSaid = true;
        // Right after a praise line, "Perfect" again would be one line too many.
        if (now - this.lastPraiseAt > 4000) this.say(lineFor('ALL', language, null, 'praise'), now);
      }
    } else {
      this.allSince = null;
    }

    if (this.praise && now < this.praise.until) return { praise: true, id: this.praise.id, text: this.praise.text };
    this.praise = null;
    if (top) return { id: top.id, text: lineFor(top.id, language, top.fill).text, quiet: recording && !CHECKS[top.id].ruin };
    const given = lasting[0];
    if (given) return { id: given.id, text: lineFor(given.id, language, given.fill).text, quiet: true };
    return null;
  }

  /** Rule 6: a tip stays on screen at least 2 s unless it was fixed. */
  show(problem, now, failing) {
    if (this.shown && problem?.id !== this.shown.id && now - this.shown.at < MIN_SHOW_MS && failing.has(this.shown.id)) return;
    if (!problem) this.shown = null;
    else if (problem.id !== this.shown?.id) this.shown = { id: problem.id, at: now };
  }

  /** The speaker is free and the creator has had time to act on the last tip. */
  canSpeak(now) {
    const speaker = this.speaker;
    if (!speaker || speaker.muted || speaker.speaking) return false;
    return now - Math.max(this.lastSaidAt, speaker.lastAt) >= ACT_MS;
  }

  /** Can this tip be said now? Said twice already and still failing: given up (rule 8). */
  sayable(problem, now, language) {
    if (CHECKS[problem.id].silent) return false;
    const said = this.said.get(problem.id) ?? { count: 0, at: -Infinity };
    if (now - said.at < REPEAT_MS) return false;
    if (said.count >= MAX_SAYS) {
      this.ignored.set(problem.id, lineFor(problem.id, language, problem.fill).text);
      return false;
    }
    return true;
  }

  /**
   * Going round LOOP from the next stop: the first stop with a tip to say, or
   * that has been looked at, is fine, and hasn't been said to be fine yet.
   */
  nextInLoop(candidates, now, language) {
    for (let i = 0; i < LOOP.length; i++) {
      const stop = (this.turn + i) % LOOP.length;
      const tip = candidates.find((p) => stopFor(p.id) === LOOP[stop] && this.sayable(p, now, language));
      // Still being looked at (the background, by Claude): wait for it rather
      // than skip ahead, so the shot starts where the loop starts.
      if (!tip && this.pending?.[LOOP[stop]] && now - this.startedAt < WAIT_FIRST_MS) return null;
      // A problem here that is still in its 1.5 s wait: wait for it too.
      if (!tip && [...this.since].some(([id, at]) => stopFor(id) === LOOP[stop] && now - at < PERSIST_MS && !this.ignored.has(id))) return null;
      const since = this.fineSince[LOOP[stop]];
      const fine = !tip && FINE[LOOP[stop]] && since != null && now - since >= PERSIST_MS && !this.confirmed.has(LOOP[stop]);
      if (tip || fine) {
        this.turn = (stop + 1) % LOOP.length;
        return tip ?? { fine: true, stop: LOOP[stop] };
      }
    }
    return null;
  }

  /** Says once that a stop is fine: "Clean background. Nice.", "Great light." */
  confirm(stop, now, language) {
    this.confirmed.add(stop);
    const line = lineFor(FINE[stop], language, null, 'praise');
    this.praise = { id: FINE[stop], text: line.text, until: now + PRAISE_SHOW_MS };
    this.lastPraiseAt = now;
    this.say(line, now);
  }

  /** What the loop will come to next, for the screen (silent tips included). */
  peek(candidates) {
    for (let i = 0; i < LOOP.length; i++) {
      const tip = candidates.find((p) => stopFor(p.id) === LOOP[(this.turn + i) % LOOP.length]);
      if (tip) return tip;
    }
    return null;
  }

  tell(problem, now, language) {
    const said = this.said.get(problem.id) ?? { count: 0, at: -Infinity };
    if (now - said.at < REPEAT_MS || said.count >= MAX_SAYS) return;
    this.said.set(problem.id, { count: said.count + 1, at: now });
    this.shown = { id: problem.id, at: now };
    this.say(lineFor(problem.id, language, problem.fill), now);
  }

  say(line, now) {
    if (!line || !this.speaker || this.speaker.muted) return;
    this.lastSaidAt = now;
    this.speaker.stop();
    this.speaker.say(line.spoken, line.languageCode);
  }
}

/**
 * Speaks one tip at a time in an Indian voice: Sarvam Bulbul through the
 * server, falling back to the phone's own voice.
 */
export class Speaker {
  constructor({ useSarvam }) {
    this.useSarvam = useSarvam;
    this.speaking = false;
    this.lastAt = 0;
    this.lastById = new Map();
    this.clips = new Map(); // text -> object URL
    // One audio element for every clip: iOS only lets an element play without a
    // tap once it has been started from a tap (see unlock).
    this.audio = typeof Audio === 'undefined' ? null : new Audio();
    if (this.audio) this.audio.setAttribute('playsinline', '');
    this.muted = false;
  }

  /** Call from a tap (e.g. "Start shooting") so later tips can play on iOS. */
  unlock() {
    if (this.unlocked || !this.audio) return;
    this.unlocked = true;
    // A tiny silent WAV.
    this.audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    this.audio.play().catch(() => {});
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }

  async say(text, languageCode) {
    this.speaking = true;
    const turn = (this.turn = (this.turn ?? 0) + 1);
    try {
      if (this.useSarvam) {
        await this.playSarvam(text, languageCode);
      } else {
        await this.playDevice(text, languageCode);
      }
    } catch {
      // Stopped on purpose (stop() or a newer line): don't fall back and say it again.
      if (turn !== this.turn) return;
      try {
        await this.playDevice(text, languageCode);
      } catch {}
    } finally {
      if (turn === this.turn) this.speaking = false;
      this.lastAt = Date.now();
    }
  }

  async playSarvam(text, languageCode) {
    const key = `${languageCode}|${text}`;
    let url = this.clips.get(key);
    if (!url) {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, languageCode }),
      });
      if (!res.ok) throw new Error('tts failed');
      url = URL.createObjectURL(await res.blob());
      this.clips.set(key, url);
    }
    await new Promise((resolve, reject) => {
      const audio = this.audio;
      audio.onended = resolve;
      audio.onerror = reject;
      audio.src = url;
      audio.play().catch(reject);
    });
  }

  playDevice(text, languageCode) {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) return reject(new Error('no speech'));
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = languageCode;
      const voices = speechSynthesis.getVoices();
      utterance.voice =
        voices.find((v) => v.lang === languageCode) ??
        voices.find((v) => v.lang.endsWith('-IN')) ??
        null;
      utterance.onend = resolve;
      utterance.onerror = reject;
      speechSynthesis.speak(utterance);
    });
  }

  stop() {
    this.turn = (this.turn ?? 0) + 1;
    this.audio?.pause();
    this.audio?.onended?.(); // settle the clip that was playing
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.speaking = false;
  }

  dispose() {
    this.stop();
    for (const url of this.clips.values()) URL.revokeObjectURL(url);
  }
}

/** Rolling microphone level: current RMS, recent peak and the noise floor. */
export class SoundMeter {
  constructor(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.ctx.createMediaStreamSource(stream).connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.history = []; // [time, rmsDb, peakDb]
  }

  read(now) {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.analyser.getFloatTimeDomainData(this.buf);
    let sumSq = 0;
    let peak = 0;
    for (const v of this.buf) {
      sumSq += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-6));
    const rmsDb = toDb(Math.sqrt(sumSq / this.buf.length));
    this.history.push([now, rmsDb, toDb(peak)]);
    while (this.history.length && now - this.history[0][0] > 3000) this.history.shift();
    const sorted = this.history.map((h) => h[1]).sort((a, b) => a - b);
    return {
      rmsDb,
      peakDb: Math.max(...this.history.map((h) => h[2])),
      // 20th percentile of the last 3 s: the level between words.
      floorDb: sorted[Math.floor(sorted.length * 0.2)],
      windowMs: now - this.history[0][0],
    };
  }

  /** Forget recent readings, e.g. after Darpan's own voice played. */
  reset() {
    this.history = [];
  }

  dispose() {
    this.ctx.close().catch(() => {});
  }
}
