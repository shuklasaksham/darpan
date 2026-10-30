# --- Build the React app ---
FROM node:24-bookworm-slim AS app-build
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

# --- Runtime: Express server + ffmpeg ---
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # The instance has 2 GB: up to 1 GB for the V8 heap, the rest for ffmpeg
    # encoding a reel (about 0.5-0.8 GB at 4K).
    NODE_OPTIONS=--max-old-space-size=1024 \
    STATIC_DIR=/srv/app/dist

WORKDIR /srv/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/fonts ./fonts
COPY server/assets ./assets
COPY --from=app-build /build/app/dist /srv/app/dist

EXPOSE 3000
# Start as root only to hand the Render Disk (mounted root-owned at /var/data)
# to the unprivileged node user, then run the app as node.
CMD ["sh", "-c", "if [ -d /var/data ]; then chown node:node /var/data; fi; exec runuser -u node -- node src/index.js"]
