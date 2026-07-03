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

import matchmaking from '../icons/icon_matchmaking.svg?url';
import training    from '../icons/icon_training.svg?url';
import playlists   from '../icons/icon_playlists.svg?url';
import customgames from '../icons/icon_customgames.svg?url';
import multiplayer from '../icons/icon_multiplayer.svg?url';
import leaderboard from '../icons/icon_leaderboards.svg?url';
import account     from '../icons/icon_account.svg?url';
import settings    from '../icons/icon_settings.svg?url';

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
  deathmatch
};

export const MATCHMAKING_ICON   = matchmaking;
export const TRAINING_ICON      = training;
export const PLAYLISTS_ICON     = playlists;
export const CUSTOM_GAMES_ICON  = customgames;
export const MULTIPLAYER_ICON   = multiplayer;
export const LEADERBOARD_ICON   = leaderboard;
export const ACCOUNT_ICON       = account;
export const LOGOUT_ICON        = account; // no dedicated logout icon in the icon set
export const SETTINGS_ICON      = settings;
