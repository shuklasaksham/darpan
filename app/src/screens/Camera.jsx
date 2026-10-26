import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { checkFrame, keepTake, posterUrl, uploadTake } from '../api.js';
import Reel from './Reel.jsx';
import TakeReview from './TakeReview.jsx';
import { pickMimeType, stopStream } from '../media.js';
import { FrameGuide } from '../camera/silhouette.jsx';
import { framingFor, headRegion, targetsFor } from '../camera/framing.js';
import { detectFace, eyeLookDown, loadFaceDetector, loadFaceLandmarker, loadPoseLandmarker } from '../camera/vision.js';
import { bodyGeometry, faceGeometry, framingProblems, lightProblems, lightReadings, soundProblems } from '../camera/checks.js';
import { ProblemTracker, SoundMeter, Speaker, tipText } from '../camera/coach.js';
import Glyph from '../ui/Glyph.jsx';
import { formatTime, readPref, writePref } from '../ui/parts.jsx';

const VIDEO_TYPES = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const ASPECTS = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9 };
const FRAMING_IDS = new Set(['no_face', 'no_body', 'raise_phone', 'lower_phone', 'show_feet', 'come_closer', 'move_back', 'step_left', 'step_right']);
const LIGHT_IDS = new Set(['backlight', 'face_dark', 'face_bright', 'room_dark']);
const TIP_GLYPHS = { backlight: 'light', face_dark: 'light', face_bright: 'light', room_dark: 'light', claude_light: 'light' };
const TIMERS = [3, 10, 0]; // countdown seconds; 0 records straight away
const TICK_MS = 200;
const TICK_RECORDING_MS = 400;
const DETECT_EDGE = 360; // long edge of the frame the models see
const LIGHT_EDGE = 240;
const RECORD_EDGE = 1280;

/** Centre crop of the camera image to the chosen aspect ratio, in source pixels. */
function cropRect(vw, vh, aspect) {
  if (vw / vh > aspect) {
    const w = vh * aspect;
    return { x: (vw - w) / 2, y: 0, w, h: vh };
  }
  const h = vw / aspect;
  return { x: 0, y: (vh - h) / 2, w: vw, h };
}

function sizeFor(aspect, edge) {
  return aspect < 1 ? [Math.round(edge * aspect), edge] : [edge, Math.round(edge / aspect)];
}

const everyShotKept = (plan, kept) => {
  const n = plan?.script?.shots?.length ?? 0;
  return n > 0 && Array.from({ length: n }, (_, i) => kept?.[i]?.takeId).every(Boolean);
};

export default function Camera({ shoot, planned: initialPlan, initialKept, health, onClose }) {
  const debug = useMemo(() => new URLSearchParams(window.location.search).has('debug'), []);
  const language = shoot.language;

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const recordRafRef = useRef(0);
  const startedAtRef = useRef(0);
  const closedRef = useRef(false);
  const statsRef = useRef(null); // loudness, gaze and frames gathered during a take
  const meterRef = useRef(null);
  const levelRef = useRef(null); // latest loudness reading, for the teleprompter
  const loudTimerRef = useRef(0);

  const [facing, setFacing] = useState('user');
  const [aspectKey, setAspectKey] = useState('9:16');
  const [showAspects, setShowAspects] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [permission, setPermission] = useState('checking'); // checking | ask | go | blocked
  const [cameraError, setCameraError] = useState('');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState(null); // { status, url, blob, progress?, result?, error? }
  const [countdown, setCountdown] = useState(0);
  const [timer, setTimer] = useState(() => readPref('timer', 3));
  const [promptSize, setPromptSize] = useState(() => readPref('promptSize', 1));
  const [kept, setKept] = useState(initialKept ?? {}); // shotIndex -> { takeId, blob, url, result }
  // Resuming a shoot whose shots are all kept goes straight to the reel.
  const [reelOpen, setReelOpen] = useState(() => everyShotKept(initialPlan, initialKept));
  const [lostNotice, setLostNotice] = useState(0); // takes lost on the server, to re-record
  const keptRef = useRef(kept);
  keptRef.current = kept;
  // Kept takes live in memory as blobs until the camera closes.
  useEffect(
    () => () => Object.values(keptRef.current).forEach((k) => k.url.startsWith('blob:') && URL.revokeObjectURL(k.url)),
    [],
  );

  const [planned, setPlanned] = useState(initialPlan); // { planId, script }, finalised on the Script screen
  const [showScript, setShowScript] = useState(false);
  // Resume on the first shot that still needs a take.
  const [shotIndex, setShotIndex] = useState(() => {
    const n = initialPlan?.script?.shots?.length ?? 0;
    const next = Array.from({ length: n }, (_, i) => i).find((i) => !initialKept?.[i]);
    return next ?? 0;
  });

  const [visionState, setVisionState] = useState('loading'); // loading | ready | off
  const [tip, setTip] = useState(null); // { id, text }
  const [matched, setMatched] = useState(false);
  const [claude, setClaude] = useState(null); // last frame verdict
  const [muted, setMuted] = useState(() => !readPref('voiceTips', true));
  const [debugInfo, setDebugInfo] = useState(null);

  const aspect = ASPECTS[aspectKey];
  const shots = planned?.script?.shots ?? [];
  const shot = shots[shotIndex] ?? null;
  const framing = shot?.framing ?? 'medium';
  const mirrored = facing === 'user';

  // Values the analysis loop reads without being restarted.
  const live = useRef({});
  live.current = { aspect, framing, recording, countdown, language, planned, shotIndex, muted, aspectKey, facing };

  // Keep the screen awake while the camera is open (Android Chrome, iOS 16.4+).
  useEffect(() => {
    let lock = null;
    let released = false;
    const acquire = async () => {
      try {
        if (!released && document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen');
      } catch {}
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', acquire);
      lock?.release().catch(() => {});
    };
  }, []);

  // --- Camera ---------------------------------------------------------------

  useEffect(() => {
    closedRef.current = false; // StrictMode mounts twice in development
    return () => {
      closedRef.current = true;
    };
  }, []);

  // Ask first, in Darpan's words, when the browser hasn't been asked yet.
  useEffect(() => {
    let alive = true;
    const query = navigator.permissions?.query?.({ name: 'camera' });
    if (!query) return setPermission('go');
    query
      .then((s) => alive && setPermission(s.state === 'prompt' ? 'ask' : s.state === 'denied' ? 'blocked' : 'go'))
      .catch(() => alive && setPermission('go'));
    return () => {
      alive = false;
    };
  }, []);

  // The camera is only on while shooting: off during take review and the reel screen.
  const cameraOn = !take && !reelOpen && permission === 'go';

  useEffect(() => {
    let cancelled = false;
    setCameraError('');
    setVideoReady(false);
    if (!cameraOn) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("This browser can't open the camera here.");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, resizeMode: 'none' },
        audio: true,
      })
      .then((stream) => {
        if (cancelled) return stopStream(stream);
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        // Some phones start zoomed in; use the widest zoom the camera allows.
        const track = stream.getVideoTracks()[0];
        const zoom = track?.getCapabilities?.().zoom;
        if (zoom) track.applyConstraints({ advanced: [{ zoom: zoom.min }] }).catch(() => {});
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') setPermission('blocked');
        else setCameraError("Couldn't start the camera. Close other apps using it and try again.");
      });
    return () => {
      cancelled = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      cancelAnimationFrame(recordRafRef.current);
      stopStream(streamRef.current);
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [facing, cameraOn]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)), 250);
    return () => clearInterval(id);
  }, [recording]);

  // --- Live checks --------------------------------------------------------

  const speakerRef = useRef(null);
  useEffect(() => {
    const speaker = new Speaker({ useSarvam: Boolean(health?.tts) });
    speakerRef.current = speaker;
    return () => speaker.dispose();
  }, [health?.tts]);

  useEffect(() => {
    if (speakerRef.current) speakerRef.current.muted = muted;
    if (muted) speakerRef.current?.stop();
  }, [muted]);

  // Claude's verdicts. `lightVerdict` remembers the light it judged so it stops
  // applying once the light changes.
  const claudeRef = useRef({ busy: false, lastAt: 0, checkedKey: null, lightVerdict: null, tip: null });

  useEffect(() => {
    // New shot, ratio or camera: Claude's earlier look no longer applies.
    claudeRef.current.checkedKey = null;
    claudeRef.current.tip = null;
    setClaude(null);
  }, [shotIndex, aspectKey, facing]);

  useEffect(() => {
    if (!videoReady) return;
    let stopped = false;
    let timer = 0;
    let faceDetector = null;
    let poseLandmarker = null;
    let meter = null;
    let lastBody = null;
    let tick = 0;
    let basicsSince = 0;
    let lastTipId = null;
    let lastMatched = null;
    let lastSpeechEnd = 0;
    const tracker = new ProblemTracker();
    const detectCanvas = document.createElement('canvas');
    const lightCanvas = document.createElement('canvas');
    const scratch = document.createElement('canvas');
    const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });
    const lightCtx = lightCanvas.getContext('2d', { willReadFrequently: true });

    let landmarker = null;
    loadFaceDetector()
      .then((d) => {
        faceDetector = d;
        setVisionState('ready');
        // Loaded second, so it doesn't slow the first face check.
        loadFaceLandmarker()
          .then((l) => (landmarker = l))
          .catch(() => {});
      })
      .catch((err) => {
        console.error('Face detection unavailable', err);
        setVisionState('off');
      });
    try {
      if (streamRef.current?.getAudioTracks().length) meter = new SoundMeter(streamRef.current);
    } catch {}
    meterRef.current = meter;

    const sendFrameCheck = async (reason, readings) => {
      const c = claudeRef.current;
      const { planned: p, shotIndex: idx, language: lang } = live.current;
      if (c.busy || !health?.scripts) return;
      c.busy = true;
      c.lastAt = Date.now();
      try {
        const [w, h] = sizeFor(live.current.aspect, 512);
        const snap = document.createElement('canvas');
        snap.width = w;
        snap.height = h;
        const v = videoRef.current;
        const crop = cropRect(v.videoWidth, v.videoHeight, live.current.aspect);
        snap.getContext('2d').drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
        const started = performance.now();
        const result = await checkFrame({
          image: snap.toDataURL('image/jpeg', 0.75),
          planId: p?.planId,
          shotIndex: idx,
          language: lang,
          metrics: readings && {
            face: readings.face?.toFixed(2),
            background: readings.background?.toFixed(2),
            frame: readings.frame.toFixed(2),
            contrast: readings.contrast.toFixed(2),
          },
        });
        if (stopped) return;
        result.reason = reason;
        result.ms = Math.round(performance.now() - started);
        c.lightVerdict = {
          ok: result.light.ok,
          tip: result.light.tip,
          spoken: result.light.tip_spoken,
          face: readings?.face ?? null,
          background: readings?.background ?? null,
        };
        const others = ['framing', 'clutter', 'angle'].filter((k) => !result[k].ok);
        c.tip = others.length && result.top_tip ? { text: result.top_tip, spoken: result.top_tip_spoken, at: Date.now() } : null;
        setClaude(result);
      } catch (err) {
        if (!stopped) setClaude({ error: err.message });
      } finally {
        c.busy = false;
      }
    };

    const loop = () => {
      if (stopped) return;
      const now = Date.now();
      const s = live.current;
      const v = videoRef.current;
      timer = setTimeout(loop, s.recording ? TICK_RECORDING_MS : TICK_MS);
      if (!v?.videoWidth) return;
      tick++;

      const crop = cropRect(v.videoWidth, v.videoHeight, s.aspect);
      const [dw, dh] = sizeFor(s.aspect, DETECT_EDGE);
      if (detectCanvas.width !== dw || detectCanvas.height !== dh) {
        detectCanvas.width = dw;
        detectCanvas.height = dh;
      }
      detectCtx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, dw, dh);

      // Face, looking in the silhouette's head first.
      let faceResult = { source: 'loading' };
      let detectMs = 0;
      if (faceDetector) {
        const t0 = performance.now();
        try {
          faceResult = detectFace(faceDetector, detectCanvas, headRegion(s.framing, s.aspect), scratch, tick % 3 === 0);
        } catch (err) {
          faceResult = { source: 'error' };
        }
        detectMs = performance.now() - t0;
      }
      const face = faceResult.eyes ? { ...faceResult, ...faceGeometry(faceResult) } : null;

      // Body pose only when the framing needs it, and every other tick.
      const needsBody = s.framing === 'full_body' || s.framing === 'waist_up';
      if (needsBody && !poseLandmarker && faceDetector) {
        poseLandmarker = 'loading';
        loadPoseLandmarker()
          .then((p) => (poseLandmarker = p))
          .catch(() => (poseLandmarker = 'off'));
      }
      if (!needsBody) lastBody = null;
      if (needsBody && poseLandmarker?.detect && tick % 3 === 0) {
        try {
          const result = poseLandmarker.detect(detectCanvas);
          lastBody = bodyGeometry(result.landmarks[0], face);
        } catch {
          lastBody = null;
        }
      }

      // Light: the middle of the face and the whole frame.
      const [lw, lh] = sizeFor(s.aspect, LIGHT_EDGE);
      if (lightCanvas.width !== lw || lightCanvas.height !== lh) {
        lightCanvas.width = lw;
        lightCanvas.height = lh;
      }
      lightCtx.drawImage(detectCanvas, 0, 0, lw, lh);
      const readings = lightReadings(lightCtx.getImageData(0, 0, lw, lh), face);

      // During a take: where the eyes point, and a small frame every second.
      const stats = statsRef.current;
      if (s.recording && stats) {
        const t = (now - stats.startedAt) / 1000;
        if (landmarker && s.facing === 'user' && face) {
          try {
            const down = eyeLookDown(landmarker, detectCanvas);
            if (down != null) stats.gaze.push([t, Math.round(down * 100) / 100]);
          } catch {}
        }
        if (now - stats.lastFrameAt >= 1000) {
          stats.lastFrameAt = now;
          stats.frames.push([t, detectCanvas.toDataURL('image/jpeg', 0.7)]);
          if (stats.frames.length > 120) stats.frames.splice(1, 1);
        }
      }

      // Sound, ignoring the moments when Darpan itself is talking.
      const speaker = speakerRef.current;
      if (speaker?.speaking) lastSpeechEnd = now;
      let sound = null;
      if (meter && now - lastSpeechEnd > 700) sound = meter.read(now);
      else meter?.reset();

      const problems = [];
      if (faceDetector) {
        problems.push(...framingProblems({ framing: s.framing, face, body: lastBody, hasFace: Boolean(face) }));
      }
      let light = lightProblems(readings);
      const c = claudeRef.current;
      const verdict = c.lightVerdict;
      const sameLight =
        verdict &&
        readings.face != null &&
        verdict.face != null &&
        Math.abs(readings.face - verdict.face) < 0.12 &&
        Math.abs((readings.background ?? 0) - (verdict.background ?? 0)) < 0.15;
      if (sameLight && light.some((p) => LIGHT_IDS.has(p.id))) {
        // Claude looked at this same light: its verdict wins over the local reading.
        light = light.filter((p) => !LIGHT_IDS.has(p.id));
        if (!verdict.ok && verdict.tip) {
          light.push({ id: 'claude_light', priority: 5, text: verdict.tip, spoken: verdict.spoken || verdict.tip });
        }
      }
      problems.push(...light, ...soundProblems(sound, { recording: s.recording }));
      if (c.tip && now - c.tip.at < 15000) {
        problems.push({ id: 'claude', priority: 9, text: c.tip.text, spoken: c.tip.spoken || c.tip.text });
      }

      const { active, ages } = tracker.update(problems, now);
      const top = active[0];
      const lang = s.language;
      const words = top
        ? top.text
          ? { text: top.text, spoken: top.spoken, languageCode: lang === 'English' ? 'en-IN' : 'hi-IN' }
          : tipText(top, lang)
        : null;
      if ((top?.id ?? null) !== lastTipId) {
        lastTipId = top?.id ?? null;
        setTip(top ? { id: top.id, text: words.text } : null);
      }
      const isMatched = Boolean(faceDetector) && !problems.some((p) => FRAMING_IDS.has(p.id));
      if (isMatched !== lastMatched) {
        lastMatched = isMatched;
        setMatched(isMatched);
      }
      // Spoken tips only between takes, so Darpan's voice never ends up in a recording.
      if (top && !s.recording && !s.countdown && speaker) speaker.maybeSay(top.id, words, now);

      // Claude: one look once the basics pass, and again if a light warning won't go away.
      const basicsPass = face || lastBody ? problems.length === 0 : false;
      basicsSince = basicsPass ? basicsSince || now : 0;
      const key = `${s.shotIndex}|${s.aspectKey}|${s.facing}`;
      if (!s.recording && !s.countdown && basicsSince && now - basicsSince > 1500 && c.checkedKey !== key && now - c.lastAt > 5000) {
        c.checkedKey = key;
        sendFrameCheck('basics passed', readings);
      }
      const lightAge = Math.max(0, ...['backlight', 'face_dark', 'face_bright'].map((id) => tracker.age(id, now)));
      if (!s.recording && !s.countdown && lightAge > 3000 && !sameLight && now - c.lastAt > 6000) {
        sendFrameCheck('light warning persisted', readings);
      }

      if (debug && tick % 2 === 0) {
        setDebugInfo({
          crop,
          detectMs,
          faceSource: faceResult.source,
          face,
          body: lastBody,
          readings,
          sound,
          ages,
          targets: targetsFor(s.framing),
          region: headRegion(s.framing, s.aspect),
          lightOverride: sameLight ? (verdict.ok ? 'Claude: light OK' : `Claude: ${verdict.tip}`) : null,
          speaking: Boolean(speaker?.speaking),
        });
      }
    };
    loop();

    return () => {
      stopped = true;
      clearTimeout(timer);
      meterRef.current = null;
      meter?.dispose();
    };
  }, [videoReady, debug, health?.scripts]);

  // --- Recording ----------------------------------------------------------

  useEffect(() => {
    if (countdown <= 0) return;
    const id = setTimeout(() => {
      if (countdown === 1) {
        setCountdown(0);
        startRecording();
      } else {
        setCountdown(countdown - 1);
      }
    }, 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  function startCountdown() {
    speakerRef.current?.unlock();
    speakerRef.current?.stop();
    setShowAspects(false);
    setTake(null);
    if (timer > 0) setCountdown(timer);
    else startRecording();
  }

  function startRecording() {
    const stream = streamRef.current;
    const v = videoRef.current;
    if (!stream || !v?.videoWidth) return;
    speakerRef.current?.stop();

    // Record through a canvas so the file has the chosen aspect ratio (and
    // isn't mirrored, unlike the preview).
    const crop = cropRect(v.videoWidth, v.videoHeight, aspect);
    const edge = Math.min(RECORD_EDGE, Math.max(crop.w, crop.h));
    const [w, h] = sizeFor(aspect, edge);
    const canvas = document.createElement('canvas');
    canvas.width = w - (w % 2);
    canvas.height = h - (h % 2);
    const ctx = canvas.getContext('2d');
    const draw = () => {
      ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      recordRafRef.current = requestAnimationFrame(draw);
    };
    draw();

    const mixed = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...stream.getAudioTracks()]);
    const mimeType = pickMimeType(VIDEO_TYPES);
    const recorder = new MediaRecorder(mixed, { ...(mimeType && { mimeType }), videoBitsPerSecond: 5_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      cancelAnimationFrame(recordRafRef.current);
      mixed.getVideoTracks().forEach((t) => t.stop());
      const durationSeconds = (Date.now() - startedAtRef.current) / 1000;
      clearInterval(loudTimerRef.current);
      levelRef.current = null;
      const stats = statsRef.current;
      statsRef.current = null;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
      if (blob.size && !closedRef.current) send(blob, durationSeconds, stats);
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    statsRef.current = { startedAt: startedAtRef.current, loudness: [], gaze: [], frames: [], lastFrameAt: 0 };
    // Loudness 10 times a second, to see how much the voice rises and falls
    // (and to move the teleprompter along while the creator speaks).
    loudTimerRef.current = setInterval(() => {
      const meter = meterRef.current;
      const st = statsRef.current;
      if (!meter || !st) return;
      const now = Date.now();
      const reading = meter.read(now);
      levelRef.current = reading;
      st.loudness.push([(now - st.startedAt) / 1000, Math.round(reading.rmsDb * 10) / 10]);
    }, 100);
    setSeconds(0);
    setTake(null);
    setShowAspects(false);
    recorder.start(1000);
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  const lastSend = useRef(null);
  async function send(blob, durationSeconds, stats) {
    const url = URL.createObjectURL(blob);
    const args = { blob, durationSeconds, stats, url, shotIndex };
    lastSend.current = args;
    await upload(args);
  }

  async function upload({ blob, durationSeconds, stats, url, shotIndex: forShot }) {
    setTake({ status: 'uploading', url, blob, progress: 0 });
    try {
      const result = await uploadTake(
        blob,
        {
          planId: planned?.planId,
          plan: planned?.planId ? undefined : planned?.script,
          shotIndex: shots[forShot] ? forShot : undefined,
          durationSeconds,
          language,
          loudness: stats?.loudness,
          gaze: stats?.gaze,
          frames: pickFrames(stats?.frames ?? []),
        },
        (progress) => setTake((t) => (t?.url === url ? { ...t, progress } : t)),
      );
      if (closedRef.current) return;
      setTake({ status: 'done', url, blob, result, progress: 1 });
      // Darpan reads the top note aloud.
      const top = result.notes?.[0];
      if (top && !live.current.muted) {
        speakerRef.current?.say(top.note_spoken || top.note, language === 'English' ? 'en-IN' : 'hi-IN');
      }
    } catch (err) {
      if (closedRef.current) return;
      setTake({ status: err.offline ? 'offline' : 'error', url, blob, error: err.message });
    }
  }

  const retryUpload = useCallback(() => {
    if (lastSend.current) upload(lastSend.current);
  }, [planned]);

  function closeTake() {
    speakerRef.current?.stop();
    if (take?.url) URL.revokeObjectURL(take.url);
    setTake(null);
  }

  // Keep this take for the shot, then go straight to the next shot that still
  // needs one; when every shot has a kept take, open the reel screen.
  function keepAndNext() {
    speakerRef.current?.stop();
    const result = take?.result;
    if (result?.id) keepTake(result.id).catch(() => {});
    const previous = kept[shotIndex];
    if (previous && previous.url !== take.url && previous.url.startsWith('blob:')) URL.revokeObjectURL(previous.url);
    const next = { ...kept, [shotIndex]: { takeId: Number(result?.id), blob: take.blob, url: take.url, result } };
    setKept(next);
    setTake(null);
    const remaining = shots.map((_, i) => i).filter((i) => !next[i]);
    if (remaining.length === 0) setReelOpen(true);
    else setShotIndex(remaining.find((i) => i > shotIndex) ?? remaining[0]);
  }

  const allKept = shots.length > 0 && shots.every((_, i) => kept[i]?.takeId);
  const keepFinishes = shots.every((_, i) => i === shotIndex || kept[i]);
  const lastKept = [...shots.keys()].reverse().map((i) => kept[i]).find(Boolean);

  function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) send(file);
  }

  // --- UI -----------------------------------------------------------------

  const script = planned?.script;
  const planSeconds = Number(shot?.duration_seconds) || 0;
  const busy = recording || countdown > 0;

  if ((permission === 'ask' || permission === 'blocked') && !take && !reelOpen) {
    return (
      <CameraPermission
        blocked={permission === 'blocked'}
        shotLabel={shots.length ? `Shot ${shotIndex + 1} of ${shots.length}` : ''}
        onAllow={() => setPermission('go')}
        onClose={onClose}
        onPickFile={onPickFile}
      />
    );
  }

  return (
    <div className="camera studio">
      <div className="stage">
        <div className="stage-frame" style={{ '--aspect': aspect }}>
          <video ref={videoRef} className={mirrored ? 'mirrored' : ''} autoPlay playsInline muted onLoadedMetadata={() => setVideoReady(true)} />
          {shot && !recording && <FrameGuide framing={framing} aspect={aspect} matched={matched} />}
          {debug && debugInfo && <DebugOverlay info={debugInfo} aspect={aspect} mirrored={mirrored} />}
        </div>
      </div>
      <div className="cam-scrim-top" aria-hidden="true" />

      <div className="cam-top">
        <div className="row">
          <button className="cam-btn" onClick={onClose} aria-label="Close camera" disabled={recording}>
            <Glyph name="x" size={22} />
          </button>
          <span className="shot-title">
            {shots.length ? `Shot ${shotIndex + 1} of ${shots.length}${shot?.title ? ` · ${shot.title}` : ''}` : 'Your take'}
          </span>
        </div>
        {shots.length > 1 && (
          <div className="segments cam" role="tablist" aria-label="Shots">
            {shots.map((s, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === shotIndex}
                aria-label={`Shot ${i + 1}: ${s.title}${kept[i] ? ', kept' : ''}`}
                disabled={busy}
                onClick={() => setShotIndex(i)}
                style={{ all: 'unset', flex: 1, padding: '8px 0', cursor: 'pointer' }}
              >
                <i className={kept[i] && i !== shotIndex ? 'on' : ''} style={{ display: 'block' }}>
                  {i === shotIndex && <b style={{ width: recording && planSeconds ? `${Math.min(100, (seconds / planSeconds) * 100)}%` : '100%' }} />}
                </i>
              </button>
            ))}
          </div>
        )}
        {shot && (
          <Teleprompter
            shot={shot}
            next={shots[shotIndex + 1]}
            recording={recording}
            levelRef={levelRef}
            size={promptSize}
          />
        )}
        {recording && (
          <span className="rec-time" aria-live="off">
            {formatTime(seconds)}
            {planSeconds ? ` / ${formatTime(planSeconds)}` : ''}
          </span>
        )}
      </div>

      {!recording && (
        <div className="tool-rail">
          <button className="cam-btn" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))} disabled={busy} aria-label="Flip camera">
            <Glyph name="flip" size={22} />
          </button>
          <button className={`cam-btn ${showAspects ? 'on' : ''}`} onClick={() => setShowAspects((v) => !v)} disabled={busy} aria-label={`Aspect ratio ${aspectKey}`}>
            {aspectKey}
          </button>
          <button
            className="cam-btn"
            onClick={() => {
              const next = (promptSize + 1) % 3;
              setPromptSize(next);
              writePref('promptSize', next);
            }}
            aria-label="Teleprompter text size"
            style={{ fontSize: [13, 15, 18][promptSize] }}
          >
            Aa
          </button>
          <button
            className="cam-btn"
            onClick={() => {
              const next = TIMERS[(TIMERS.indexOf(timer) + 1) % TIMERS.length];
              setTimer(next);
              writePref('timer', next);
            }}
            disabled={busy}
            aria-label={timer ? `Countdown ${timer} seconds` : 'No countdown'}
          >
            {timer ? `${timer}s` : 'Off'}
          </button>
          <button className="cam-btn" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Turn spoken tips on' : 'Turn spoken tips off'}>
            <Glyph name={muted ? 'muted' : 'speaker'} size={22} />
          </button>
        </div>
      )}

      {showAspects && !busy && (
        <div className="aspect-menu" role="group" aria-label="Aspect ratio">
          {Object.keys(ASPECTS).map((key) => (
            <button
              key={key}
              className={`chip ${key === aspectKey ? 'selected' : ''}`}
              onClick={() => {
                setAspectKey(key);
                setShowAspects(false);
              }}
            >
              {key}
            </button>
          ))}
        </div>
      )}

      {!recording && !countdown && claude && !claude.error && (
        <div className="coach-stack">
          <LookCard result={claude} onClose={() => setClaude(null)} />
        </div>
      )}

      {!countdown && <CoachPill tip={tip} recording={recording} visionState={visionState} hasShot={Boolean(shot)} lostNotice={lostNotice} onDismissLost={() => setLostNotice(0)} />}

      {countdown > 0 && (
        <div className="countdown" aria-live="assertive">
          {countdown}
        </div>
      )}

      <div className="cam-bottom">
        {cameraError ? (
          <div className="stack" style={{ width: '100%', textAlign: 'center' }}>
            <p>{cameraError}</p>
            <label className="button primary">
              Use the phone camera instead
              <input type="file" accept="video/*" capture="user" onChange={onPickFile} hidden />
            </label>
          </div>
        ) : (
          <>
            <span className="slot">
              {lastKept && !busy && (
                <button
                  className="kept-thumb"
                  onClick={() => allKept && setReelOpen(true)}
                  aria-label={allKept ? 'Open your reel' : `${Object.keys(kept).length} of ${shots.length} shots kept`}
                >
                  <img src={posterUrl(lastKept.takeId)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <b>
                    {Object.keys(kept).length}/{shots.length}
                  </b>
                </button>
              )}
            </span>
            <button
              className={`shutter ${recording ? 'recording' : ''}`}
              onClick={recording ? stopRecording : countdown ? () => setCountdown(0) : startCountdown}
              disabled={!videoReady || Boolean(take) || showScript || reelOpen}
              aria-label={recording ? 'Stop recording' : countdown ? 'Cancel countdown' : 'Start recording'}
            />
            <span className="slot">
              {!busy &&
                (allKept ? (
                  <button className="cam-btn" style={{ width: 52, height: 52 }} onClick={() => setReelOpen(true)} aria-label="Your reel">
                    <Glyph name="reel" />
                  </button>
                ) : (
                  script && (
                    <button className="cam-btn" style={{ width: 52, height: 52 }} onClick={() => setShowScript(true)} aria-label="Read the whole script">
                      <Glyph name="script" />
                    </button>
                  )
                ))}
            </span>
          </>
        )}
      </div>

      {showScript && script && <ScriptSheet script={script} onClose={() => setShowScript(false)} />}

      {take && (
        <TakeReview
          take={take}
          shot={shots[lastSend.current?.shotIndex ?? shotIndex]}
          shotIndex={lastSend.current?.shotIndex ?? shotIndex}
          isLast={keepFinishes}
          speaker={speakerRef.current}
          onRetake={closeTake}
          onKeep={keepAndNext}
          onRetry={retryUpload}
        />
      )}

      {reelOpen && allKept && (
        <Reel
          planId={planned?.planId}
          caption={[script?.caption, ...(Array.isArray(script?.hashtags) ? script.hashtags : [])].filter(Boolean).join(' ')}
          shots={shots}
          kept={kept}
          onKeptChange={setKept}
          onBack={() => setReelOpen(false)}
          onDone={onClose}
          onReshoot={(i) => {
            setReelOpen(false);
            setShotIndex(i);
          }}
          onMissing={(takeIds) => {
            const lost = Object.entries(kept).filter(([, k]) => takeIds.includes(k.takeId)).map(([i]) => Number(i));
            setKept((current) => Object.fromEntries(Object.entries(current).filter(([i]) => !lost.includes(Number(i)))));
            setReelOpen(false);
            if (lost.length) setShotIndex(Math.min(...lost));
            setLostNotice(lost.length);
          }}
        />
      )}

      {debug && debugInfo && <DebugPanel info={debugInfo} claude={claude} visionState={visionState} />}
    </div>
  );
}

function CoachPill({ tip, recording, visionState, hasShot, lostNotice, onDismissLost }) {
  if (lostNotice > 0 && !recording) {
    return (
      <button className="coach-pill" onClick={onDismissLost} style={{ border: 0, minHeight: 0 }}>
        <Glyph name="alert" size={18} />
        {lostNotice === 1 ? 'This shot needs' : `${lostNotice} shots need`} recording again: its take expired.
      </button>
    );
  }
  if (visionState === 'off' && !recording) {
    return <p className="coach-pill quiet">Live checks aren’t available on this phone. You can still record.</p>;
  }
  if (tip) {
    return (
      <p className={`coach-pill ${recording ? 'quiet' : ''}`} aria-live="polite">
        <Glyph name={TIP_GLYPHS[tip.id] ?? 'frame'} size={18} />
        {tip.text}
      </p>
    );
  }
  if (!recording && visionState === 'ready' && hasShot) {
    return (
      <p className="coach-pill good" aria-live="polite">
        <Glyph name="check" size={18} /> Perfect. Hold it there
      </p>
    );
  }
  return null;
}

/**
 * The current line near the lens. While recording it follows the creator's
 * voice: it moves on while they're speaking and waits while they pause. It
 * listens to loudness, not words, so it keeps pace rather than reading along.
 */
function Teleprompter({ shot, next, recording, levelRef, size }) {
  const words = useMemo(() => (shot.line || '').split(/\s+/).filter(Boolean), [shot.line]);
  const [pos, setPos] = useState(0); // words spoken so far, fractional
  const boxRef = useRef(null);
  const textRef = useRef(null);
  const nowRef = useRef(null);

  useEffect(() => setPos(0), [shot, recording]);

  useEffect(() => {
    if (!recording || !words.length) return;
    // Pace from the planned length, kept to how fast people actually talk.
    const planned = Number(shot.duration_seconds) || words.length / 2.5;
    const rate = Math.min(3.6, Math.max(1.8, words.length / Math.max(1, planned * 0.85)));
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const l = levelRef.current;
      const voiced = l && l.rmsDb > Math.max(-48, (l.floorDb ?? -70) + 6);
      if (voiced) setPos((p) => Math.min(words.length, p + rate * dt));
    }, 100);
    return () => clearInterval(id);
  }, [recording, shot, words.length, levelRef]);

  const current = Math.min(words.length - 1, Math.floor(pos));

  useLayoutEffect(() => {
    const box = boxRef.current;
    const el = nowRef.current;
    if (!box || !textRef.current) return;
    // Keep one line of what was said above the current word; never scroll past the end.
    const overflow = textRef.current.offsetHeight - box.clientHeight;
    const offset = recording && el && overflow > 0 ? Math.min(overflow, Math.max(0, el.offsetTop - el.offsetHeight)) : 0;
    textRef.current.style.transform = `translateY(-${offset}px)`;
  }, [current, recording, size]);

  return (
    <div className={`teleprompter size-${size} ${recording ? '' : 'idle'}`}>
      <div className="lines" ref={boxRef}>
        <p ref={textRef}>
          {words.map((w, i) => (
            <span key={i} ref={i === current ? nowRef : null} className={!recording ? '' : i < current ? 'said' : i === current ? 'now' : ''}>
              {w}{' '}
            </span>
          ))}
        </p>
      </div>
      {recording && next?.line && <p className="small muted" style={{ marginTop: 6, fontFamily: 'var(--font-body)', fontSize: 13 }}>Next: {next.line.split(/\s+/).slice(0, 5).join(' ')}…</p>}
      <span className="hint">{recording ? 'Following your voice' : 'Scrolls with your voice · Aa to resize'}</span>
    </div>
  );
}

function ScriptSheet({ script, onClose }) {
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Your script" onClick={onClose}>
      <div className="sheet studio" onClick={(e) => e.stopPropagation()}>
        <h2>{script.title}</h2>
        <ol className="shot-list">
          {script.shots.map((s, i) => (
            <li key={i} className="shot-row" style={{ display: 'block' }}>
              <p className="eyebrow">
                Shot {i + 1} · {s.title} <span className="muted">· {framingFor(s.framing).label}</span>
              </p>
              <p className="say">“{s.line}”</p>
              {s.direction && <p className="meta">{s.direction}</p>}
            </li>
          ))}
        </ol>
        {script.lighting && (
          <p className="row" style={{ alignItems: 'flex-start' }}>
            <Glyph name="light" size={22} /> {script.lighting.suggestion}
          </p>
        )}
        {script.background && (
          <p className="row" style={{ alignItems: 'flex-start' }}>
            <Glyph name="frame" size={22} /> {script.background.suggestion}
          </p>
        )}
        <button className="primary block" onClick={onClose}>
          Back to shooting
        </button>
      </div>
    </div>
  );
}

/** Asks for the camera in Darpan's words first; if it's blocked, how to unblock it. */
function CameraPermission({ blocked, shotLabel, onAllow, onClose, onPickFile }) {
  return (
    <div className="studio" style={{ minHeight: '100dvh' }}>
      <main className="screen with-bar">
        <header className="topbar">
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Glyph name="x" />
          </button>
          <span className="title">{shotLabel}</span>
        </header>
        {blocked ? (
          <div className="stack loose">
            <h1>The camera is blocked</h1>
            <p className="muted" style={{ fontSize: 17 }}>Darpan can’t start without your camera and mic. Turn them on for this site, then come back.</p>
            <div className="stack">
              <h3>Chrome on Android</h3>
              <ol className="steps">
                <li>Tap the lock left of the address</li>
                <li>Permissions → Camera and Microphone → Allow</li>
              </ol>
            </div>
            <div className="stack">
              <h3>Safari on iPhone</h3>
              <ol className="steps">
                <li>Tap aA in the address bar</li>
                <li>Website Settings → Camera and Microphone → Allow</li>
              </ol>
            </div>
            <label className="link strong" style={{ flexDirection: 'row', cursor: 'pointer', fontSize: 15 }}>
              Or record with your phone’s camera app
              <input type="file" accept="video/*" capture="user" onChange={onPickFile} hidden />
            </label>
          </div>
        ) : (
          <div className="big-state">
            <Glyph name="shoot" size={48} />
            <h1>Let Darpan see and hear you</h1>
            <p className="muted" style={{ fontSize: 17 }}>
              Your browser will ask for the camera and mic next. Framing and light tips run on this phone; only the takes you record are uploaded.
            </p>
          </div>
        )}
        <div className="action-bar">
          <button className="primary" onClick={blocked ? () => window.location.reload() : onAllow}>
            {blocked ? 'I’ve allowed it, try again' : 'Allow camera and mic'}
          </button>
        </div>
      </main>
    </div>
  );
}

function LookCard({ result, onClose }) {
  const rows = [
    ['Light', result.light],
    ['Framing', result.framing],
    ['Background', result.clutter],
    ['Angle', result.angle],
  ];
  return (
    <div className="look-card">
      <div className="row between">
        <strong>Darpan took a look</strong>
        <button className="icon-btn bare" style={{ width: 32, height: 32, minHeight: 32 }} onClick={onClose} aria-label="Dismiss">
          <Glyph name="x" size={18} />
        </button>
      </div>
      <ul>
        {rows.map(([label, v]) => (
          <li key={label} className={v.ok ? 'ok' : 'fix'}>
            <Glyph name={v.ok ? 'check' : 'alert'} size={16} />
            <span>
              {label}
              {!v.ok && v.tip ? `: ${v.tip}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** First, middle and last frames of the take, as JPEG data URLs. */
function pickFrames(frames) {
  if (frames.length <= 3) return frames.map(([, data]) => data);
  const usable = frames.filter(([t]) => t >= 0.5);
  const list = usable.length >= 3 ? usable : frames;
  return [list[0], list[Math.floor(list.length / 2)], list[list.length - 1]].map(([, data]) => data);
}

function DebugOverlay({ info, aspect, mirrored }) {
  const W = aspect * 1000;
  const H = 1000;
  const x = (v) => (mirrored ? 1 - v : v) * W;
  const { face, targets, region, body } = info;
  return (
    <svg className="debug-overlay" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <rect
        x={mirrored ? (1 - region.x - region.w) * W : region.x * W}
        y={region.y * H}
        width={region.w * W}
        height={region.h * H}
        fill="none"
        stroke="#4fc3f7"
        strokeDasharray="12 8"
        strokeWidth="3"
      />
      <line x1="0" x2={W} y1={(targets.eye - targets.tolerance) * H} y2={(targets.eye - targets.tolerance) * H} stroke="#ffd54f" strokeWidth="2" strokeDasharray="6 6" />
      <line x1="0" x2={W} y1={(targets.eye + targets.tolerance) * H} y2={(targets.eye + targets.tolerance) * H} stroke="#ffd54f" strokeWidth="2" strokeDasharray="6 6" />
      <line x1="0" x2={W} y1={targets.headTop * H} y2={targets.headTop * H} stroke="#ce93d8" strokeWidth="2" strokeDasharray="6 6" />
      {face && (
        <>
          <rect
            x={mirrored ? (1 - face.box.x - face.box.w) * W : face.box.x * W}
            y={face.box.y * H}
            width={face.box.w * W}
            height={face.box.h * H}
            fill="none"
            stroke="#5fc08a"
            strokeWidth="3"
          />
          <line x1="0" x2={W} y1={face.eyeY * H} y2={face.eyeY * H} stroke="#ffd54f" strokeWidth="4" />
          <line x1="0" x2={W} y1={face.headTop * H} y2={face.headTop * H} stroke="#ce93d8" strokeWidth="4" />
          {face.eyes.map(([ex, ey], i) => (
            <circle key={i} cx={x(ex)} cy={ey * H} r="8" fill="#ffd54f" />
          ))}
          <circle cx={x(face.mouth[0])} cy={face.mouth[1] * H} r="8" fill="#ff8a65" />
        </>
      )}
      {body && <line x1="0" x2={W} y1={body.feetY * H} y2={body.feetY * H} stroke="#4fc3f7" strokeWidth="4" />}
    </svg>
  );
}

function DebugPanel({ info, claude, visionState }) {
  const f = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
  const { face, body, readings: r, sound: s, targets: t } = info;
  return (
    <pre className="debug-panel">
      {[
        `vision ${visionState}  detect ${f(info.detectMs, 0)}ms  face via ${info.faceSource}`,
        `crop ${Math.round(info.crop.w)}×${Math.round(info.crop.h)}`,
        face
          ? `score ${f(face.score)}  eye ${f(face.eyeY)} (target ${f(t.eye)}±${f(t.tolerance)})  headTop ${f(face.headTop)}  size ${f(face.eyeToChin / t.eyeToChin)}  x ${f(face.centerX)}`
          : 'no face',
        body ? `body headTop ${f(body.headTop)}  feet ${body.feetVisible ? 'in' : 'out'} ${f(body.feetY)}  height ${f(body.height)}  hips ${body.hipsVisible ? 'in' : 'out'}` : '',
        `light face ${f(r.face)}  bg ${f(r.background)}  frame ${f(r.frame)}  contrast ${f(r.contrast)}`,
        `clip hi ${f(r.clippedHigh * 100, 1)}%  lo ${f(r.clippedLow * 100, 1)}%  sharp ${f(r.sharpness, 4)}`,
        s ? `sound rms ${f(s.rmsDb, 0)}dB  peak ${f(s.peakDb, 0)}dB  floor ${f(s.floorDb, 0)}dB` : `sound — ${info.speaking ? '(Darpan speaking)' : ''}`,
        `problems ${Object.entries(info.ages).map(([id, ms]) => `${id} ${(ms / 1000).toFixed(1)}s`).join(', ') || 'none'}`,
        info.lightOverride ? `light override ${info.lightOverride}` : '',
        claude
          ? claude.error
            ? `claude error: ${claude.error}`
            : `claude (${claude.reason}, ${claude.ms}ms) light ${claude.light.ok ? 'ok' : 'x'} framing ${claude.framing.ok ? 'ok' : 'x'} clutter ${claude.clutter.ok ? 'ok' : 'x'} angle ${claude.angle.ok ? 'ok' : 'x'}`
          : 'claude —',
      ]
        .filter(Boolean)
        .join('\n')}
    </pre>
  );
}
