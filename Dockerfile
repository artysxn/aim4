# AIM4 multiplayer backend — Node.js (HTTP config API + /ws WebSocket).
# Replaces the static-site image fly launch auto-detected; this project is a
# Node server, not a static host (the client is served separately on Vercel).
FROM node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Server source. The client build (dist/) is hosted on Vercel and never served
# here (AIM4_SERVE_STATIC is unset), but the server shares a few pure-data
# modules with the client under src/multiplayer/ (lobby.js / hitscan.js import
# constants.js, protocol.js, maps.js), so that dir must ship too.
COPY server ./server
COPY src/multiplayer ./src/multiplayer

ENV NODE_ENV=production
EXPOSE 8080

# package.json ("type": "module") ships in the image so Node loads the ESM server.
CMD ["node", "server/index.js"]
