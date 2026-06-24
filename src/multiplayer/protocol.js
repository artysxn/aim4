// ---------------------------------------------------------------------------
// multiplayer/protocol.js
// Wire protocol message-type constants shared by client + server. Messages are
// JSON objects with a `t` (type) field. Kept tiny and explicit so both ends
// agree without a schema library.
// ---------------------------------------------------------------------------

// Client -> Server
export const C2S = {
  CREATE: 'create', // { name, target, isPublic }
  JOIN: 'join', // { code, name }
  LEAVE: 'leave',
  READY: 'ready', // { ready }
  CONFIG: 'config', // host: { target?, isPublic? }
  START: 'start', // host
  STATE: 'state', // { x,y,z, yaw, pitch, crouch }
  SHOOT: 'shoot', // { ox,oy,oz, dx,dy,dz, rtt? }
  CHAT: 'chat', // { text }
  LIST: 'list', // subscribe to the public lobby browser
  UNLIST: 'unlist', // stop receiving lobby-browser updates
  PING: 'ping' // { id, ct }
};

// Server -> Client
export const S2C = {
  WELCOME: 'welcome', // { id }
  LOBBY: 'lobby', // { lobby }
  ERROR: 'error', // { msg }
  MATCH_START: 'matchStart', // { mapId, target, spawns, scores, stats }
  SNAPSHOT: 'snap', // { players:[...], st }
  HIT: 'hit', // { shooterId, victimId, zone }
  KILL: 'kill', // { shooterId, victimId, scores, mapId?, spawns?, stats? }
  RESPAWN: 'respawn', // { spawns }
  CHAT: 'chat', // { fromId, fromName, text }
  MATCH_END: 'matchEnd', // { winnerId, scores }
  PLAYER_LEFT: 'playerLeft', // { id }
  LOBBY_LIST: 'lobbyList', // { lobbies:[{code,host,map,target,players,max}] }
  PONG: 'pong' // { id, ct, st }
};
