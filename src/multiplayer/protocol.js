// ---------------------------------------------------------------------------
// multiplayer/protocol.js
// Wire protocol message-type constants shared by client + server. Messages are
// JSON objects with a `t` (type) field. Kept tiny and explicit so both ends
// agree without a schema library.
// ---------------------------------------------------------------------------

// Client -> Server
export const C2S = {
  CREATE: 'create', // { name, target, isPublic, weapon? }
  JOIN: 'join', // { code, name }
  LEAVE: 'leave',
  RETURN_LOBBY: 'returnLobby', // end an active match, stay in the lobby
  READY: 'ready', // { ready }
  CONFIG: 'config', // host: { target?, isPublic?, weapon? }
  START: 'start', // host
  STATE: 'state', // { x,y,z, yaw, pitch, crouch }
  SHOOT: 'shoot', // { ox,oy,oz, dx,dy,dz, ex?,ey?,ez?, aimDx?,aimDy?,aimDz?, onGround?, speedHoriz?, spreadSeed?, rtt?, victimId?, zone? }
  CHAT: 'chat', // { text }
  LIST: 'list', // subscribe to the public lobby browser
  UNLIST: 'unlist', // stop receiving lobby-browser updates
  QUEUE: 'queue', // { name, userId?, elo? }
  DEQUEUE: 'dequeue',
  PING: 'ping' // { id, ct }
};

// Server -> Client
export const S2C = {
  WELCOME: 'welcome', // { id }
  LOBBY: 'lobby', // { lobby }
  ERROR: 'error', // { msg }
  MATCH_START: 'matchStart', // { mapId, target, spawns, scores, stats, gameMode?, matchEndsAt?, duration?, weapon?, ... }
  SNAPSHOT: 'snap', // { players:[...], st, matchEndsAt? }
  SHOT_FIRED: 'shotFired', // { shooterId, x,y,z, ox,oy,oz, mx?,my?,mz?, ex?,ey?,ez? }
  HIT: 'hit', // { shooterId, victimId, zone, scores?, stats?, points? }
  KILL: 'kill', // { shooterId, victimId, scores, mapId?, spawns?, stats? }
  RESPAWN: 'respawn', // { spawns }
  CHAT: 'chat', // { fromId, fromName, text }
  MATCH_END: 'matchEnd', // { winnerId, scores, aborted?, returnToLobby? }
  PLAYER_LEFT: 'playerLeft', // { id }
  LOBBY_LIST: 'lobbyList', // { lobbies:[{code,host,map,target,players,max}] }
  QUEUE_STATUS: 'queueStatus', // { inQueue, queueSize, elo, searchRange? }
  PONG: 'pong' // { id, ct, st }
};
