// ---------------------------------------------------------------------------
// replays/gif/utilityPreviews.js
// "Utility previews" on a strategy made from a round: a clip of each player's
// grenades from their own eyes, linked from that player's note.
//
// A player's clips come from when they threw. A clip opens 5 seconds before a
// throw and closes 3 seconds after the last one, and throws close enough that
// those would overlap share one clip, so a lineup thrown back to back is one
// watch. A lone grenade is the same 5 and 3 around it.
//
// The link goes on the grenade's own words in the note, beside its throw id
// (stratNoteLinks.js: adjacent tags share one label), so clicking "Window smoke"
// copies the setpos and opens the clip. A clip whose grenades the note does not
// name goes at the end of the note under its time.
//
// The planning and the note are DOM-free; making the clips is roundGif.js.
// ---------------------------------------------------------------------------

import { clockAt, timingFor } from '../viewer/roundClock.js';
import { cs3dMap } from '../../../shared/cs3d/maps.js';
import { MAX_SECONDS } from './gifCore.js';
import { utilitySetposLines } from './gifSetpos.js';
import { GIF_DESCRIPTION_MAX, GIF_TITLE_MAX } from './gifMeta.js';

export const PREVIEW_LEAD_SECONDS = 5;
export const PREVIEW_TAIL_SECONDS = 3;
/** A thrower who dies is watched this long after: the rest would be a corpse's view. */
const AFTER_DEATH_SECONDS = 1;

/** What the server keeps of a note with its links. Keep equal to teamsStore.js. */
export const NOTE_WITH_LINKS_MAX = 1600;

/**
 * One player's clips, in round order.
 *
 * @param {object} meta  the round's meta
 * @param {string} playerId
 * @param {{ fromTick?: number, toTick?: number }} [range]  only grenades thrown in this part of the round
 * @returns {Array<{ fromTick: number, toTick: number, grenades: object[] }>}
 */
export function utilityWindows(meta, playerId, { fromTick = -Infinity, toTick = Infinity } = {}) {
  const timing = timingFor(meta);
  const rate = timing.tickRate || 64;
  const lead = PREVIEW_LEAD_SECONDS * rate;
  const tail = PREVIEW_TAIL_SECONDS * rate;
  const longest = MAX_SECONDS['3d'] * rate;
  const id = String(playerId);
  const grenades = (meta?.events?.grenades || [])
    .filter((g) => {
      const t = Number(g.throwTick);
      return String(g.player) === id && Number.isFinite(t) && t >= fromTick && t <= toTick;
    })
    .sort((a, b) => Number(a.throwTick) - Number(b.throwTick));

  const groups = [];
  let open = null;
  for (const g of grenades) {
    const t = Number(g.throwTick);
    // One clip while the 5 and 3 touch and it still fits in the longest 3D clip.
    if (open && t - open.last <= lead + tail && t + tail - (open.first - lead) <= longest) {
      open.last = t;
      open.grenades.push(g);
    } else {
      open = { first: t, last: t, grenades: [g] };
      groups.push(open);
    }
  }

  const death = (meta?.events?.kills || []).find((k) => String(k.victim) === id);
  const deathTick = Number.isFinite(Number(death?.tick)) ? Number(death.tick) : Infinity;
  return groups.map((g) => ({
    fromTick: Math.max(timing.startTick, g.first - lead),
    toTick: Math.min(timing.officialEndTick, g.last + tail, deathTick + AFTER_DEATH_SECONDS * rate),
    grenades: g.grenades
  }));
}

/**
 * A note with its clips linked: on the words of each grenade when the note names one, else appended.
 * A link that does not fit is left out whole, never cut: half a tag shows as text.
 *
 * @param {string} note
 * @param {Array<{ url: string, label: string, throwIds?: string[] }>} previews
 * @param {number} [max]
 * @returns {{ text: string, linked: number, left: number }}
 */
export function linkPreviews(note, previews, max = NOTE_WITH_LINKS_MAX) {
  let text = String(note || '');
  let linked = 0;
  let left = 0;
  const appended = [];
  for (const p of previews || []) {
    const url = String(p.url || '');
    if (!url) continue;
    let next = text;
    for (const id of p.throwIds || []) next = next.split(`<!${id}>`).join(`<!${id}><URL=${url}>`);
    if (next === text) {
      appended.push(`<${p.label}><URL=${url}>`);
      linked++;
    } else if (next.length <= max) {
      text = next;
      linked++;
    } else {
      left++;
    }
  }
  for (const tag of appended) {
    const next = text ? `${text}${text.endsWith(' ') ? '' : ' '}${tag}` : tag;
    if (next.length <= max) {
      text = next;
    } else {
      linked--;
      left++;
    }
  }
  return { text, linked, left };
}

/** The clip maker: one 3D scene for all of a strategy's clips, since booting a map is the slow part. */
async function sceneMaker({ meta, track }) {
  const [{ makeRoundGif, openRoundScene }, { updateGif }, { gifPageUrl }] = await Promise.all([
    import('./roundGif.js'),
    import('../api.js'),
    import('./gifCapture.js')
  ]);
  const kind = cs3dMap(meta.map)?.slug ? '3d' : '2d';
  let scene = null;
  return {
    async make({ setposLines, ...opts }) {
      if (kind === '3d' && !scene) scene = await openRoundScene({ meta, track });
      const res = await makeRoundGif({ ...opts, kind, scene });
      if (!res.gif) throw res.saveError || new Error('it could not be saved');
      // A separate edit: the save carries its metadata in a request header, which proxies cap.
      if (setposLines.length) {
        const description = setposLines.join('\n').slice(0, GIF_DESCRIPTION_MAX);
        await updateGif(res.gif.id, { description }).catch(() => {});
      }
      return { url: gifPageUrl(res.gif.id) };
    },
    close: () => scene?.close()
  };
}

/**
 * Make every clip in a plan, one after another. One that fails costs that link, not the rest.
 *
 * @param {object} args
 * @param {string} args.file
 * @param {object} args.meta
 * @param {object} args.track
 * @param {Array<{ id: string, slot: number, name: string, windows: Array<{ fromTick: number, toTick: number, grenades: object[] }> }>} args.plan
 * @param {string} [args.strategyName]
 * @param {(text: string) => void} [args.onStatus]
 * @param {AbortSignal} [args.signal]
 * @param {typeof sceneMaker} [args.maker]
 * @returns {Promise<{ byPlayer: Map<string, Array<{ url: string, label: string, throwTicks: number[] }>>, made: number, failed: number, firstError: string }>}
 */
export async function makeUtilityPreviews({ file, meta, track, plan, strategyName = '', onStatus = () => {}, signal, maker = sceneMaker }) {
  const timing = timingFor(meta);
  const clips = plan.flatMap((p) => p.windows.map((w) => ({ p, w })));
  const byPlayer = new Map();
  let made = 0;
  let failed = 0;
  let firstError = '';
  if (!clips.length) return { byPlayer, made, failed, firstError };
  const maker1 = await maker({ meta, track });
  try {
    for (let i = 0; i < clips.length; i++) {
      const { p, w } = clips[i];
      const clock = clockAt(timing, Number(w.grenades[0]?.throwTick ?? w.fromTick)).label;
      const count = `Preview ${i + 1} of ${clips.length}, ${p.name}`;
      onStatus(count);
      try {
        const { url } = await maker1.make({
          file,
          round: { meta, track },
          fromTick: w.fromTick,
          toTick: w.toTick,
          camera: { player: p.slot, mode: 'pov' },
          title: `${strategyName ? `${strategyName}: ` : ''}${p.name} ${clock}`.slice(0, GIF_TITLE_MAX),
          source: 'strategy',
          signal,
          onProgress: (text) => onStatus(`${count}: ${text}`),
          setposLines: utilitySetposLines(meta, track, { fromTick: w.fromTick, toTick: w.toTick, timing, player: p.id })
        });
        if (!byPlayer.has(p.id)) byPlayer.set(p.id, []);
        byPlayer.get(p.id).push({ url, label: `Preview ${clock}`, throwTicks: w.grenades.map((g) => Number(g.throwTick)) });
        made++;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        failed++;
        firstError ||= err?.message || 'it could not be made';
      }
    }
  } finally {
    maker1.close?.();
  }
  return { byPlayer, made, failed, firstError };
}
