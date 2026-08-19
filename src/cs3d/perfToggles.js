// ---------------------------------------------------------------------------
// src/cs3d/perfToggles.js
// Independent renderer switches, flipped from the Y console (`r_*`).
//
// Defaults are the current picture. `r_perf 1` turns the cheap cluster on;
// each flag can still be flipped on its own if one of them is the problem.
// ---------------------------------------------------------------------------

export const PERF_HELP = [
  'fps_max [n]           cap present rate, 0 = rAF, default 240',
  'r_profile [0|1]       frame times, 1% / 10% lows',
  'r_msaa [0|1]          framebuffer MSAA (reload)',
  'r_dpr 0.5|1|2         backbuffer scale',
  'r_bloom [0|1]         HDR bloom composite',
  'r_shadows [0|1]       redraw the live shadow map',
  'r_shadow_bodies [0|1] redraw shadows for moving bodies',
  'r_simple [0|1]        lightmap-only world shader',
  'r_skypass [0|1]       3D sky two-pass',
  'r_perf [0|1]          all cheap opts (1) or quality (0)'
];

const BOOL_ON = new Set(['1', 'on', 'true', 'yes']);
const BOOL_OFF = new Set(['0', 'off', 'false', 'no']);

export function parseOnOff(raw, current) {
  if (raw == null || raw === '') return !current;
  const s = String(raw).toLowerCase();
  if (BOOL_ON.has(s)) return true;
  if (BOOL_OFF.has(s)) return false;
  return null;
}

export function dumpFlags(f) {
  return [
    `r_profile ${f.profile ? 1 : 0}`,
    `r_msaa ${f.msaa ? 1 : 0}`,
    `r_dpr ${f.dpr}`,
    `r_bloom ${f.bloom ? 1 : 0}`,
    `r_shadows ${f.shadows ? 1 : 0}`,
    `r_shadow_bodies ${f.shadowBodies ? 1 : 0}`,
    `r_simple ${f.simple ? 1 : 0}`,
    `r_skypass ${f.skyPass ? 1 : 0}`,
    `fps_max ${f.fpsMax ?? 240}`
  ];
}

/** Median rAF time sitting on a panel refresh (or a present cap). */
export function displayHzHint(medianMs) {
  if (!(medianMs > 1)) return '';
  const hz = 1000 / medianMs;
  const rates = [60, 75, 90, 120, 144, 165, 180, 240, 360];
  let best = 0;
  let bestErr = Infinity;
  for (const r of rates) {
    const err = Math.abs(hz - r) / r;
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
  }
  if (bestErr > 0.08) return '';
  return `display ~${best} Hz`;
}

function cheapOf(f) {
  return {
    profile: f.profile,
    msaa: false,
    dpr: 0.5,
    bloom: false,
    shadows: false,
    shadowBodies: false,
    simple: true,
    skyPass: false
  };
}

/**
 * @param {Partial<{profile:boolean,msaa:boolean,dpr:number,bloom:boolean,shadows:boolean,shadowBodies:boolean,simple:boolean,skyPass:boolean,fpsMax:number}>} init
 * @param {(flags: object) => void} [onChange]
 */
export function createPerfFlags(init = {}, onChange) {
  const flags = {
    profile: !!init.profile,
    msaa: init.msaa !== false,
    dpr: Number.isFinite(init.dpr) && init.dpr > 0 ? init.dpr : 1,
    bloom: init.bloom !== false,
    shadows: init.shadows !== false,
    shadowBodies: init.shadowBodies !== false,
    simple: !!init.simple,
    skyPass: init.skyPass !== false,
    fpsMax: Number.isFinite(init.fpsMax) ? Math.max(0, init.fpsMax) : 240
  };
  const quality = { ...flags };

  function commit() {
    onChange?.(flags);
  }

  function setBool(key, raw, label) {
    const next = parseOnOff(raw, flags[key]);
    if (next === null) return `${label} 0|1`;
    flags[key] = next;
    commit();
    return `${label} ${next ? 1 : 0}`;
  }

  function command(cmd, args) {
    switch (cmd) {
      case 'r_profile':
        return setBool('profile', args[0], 'r_profile');
      case 'r_msaa': {
        const msg = setBool('msaa', args[0], 'r_msaa');
        if (msg.startsWith('r_msaa') && flags.msaa !== quality.msaa) return `${msg} (reload)`;
        return msg;
      }
      case 'r_dpr': {
        if (args[0] == null) return `r_dpr ${flags.dpr}`;
        const n = Number(args[0]);
        if (![0.5, 0.75, 1, 1.5, 2].includes(n)) return 'r_dpr 0.5|1|2';
        flags.dpr = n;
        commit();
        return `r_dpr ${n}`;
      }
      case 'r_bloom':
        return setBool('bloom', args[0], 'r_bloom');
      case 'r_shadows':
        return setBool('shadows', args[0], 'r_shadows');
      case 'r_shadow_bodies':
        return setBool('shadowBodies', args[0], 'r_shadow_bodies');
      case 'r_simple':
        return setBool('simple', args[0], 'r_simple');
      case 'r_skypass':
        return setBool('skyPass', args[0], 'r_skypass');
      case 'fps_max': {
        if (args[0] == null) return `fps_max ${flags.fpsMax}`;
        const n = Number(args[0]);
        if (!Number.isFinite(n) || n < 0 || n > 1000) return 'fps_max 0..1000';
        flags.fpsMax = n;
        commit();
        return `fps_max ${n}`;
      }
      case 'r_perf': {
        if (args[0] == null) return dumpFlags(flags);
        const on = parseOnOff(args[0], false);
        if (on === null) return 'r_perf 0|1';
        const fpsMax = flags.fpsMax;
        Object.assign(flags, on ? cheapOf(flags) : quality);
        flags.fpsMax = fpsMax;
        commit();
        return [`r_perf ${on ? 1 : 0}`, ...dumpFlags(flags)];
      }
      default:
        return null;
    }
  }

  return { flags, command, dump: () => dumpFlags(flags) };
}
