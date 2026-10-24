export function pickMimeType(candidates) {
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

export function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}
