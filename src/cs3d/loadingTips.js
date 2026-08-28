// ---------------------------------------------------------------------------
// src/cs3d/loadingTips.js
// Tips shown on the 3D loading screen, and the map screenshots behind them.
//
// Every tip states something the site actually does, in one sentence, checked
// against the code rather than remembered: a loading screen is read thousands
// of times, and a tip that promises a feature that does not exist is worse
// than no tip. Keys named here are the keys timelineViewer.js binds.
//
// Order is shuffled per session so the same person loading the same map twice
// reads something new, but the shuffle happens once: within a session the
// rotation walks the whole list before repeating.
// ---------------------------------------------------------------------------

/** Maps with a screenshot in public/maps/loading. */
const SHOT_SLUGS = new Set(['ancient', 'anubis', 'cache', 'dust2', 'inferno', 'mirage', 'nuke']);

/** Background image for a map's loading screen, or '' when there is none. */
export function loadingShotUrl(slug) {
  const s = String(slug || '').toLowerCase();
  return SHOT_SLUGS.has(s) ? `/maps/loading/${s}.jpg` : '';
}

export const TIPS = Object.freeze([
  // --- playback ------------------------------------------------------------
  'Space plays and pauses. The arrow keys step 2 seconds; hold Shift for 10.',
  'O and P jump 15 seconds back or forward.',
  'J and K switch to the previous and next round.',
  'M cycles playback speed.',
  'Press 1 to 0 to spectate a player by their seat on the scoreboard.',
  'V switches between the map view and the spectated player’s POV.',
  'Hold Tab for the stats board without leaving the round.',
  'The round strip under the map jumps straight to any round of the match.',
  // --- 3D ------------------------------------------------------------------
  'In 3D, F follows the player you are spectating.',
  'In 3D, G frees the camera to fly anywhere on the map.',
  'In 3D, X turns on x-ray so players show through walls.',
  'In 3D, hold Q for a radar overview of the whole map.',
  'The scroll wheel cycles cameras in 3D.',
  'The 3D and 2D views share the same clock: switch mid-round and nothing moves.',
  // --- tools on the viewer -------------------------------------------------
  'Draw executes straight onto the radar with the pencil tool. E clears your drawings.',
  'Hover a player and press S to copy a setpos command that puts you on that exact spot in CS2.',
  'The chart button plots round win chance as the round plays.',
  'The duels panel breaks a round into its duels.',
  'The coach button flags one team’s mistakes, round by round.',
  'The zones button overlays position names on the map.',
  'The bookmark button saves a round to a playlist.',
  'Playlists collect rounds from different matches into one reel.',
  'Every round has its own link. Share the exact moment, not the whole match.',
  'Share links work without an account, so a teammate can watch before signing up.',
  // --- voice comms ---------------------------------------------------------
  'The mic button attaches recorded TeamSpeak comms to a demo.',
  'Comms captions appear over the speaking player in 2D and in a sidebar in 3D.',
  'Recording comms? Say “record, three, two, one” on round 1’s freeze clock and the file syncs itself.',
  'The comms recorder is one small program that keeps itself up to date.',
  'If comms captions drift, nudge the sync by a second from the mic dialog.',
  // --- uploads and library -------------------------------------------------
  'Drag a .dem file onto the site to upload it. Compressed demos work too.',
  'Demos, extracted rounds, and voice comms share one storage meter, in Account under Data.',
  'Upload both teams’ matches and the antistrat tool reads your opponent’s habits.',
  // --- stats and analytics -------------------------------------------------
  'Pattern search finds every round in your library that matches a setup.',
  'The round library groups rounds by how they were actually played.',
  'Charts build from any stat column, filtered the same way as the tables.',
  'The performance page tracks form over time, map by map.',
  'Aim analytics measure your crosshair work from real demos, not aim maps.',
  'Leaderboards rank players by elo. Click any name for their profile.',
  // --- team ----------------------------------------------------------------
  'The stratbook keeps strategies per map, linked to the demos that prove them.',
  'Team documents embed boards and clips next to the text.',
  'The utility archive stores lineups per map for the whole team.',
  'The drawing board is a shared canvas for planning executes.',
  'A team plan lends seats: teammates get the plan without paying separately.',
  // --- practice ------------------------------------------------------------
  'Every ported map is walkable in your browser: aim4.io/dust2, /mirage, /inferno and the rest.',
  'Grenade practice uses real CS2 trajectories, in the browser.',
  'Wallbangs in practice use CS2 penetration values, surface by surface.',
  'The doors gamemode holds mid doors against real pro CT rounds.',
  'Deathmatch with bots runs on all seven ported maps.',
  // --- account -------------------------------------------------------------
  'Sign in on any device and your settings follow you.',
  'On a phone, the same link opens the mobile layout. Switch back from the footer.'
]);

/**
 * The session's tip order: every tip once, shuffled, then again.
 * A generator so callers just pull the next one on their own clock.
 */
export function tipCycle(random = Math.random) {
  const order = TIPS.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let at = 0;
  return () => {
    const tip = order[at % order.length];
    at += 1;
    return tip;
  };
}
