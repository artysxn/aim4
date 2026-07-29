# AIM4 backend — Node.js (HTTP API + /ws WebSocket + replay parsing).
# This project is a Node server, not a static host: the client is built and
# served separately, so nothing here serves dist/ unless AIM4_SERVE_STATIC=1.
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
FROM node:22-slim

WORKDIR /app

# .zip, .tar.gz and .gz/.zst are read in process by server/replays/archive.js.
# .rar cannot be: the format is proprietary and there is no usable in-process
# decoder, so it shells out to whichever of these is present. unar has the more
# complete RAR5 and solid-archive support and is preferred at runtime;
# libarchive-tools (bsdtar) is the fallback. Drop this line and .rar uploads are
# refused with an explanation rather than failing obscurely.
RUN apt-get update \
  && apt-get install -y --no-install-recommends unar libarchive-tools \
  && rm -rf /var/lib/apt/lists/*

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Server source. The client build (dist/) is hosted on Vercel and never served
# here (AIM4_SERVE_STATIC is unset), but the server shares pure-data modules with
# the client under src/multiplayer/ and src/utils/ (shot spread), so those dirs
# must ship too.
COPY server ./server
COPY src/multiplayer ./src/multiplayer
COPY src/utils/shotAccuracy.js src/utils/SourceMovement.js ./src/utils/
# Replay round naming and the binary tick layout are shared with the browser.
COPY src/replays/shared ./src/replays/shared

ENV NODE_ENV=production
EXPOSE 8080

# package.json ("type": "module") ships in the image so Node loads the ESM server.
CMD ["node", "server/index.js"]
