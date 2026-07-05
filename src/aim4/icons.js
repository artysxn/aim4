// AIM4 menu / scenario icons — sourced exclusively from src/icons/
import gridshot    from '../icons/mode_gridshot.svg?url';
import stars       from '../icons/mode_stars.svg?url';
import bounce      from '../icons/mode_bounce.svg?url';
import microflicks from '../icons/mode_microflicks.svg?url';
import pasu        from '../icons/mode_pasu.svg?url';
import spidershot  from '../icons/mode_spidershot.svg?url';
import survival    from '../icons/mode_survival.svg?url';
import arena       from '../icons/mode_crossfire.svg?url';
import duels       from '../icons/mode_duels.svg?url';
import range       from '../icons/mode_range.svg?url';
import tracking    from '../icons/mode_tracking.svg?url';
import deathmatch  from '../icons/mode_deathmatch.svg?url';
import sequence    from '../icons/mode_sequence.svg?url';
import double_     from '../icons/mode_double.svg?url';
import ball        from '../icons/icon_ball.svg?url';
import waves       from '../icons/mode_waves.svg?url';
import box         from '../icons/mode_box.svg?url';
import circle      from '../icons/mode_circle.svg?url';
import threeshot   from '../icons/mode_threeshot.svg?url';
import cover       from '../icons/mode_cover.svg?url';
import drone       from '../icons/mode_drone.svg?url';
import line        from '../icons/mode_line.svg?url';
import sniperpeeks from '../icons/mode_sniperpeeks.svg?url';
import sniperholds from '../icons/mode_sniperholds.svg?url';
import sniperquickscopes from '../icons/mode_sniperquickscopes.svg?url';
import sniperflicks from '../icons/mode_sniperflicks.svg?url';

import matchmaking from '../icons/icon_matchmaking.svg?url';
import training    from '../icons/icon_training.svg?url';
import playlists   from '../icons/icon_playlists.svg?url';
import customgames from '../icons/icon_customgames.svg?url';
import multiplayer from '../icons/icon_multiplayer.svg?url';
import leaderboard from '../icons/icon_leaderboards.svg?url';
import account     from '../icons/icon_account.svg?url';
import logout      from '../icons/icon_logout.svg?url';
import settings    from '../icons/icon_settings.svg?url';
import precision   from '../icons/icon_precision.svg?url';
import all         from '../icons/icon_all.svg?url';

/** Scenario card icons keyed by SceneManager scenario id. */
export const SCENARIO_ICONS = {
  gridshot,
  stars,
  bounce,
  microflicks,
  pasu,
  spidershot,
  survival,
  arena,
  duels,
  range,
  tracking,
  deathmatch,
  sequence,
  sequencespeed: sequence,
  sequencetracking: sequence,
  double: double_,
  doubletracking: double_,
  ball,
  bouncetracking: bounce, // Bounce (Tracking) shares the Bounce icon
  pasutracking: pasu,     // Pasu (Tracking) shares the Pasu icon
  turn: precision,        // no dedicated Turn icon — Precision glyph fits
  box,
  circle,
  threeshot,
  cover,
  drone,
  line,
  galaxy: stars,          // Galaxy challenge uses the Stars icon (by design)
  waves,
  sequenceultra: sequence,
  sniperpeeks,
  sniperholds,
  sniperquickscopes,
  sniperflicks,
  snipertracking: sniperflicks // no dedicated icon — shares the Flicks scope glyph
};

export const MATCHMAKING_ICON   = matchmaking;
export const TRAINING_ICON      = training;
export const PLAYLISTS_ICON     = playlists;
export const CUSTOM_GAMES_ICON  = customgames;
export const MULTIPLAYER_ICON   = multiplayer;
export const LEADERBOARD_ICON   = leaderboard;
export const ACCOUNT_ICON       = account;
export const LOGOUT_ICON        = logout;
export const SETTINGS_ICON      = settings;
export const PRECISION_ICON     = precision;
export const ALL_MODES_ICON     = all;
