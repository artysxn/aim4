# AIM4 backend — Node.js (HTTP API + /ws WebSocket + replay parsing).
# This project is a Node server, not a static host: the client is built and
# served separately, so nothing here serves dist/ unless AIM4_SERVE_STATIC=1.
FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache 7zip

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
