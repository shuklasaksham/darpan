# Darpan

A phone web app that coaches first-time Indian creators while they shoot reels.

- `app/` — React + Vite front end
- `server/` — Node + Express API; serves the built app in production
- `Dockerfile` — builds the app, installs ffmpeg, runs the server
- `render.yaml` — Render Blueprint (web service + Render Postgres)

## Local development

Requires Node 24+ and ffmpeg on your PATH.

```bash
cp .env.example .env
cd server && npm install && npm run dev
cd app && npm install && npm run dev
```

The Vite dev server proxies `/api` to the Express server on port 3000. Use the
"Network" URL Vite prints to open it on your phone (same Wi-Fi). Camera capture
needs HTTPS outside localhost, so test recording on the deployed site.

## Environment variables

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Render Postgres connection string |
| `ANTHROPIC_API_KEY` | Claude: scripts, frame checks, director's notes |
| `DEEPGRAM_API_KEY` | Deepgram: spoken ideas and take transcripts |
| `SARVAM_API_KEY` | Sarvam Bulbul voice for spoken tips and notes |
| `SARVAM_SPEAKER` | Optional Bulbul v3 voice (default `priya`) |
| `UPLOAD_DIR` | Optional; where uploads are written (default: OS temp dir) |
| `MAX_UPLOAD_MB` | Optional; upload size cap (default 200) |

## Accounts

Sign-up asks for a name (English or Hindi script), gender (woman, man, prefer
not to say) and a free-text niche. It then suggests usernames built from the
name; Devanagari names are transliterated the way Indian names are usually
spelled in English (प्रिया शर्मा → `priya.sharma`, सिंह → `singh`). See
`server/src/usernames.js`.

Login is username + 4-digit PIN. PINs are hashed with scrypt, and 5 wrong PINs
lock the account for 15 minutes. Sessions are random tokens in an httpOnly
cookie, stored hashed in the `sessions` table for 30 days. With only 10,000
possible PINs, the lockout is the real protection; don't relax it.

Gender and niche go to Claude so Hindi lines use the right verb forms ("main
karti hoon" / "main karta hoon", or no gendered forms for "prefer not to say")
and scripts fit the creator.

## Ideas

The home screen has a text box and a mic. Whatever is in the text box is used
as the idea, word for word. "Shoot this idea", a format chip or a suggested idea
opens the camera right away.

The mic records audio in the browser and sends it to `/api/transcribe`, which
streams it from disk to Deepgram Nova-3 with `language=multi` and Hindi/English
hints. Browser speech recognition is deliberately not used because it garbles
Hinglish. Deepgram may write Hindi words in Devanagari.

## Script (Claude)

When the camera opens, `/api/script` asks Claude (`server/src/claude.js`) for a
script and shot plan while the camera warms up:

1. Claude's web search looks up what's trending in Indian Reels for the
   creator's niche (cached per niche for 6 hours).
2. Claude writes 1–6 shots, only as many as the idea needs. Each has a line to
   say in Hindi (Devanagari), Hinglish (Roman) or English with gendered verbs
   matching the creator, a framing (close-up, chest up, waist up, full body), a
   pose, a direction and a length; plus background and lighting suggestions for
   the niche and script.

All Claude calls use `claude-opus-5-5` with structured JSON output and the
server-side refusal fallback (`fallbacks: "default"`). Without
`ANTHROPIC_API_KEY` the camera still works with a one-shot plan built from the
idea.

## Camera coaching

A full-screen 9:16 camera (switchable to 4:5, 1:1 or 16:9) shows the line as a
teleprompter at the top near the lens, and a Photogenik-style pose silhouette
for the shot that turns green when framing is right. Live checks run on the
phone about 8 times a second (`app/src/camera/`):

- **Face**: MediaPipe face detection on the CPU delegate (not GPU), looking in
  the silhouette's head area first, then the whole frame. The runtime and models
  are served by this app (downloaded at build time by
  `app/scripts/prepare-mediapipe.mjs`).
- **Framing**: from the eye line and the estimated top of the head (about as far
  above the eyes as the chin is below). Face low → "lower the phone"; head cut
  off or no headroom → "raise the phone"; plus come closer / move back / step
  left or right. Full-body and waist-up shots also use MediaPipe pose: feet in
  frame, head not cut off, body big enough.
- **Light**: only the middle of the face (between the eyes and the mouth), plus
  whole-frame exposure, contrast, clipping and sharpness. "Light is behind you"
  only when the face is dark *and* much darker than the background, so a bright
  wall doesn't count as a window.
- **Sound**: mic level, background-noise floor and clipping.

A problem has to last 1.5 seconds before Darpan mentions it, and only the most
important one is shown and spoken, one at a time, in an Indian voice (Sarvam
Bulbul via `/api/tts`, falling back to the phone's own voice). Tips are spoken
only between takes; while recording they're shown silently.

Once the basics pass, one frame goes to Claude (`/api/frame-check`) to judge
light, framing, background clutter and camera angle. If a light warning keeps
coming back, Claude looks too, and its verdict wins over the on-device reading
until the light changes.

Open the app with `?debug` to see every number live (face position, targets,
face/background brightness, sharpness, sound levels, problem timers, Claude's
verdicts) with overlays on the camera. Thresholds live in
`app/src/camera/checks.js` and `app/src/camera/framing.js`; tune them on real
phones with `?debug`.

## Takes and director's notes

Recording starts after a 3-2-1 countdown and records the cropped canvas (so the
file has the chosen aspect ratio and isn't mirrored) plus the mic. While
recording, the phone samples loudness 10 times a second, where the eyes point
(MediaPipe face landmarks, front camera only), and a small frame every second.

Each take goes to `/api/takes` with that data and three frames (start, middle,
end). The server extracts the audio with ffmpeg, transcribes it with Deepgram
keeping filler words, and measures the beginner mistakes
(`server/src/analyze.js`): a slow first 2 seconds or a "hi guys" opener, a flat
voice or trailing off at line ends, looking at the screen instead of the lens,
a cut-off last word, fillers like "umm" and "matlab", and going over the planned
length. Claude then writes up to 3 director's notes from the transcript,
measurements and frames; without Claude, the rules write them. The take plays
back with a score and the notes, Darpan reads the top note aloud, and "Keep &
next" goes straight to the next shot.

Deepgram documents `filler_words=true` for English; Hindi fillers like "matlab"
are ordinary words, so they're transcribed either way.

## Uploads

Uploads are streamed to disk with multer's disk storage, never held in memory,
because the Render instance has 512 MB of RAM. The Node heap is capped at 320 MB
in the Dockerfile to leave room for ffmpeg. Render's disk is ephemeral, so files
are deleted after each request; attach a Render Disk or object storage if you
need to keep them.

## Deploy on Render

In the Render dashboard choose **New → Blueprint** and pick this repo. Render
reads `render.yaml`, creates the `darpan-db` Postgres database and the `darpan`
web service, and prompts you for the three API keys.
