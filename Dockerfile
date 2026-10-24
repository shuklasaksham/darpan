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
    UPLOAD_DIR=/tmp/darpan-uploads \
    STATIC_DIR=/srv/app/dist

WORKDIR /srv/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=app-build /build/app/dist /srv/app/dist

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
