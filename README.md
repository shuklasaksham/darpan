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
| `UPLOAD_DIR` | Optional; where uploads are written (default: OS temp dir) |
| `MAX_UPLOAD_MB` | Optional; upload size cap (default 200) |

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
