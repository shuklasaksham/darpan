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
    # Keep the V8 heap well under Render's 512 MB so ffmpeg has room too.
    NODE_OPTIONS=--max-old-space-size=320 \
    STATIC_DIR=/srv/app/dist

WORKDIR /srv/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/fonts ./fonts
COPY --from=app-build /build/app/dist /srv/app/dist

EXPOSE 3000
# Start as root only to hand the Render Disk (mounted root-owned at /var/data)
# to the unprivileged node user, then run the app as node.
CMD ["sh", "-c", "if [ -d /var/data ]; then chown node:node /var/data; fi; exec runuser -u node -- node src/index.js"]
