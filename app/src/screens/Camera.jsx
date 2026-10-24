import { useEffect, useRef, useState } from 'react';
import { planShoot, uploadTake } from '../api.js';
import { pickMimeType, stopStream } from '../media.js';

const VIDEO_TYPES = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export default function Camera({ shoot, health, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const startedAtRef = useRef(0);
  const closedRef = useRef(false);

  const [facing, setFacing] = useState('user');
  const [cameraError, setCameraError] = useState('');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState(null); // { status: 'uploading' | 'done' | 'error', result?, error? }

  const [planned, setPlanned] = useState(null); // { planId, plan }
  const [planState, setPlanState] = useState(health?.director ? 'loading' : 'off');
  const [shotIndex, setShotIndex] = useState(0);

  const shots = Array.isArray(planned?.plan?.shots) ? planned.plan.shots : [];
  const shot = shots[shotIndex];

  // A recording cut short by closing the camera is thrown away, not uploaded.
  useEffect(() => () => {
    closedRef.current = true;
  }, []);

  // Ask the director for a plan while the camera warms up.
  useEffect(() => {
    if (!health?.director) return;
    let cancelled = false;
    planShoot({ idea: shoot.idea, format: shoot.format, language: shoot.language })
      .then((result) => {
        if (cancelled) return;
        setPlanned(result);
        setPlanState('ready');
      })
      .catch(() => !cancelled && setPlanState('error'));
    return () => {
      cancelled = true;
    };
  }, [shoot, health?.director]);

  useEffect(() => {
    let cancelled = false;
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("This browser can't open the camera here.");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: facing, width: { ideal: 1080 }, height: { ideal: 1920 } },
        audio: true,
      })
      .then((stream) => {
        if (cancelled) return stopStream(stream);
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
      })
      .catch(() => !cancelled && setCameraError('Allow camera and microphone access to start shooting.'));
    return () => {
      cancelled = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [facing]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)), 250);
    return () => clearInterval(id);
  }, [recording]);

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = pickMimeType(VIDEO_TYPES);
    const recorder = new MediaRecorder(stream, {
      ...(mimeType && { mimeType }),
      videoBitsPerSecond: 4_000_000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const durationSeconds = (Date.now() - startedAtRef.current) / 1000;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
      if (blob.size && !closedRef.current) send(blob, durationSeconds);
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setSeconds(0);
    setTake(null);
    recorder.start(1000);
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  async function send(blob, durationSeconds) {
    setTake({ status: 'uploading' });
    try {
      const result = await uploadTake(blob, {
        planId: planned?.planId,
        plan: planned?.planId ? undefined : planned?.plan,
        shotIndex: shot ? shotIndex : undefined,
        durationSeconds,
      });
      setTake({ status: 'done', result });
    } catch (err) {
      setTake({ status: 'error', error: err.message });
    }
  }

  function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) send(file);
  }

  return (
    <div className="camera">
      <video
        ref={videoRef}
        className={facing === 'user' ? 'mirrored' : ''}
        autoPlay
        playsInline
        muted
      />

      <div className="camera-top">
        <button className="icon" onClick={onClose} aria-label="Close camera">✕</button>
        <div className="brief">
          {shoot.format && <span className="tag">{shoot.format}</span>}
          {shoot.idea && <p className="brief-idea">{shoot.idea}</p>}
        </div>
      </div>

      <div className="guide">
        {planState === 'loading' && <p>Darpan is planning your shots…</p>}
        {planState === 'error' && <p>Couldn't plan shots right now. You can still record.</p>}
        {shot && (
          <>
            <div className="row between">
              <button className="icon" onClick={() => setShotIndex((i) => i - 1)} disabled={shotIndex === 0} aria-label="Previous shot">‹</button>
              <span className="muted">
                Shot {shotIndex + 1} of {shots.length}
                {shot.duration_seconds && ` · ${shot.duration_seconds}s`}
              </span>
              <button className="icon" onClick={() => setShotIndex((i) => i + 1)} disabled={shotIndex === shots.length - 1} aria-label="Next shot">›</button>
            </div>
            <strong>{shot.title}</strong>
            {shot.framing && <p>{shot.framing}</p>}
            {shot.say && <p className="say">“{shot.say}”</p>}
          </>
        )}
      </div>

      {take && (
        <div className="take-sheet">
          {take.status === 'uploading' && <p>Sending your take…</p>}
          {take.status === 'error' && <p className="error">{take.error}</p>}
          {take.status === 'done' && <TakeResult result={take.result} />}
          {take.status !== 'uploading' && (
            <div className="row">
              <button onClick={() => setTake(null)}>Retake</button>
              {shot && shotIndex < shots.length - 1 && (
                <button
                  className="primary"
                  onClick={() => {
                    setShotIndex((i) => i + 1);
                    setTake(null);
                  }}
                >
                  Next shot
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="camera-bottom">
        {cameraError ? (
          <div className="stack center">
            <p>{cameraError}</p>
            <label className="record">
              Use the phone camera instead
              <input type="file" accept="video/*" capture="user" onChange={onPickFile} hidden />
            </label>
          </div>
        ) : (
          <>
            <span className="timer">{recording ? formatTime(seconds) : ''}</span>
            <button
              className={`shutter ${recording ? 'recording' : ''}`}
              onClick={recording ? stopRecording : startRecording}
              disabled={take?.status === 'uploading'}
              aria-label={recording ? 'Stop recording' : 'Start recording'}
            />
            <button
              className="icon"
              onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
              disabled={recording}
              aria-label="Flip camera"
            >
              ⟲
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TakeResult({ result }) {
  const r = result.review;
  if (!r) {
    return <p>Saved{result.durationSeconds ? ` · ${result.durationSeconds.toFixed(1)}s` : ''}</p>;
  }
  return (
    <div className={`review ${r.verdict === 'retake' ? 'retake' : 'keep'}`}>
      <strong>{r.verdict === 'retake' ? 'Try once more' : 'Nice, keep it!'}</strong>
      {r.praise?.map((p, i) => <p key={`p${i}`}>👍 {p}</p>)}
      {r.fixes?.map((f, i) => <p key={`f${i}`}>👉 {f}</p>)}
      {r.next_step && <p className="muted">{r.next_step}</p>}
    </div>
  );
}

function formatTime(total) {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
