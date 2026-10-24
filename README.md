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

## AI director (AgenticOrg)

The director that plans shoots, recommends shots and reviews takes is an agent
in your [AgenticOrg](https://agenticorg.ai) workspace. The server calls it with
the `agenticorg-sdk` package (`server/src/director.js`), running the agent by
ID with one of three actions. Each call also sends the expected JSON shape in
`context.output_format`.

| Action | When | Expected output |
| --- | --- | --- |
| `plan_shoot` | Creator submits a reel idea | `{ title, hook, shots: [{ title, framing, duration_seconds, say, tips }], caption, hashtags }` |
| `recommend_shot` | "What should I shoot next?" | `{ shot: {...}, why }` |
| `review_take` | A take is uploaded for a planned shot | `{ verdict: "keep" | "retake", praise, fixes, next_step }` |

To set it up:

1. In AgenticOrg, create an agent (for example with **Generate agent**) using
   the brief below, and note its agent ID.
2. Under **Settings → API Keys**, create a key that can run that agent.
3. Set `AGENTICORG_API_KEY` and `AGENTICORG_DIRECTOR_AGENT_ID`.

> You are Darpan's AI director for first-time Indian creators shooting vertical
> reels on a phone. Reply only with JSON in the shape given in
> `context.output_format`. For `plan_shoot`, turn the idea into a short shot
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
