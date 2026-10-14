# AIM4 — the whole site in one container: built client (dist/) + HTTP API +
# /ws WebSocket + replay parsing, on one origin.
#
# NOTE: the Hetzner box builds with NIXPACKS (nixpacks.toml), and when it does
# this file is never read. It is kept as a working alternative (switch the
# Coolify build pack to "Dockerfile" to use it), and the two must describe the
# same runtime. Changing one without the other is how a heap flag once did
# nothing for a whole deploy.
#
# Debian slim rather than Alpine, and 22 rather than 20. Both come from parsing:
#
#   glibc, not musl. The parser is a Rust/napi module doing millions of small
#   allocations, a pattern musl's allocator handles noticeably worse. On a
#   memory-tight host that is the difference between finishing and being killed.
#   @laihoe/demoparser2 ships a linux-x64-gnu prebuild, so nothing is compiled
#   here either way.
#
#   Node 22.15+ has zstd in node:zlib, which server/replays/tickCodec.js needs to
#   store tick buffers. Node 20 does not, and pulling in a native zstd module to
#   get it would reintroduce the build step this image does not have.

# --- client build ------------------------------------------------------------
FROM node:22-slim AS client

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# VITE_* values are inlined into the bundle, so they are build arguments, not
# runtime env. On Coolify, tick "Build Variable" on each. build/build.mjs refuses
# a hosted build (VITE_LOCAL_MODE=0) without the two Supabase values.
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_API_URL=""
ARG VITE_CS3D_ASSET_BASE=""
ENV VITE_LOCAL_MODE=0 \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_API_URL=$VITE_API_URL \
    VITE_CS3D_ASSET_BASE=$VITE_CS3D_ASSET_BASE

COPY . .
RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:22-slim

WORKDIR /app

# .zip, .tar.gz and .gz/.zst are read in process by server/replays/archive.js.
# .rar cannot be: the format is proprietary and there is no usable in-process
# decoder, so it shells out to whichever of these is present. unar has the more
# complete RAR5 and solid-archive support and is preferred at runtime;
# libarchive-tools (bsdtar) is the fallback. Drop this line and .rar uploads are
# refused with an explanation rather than failing obscurely.
# CloakBrowser baseline fonts (same set as nixpacks.toml) plus archive tools
# and Xvfb for headed Chromium in the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    unar \
    libarchive-tools \
    xvfb \
    xauth \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    fonts-unifont \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-tlwg-loma-otf \
  && rm -rf /var/lib/apt/lists/*

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# CloakBrowser uses its own Chromium build but still needs Chromium's Linux
# system libraries. Cache both the dependencies and signed browser binary in
# the image so the first admin probe does not spend minutes provisioning them.
ENV CLOAKBROWSER_AUTO_UPDATE=false
RUN npx playwright-core install-deps chromium \
  && npx cloakbrowser install

# Server source plus everything it imports. The server reaches into src/ in a
# lot of places (replays, zones, multiplayer, utils, the duel/round models), and
# the hand-picked list of src/ files this used to copy went stale without anyone
# noticing: it never had src/utils/spawnVisibility.js, which server/lobby.js
# imports at boot. Copying src/ whole costs ~50 MB and cannot go stale.
COPY server ./server
COPY src ./src
COPY shared ./shared
# Training and the stats index both decode radar PNGs to build the walkable
# mask (scripts/lib/radarMask.mjs -> registerRadarMask -> prepareControlField).
COPY scripts/lib ./scripts/lib
COPY scripts/extract-round-snapshots.mjs scripts/extract-duel-episodes.mjs ./scripts/
COPY scripts/train-round-model.mjs scripts/train-duel-model.mjs ./scripts/
COPY scripts/train-model-server.mjs scripts/create-account.mjs ./scripts/
COPY public/maps/radar ./public/maps/radar
COPY sampledemos ./sampledemos
COPY --from=client /app/dist ./dist

# Hosted mode, on one origin. Host env (Coolify) wins over all of these.
ENV NODE_ENV=production \
    AIM4_LOCAL=0 \
    AIM4_SERVE_STATIC=1 \
    AIM4_HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080

# Headed CloakBrowser runs on a virtual display; package.json ("type": "module")
# ships in the image so Node loads the ESM server.
#
# --max-old-space-size is not optional at this library size. Node sized its own
# heap at 1 GB here, and the resident statistics store is a few hundred MB of
# typed arrays built by parsing every stats index in turn: against a 1 GB
# ceiling that is permanent GC pressure rather than progress, and /aggregate
# stops answering at all while it grinds (RSS sat at 1.8 GB with the heap
# capped at 1 GB). The host has ~7.7 GB and the parse worker caps its own heap
# separately (AIM4_PARSE_HEAP_MB, default 1536), so this leaves room for a parse
# to run alongside a store build.
CMD ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", "node", "--max-old-space-size=3072", "server/index.js"]
