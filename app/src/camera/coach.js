// Turns raw check results into one tip at a time, on screen and out loud.

// priority: lower wins. en / hinglish are shown; en / hi are spoken (Hindi and
// Hinglish users hear Devanagari, which Indian TTS voices read naturally).
export const TIPS = {
  no_face: { priority: 1, en: "Can't see you. Come into the frame", hinglish: 'Aap dikh nahi rahe. Frame mein aao', hi: 'आप दिख नहीं रहे। फ़्रेम में आओ' },
  no_body: { priority: 1, en: 'Step back a bit, I need all of you', hinglish: 'Thoda peeche jao, poore dikhne chahiye', hi: 'थोड़ा पीछे जाओ, पूरे दिखने चाहिए' },
  raise_phone: { priority: 2, en: 'Phone a little higher', hinglish: 'Phone thoda upar karo', hi: 'फ़ोन थोड़ा ऊपर करो' },
  lower_phone: { priority: 2, en: 'Phone a little lower', hinglish: 'Phone thoda neeche karo', hi: 'फ़ोन थोड़ा नीचे करो' },
  show_feet: { priority: 2, en: 'Step back till your feet show', hinglish: 'Peeche jao, pair bhi dikhne chahiye', hi: 'पीछे जाओ, पैर भी दिखने चाहिए' },
  come_closer: { priority: 3, en: 'Come a little closer', hinglish: 'Thoda paas aao', hi: 'थोड़ा पास आओ' },
  move_back: { priority: 3, en: 'Go back a little', hinglish: 'Thoda peeche jao', hi: 'थोड़ा पीछे जाओ' },
  step_left: { priority: 4, en: 'A little to your left', hinglish: 'Thoda apne left ko', hi: 'थोड़ा अपने बाएँ को' },
  step_right: { priority: 4, en: 'A little to your right', hinglish: 'Thoda apne right ko', hi: 'थोड़ा अपने दाएँ को' },
  backlight: { priority: 5, en: 'Light is behind you. Turn and face it', hinglish: 'Light peeche hai. Uski taraf ghumo', hi: 'रोशनी पीछे है। उसकी तरफ़ घूमो' },
  face_dark: { priority: 5, en: 'Too dark. Face a window or a lamp', hinglish: 'Chehra dark hai. Window ki taraf ghumo', hi: 'चेहरा अँधेरे में है। खिड़की की तरफ़ घूमो' },
  face_bright: { priority: 5, en: 'Too bright on your face. Step away a bit', hinglish: 'Chehre pe light zyada hai. Thoda hato', hi: 'चेहरे पर रोशनी ज़्यादा है। थोड़ा हटो' },
  room_dark: { priority: 5, en: "It's dark in here. Switch on a light", hinglish: 'Andhera hai. Light jala lo', hi: 'अँधेरा है। लाइट जला लो' },
  mic_silent: { priority: 6, en: "Can't hear the mic", hinglish: 'Mic se awaaz nahi aa rahi', hi: 'माइक से आवाज़ नहीं आ रही' },
  too_loud: { priority: 7, en: 'Too loud. Hold the phone further away', hinglish: 'Bahut loud hai. Phone thoda door rakho', hi: 'बहुत तेज़ है। फ़ोन थोड़ा दूर रखो' },
  noisy: { priority: 7, en: 'Bit noisy here. Find a quieter spot', hinglish: 'Shor hai. Koi shaant jagah dhoondho', hi: 'शोर है। कोई शांत जगह ढूँढो' },
  blurry: { priority: 8, en: 'Looks blurry. Wipe the lens', hinglish: 'Blurry hai. Lens saaf kar lo', hi: 'धुँधला है। लेंस साफ़ कर लो' },
};

export const PERSIST_MS = 1500;
const MIN_GAP_MS = 2500; // between any two spoken tips
const REPEAT_MS = 9000; // before repeating the same tip

/** Shown text and spoken text + language for a tip, in the creator's language. */
export function tipText(problem, language) {
  if (problem.text) return problem; // Claude's tips arrive already written
  const tip = TIPS[problem.id];
  if (!tip) return { text: problem.id, spoken: problem.id, languageCode: 'en-IN' };
  if (language === 'English') return { text: tip.en, spoken: tip.en, languageCode: 'en-IN' };
  return { text: language === 'Hindi' ? tip.hi : tip.hinglish, spoken: tip.hi, languageCode: 'hi-IN' };
}

/** Tracks how long each problem has lasted; only ones past PERSIST_MS count. */
export class ProblemTracker {
  constructor() {
    this.since = new Map();
  }

  update(problems, now) {
    const present = new Map(problems.map((p) => [p.id, p]));
    for (const id of this.since.keys()) if (!present.has(id)) this.since.delete(id);
    for (const id of present.keys()) if (!this.since.has(id)) this.since.set(id, now);
    const active = problems
      .filter((p) => now - this.since.get(p.id) >= PERSIST_MS)
      .sort((a, b) => (a.priority ?? TIPS[a.id]?.priority ?? 9) - (b.priority ?? TIPS[b.id]?.priority ?? 9));
    return { active, ages: Object.fromEntries([...this.since].map(([id, t]) => [id, now - t])) };
  }

  /** How long a problem has been present (0 if not). */
  age(id, now) {
    return this.since.has(id) ? now - this.since.get(id) : 0;
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

  /** Speaks if nothing else is playing and this tip hasn't just been said. */
  maybeSay(id, { spoken, languageCode }, now) {
    if (this.muted || this.speaking) return false;
    if (now - this.lastAt < MIN_GAP_MS) return false;
    if (now - (this.lastById.get(id) ?? -Infinity) < REPEAT_MS) return false;
    this.lastAt = now;
    this.lastById.set(id, now);
    this.say(spoken, languageCode);
    return true;
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
