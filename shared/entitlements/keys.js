// ---------------------------------------------------------------------------
// shared/entitlements/keys.js
// Capability keys as constants.
//
// `can(user, CAP.DEMOS_UPLOAD_LIMIT)` fails at import time if the name is
// wrong. `can(user, 'demos.upload_limt')` fails silently at runtime, on a
// Tuesday, for one user, in production. Import from here everywhere.
// ---------------------------------------------------------------------------

import { CAPABILITY_KEYS } from './catalogue.js';

export const CAP = Object.freeze({
  DEMOS_VIEWER: 'demos.viewer',
  DEMOS_ADS_FREE: 'demos.ads_free',
  DEMOS_FULL_RECENT_ACCESS: 'demos.full_recent_access',
  DEMOS_MACRO_VIEWER: 'demos.macro_viewer',
  DEMOS_UPLOAD_LIMIT: 'demos.upload_limit',
  DEMOS_MAP_CONTROL: 'demos.map_control',
  DEMOS_ROUND_WIN_PREDICTION: 'demos.round_win_prediction',
  DEMOS_DUEL_WIN_PREDICTION: 'demos.duel_win_prediction',
  DEMOS_AUTO_COACH: 'demos.auto_coach',
  DEMOS_TEAMSPEAK_SYNC: 'demos.teamspeak_sync',
  DEMOS_COMMS_COACH: 'demos.comms_coach',
  DRAWING_BOARD: 'drawing_board',

  STATS_PERFORMANCE_CHAPTERS: 'stats.performance_chapters',
  STATS_SINGLE_GAME: 'stats.single_game',
  STATS_TEAM_STATISTICS: 'stats.team_statistics',
  STATS_METRICS_PLAYER_FULL: 'stats.metrics_player_full',
  STATS_METRICS_TEAM_FULL: 'stats.metrics_team_full',
  STATS_FILTERS_FULL: 'stats.filters_full',
  ANALYTICS_CHARTS: 'analytics.charts',
  ANALYTICS_PATTERN_FINDER: 'analytics.pattern_finder',
  ANALYTICS_ANTISTRAT: 'analytics.antistrat',

  TEAM_CREATE_LIMIT: 'team.create_limit',
  TEAM_JOIN: 'team.join',
  TEAM_SEAT_CAPACITY: 'team.seat_capacity',
  TEAM_DOCUMENTS: 'team.documents',
  TEAM_ROLES_POSITIONS: 'team.roles_positions',
  TEAM_PLAYLISTS: 'team.playlists',
  TEAM_COMMS: 'team.comms',
  TEAM_STRATBOOK_ACCESS: 'team.stratbook_access',
  TEAM_STRATBOOK_LIMIT: 'team.stratbook_limit',
  TEAM_UTILITY_ARCHIVE: 'team.utility_archive',
  TEAM_STRATEGY_CREATOR_2D: 'team.strategy_creator_2d',
  TEAM_AUTO_ROUND_WINRATES: 'team.auto_round_winrates',

  AIM_TRAINER: 'aim.trainer',
  AIM_ROUTINES: 'aim.routines',
  AIM_MAP_PRACTICE: 'aim.map_practice',
  AIM_ADVANCED_ANALYTICS: 'aim.advanced_analytics',
  AIM_REPLAYS: 'aim.replays',
  AIM_CUSTOM_ROUTINES: 'aim.custom_routines',
  AIM_COSMETICS: 'aim.cosmetics'
});

// A key added to the catalogue but not here (or renamed in one place only)
// would otherwise be found by whichever test happened to touch it. Fail loudly
// at import instead, in both runtimes.
const declared = new Set(Object.values(CAP));
const missing = CAPABILITY_KEYS.filter((k) => !declared.has(k));
const extra = [...declared].filter((k) => !CAPABILITY_KEYS.includes(k));
if (missing.length || extra.length) {
  throw new Error(
    `keys.js is out of sync with catalogue.js. Missing: [${missing}] Unknown: [${extra}]`
  );
}
