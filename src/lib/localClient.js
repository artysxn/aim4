// ---------------------------------------------------------------------------
// lib/localClient.js
// The stand-in for the Supabase client when this machine is the deployment.
//
// One account, one browser, no network: the tables the app reads and writes are
// JSON arrays in localStorage and the RPCs are the SQL in supabase/ rewritten in
// JavaScript against them. The point is that NOTHING above this file changes —
// AuthManager, the leaderboards, the account page, the replays store all keep
// talking to the same client-shaped API they always did, they just get their
// rows from here.
//
// What it is not: a Postgres. No RLS, no transactions, no concurrent writers, no
// second reader. There is one reader, and it is this tab. Anything that needs
// those is a hosted feature and says so where it is used (see /api routes, which
// answer from the server side).
//
// Kept deliberately small: the query builder implements the operators the app
// actually calls (eq/neq/in/ilike/gte/lte/gt/lt/is, order/limit/range,
// single/maybeSingle) and the RPC set is the thirteen functions in schema.sql
// plus the migrations. An unknown table reads as empty rather than throwing, so
// a hosted-only view shows its empty state instead of a blank page.
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'aim4.local.';
const SESSION_KEY = 'aim4.local.session';

/** The one account. Mirrors server/local/mode.js; the two cannot drift because
 *  nothing here is security, only labelling. */
export const LOCAL_USER_ID = 'local:owner';
const LOCAL_USERNAME = 'owner';

/** Scenarios whose leaderboard ranks kills rather than score. */
const KILL_RANKED = new Set([
  'gridshot', 'stars', 'microflicks', 'pasu', 'spidershot', 'arena', 'duels',
  'range', 'deathmatch'
]);

/** Not rated toward the overall Aim rating, exactly as the SQL excludes them. */
const UNRATED_MODES = new Set(['duels', 'range', 'deathmatch']);

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

function readTable(table) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + table);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeTable(table, rows) {
  try {
    localStorage.setItem(STORAGE_PREFIX + table, JSON.stringify(rows));
  } catch (err) {
    // A full quota must not take the run down with it.
    console.warn('[local] could not persist', table, err?.message);
  }
}

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `local-${Date.now().toString(36)}-${idCounter}`;
}

const nowIso = () => new Date().toISOString();

function rowsMatching(rows, filters) {
  return rows.filter((row) =>
    filters.every(({ op, column, value }) => {
      const cell = row[column];
      switch (op) {
        case 'eq': return cell === value;
        case 'neq': return cell !== value;
        case 'in': return Array.isArray(value) && value.includes(cell);
        case 'ilike': return String(cell ?? '').toLowerCase().includes(String(value ?? '').toLowerCase().replace(/%/g, ''));
        case 'gt': return cell > value;
        case 'gte': return cell >= value;
        case 'lt': return cell < value;
        case 'lte': return cell <= value;
        case 'is': return value === null ? cell === null || cell === undefined : cell === value;
        default: return true;
      }
    })
  );
}

/** PostgREST returns only the asked-for columns. '*' means the whole row. */
function project(row, columns) {
  if (!columns || columns === '*') return { ...row };
  const wanted = String(columns)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => !c.includes('(') && !c.includes(':'));
  if (!wanted.length) return { ...row };
  const out = {};
  for (const column of wanted) out[column] = row[column];
  return out;
}

// ---------------------------------------------------------------------------
// query builder
// ---------------------------------------------------------------------------

class Query {
  constructor(table, hooks = {}) {
    this.table = table;
    this.hooks = hooks;
    this.action = 'select';
    this.columns = '*';
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.offset = 0;
    this.singleMode = null;
    this.payload = null;
    this.conflict = null;
  }

  select(columns = '*') {
    this.action = 'select';
    this.columns = columns;
    return this;
  }

  insert(rows) {
    this.action = 'insert';
    this.payload = rows;
    return this;
  }

  upsert(rows, { onConflict } = {}) {
    this.action = 'upsert';
    this.payload = rows;
    this.conflict = onConflict ? String(onConflict).split(',').map((c) => c.trim()) : null;
    return this;
  }

  update(patch) {
    this.action = 'update';
    this.payload = patch;
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  eq(column, value) { return this._where('eq', column, value); }
  neq(column, value) { return this._where('neq', column, value); }
  gt(column, value) { return this._where('gt', column, value); }
  gte(column, value) { return this._where('gte', column, value); }
  lt(column, value) { return this._where('lt', column, value); }
  lte(column, value) { return this._where('lte', column, value); }
  in(column, value) { return this._where('in', column, value); }
  ilike(column, value) { return this._where('ilike', column, value); }
  is(column, value) { return this._where('is', column, value); }

  _where(op, column, value) {
    this.filters.push({ op, column, value });
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.orders.push({ column, ascending });
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  range(from, to) {
    this.offset = from;
    this.limitCount = to - from + 1;
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybe';
    return this;
  }

  then(onFulfilled, onRejected) {
    return this._run().then(onFulfilled, onRejected);
  }

  _run() {
    try {
      return Promise.resolve(this._execute());
    } catch (err) {
      console.warn('[local] query failed', this.table, err?.message);
      return Promise.resolve({ data: null, error: { message: String(err?.message || err), code: 'P0001' } });
    }
  }

  _execute() {
    const table = this.table;
    const rows = readTable(table);

    if (this.action === 'insert' || this.action === 'upsert') {
      return this._write(rows);
    }

    let matched = rowsMatching(rows, this.filters);

    if (this.action === 'delete') {
      const keep = rows.filter((row) => !matched.includes(row));
      writeTable(table, keep);
      return { data: null, error: null };
    }

    if (this.action === 'update') {
      for (const row of matched) Object.assign(row, this.payload);
      writeTable(table, rows);
      const out = matched.map((row) => project(row, this.columns));
      return { data: this._shape(out), error: null };
    }

    for (const { column, ascending } of [...this.orders].reverse()) {
      matched = [...matched].sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
      });
    }

    if (this.offset) matched = matched.slice(this.offset);
    if (this.limitCount != null) matched = matched.slice(0, this.limitCount);

    return { data: this._shape(matched.map((row) => project(row, this.columns))), error: null };
  }

  _write(rows) {
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
    const written = [];
    for (const raw of incoming) {
      const row = { ...raw };
      if (row.created_at === undefined && TIMESTAMPED.has(this.table)) row.created_at = nowIso();
      if (this.action === 'upsert' && this.conflict) {
        const existing = rows.find((candidate) =>
          this.conflict.every((column) => candidate[column] === row[column])
        );
        if (existing) {
          Object.assign(existing, row);
          written.push(existing);
          continue;
        }
      }
      if (row.id === undefined) row.id = nextId();
      rows.push(row);
      written.push(row);
    }
    writeTable(this.table, rows);
    this.hooks.afterWrite?.(this.table, written);
    return { data: this.action === 'upsert' ? null : this._shape(written), error: null };
  }

  _shape(data) {
    if (this.singleMode === 'single') {
      if (!data.length) return { data: null, error: { message: 'No rows returned', code: 'PGRST116' } };
      return { data: data[0], error: null };
    }
    if (this.singleMode === 'maybe') return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }
}

/** Tables that get a created_at without being asked. */
const TIMESTAMPED = new Set([
  'profiles', 'scores', 'aim_run_stats', 'replays', 'shared_replays',
  'user_settings', 'demo_watch_time'
]);

// ---------------------------------------------------------------------------
// the RPCs
// ---------------------------------------------------------------------------

function profileFor(userId) {
  return readTable('profiles').find((row) => row.id === userId) || null;
}

function patchProfile(userId, patch) {
  const rows = readTable('profiles');
  const row = rows.find((r) => r.id === userId);
  if (!row) return null;
  Object.assign(row, patch);
  writeTable('profiles', rows);
  return row;
}

/**
 * The board behind get_leaderboard_top and get_scenario_leaderboard_rank: one
 * best run per account for a scenario/config pair. Kill-ranked modes compare
 * kills, everything else compares score, and a tie goes to the earlier run.
 */
function leaderboard(scenario, configKey) {
  const killRanked = KILL_RANKED.has(scenario);
  const better = (a, b) => {
    if (killRanked) {
      const ak = a.kills ?? a.score ?? 0;
      const bk = b.kills ?? b.score ?? 0;
      if (ak !== bk) return ak > bk;
      if ((a.accuracy ?? 0) !== (b.accuracy ?? 0)) return (a.accuracy ?? 0) > (b.accuracy ?? 0);
    } else if (a.score !== b.score) {
      return (a.score ?? 0) > (b.score ?? 0);
    }
    return String(a.created_at) < String(b.created_at);
  };

  const best = new Map();
  for (const score of readTable('scores')) {
    if (score.scenario !== scenario || score.config_key !== configKey) continue;
    const held = best.get(score.user_id);
    if (!held || better(score, held)) best.set(score.user_id, score);
  }
  return [...best.values()].map((score) => {
    const profile = profileFor(score.user_id);
    return {
      user_id: score.user_id,
      username: profile?.username || `player_${String(score.user_id).replace(/-/g, '').slice(0, 8)}`,
      score: score.score ?? 0,
      accuracy: score.accuracy ?? null,
      crit_ratio: score.crit_ratio ?? null,
      kills: score.kills ?? null,
      time_played: score.time_played ?? null,
      kpm: score.kpm ?? null,
      achieved_at: score.created_at
    };
  });
}

function rankBoard(rows, scenario) {
  const killRanked = KILL_RANKED.has(scenario);
  return [...rows].sort((a, b) => {
    if (killRanked) {
      const ak = a.kills ?? a.score ?? 0;
      const bk = b.kills ?? b.score ?? 0;
      if (ak !== bk) return bk - ak;
      if ((a.accuracy ?? 0) !== (b.accuracy ?? 0)) return (b.accuracy ?? 0) - (a.accuracy ?? 0);
    } else if (a.score !== b.score) return b.score - a.score;
    return String(a.achieved_at).localeCompare(String(b.achieved_at));
  });
}

const clampLimit = (value, fallback, max) =>
  Math.max(1, Math.min(Number.isFinite(value) ? value : fallback, max));

/** Best run per rated gamemode, averaged, and only past the three-mode floor. */
function ratingByUser(column) {
  const best = new Map();
  for (const run of readTable('aim_run_stats')) {
    if (UNRATED_MODES.has(run.scenario) || run.variant !== 'competitive') continue;
    const value = run[column];
    if (value === null || value === undefined) continue;
    const key = `${run.user_id} ${run.scenario}`;
    const held = best.get(key);
    if (!held || value > held.value) best.set(key, { userId: run.user_id, value });
  }
  const perUser = new Map();
  for (const { userId, value } of best.values()) {
    if (!perUser.has(userId)) perUser.set(userId, []);
    perUser.get(userId).push(value);
  }
  const out = new Map();
  for (const [userId, values] of perUser) {
    if (values.length < 3) continue;
    out.set(userId, values.reduce((a, b) => a + b, 0) / values.length);
  }
  return out;
}

const CATEGORY_COLUMNS = {
  precision: 'rating_precision',
  speed: 'rating_speed',
  flicks: 'rating_flicks',
  adjustments: 'rating_adjustments',
  reaction: 'rating_reaction',
  tension: 'rating_tension',
  tracking: 'rating_tracking'
};

function avg(rows, column) {
  const values = rows.map((r) => r[column]).filter((v) => Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function sum(rows, column) {
  return rows.reduce((total, row) => total + (Number(row[column]) || 0), 0);
}

const RPC = {
  claim_username({ p_username }) {
    const name = String(p_username || '').trim().toLowerCase();
    if (!name) return { data: null, error: { message: 'Username required', code: '22023' } };
    const taken = readTable('profiles').some((row) => row.username === name && row.id !== LOCAL_USER_ID);
    if (taken) return { data: null, error: { message: 'username_taken', code: '23505' } };
    const row = patchProfile(LOCAL_USER_ID, { username: name, username_chosen: true });
    return { data: row, error: null };
  },

  increment_play_time({ p_user_id: userId, p_seconds: seconds }) {
    if (!userId || !(seconds > 0)) return { data: null, error: null };
    const profile = profileFor(userId);
    patchProfile(userId, { play_time_sec: (profile?.play_time_sec || 0) + seconds });
    return { data: null, error: null };
  },

  update_overall_aim_rating({ p_user_id: userId, p_rating: rating }) {
    if (!userId || !Number.isFinite(rating)) return { data: null, error: null };
    patchProfile(userId, { overall_aim_rating: rating });
    return { data: null, error: null };
  },

  get_leaderboard_top({ p_scenario: scenario, p_config_key: configKey, p_limit: limit }) {
    const rows = rankBoard(leaderboard(scenario, configKey), scenario);
    return { data: rows.slice(0, clampLimit(limit, 10, 50)), error: null };
  },

  get_elo_leaderboard_top({ p_limit: limit }) {
    const rows = readTable('profiles')
      .map((p) => ({ user_id: p.id, username: p.username, elo: p.elo ?? 1000, joined_at: p.created_at }))
      .sort((a, b) => b.elo - a.elo || String(a.joined_at).localeCompare(String(b.joined_at)));
    return { data: rows.slice(0, clampLimit(limit, 50, 100)), error: null };
  },

  get_scenario_leaderboard_rank({ p_scenario: scenario, p_config_key: configKey, p_user_id: userId }) {
    const ordered = rankBoard(leaderboard(scenario, configKey), scenario);
    const index = ordered.findIndex((row) => row.user_id === userId);
    if (index === -1) {
      return { data: [{ rank: null, total: ordered.length, score: null, kills: null, accuracy: null, kpm: null, time_played: null }], error: null };
    }
    const row = ordered[index];
    return {
      data: [{
        rank: index + 1,
        total: ordered.length,
        score: row.score,
        kills: row.kills,
        accuracy: row.accuracy,
        kpm: row.kpm,
        time_played: row.time_played
      }],
      error: null
    };
  },

  get_elo_leaderboard_rank({ p_user_id: userId }) {
    const rows = readTable('profiles')
      .map((p) => ({ user_id: p.id, elo: p.elo ?? 1000 }))
      .sort((a, b) => b.elo - a.elo);
    const index = rows.findIndex((row) => row.user_id === userId);
    return {
      data: [{ rank: index === -1 ? null : index + 1, total: rows.length, elo: rows[index]?.elo ?? 1000 }],
      error: null
    };
  },

  get_account_replays({ p_user_id: userId }) {
    const rows = readTable('replays')
      .filter((row) => row.user_id === userId)
      .sort((a, b) =>
        String(a.scenario).localeCompare(String(b.scenario)) ||
        String(a.variant).localeCompare(String(b.variant)) ||
        Number(a.slot || 0) - Number(b.slot || 0)
      );
    return { data: rows, error: null };
  },

  get_aim_stats({ p_user_id: userId, p_scenario: scenario, p_last_n: lastN, p_since: since }) {
    let rows = readTable('aim_run_stats');
    if (userId) rows = rows.filter((row) => row.user_id === userId);
    if (scenario) rows = rows.filter((row) => row.scenario === scenario);
    if (since) rows = rows.filter((row) => row.created_at >= since);
    rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (Number.isFinite(lastN)) rows = rows.slice(0, Math.max(1, lastN));
    return {
      data: [{
        games: rows.length,
        flick_speed_ms: avg(rows, 'flick_speed_ms'),
        flick_accuracy_pct: avg(rows, 'flick_accuracy_pct'),
        tension_pct: avg(rows, 'tension_pct'),
        flicks_accurate: sum(rows, 'flicks_accurate'),
        flicks_over: sum(rows, 'flicks_over'),
        flicks_under: sum(rows, 'flicks_under'),
        clicks_early: sum(rows, 'clicks_early'),
        clicks_accurate: sum(rows, 'clicks_accurate'),
        clicks_late: sum(rows, 'clicks_late'),
        tracking_pct: avg(rows, 'tracking_pct'),
        reaction_ms: avg(rows, 'reaction_ms'),
        adjustments_per_target: avg(rows, 'adjustments_per_target'),
        speed_deg_s: avg(rows, 'speed_deg_s')
      }],
      error: null
    };
  },

  get_aim_rating_leaderboard({ p_limit: limit }) {
    const ratings = ratingByUser('run_overall_rating');
    const rows = [...ratings.entries()]
      .map(([userId, rating]) => {
        const profile = profileFor(userId);
        return profile
          ? { user_id: userId, username: profile.username, country_code: profile.country_code || null, overall_aim_rating: rating }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.overall_aim_rating - a.overall_aim_rating)
      .slice(0, clampLimit(limit, 500, 1000))
      .map((row, i) => ({ ...row, rank: i + 1 }));
    return { data: rows, error: null };
  },

  get_aim_rating_rank({ p_user_id: userId }) {
    const ratings = [...ratingByUser('run_overall_rating').entries()].sort((a, b) => b[1] - a[1]);
    const index = ratings.findIndex(([id]) => id === userId);
    if (index === -1) return { data: [], error: null };
    return {
      data: [{ rank: index + 1, total: ratings.length, overall_aim_rating: ratings[index][1] }],
      error: null
    };
  },

  get_aim_category_leaderboard({ p_category: category, p_limit: limit }) {
    const column = CATEGORY_COLUMNS[category];
    if (!column) return { data: [], error: null };
    const ratings = ratingByUser(column);
    const rows = [...ratings.entries()]
      .map(([userId, rating]) => {
        const profile = profileFor(userId);
        if (!profile) return null;
        return {
          user_id: userId,
          username: profile.username,
          country_code: profile.country_code || null,
          rating,
          rated_modes: 3
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, clampLimit(limit, 500, 2000))
      .map((row, i) => ({ ...row, rank: i + 1 }));
    return { data: rows, error: null };
  },

  set_demo_watch_time({ p_day: day, p_seconds: seconds }) {
    const clamped = Math.min(Math.max(Number(seconds) || 0, 0), 86400);
    const rows = readTable('demo_watch_time');
    const row = rows.find((r) => r.user_id === LOCAL_USER_ID && r.day === day);
    if (row) row.seconds = Math.max(row.seconds || 0, clamped);
    else rows.push({ id: nextId(), user_id: LOCAL_USER_ID, day, seconds: clamped, updated_at: nowIso() });
    writeTable('demo_watch_time', rows);
    return { data: null, error: null };
  }
};

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/**
 * The session is a constant. There is one account, it cannot be signed out of,
 * and the token is never checked by anything local.
 */
function localUser() {
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    } catch {
      return {};
    }
  })();
  const username = stored.username || LOCAL_USERNAME;
  return {
    id: LOCAL_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: '',
    created_at: stored.created_at || nowIso(),
    app_metadata: { provider: 'local', providers: ['local'] },
    user_metadata: { username }
  };
}

function localSession() {
  const user = localUser();
  return {
    access_token: `local.${user.id}`,
    refresh_token: `local.${user.id}`,
    token_type: 'bearer',
    expires_in: 86400,
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    user
  };
}

function localAuth() {
  const listeners = new Set();
  return {
    async getSession() {
      return { data: { session: localSession() }, error: null };
    },
    async getUser() {
      return { data: { user: localUser() }, error: null };
    },
    onAuthStateChange(fn) {
      listeners.add(fn);
      // Supabase replays the current state to a new listener; the account page
      // and the entitlement manager both rely on hearing about it.
      queueMicrotask(() => {
        try {
          fn('INITIAL_SESSION', localSession());
        } catch {
          /* one broken listener must not stop the others */
        }
      });
      return {
        data: { subscription: { unsubscribe: () => listeners.delete(fn) } },
        error: null
      };
    },
    async signOut() {
      // Signed out is not a state this deployment has.
      return { error: null };
    },
    async updateUser({ data } = {}) {
      const rows = readTable('profiles');
      const row = rows.find((r) => r.id === LOCAL_USER_ID);
      const username = data?.username ? String(data.username).trim().toLowerCase() : row?.username;
      try {
        localStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ username, created_at: row?.created_at || nowIso() })
        );
      } catch {
        /* private browsing */
      }
      return { data: { user: localUser() }, error: null };
    },
    async refreshSession() {
      return { data: { session: localSession() }, error: null };
    },
    // Everything below is a hosted-only door. Answering with an error rather
    // than throwing keeps the sign-in form usable if it is ever reached.
    _unavailable: () => ({
      data: { user: null, provider: null, url: null },
      error: { message: 'This deployment has one account and needs no sign-in.', code: 'local_only' }
    })
  };
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

/**
 * The profile row also exists on the server, which is what /api/me reads (it
 * cannot see localStorage). Every write to the table is mirrored there, so the
 * header tag and the account page never disagree. Fire and forget: a failed
 * mirror is a stale tag, not a failed save.
 */
const PROFILE_MIRROR = [
  'username', 'display_name', 'language', 'country_code', 'elo'
];

function mirrorProfile(rows) {
  const row = rows.find((r) => r.id === LOCAL_USER_ID);
  if (!row) return;
  const patch = {};
  for (const key of PROFILE_MIRROR) {
    if (row[key] !== undefined) patch[key] = row[key];
  }
  const base = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
  fetch(`${base}/api/local/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  }).catch(() => {
    /* the mirror is a convenience, never a dependency */
  });
}

/**
 * Build the client. The profile row is seeded on first use so the account page,
 * the header tag and the leaderboards all have something to read, which is also
 * what the hosted `handle_new_user` trigger used to do on sign-up.
 */
export function createLocalClient() {
  const rows = readTable('profiles');
  if (!rows.some((row) => row.id === LOCAL_USER_ID)) {
    rows.push({
      id: LOCAL_USER_ID,
      username: LOCAL_USERNAME,
      display_name: '',
      language: 'en',
      elo: 1000,
      country_code: '',
      play_time_sec: 0,
      username_chosen: false,
      created_at: nowIso()
    });
    writeTable('profiles', rows);
  }

  const auth = localAuth();
  // The hosted client exposes the sign-in methods on auth; aliasing them keeps a
  // stray sign-in button from being a TypeError.
  for (const method of [
    'signInWithPassword', 'signInWithOAuth', 'signInWithOtp', 'signInWithIdToken',
    'signInAnonymously', 'resetPasswordForEmail', 'signInWithSSO', 'verifyOtp'
  ]) {
    auth[method] = auth._unavailable;
  }

  return {
    auth,
    from: (table) =>
      new Query(String(table), {
        afterWrite: (name, rows) => {
          if (name === 'profiles') mirrorProfile(rows);
        }
      }),
    rpc: async (name, args = {}) => {
      const fn = RPC[name];
      if (!fn) {
        console.warn('[local] no such rpc', name);
        return { data: null, error: { message: `Unknown function ${name}`, code: '42883' } };
      }
      return fn(args);
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: { message: 'Local storage is localStorage.', code: 'local_only' } }),
        download: async () => ({ data: null, error: { message: 'Local storage is localStorage.', code: 'local_only' } }),
        getPublicUrl: (path) => ({ data: { publicUrl: String(path) } })
      })
    },
    channel: () => ({
      subscribe: () => ({ unsubscribe() {} }),
      unsubscribe: async () => ({ error: null }),
      send: async () => ({ error: null })
    }),
    removeChannel: async () => ({ error: null })
  };
}
