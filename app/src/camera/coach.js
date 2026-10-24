// Turns raw check results into one tip at a time, on screen and out loud.

// priority: lower wins. en / hinglish are shown; en / hi are spoken (Hindi and
// Hinglish users hear Devanagari, which Indian TTS voices read naturally).
export const TIPS = {
  no_face: { priority: 1, en: "I can't see your face", hinglish: 'Aapka chehra nahi dikh raha', hi: 'आपका चेहरा नहीं दिख रहा' },
  no_body: { priority: 1, en: 'Step back so I can see all of you', hinglish: 'Peeche jaiye, aap poore dikhne chahiye', hi: 'पीछे जाइए, आप पूरे दिखने चाहिए' },
  raise_phone: { priority: 2, en: 'Raise the phone', hinglish: 'Phone thoda upar kijiye', hi: 'फ़ोन थोड़ा ऊपर कीजिए' },
  lower_phone: { priority: 2, en: 'Lower the phone', hinglish: 'Phone thoda neeche kijiye', hi: 'फ़ोन थोड़ा नीचे कीजिए' },
  show_feet: { priority: 2, en: 'Step back so your feet are in the frame', hinglish: 'Peeche jaiye, pair frame mein aane chahiye', hi: 'पीछे जाइए, पैर फ़्रेम में आने चाहिए' },
  come_closer: { priority: 3, en: 'Come a little closer', hinglish: 'Thoda paas aaiye', hi: 'थोड़ा पास आइए' },
  move_back: { priority: 3, en: 'Move back a little', hinglish: 'Thoda peeche jaiye', hi: 'थोड़ा पीछे जाइए' },
  step_left: { priority: 4, en: 'Move a little to your left', hinglish: 'Thoda apne left jaiye', hi: 'थोड़ा अपने बाएँ जाइए' },
  step_right: { priority: 4, en: 'Move a little to your right', hinglish: 'Thoda apne right jaiye', hi: 'थोड़ा अपने दाएँ जाइए' },
  backlight: { priority: 5, en: 'Light is behind you. Turn to face the light', hinglish: 'Light aapke peeche hai. Light ki taraf mudiye', hi: 'रोशनी आपके पीछे है। रोशनी की तरफ़ मुड़िए' },
  face_dark: { priority: 5, en: 'Your face is too dark. Face a window or a lamp', hinglish: 'Chehre pe light kam hai. Window ya lamp ki taraf mudiye', hi: 'चेहरे पर रोशनी कम है। खिड़की या लैंप की तरफ़ मुड़िए' },
  face_bright: { priority: 5, en: 'Too much light on your face', hinglish: 'Chehre pe bahut zyada light hai', hi: 'चेहरे पर बहुत ज़्यादा रोशनी है' },
  room_dark: { priority: 5, en: 'The room is too dark. Turn on a light', hinglish: 'Kamre mein andhera hai. Light jalaiye', hi: 'कमरे में अंधेरा है। लाइट जलाइए' },
  mic_silent: { priority: 6, en: "I can't hear your mic", hinglish: 'Mic se awaaz nahi aa rahi', hi: 'माइक से आवाज़ नहीं आ रही' },
  too_loud: { priority: 7, en: 'Too loud. Hold the phone a little further away', hinglish: 'Awaaz bahut tez hai. Phone thoda door rakhiye', hi: 'आवाज़ बहुत तेज़ है। फ़ोन थोड़ा दूर रखिए' },
  noisy: { priority: 7, en: "It's noisy here. Find a quieter spot", hinglish: 'Yahan shor hai. Koi shaant jagah dhoondhiye', hi: 'यहाँ शोर है। कोई शांत जगह ढूँढिए' },
  blurry: { priority: 8, en: 'Wipe your camera lens', hinglish: 'Camera lens saaf kijiye', hi: 'कैमरे का लेंस साफ़ कीजिए' },
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
    try {
      if (this.useSarvam) {
        await this.playSarvam(text, languageCode);
      } else {
        await this.playDevice(text, languageCode);
      }
    } catch {
      try {
        await this.playDevice(text, languageCode);
      } catch {}
    } finally {
      this.speaking = false;
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
    this.audio?.pause();
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
