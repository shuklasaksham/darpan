# Launch checklist

What's needed to put Darpan in real users' hands.

## Accounts and keys (owner)

- **Anthropic** API key with web search enabled for the org (Console → Settings).
  Used for scripts, trend cards, frame checks, director's notes and captions.
- **Deepgram** API key (spoken ideas and take transcripts).
- **Sarvam AI** API key (Bulbul voice for tips and notes).
- Optional: AgenticOrg key and agent ID (idea suggestions).
- Set spending limits/alerts in each dashboard.

## Payments (Pine Labs)

- In the Pine Labs Online dashboard, Settings → API Keys: set `PINELABS_CLIENT_ID`
  and `PINELABS_CLIENT_SECRET` in Render; start with `PINELABS_ENV=uat`.
- Ask Pine Labs support to point webhooks at `https://<your-domain>/api/billing/webhook`
  and set the webhook secret as `PINELABS_WEBHOOK_SECRET`.
- Confirm with Pine Labs that amounts are in paise (`PRO_PRICE_PAISE`, default 29900)
  and which order status means paid (`PINELABS_PAID_STATUSES`, default PROCESSED).
- Set `PUBLIC_URL` if you use a custom domain (Render's own URL is used otherwise).
- Switch to `PINELABS_ENV=production` with live keys after a test payment in UAT.
- Pro is a 30-day pass; auto-renewal needs Pine Labs UPI Autopay (separate work).

## Render

- Deploy with **New → Blueprint** from this repo (`render.yaml`).
- Use a paid web plan (Starter or above): the free plan sleeps after 15 minutes
  idle (about a minute's cold start) and has too little CPU for reel rendering.
- Use a paid Postgres plan: free Render Postgres databases expire after 30 days.
- Optional but recommended: attach a **Render Disk** at `/tmp/darpan-uploads` so
  takes survive restarts and deploys (the app re-uploads from the phone if not).
- Add a custom domain (e.g. `darpan.app`). HTTPS is required for the camera and
  microphone on every phone browser; Render provides it automatically.

## Before inviting users

- Privacy policy and terms (camera, microphone and voice data go to Anthropic,
  Deepgram and Sarvam; takes are deleted after 24 hours). Required for India's
  DPDP Act and for app-store listings later.
- A support contact shown in the app.
- Test on real phones with `?debug`: a budget Android (Chrome), a recent Android,
  an iPhone (Safari, iOS 16.4+), and the home-screen (installed) app on both.
  Tune thresholds in `app/src/camera/checks.js` and `server/src/analyze.js`.
- Error monitoring (e.g. Sentry) and uptime checks on `/api/health`.

## Known limits

- One reel renders at a time per server (memory); others queue.
- Rate limits are in memory per instance (`server/src/limits.js`).
- iOS: sharing the reel uses the share sheet ("Save Video" puts it in Photos);
  the Download button saves to Files.
- Browsers can't lock portrait orientation; the installed app requests it.
