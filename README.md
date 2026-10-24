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
| `ANTHROPIC_API_KEY` | Claude API |
| `DEEPGRAM_API_KEY` | Deepgram speech-to-text |
| `SARVAM_API_KEY` | Sarvam AI (Indian languages) |
| `AGENTICORG_API_KEY` | AgenticOrg workspace API key (`ao_sk_...`); needs access to run the director agent |
| `AGENTICORG_DIRECTOR_AGENT_ID` | UUID of the director agent in AgenticOrg |
| `AGENTICORG_BASE_URL` | Optional; defaults to `https://app.agenticorg.ai` |
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

Gender and niche are sent to the director so Hindi lines use the right verb
forms ("main karti hoon" / "main karta hoon") and ideas fit the creator.

## Shooting

The home screen has a text box and a mic. Whatever is in the text box is used
as the idea, word for word. "Shoot this idea", a format chip or a suggested idea
opens the in-app camera right away, and the director plans shots while it warms
up. Takes are recorded with `MediaRecorder` and uploaded to `/api/takes`.

The mic records audio in the browser and sends it to `/api/transcribe`, which
streams it from disk to Deepgram Nova-3 with `language=multi` and Hindi/English
hints. Browser speech recognition is deliberately not used because it garbles
Hinglish. Deepgram may write Hindi words in Devanagari.

## AI director (AgenticOrg)

The director that plans shoots, recommends shots and reviews takes is an agent
in your [AgenticOrg](https://agenticorg.ai) workspace. The server calls it with
the `agenticorg-sdk` package (`server/src/director.js`), running the agent by
ID with one of three actions. Each call also sends the expected JSON shape in
`context.output_format`.

| Action | When | Expected output |
| --- | --- | --- |
| `suggest_ideas` | Home screen loads | `{ ideas: [{ title, format, why }] }` |
| `plan_shoot` | Camera opens for an idea and/or format | `{ title, hook, shots: [{ title, framing, duration_seconds, say, tips }], caption, hashtags }` |
| `recommend_shot` | "What should I shoot next?" | `{ shot: {...}, why }` |
| `review_take` | A take is uploaded for a planned shot | `{ verdict: "keep" | "retake", praise, fixes, next_step }` |

To set it up:

1. In AgenticOrg, create an agent (for example with **Generate agent**) using
   the brief below, and note its agent ID.
2. Under **Settings → API Keys**, create a key that can run that agent.
3. Set `AGENTICORG_API_KEY` and `AGENTICORG_DIRECTOR_AGENT_ID`.

> You are Darpan's AI director for first-time Indian creators shooting vertical
> reels on a phone. Reply only with JSON in the shape given in
> `context.output_format`. Use the creator's gender for Hindi verb forms. For
> `suggest_ideas`, suggest reel ideas that fit `creator_niche`. For `plan_shoot`,
> keep the creator's idea exactly as given and turn it (and the `format`, if any) into a short shot
> list with a strong 1–3 second hook, simple phone-friendly framing, and lines
> to say in the requested language. For `recommend_shot`, suggest the single
> best next shot given the plan and shots already done. For `review_take`,
> compare the take's duration and orientation with the planned shot and give
> warm, specific, encouraging feedback.

Without these two variables the app still runs: it shows a plain "Record a
take" button and `/api/health` reports `director: false`.

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
