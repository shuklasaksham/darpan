// MediaPipe runs on the CPU delegate on purpose: GPU delegates are unreliable on
// the budget Android phones most first-time creators use. The library is
// loaded lazily so the home screen stays light.
let filesetPromise;
let facePromise;
let posePromise;

async function fileset() {
  const { FilesetResolver } = await import('@mediapipe/tasks-vision');
  filesetPromise ??= FilesetResolver.forVisionTasks('/mediapipe/wasm');
  return filesetPromise;
}

export function loadFaceDetector() {
  facePromise ??= (async () => {
    const { FaceDetector } = await import('@mediapipe/tasks-vision');
    return FaceDetector.createFromOptions(await fileset(), {
      baseOptions: { modelAssetPath: '/mediapipe/blaze_face_short_range.tflite', delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    });
  })();
  return facePromise;
}

export function loadPoseLandmarker() {
  posePromise ??= (async () => {
    const { PoseLandmarker } = await import('@mediapipe/tasks-vision');
    return PoseLandmarker.createFromOptions(await fileset(), {
      baseOptions: { modelAssetPath: '/mediapipe/pose_landmarker_lite.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numPoses: 1,
    });
  })();
  return posePromise;
}

let landmarkerPromise;

/** Face mesh with blendshapes, used while recording to tell lens from screen. */
export function loadFaceLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
    return FaceLandmarker.createFromOptions(await fileset(), {
      baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
  })();
  return landmarkerPromise;
}

/**
 * How far the eyes are looking down (0-1). The front camera sits above the
 * screen, so a creator reading the screen looks down relative to the lens.
 */
export function eyeLookDown(landmarker, canvas) {
  const result = landmarker.detect(canvas);
  const shapes = result.faceBlendshapes?.[0]?.categories;
  if (!shapes) return null;
  const score = (name) => shapes.find((c) => c.categoryName === name)?.score ?? 0;
  return (score('eyeLookDownLeft') + score('eyeLookDownRight')) / 2;
}

/**
 * Finds a face, looking inside the silhouette's head area first (a small face
 * in a full-body shot is far easier to find in a close crop), then the whole
 * frame. Returns keypoints in frame fractions, or null.
 *
 * `frame` is a canvas holding the cropped camera frame; `region` is the head
 * area in frame fractions.
 */
export function detectFace(detector, frame, region, scratch) {
  const { width: fw, height: fh } = frame;
  const sx = region.x * fw;
  const sy = region.y * fh;
  const sw = region.w * fw;
  const sh = region.h * fh;
  scratch.width = 256;
  scratch.height = Math.round((256 * sh) / sw);
  scratch.getContext('2d').drawImage(frame, sx, sy, sw, sh, 0, 0, scratch.width, scratch.height);

  let found = best(detector.detect(scratch), scratch);
  let source = 'silhouette';
  if (found) {
    found = mapBack(found, (x, y) => [(sx + x * sw) / fw, (sy + y * sh) / fh]);
  } else {
    found = best(detector.detect(frame), frame);
    source = found ? 'full frame' : 'none';
  }
  return found ? { ...found, source } : { source };
}

function best(result, canvas) {
  const d = result.detections
    .filter((det) => det.boundingBox && det.keypoints.length >= 4)
    .sort((a, b) => (b.categories[0]?.score ?? 0) - (a.categories[0]?.score ?? 0))[0];
  if (!d) return null;
  const b = d.boundingBox;
  // BlazeFace keypoints: 0 right eye, 1 left eye, 2 nose tip, 3 mouth, 4-5 ears.
  const [eyeA, eyeB, nose, mouth] = d.keypoints;
  return {
    score: d.categories[0]?.score ?? 0,
    // The bounding box is in pixels; keypoints are already normalized.
    box: {
      x: b.originX / canvas.width,
      y: b.originY / canvas.height,
      w: b.width / canvas.width,
      h: b.height / canvas.height,
    },
    eyes: [[eyeA.x, eyeA.y], [eyeB.x, eyeB.y]],
    nose: [nose.x, nose.y],
    mouth: [mouth.x, mouth.y],
  };
}

function mapBack(face, map) {
  const [x0, y0] = map(face.box.x, face.box.y);
  const [x1, y1] = map(face.box.x + face.box.w, face.box.y + face.box.h);
  return {
    ...face,
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    eyes: face.eyes.map(([x, y]) => map(x, y)),
    nose: map(...face.nose),
    mouth: map(...face.mouth),
  };
}
