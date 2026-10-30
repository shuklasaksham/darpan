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
  }

  /** Tips the creator didn't act on after hearing them twice (rule 8). */
  ignoredTips() {
    return [...this.ignored].map(([id, text]) => ({ id, text }));
  }

  update(problems, { now, recording, language, quiet = false }) {
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

    // Candidates: lasted 1.5 s and allowed now, highest first. Tips given up on
    // (rule 8) are only shown, quietly, when nothing else is left.
    const lasting = [...failing.values()]
      .filter((p) => now - this.since.get(p.id) >= PERSIST_MS)
      .filter((p) => !recording || CHECKS[p.id].tag === 'recording')
      .sort((a, b) => rank(a.id) - rank(b.id));
    const candidates = lasting.filter((p) => !this.ignored.has(p.id));

    // Rule 6: the tip on screen stays at least 2 s unless it was fixed.
    let top = candidates[0] ?? null;
    if (this.shown && top?.id !== this.shown.id && now - this.shown.at < MIN_SHOW_MS && failing.has(this.shown.id)) {
      top = failing.get(this.shown.id);
    }
    if (top && top.id !== this.shown?.id) this.shown = { id: top.id, at: now };
    if (!top) this.shown = null;

    // Rule 10: while recording, speak only when the take is being ruined.
    if (top && !quiet && !CHECKS[top.id].silent && (!recording || CHECKS[top.id].ruin)) this.maybeSay(top, now, language);

    // Section 6: every check passes: say the final line once.
    if (!recording && failing.size === 0 && !quiet) {
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

  maybeSay(problem, now, language) {
    const speaker = this.speaker;
    if (!speaker || speaker.muted || speaker.speaking) return;
    if (now - Math.max(this.lastSaidAt, speaker.lastAt) < ACT_MS) return;
    const said = this.said.get(problem.id) ?? { count: 0, at: -Infinity };
    if (now - said.at < REPEAT_MS) return;
    const line = lineFor(problem.id, language, problem.fill);
    if (said.count >= MAX_SAYS) {
      this.ignored.set(problem.id, line.text);
      return;
    }
    this.said.set(problem.id, { count: said.count + 1, at: now });
    this.say(line, now);
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
