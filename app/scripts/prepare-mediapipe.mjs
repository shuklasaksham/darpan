// Copies MediaPipe's WebAssembly runtime into public/ and downloads the face and
// pose models once, so the app serves them itself instead of a third-party CDN.
import fs from 'node:fs';
import path from 'node:path';

const appDir = path.resolve(import.meta.dirname, '..');
const outDir = path.join(appDir, 'public', 'mediapipe');
const wasmSrc = path.join(appDir, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');

const MODELS = {
  'blaze_face_short_range.tflite':
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

fs.mkdirSync(path.join(outDir, 'wasm'), { recursive: true });
for (const file of fs.readdirSync(wasmSrc)) {
  // The ES-module build of the runtime is never loaded (FilesetResolver's default).
  if (file.includes('_module_')) continue;
  fs.copyFileSync(path.join(wasmSrc, file), path.join(outDir, 'wasm', file));
}

for (const [name, url] of Object.entries(MODELS)) {
  const dest = path.join(outDir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading ${name} failed: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`Downloaded ${name}`);
}
