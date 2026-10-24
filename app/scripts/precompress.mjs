// Brotli (max) and gzip copies of every text-like build file, made once at build
// time so the server never compresses on the fly. The big MediaPipe engine
// shrinks from 13 MB to about 2.7 MB.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dist = path.resolve(import.meta.dirname, '..', 'dist');
const EXTS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.wasm', '.task', '.tflite', '.woff']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let saved = 0;
for (const file of walk(dist)) {
  if (!EXTS.has(path.extname(file)) || file.endsWith('.br') || file.endsWith('.gz')) continue;
  const data = fs.readFileSync(file);
  if (data.length < 1024) continue;
  const br = zlib.brotliCompressSync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  // Only keep compressed copies that are meaningfully smaller.
  if (br.length < data.length * 0.95) {
    fs.writeFileSync(`${file}.br`, br);
    fs.writeFileSync(`${file}.gz`, zlib.gzipSync(data, { level: 9 }));
    saved += data.length - br.length;
  }
}
console.log(`Precompressed build: ${(saved / 1e6).toFixed(1)} MB smaller with Brotli`);
