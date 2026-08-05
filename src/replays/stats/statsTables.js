// ---------------------------------------------------------------------------
// replays/stats/statsTables.js
// Rendering for the two stats tables, plus the hover breakdowns.
//
// Kept apart from any one screen because three surfaces show the same numbers:
// the Statistics page, the per-demo view opened from a match row, and the live
// scoreboard inside the viewer.
// ---------------------------------------------------------------------------

import { roleHowText } from '../roles/regionKeys.js';
import { MAP_CONTROL_BASE } from '../coach/mapControlBases.js';
import { relativePossession } from '../coach/mapControlAdvantage.js';

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const f0 = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—');
const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}%` : '—');
/** A 0-1 fraction as a percentage. The aim components are stored as fractions. */
const pct1 = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');
const int = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—');
const signed = (n) =>
  Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}` : '—';

/** Accuracy is blank rather than 0% when the demo predates hit counts. */
const accCell = (p) => (p.shots > 0 ? pct(p.accuracy) : '—');

const tip = (lines) => lines.filter(Boolean).join('\n');

/** Hover breakdown for Aim4 Rating: each input and its contribution. */
function a4rTip(p) {
  const d = p.a4rDetail;
  if (!d || !Number.isFinite(d.value)) return 'Aim4 Rating unavailable.';
  const fmtIn = (t) => {
    if (t.key === 'duelWin' || t.key === 'kast' || t.key === 'or' || t.key === 'ready') {
      return pct(t.input);
    }
    if (t.key === 'aim') return f1(t.input);
    return f2(t.input);
  };
  const lines = [
    `Aim4 Rating: ${f2(d.value)}`,
    ...d.terms.map((t) => `${t.label} ${fmtIn(t)} → ${signed(t.contrib)}`),
    `Average (/10): ${signed(d.avg)}`,
    `Swing won ${f2(d.swingWon.input)} → ${signed(d.swingWon.contrib)}`,
    `Swing lost ${f2(d.swingLost.input)} → ${signed(d.swingLost.contrib)}`,
    `Core: ${signed(d.core)}`,
    `Core^1.25: ${signed(d.powered)}`,
    `Rounds ${int(d.rounds)} / 3000 → ${signed(d.roundsBonus)}`,
    `Offset → ${signed(d.offset)}`
  ];
  return tip(lines);
}

/** Frozen left columns (before roles). */
export const PLAYER_FIXED_BASE = [
  {
    key: 'name',
    label: 'Player',
    align: 'left',
    noAvg: true,
    get: (p) => p.name.toLowerCase(),
    cell: null
  },
  {
    key: 'team',
    label: 'Team',
    align: 'left',
    noAvg: true,
    get: (p) => (p.teamLabel || '').toLowerCase(),
    cell: (p) => p.teamLabel || '—',
    em: (p) => (p.teams?.length || 0) > 1,
    tip: (p) => {
      const teams = p.teams || [];
      if (!teams.length) return '';
      return tip(
        teams.map((t) => `${t.name}: ${t.rounds} round${t.rounds === 1 ? '' : 's'}`)
      );
    }
  },
  {
    key: 'rounds',
    label: 'Rounds',
    get: (p) => p.rounds,
    cell: (p) => int(p.rounds),
    avgOf: (p) => (Number.isFinite(p.rounds) ? p.rounds : null),
    avgFormat: int
  }
];

/**
 * Scrollable metric columns (after fixed + optional roles).
 * Order: Rating, A4R, Swing, KD, xK, Duel Win%, ADR, KAST, OPKD, Impact, A4OR,
 * Opatt, OR, PFW, PFO, Aim, Acc, C°, R%, AA%, 1st%, O%, U%, DT, PSDT, util.
 */
export const PLAYER_METRIC_COLUMNS = [
  {
    key: 'rating',
    label: 'Rating',
    get: (p) => p.rating,
    cell: (p) => f2(p.rating),
    avgOf: (p) => (Number.isFinite(p.rating) ? p.rating : null),
    avgFormat: f2,
    strong: true,
    tip: (p) =>
      tip([
        `Rating: ${f2(p.rating)}`,
        `On T: ${f2(p.ratingT)}`,
        `On CT: ${f2(p.ratingCT)}`,
        `In rounds won: ${f2(p.ratingWon)}`,
        `In rounds lost: ${f2(p.ratingLost)}`
      ])
  },
  {
    key: 'a4r',
    label: 'A4R',
    get: (p) => (Number.isFinite(p.a4r) ? p.a4r : -Infinity),
    cell: (p) => f2(p.a4r),
    avgOf: (p) => (Number.isFinite(p.a4r) ? p.a4r : null),
    avgFormat: f2,
    strong: true,
    tip: (p) => a4rTip(p)
  },
  {
    key: 'prwSwing',
    label: 'Swing',
    get: (p) => (Number.isFinite(p.prwSwing) ? p.prwSwing : -Infinity),
    cell: (p) => signed(p.prwSwing),
    avgOf: (p) => (Number.isFinite(p.prwSwing) ? p.prwSwing : null),
    avgFormat: signed,
    tip: (p) =>
      Number.isFinite(p.prwSwing)
        ? tip([
            `Avg PRW swing / round: ${signed(p.prwSwing)}`,
            `Total swing: ${signed(p.prwSwingTotal)}`,
            `Rounds with swing data: ${p.prwSwingRounds || 0}`,
            `Kills / deaths / damage that move predicted win%`
          ])
        : 'No PRW swing data. Stats index will rebuild on next library load.'
  },
  {
    key: 'kd',
    label: 'KD',
    get: (p) => p.kd,
    cell: (p) => f2(p.kd),
    avgOf: (p) => (Number.isFinite(p.kd) ? p.kd : null),
    avgFormat: f2,
    tip: (p) => tip([`Kills: ${p.kills}`, `Assists: ${p.assists}`, `Deaths: ${p.deaths}`])
  },
  {
    key: 'xk',
    label: 'xK',
    get: (p) => (Number.isFinite(p.xk) ? p.xk : -Infinity),
    cell: (p) => (Number.isFinite(p.xk) ? f2(p.xk) : '—'),
    avgOf: (p) => (Number.isFinite(p.xk) ? p.xk : null),
    avgFormat: f2,
    tip: (p) =>
      Number.isFinite(p.xk)
        ? tip([
            'Expected kills per round.',
            'Sum of the model’s win chance across every duel, averaged per round.',
            'A 50/50 is 0.50; a 1v2 at high odds is close to 2.',
            Number.isFinite(p.xkTotal) ? `Total xK: ${f2(p.xkTotal)}` : '',
            `Duels: ${f1(p.duels)}`
          ])
        : 'No duel data yet. Stats index rebuilds on next library load (v13+).'
  },
  {
    key: 'tfw',
    label: 'Duel Win%',
    get: (p) => (Number.isFinite(p.tfw) ? p.tfw : -Infinity),
    cell: (p) => pct(p.tfw),
    avgOf: (p) => (Number.isFinite(p.tfw) ? p.tfw : null),
    avgFormat: pct,
    tip: (p) =>
      Number.isFinite(p.tfw)
        ? tip([
            'Total fight winrate.',
            'Kills as a share of kills plus deaths.',
            `Kills: ${int(p.kills)}`,
            `Deaths: ${int(p.deaths)}`
          ])
        : '—'
  },
  {
    key: 'adr',
    label: 'ADR',
    get: (p) => p.adr,
    cell: (p) => f2(p.adr),
    avgOf: (p) => (Number.isFinite(p.adr) ? p.adr : null),
    avgFormat: f2,
    tip: (p) =>
      tip([
        `ADR in rounds won: ${f2(p.adrWon)}`,
        `ADR in rounds lost: ${f2(p.adrLost)}`,
        `Total damage: ${int(p.damage)}`
      ])
  },
  {
    key: 'kast',
    label: 'KAST',
    get: (p) => p.kast,
    cell: (p) => pct(p.kast),
    avgOf: (p) => (Number.isFinite(p.kast) ? p.kast : null),
    avgFormat: pct
  },
  {
    key: 'opkd',
    label: 'OPKD',
    get: (p) => p.opkd,
    cell: (p) =>
      Number.isFinite(p.opkd) ? `${p.opkd > 0 ? '+' : ''}${Math.round(p.opkd)}` : '—',
    avgOf: (p) => (Number.isFinite(p.opkd) ? p.opkd : null),
    avgFormat: (n) => `${n > 0 ? '+' : ''}${Math.round(n)}`,
    tip: (p) =>
      tip([
        Number.isFinite(p.opkRate) ? `Success rate: ${pct(p.opkRate)}` : 'No opening duels',
        `Opening kills: ${p.openKills}`,
        `Opening deaths: ${p.openDeaths}`,
        `Difference: ${p.openKills - p.openDeaths}`
      ])
  },
  {
    key: 'impact',
    label: 'Impact',
    get: (p) => p.impact,
    cell: (p) => f2(p.impact),
    avgOf: (p) => (Number.isFinite(p.impact) ? p.impact : null),
    avgFormat: f2
  },
  {
    key: 'a4or',
    label: 'A4OR',
    get: (p) => (Number.isFinite(p.a4or) ? p.a4or : -Infinity),
    cell: (p) => f2(p.a4or),
    avgOf: (p) => (Number.isFinite(p.a4or) ? p.a4or : null),
    avgFormat: f2,
    tip: (p) =>
      tip([
        `Aim4 Opening Rating: ${f2(p.a4or)}`,
        `1.00 + OPKD/100 ${signed((p.opkd || 0) / 100)} + Swing/8 ${
          Number.isFinite(p.prwSwing) ? signed(p.prwSwing / 8) : '—'
        } + OPATT ${f2(p.opatt)}`
      ])
  },
  {
    key: 'opatt',
    label: 'Opatt',
    get: (p) => (Number.isFinite(p.opatt) ? p.opatt : -1),
    cell: (p) => (Number.isFinite(p.opatt) ? f2(p.opatt) : '—'),
    avgOf: (p) => (Number.isFinite(p.opatt) ? p.opatt : null),
    avgFormat: f2,
    tip: (p) =>
      tip([
        `Opening attempts / round: ${f2(p.opatt)}`,
        `Opening kills: ${p.openKills}`,
        `Opening deaths: ${p.openDeaths}`,
        `Attempts: ${p.openKills + p.openDeaths}`,
        `Rounds: ${p.rounds}`
      ])
  },
  {
    key: 'opkRate',
    label: 'OR',
    get: (p) =>
      p.openKills + p.openDeaths > 0 && Number.isFinite(p.opkRate) ? p.opkRate : -1,
    cell: (p) => (p.openKills + p.openDeaths > 0 ? pct(p.opkRate) : '—'),
    avgOf: (p) =>
      p.openKills + p.openDeaths > 0 && Number.isFinite(p.opkRate) ? p.opkRate : null,
    avgFormat: pct,
    tip: (p) =>
      tip([
        `Opening success rate: ${p.openKills + p.openDeaths > 0 ? pct(p.opkRate) : '—'}`,
        `Opening kills: ${p.openKills}`,
        `Opening deaths: ${p.openDeaths}`
      ])
  },
  {
    key: 'pfw',
    label: 'PFW',
    get: (p) => (Number.isFinite(p.pfw) ? p.pfw : -Infinity),
    cell: (p) => pct(p.pfw),
    avgOf: (p) => (Number.isFinite(p.pfw) ? p.pfw : null),
    avgFormat: pct,
    tip: (p) =>
      Number.isFinite(p.pfw)
        ? tip([
            'Predicted fight winrate.',
            'The average chance the model gave this player across every',
            'active duel they were in, so it measures how hard their fights',
            'were, not how they did in them.',
            `Duels: ${f1(p.duels)}`
          ])
        : 'No duel data yet. Stats index rebuilds on next library load (v13+).'
  },
  {
    key: 'pfo',
    label: 'PFO',
    get: (p) => (Number.isFinite(p.pfo) ? p.pfo : -Infinity),
    cell: (p) => (Number.isFinite(p.pfo) ? `${p.pfo > 0 ? '+' : ''}${p.pfo.toFixed(2)}%` : '—'),
    avgOf: (p) => (Number.isFinite(p.pfo) ? p.pfo : null),
    avgFormat: (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`,
    strong: true,
    tip: (p) => {
      if (!Number.isFinite(p.pfo)) {
        return 'No duel data yet. Stats index rebuilds on next library load (v13+).';
      }
      const rows = (p.pfoBuckets || []).map(
        (b) =>
          `  ${String(b.centre).padStart(3)}%: won ${b.actual.toFixed(0)}% of ${b.duels.toFixed(1)}` +
          ` (${b.delta > 0 ? '+' : ''}${b.delta.toFixed(0)})`
      );
      return tip([
        'Predicted fight overperformance.',
        'Actual win rate minus what the model predicted, in points.',
        'Already adjusted for difficulty: winning easy fights scores zero.',
        rows.length ? 'By predicted odds:' : '',
        ...rows
      ]);
    }
  },
  {
    key: 'a4aim',
    label: 'Aim',
    get: (p) => (Number.isFinite(p.a4aim) ? p.a4aim : -1),
    cell: (p) => (Number.isFinite(p.a4aim) ? f1(p.a4aim) : '—'),
    avgOf: (p) => (Number.isFinite(p.a4aim) ? p.a4aim : null),
    avgFormat: f1,
    strong: true,
    tip: (p) =>
      Number.isFinite(p.a4aim)
        ? tip([
            `Aim rating: ${f1(p.a4aim)} / 100`,
            `Crosshair placement: ${
              Number.isFinite(p.aimRaw?.crosshairError)
                ? `${f1(-p.aimRaw.crosshairError)}°`
                : '—'
            } (${f0(p.aimComponents?.crosshairError)})`,
            `Ready for the fight: ${pct1(p.aimRaw?.readyRate)} (${f0(p.aimComponents?.readyRate)})`,
            `Accuracy, no smoke shots: ${pct1(p.aimRaw?.accuracy)} (${f0(p.aimComponents?.accuracy)})`,
            `First bullet: ${pct1(p.aimRaw?.firstBullet)} (${f0(p.aimComponents?.firstBullet)})`,
            `Overflick: ${pct1(p.aimRaw?.overflick)} (${f0(p.aimComponents?.overflick)})`,
            `Underflick: ${pct1(p.aimRaw?.underflick)} (${f0(p.aimComponents?.underflick)})`,
            `Sample: ${p.aimSample?.crosshairError || 0} engagements, ${p.aimSample?.accuracy || 0} shots`
          ])
        : 'Not enough sampled duels yet for an aim rating.'
  },
  {
    key: 'accuracy',
    label: 'Acc',
    get: (p) => (p.shots > 0 ? p.accuracy : -1),
    cell: accCell,
    avgOf: (p) => (p.shots > 0 && Number.isFinite(p.accuracy) ? p.accuracy : null),
    avgFormat: pct,
    tip: (p) =>
      p.shots > 0
        ? tip([
            `Shots fired: ${p.shots}`,
            `Shots hit: ${p.hits}`,
            `Headshots hit: ${p.headshots}`,
            `AWP shots fired: ${p.awpShots}`,
            `AWP shots hit: ${p.awpHits}`,
            `AWP hit rate: ${p.awpShots > 0 ? pct(p.awpAccuracy) : '—'}`,
            `AWP Acc: holds within 10° of an enemy with a clear (no smoke) path`
          ])
        : 'No hit data. Re-parse this demo to record accuracy.'
  },
  {
    key: 'aimCrosshair',
    label: 'C°',
    // Negative degrees so lower-is-better sorts correctly under default desc.
    get: (p) =>
      Number.isFinite(p.aimRaw?.crosshairError) ? -p.aimRaw.crosshairError : 1,
    cell: (p) =>
      Number.isFinite(p.aimRaw?.crosshairError) ? f1(-p.aimRaw.crosshairError) : '—',
    avgOf: (p) =>
      Number.isFinite(p.aimRaw?.crosshairError) ? -p.aimRaw.crosshairError : null,
    avgFormat: f1,
    tip: (p) =>
      Number.isFinite(p.aimRaw?.crosshairError)
        ? tip([
            `Mean yaw error when engaged: ${f1(-p.aimRaw.crosshairError)}°`,
            `Component score: ${f0(p.aimComponents?.crosshairError)} / 100`,
            `Sample: ${p.aimSample?.crosshairError || 0} engagements`,
            'Negative because lower error is better. ~−30° is average.'
          ])
        : 'Not enough engagements yet.'
  },
  {
    key: 'aimReady',
    label: 'R%',
    get: (p) =>
      Number.isFinite(p.aimRaw?.readyRate) ? p.aimRaw.readyRate * 100 : -1,
    cell: (p) => (Number.isFinite(p.aimRaw?.readyRate) ? pct1(p.aimRaw.readyRate) : '—'),
    avgOf: (p) =>
      Number.isFinite(p.aimRaw?.readyRate) ? p.aimRaw.readyRate * 100 : null,
    avgFormat: (n) => pct1(n / 100),
    tip: (p) =>
      Number.isFinite(p.aimRaw?.readyRate)
        ? tip([
            `Already in the cone when engaged: ${pct1(p.aimRaw.readyRate)}`,
            `Component score: ${f0(p.aimComponents?.readyRate)} / 100`,
            `Sample: ${p.aimSample?.readyRate || 0} engagements`,
            'Typical band ~60–70%. A few points move the aim rating a lot.'
          ])
        : 'Not enough engagements yet.'
  },
  {
    key: 'aimAcc',
    label: 'AA%',
    get: (p) => (Number.isFinite(p.aimRaw?.accuracy) ? p.aimRaw.accuracy * 100 : -1),
    cell: (p) => (Number.isFinite(p.aimRaw?.accuracy) ? pct1(p.aimRaw.accuracy) : '—'),
    avgOf: (p) =>
      Number.isFinite(p.aimRaw?.accuracy) ? p.aimRaw.accuracy * 100 : null,
    avgFormat: (n) => pct1(n / 100),
    tip: (p) =>
      Number.isFinite(p.aimRaw?.accuracy)
        ? tip([
            `Hits / shots (smoke shots excluded): ${pct1(p.aimRaw.accuracy)}`,
            `Component score: ${f0(p.aimComponents?.accuracy)} / 100`,
            `Sample: ${p.aimSample?.accuracy || 0} shots`,
            'High variance by weapon and role (~15–40%).'
          ])
        : 'Not enough sampled shots yet.'
  },
  {
    key: 'aimFirst',
    label: '1st%',
    get: (p) =>
      Number.isFinite(p.aimRaw?.firstBullet) ? p.aimRaw.firstBullet * 100 : -1,
    cell: (p) => (Number.isFinite(p.aimRaw?.firstBullet) ? pct1(p.aimRaw.firstBullet) : '—'),
    avgOf: (p) =>
      Number.isFinite(p.aimRaw?.firstBullet) ? p.aimRaw.firstBullet * 100 : null,
    avgFormat: (n) => pct1(n / 100),
    tip: (p) =>
      Number.isFinite(p.aimRaw?.firstBullet)
        ? tip([
            `First bullet hit when enemy was in the cone: ${pct1(p.aimRaw.firstBullet)}`,
            `Component score: ${f0(p.aimComponents?.firstBullet)} / 100`,
            `Sample: ${p.aimSample?.firstBullet || 0} first bullets`,
            'High variance (~15–50%).'
          ])
        : 'Not enough first-bullet samples yet.'
  },
  {
    key: 'aimOverflick',
    label: 'O%',
    // Lower is better → negate so default desc still puts the tidy aimers first.
    get: (p) =>
      Number.isFinite(p.aimRaw?.overflick) ? -p.aimRaw.overflick * 100 : 1,
    cell: (p) => (Number.isFinite(p.aimRaw?.overflick) ? pct1(p.aimRaw.overflick) : '—'),
    avgOf: (p) =>
      Number.isFinite(p.aimRaw?.overflick) ? p.aimRaw.overflick * 100 : null,
    avgFormat: (n) => pct1(n / 100),
    tip: (p) =>
      Number.isFinite(p.aimRaw?.overflick)
        ? tip([
            `First-bullet misses that went past the enemy: ${pct1(p.aimRaw.overflick)} of cone engagements`,
            `Component score: ${f0(p.aimComponents?.overflick)} / 100 (lower rate scores higher)`,
            `Count: ${Math.round((p.aimRaw.overflick || 0) * (p.aimSample?.firstBullet || 0))} overflicks`,
            `Sample: ${p.aimSample?.firstBullet || 0} first-bullet engagements`,
            'Yaw at shot vs enemy, relative to yaw ~0.2s earlier.'
          ])
        : 'Not enough first-bullet samples yet.'
  },
  {
    key: 'aimUnderflick',
    label: 'U%',
    get: (p) =>
      Number.isFinite(p.aimRaw?.underflick) ? -p.aimRaw.underflick * 100 : 1,
    cell: (p) => (Number.isFinite(p.aimRaw?.underflick) ? pct1(p.aimRaw.underflick) : '—'),
    avgOf: (p) =>
      Number.isFinite(p.aimRaw?.underflick) ? p.aimRaw.underflick * 100 : null,
    avgFormat: (n) => pct1(n / 100),
    tip: (p) =>
      Number.isFinite(p.aimRaw?.underflick)
        ? tip([
            `First-bullet misses that stopped short of the enemy: ${pct1(p.aimRaw.underflick)} of cone engagements`,
            `Component score: ${f0(p.aimComponents?.underflick)} / 100 (lower rate scores higher)`,
            `Count: ${Math.round((p.aimRaw.underflick || 0) * (p.aimSample?.firstBullet || 0))} underflicks`,
            `Sample: ${p.aimSample?.firstBullet || 0} first-bullet engagements`,
            'Yaw at shot vs enemy, relative to yaw ~0.2s earlier.'
          ])
        : 'Not enough first-bullet samples yet.'
  },
  {
    key: 'dt',
    label: 'DT',
    get: (p) => (Number.isFinite(p.dt) ? p.dt : -1),
    cell: (p) => (Number.isFinite(p.dt) ? int(p.dt) : '—'),
    avgOf: (p) => (Number.isFinite(p.dt) ? p.dt : null),
    avgFormat: int,
    tip: (p) =>
      Number.isFinite(p.dt)
        ? tip([
            `Avg distance travelled / round: ${int(p.dt)}`,
            `Total DT: ${int(p.dtTotal)}`,
            `Rounds sampled: ${p.dtRounds || 0}`,
            `Raw path length (resets on death)`
          ])
        : 'No movement data yet. Reloading Statistics fills DT in the background.'
  },
  {
    key: 'psdt',
    label: 'PSDT',
    get: (p) => (Number.isFinite(p.psdt) ? p.psdt : -1),
    cell: (p) => (Number.isFinite(p.psdt) ? int(p.psdt) : '—'),
    avgOf: (p) => (Number.isFinite(p.psdt) ? p.psdt : null),
    avgFormat: int,
    tip: (p) =>
      Number.isFinite(p.psdt)
        ? tip([
            `Avg pulled-string distance / round: ${int(p.psdt)}`,
            `Total PSDT: ${int(p.psdtTotal)}`,
            `Rounds sampled: ${p.psdtRounds || 0}`,
            `125u brush — filters ADAD jitter`
          ])
        : 'No movement data yet. Reloading Statistics fills PSDT in the background.'
  },
  {
    key: 'heDmg',
    label: 'HE dmg',
    get: (p) => (p.heThrown > 0 ? p.heDmgPerNade : -1),
    cell: (p) => (p.heThrown > 0 ? f1(p.heDmgPerNade) : '—'),
    avgOf: (p) => (p.heThrown > 0 ? p.heDmgPerNade : null),
    avgFormat: f1,
    tip: (p) =>
      p.heThrown > 0
        ? tip([
            `Damage per HE thrown: ${f1(p.heDmgPerNade)}`,
            `${p.heDamage} damage from ${p.heThrown} HE`,
            'Enemy damage only. Team and self damage never count.'
          ])
        : 'No HE grenades thrown in this selection.'
  },
  {
    key: 'blind',
    label: 'Blind/flash',
    get: (p) => (p.flashesThrown > 0 ? p.blindPerFlash : -1),
    cell: (p) => (p.flashesThrown > 0 ? `${f2(p.blindPerFlash)}s` : '—'),
    avgOf: (p) => (p.flashesThrown > 0 ? p.blindPerFlash : null),
    avgFormat: (n) => `${f2(n)}s`,
    tip: (p) =>
      p.flashesThrown > 0
        ? tip([
            `Enemy blind per flash: ${f2(p.blindPerFlash)}s`,
            `${f1(p.enemyBlindSeconds)}s across ${p.flashesThrown} flashes`,
            `Flashes that blinded someone: ${pct1(p.flashHitRate)}`,
            'Duds are counted in the denominator. Team flashes earn nothing.'
          ])
        : 'No flashbangs thrown in this selection.'
  },
  {
    key: 'utilDmg',
    label: 'Util dmg',
    get: (p) => (Number.isFinite(p.utilDmgPerRound) ? p.utilDmgPerRound : -1),
    cell: (p) => (Number.isFinite(p.utilDmgPerRound) ? f1(p.utilDmgPerRound) : '—'),
    avgOf: (p) => (Number.isFinite(p.utilDmgPerRound) ? p.utilDmgPerRound : null),
    avgFormat: f1,
    tip: (p) =>
      tip([
        `All utility damage per round: ${f1(p.utilDmgPerRound)}`,
        `HE: ${p.heDamage} over ${p.heThrown} thrown`,
        `Fire: ${p.fireDamage} over ${p.fireThrown} thrown`
      ])
  }
];

/** @deprecated Duel cols live inside PLAYER_METRIC_COLUMNS; kept for imports. */
export const PLAYER_DUEL_COLUMNS = [];

export const PLAYER_COLUMNS = [...PLAYER_FIXED_BASE, ...PLAYER_METRIC_COLUMNS];

/** Alias kept for the viewer scoreboard (same columns as the Statistics page). */
export const PLAYER_COLUMNS_WITH_DUELS = PLAYER_COLUMNS;

/**
 * Player columns with T (yellow) / CT (blue) role or position after Rounds.
 * @param {'position'|'tactical'|''} roleMode
 * @returns {{ columns: object[], fixedCount: number }}
 */
export function playerColumnsWithRoles(roleMode = 'tactical') {
  const tLabel = roleMode === 'position' ? 'T pos' : 'T role';
  const ctLabel = roleMode === 'position' ? 'CT pos' : 'CT role';
  const tGet = (p) =>
    (roleMode === 'position' ? p.posT || p.roleT : p.roleT || '') || '';
  const ctGet = (p) =>
    (roleMode === 'position' ? p.posCT || p.roleCT : p.roleCT || '') || '';
  const roleTip = (side, p) => {
    const label = side === 'T' ? tGet(p) : ctGet(p);
    if (!label) return '';
    const how = roleHowText(side, label, roleMode);
    const tac = side === 'T' ? p.roleT : p.roleCT;
    if (roleMode === 'position') {
      return tip([label, how, tac ? `Tactical role: ${tac}` : '']);
    }
    return tip([label, how]);
  };
  const roleCols = [
    {
      key: 'roleT',
      label: tLabel,
      align: 'left',
      noAvg: true,
      get: (p) => tGet(p).toLowerCase(),
      cell: (p) => tGet(p) || '—',
      cellClass: 'st-role-t',
      tip: (p) => roleTip('T', p)
    },
    {
      key: 'roleCT',
      label: ctLabel,
      align: 'left',
      noAvg: true,
      get: (p) => ctGet(p).toLowerCase(),
      cell: (p) => ctGet(p) || '—',
      cellClass: 'st-role-ct',
      tip: (p) => roleTip('CT', p)
    }
  ];
  return {
    columns: [...PLAYER_FIXED_BASE, ...roleCols, ...PLAYER_METRIC_COLUMNS],
    fixedCount: PLAYER_FIXED_BASE.length + roleCols.length
  };
}

function formatMatchDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '—';
  try {
    return new Date(n).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return '—';
  }
}

/** Sticky identity columns for player/team match drill-down tables. */
export const MATCH_IDENTITY_COLUMNS = [
  {
    key: 'map',
    label: 'Map',
    align: 'left',
    noAvg: true,
    get: (r) => (r.mapName || r.map || '').toLowerCase(),
    cell: (r) => r.mapName || r.map || '—'
  },
  {
    key: 'score',
    label: 'Score',
    align: 'left',
    noAvg: true,
    get: (r) => r.scoreSort ?? 0,
    cell: (r) => r.scoreLabel || '—'
  },
  {
    key: 'result',
    label: 'Result',
    align: 'left',
    noAvg: true,
    get: (r) => r.result || '',
    cell: (r) => r.result || '—',
    cellClass: (r) =>
      r.result === 'W' ? 'st-result-w' : r.result === 'L' ? 'st-result-l' : ''
  },
  {
    key: 'opponent',
    label: 'Opponent',
    align: 'left',
    noAvg: true,
    get: (r) => (r.opponent || '').toLowerCase(),
    cell: (r) => r.opponent || '—'
  },
  {
    key: 'date',
    label: 'Date',
    align: 'left',
    noAvg: true,
    get: (r) => Number(r.uploadedAt) || 0,
    cell: (r) => formatMatchDate(r.uploadedAt)
  }
];

/** Player match detail: identity + metric cols (no Player/Team/Rounds/roles). */
export function playerMatchColumns() {
  return {
    columns: [...MATCH_IDENTITY_COLUMNS, ...PLAYER_METRIC_COLUMNS],
    fixedCount: MATCH_IDENTITY_COLUMNS.length
  };
}

/** Team match detail: identity + team metrics (skip Team name col). */
export function teamMatchColumns() {
  const metrics = TEAM_COLUMNS.filter((c) => c.key !== 'name');
  return {
    columns: [...MATCH_IDENTITY_COLUMNS, ...metrics],
    fixedCount: MATCH_IDENTITY_COLUMNS.length
  };
}

function possessionDeltaTip(t) {
  const lines = [
    `Avg possession: ${pct(t.possession)}`,
    `Rounds sampled: ${t.possessionRounds || 0}`
  ];
  const byMap = t.possessionByMap || [];
  for (const row of byMap) {
    const base = MAP_CONTROL_BASE[row.map];
    if (!base || !Number.isFinite(row.possession)) {
      lines.push(`${row.map}: ${pct(row.possession)} (${row.rounds} rds)`);
      continue;
    }
    const dCt = row.possession - base.ct;
    const dT = row.possession - base.t;
    const baseRel = relativePossession(base.ct, base.t);
    // Treat team share vs (100 - share) as a 2-side split for relative Δ.
    const curRel = relativePossession(row.possession, Math.max(0, 100 - row.possession));
    const dRel = curRel.ct - baseRel.ct;
    lines.push(
      `${row.map}: ${pct(row.possession)} · vs CT avg ${signed(dCt)} · vs T avg ${signed(dT)} · rel Δ ${signed(dRel)} (${row.rounds} rds)`
    );
  }
  if (!byMap.length && !Number.isFinite(t.possession)) {
    return 'No possession data (needs Sites & Vision zones + radar).';
  }
  return tip(lines);
}

/**
 * Team duel columns: the side's five players averaged.
 *
 * Averaging the players rather than pooling their duels gives each of the five
 * an equal say. Pooling would let whoever fought most often speak for the team,
 * which is exactly the player whose numbers are least in need of amplifying.
 */
export const TEAM_DUEL_COLUMNS = [
  {
    key: 'teamPfw',
    label: 'PFW',
    get: (t) => (Number.isFinite(t.pfw) ? t.pfw : -Infinity),
    cell: (t) => pct(t.pfw),
    avgOf: (t) => (Number.isFinite(t.pfw) ? t.pfw : null),
    avgFormat: pct,
    tip: (t) =>
      Number.isFinite(t.pfw)
        ? tip([
            'Team predicted fight winrate.',
            'The five players’ PFW averaged: how hard this side’s duels were.',
            ...(t.members || [])
              .filter((m) => Number.isFinite(m.pfw))
              .map((m) => `${m.name}: ${m.pfw.toFixed(1)}%`)
          ])
        : 'No duel data yet. Stats index rebuilds on next library load (v13+).'
  },
  {
    key: 'teamPfo',
    label: 'PFO',
    get: (t) => (Number.isFinite(t.pfo) ? t.pfo : -Infinity),
    cell: (t) => (Number.isFinite(t.pfo) ? `${t.pfo > 0 ? '+' : ''}${t.pfo.toFixed(2)}%` : '—'),
    avgOf: (t) => (Number.isFinite(t.pfo) ? t.pfo : null),
    avgFormat: (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`,
    strong: true,
    tip: (t) =>
      Number.isFinite(t.pfo)
        ? tip([
            'Team predicted fight overperformance.',
            'How far the side beat the odds it was given, in points.',
            ...(t.members || [])
              .filter((m) => Number.isFinite(m.pfo))
              .map((m) => `${m.name}: ${m.pfo > 0 ? '+' : ''}${m.pfo.toFixed(1)}`)
          ])
        : 'No duel data yet. Stats index rebuilds on next library load (v13+).'
  },
  {
    key: 'teamXk',
    label: 'xK',
    get: (t) => (Number.isFinite(t.xk) ? t.xk : -Infinity),
    cell: (t) => (Number.isFinite(t.xk) ? f2(t.xk) : '—'),
    avgOf: (t) => (Number.isFinite(t.xk) ? t.xk : null),
    avgFormat: f2,
    tip: (t) =>
      Number.isFinite(t.xk)
        ? tip([
            'Team expected kills per round.',
            'The five players’ xK averaged.',
            ...(t.members || [])
              .filter((m) => Number.isFinite(m.xk))
              .map((m) => `${m.name}: ${m.xk.toFixed(2)}`)
          ])
        : 'No duel data yet. Stats index rebuilds on next library load (v13+).'
  }
];

export const TEAM_COLUMNS = [
  { key: 'name', label: 'Team', align: 'left', noAvg: true, get: (t) => t.name.toLowerCase() },
  {
    key: 'rounds',
    label: 'Rds',
    get: (t) => t.rounds,
    cell: (t) => int(t.rounds),
    avgOf: (t) => (Number.isFinite(t.rounds) ? t.rounds : null),
    avgFormat: int
  },
  {
    key: 'roundWinrate',
    label: 'Round WR',
    get: (t) => t.roundWinrate,
    cell: (t) => pct(t.roundWinrate),
    avgOf: (t) => (Number.isFinite(t.roundWinrate) ? t.roundWinrate : null),
    avgFormat: pct,
    tip: (t) => tip([`Rounds won: ${t.roundsWon}`, `Rounds lost: ${t.roundsLost}`])
  },
  {
    key: 'avgRating',
    label: 'Avg rating',
    get: (t) => t.avgRating,
    cell: (t) => f2(t.avgRating),
    avgOf: (t) => (Number.isFinite(t.avgRating) ? t.avgRating : null),
    avgFormat: f2,
    strong: true,
    tip: (t) =>
      t.members.length
        ? tip(
            t.members.map((m) => {
              const sw = Number.isFinite(m.prwSwing) ? ` · Swing ${signed(m.prwSwing)}` : '';
              return `${m.name}: ${f2(m.rating)}${sw}`;
            })
          )
        : 'No players in range.'
  },
  ...TEAM_DUEL_COLUMNS,
  {
    key: 'possession',
    label: 'Poss%',
    get: (t) => (Number.isFinite(t.possession) ? t.possession : -1),
    cell: (t) => (Number.isFinite(t.possession) ? pct(t.possession) : '—'),
    avgOf: (t) => (Number.isFinite(t.possession) ? t.possession : null),
    avgFormat: pct,
    tip: (t) => possessionDeltaTip(t)
  },
  {
    key: 'prw',
    label: 'PRW',
    get: (t) => (Number.isFinite(t.prw) ? t.prw : -1),
    cell: (t) => (Number.isFinite(t.prw) ? pct(t.prw) : '—'),
    avgOf: (t) => (Number.isFinite(t.prw) ? t.prw : null),
    avgFormat: pct,
    tip: (t) =>
      Number.isFinite(t.prw)
        ? tip([
            `Avg predicted round win%: ${pct(t.prw)}`,
            `Rounds sampled: ${t.prwRounds || 0}`,
            `Sampled every 4s from kill-log win probability`
          ])
        : 'No PRW data yet. Stats index rebuilds on next library load.'
  },
  {
    key: 'ac',
    label: 'AC%',
    get: (t) => (Number.isFinite(t.ac) ? t.ac : -1),
    cell: (t) => (Number.isFinite(t.ac) ? pct(t.ac) : '—'),
    avgOf: (t) => (Number.isFinite(t.ac) ? t.ac : null),
    avgFormat: pct,
    tip: (t) =>
      Number.isFinite(t.ac)
        ? tip([
            `Advantage conversion: ${pct(t.ac)}`,
            `Advantage-choke: ${pct(t.acChokeRate)}`,
            `Advantages (>51% model win%): ${t.acAdvantages || 0}`,
            `Choked (later fell below 50%): ${t.acChokes || 0}`,
            'Not tied to the actual round winner.'
          ])
        : 'No advantage samples yet. Stats index rebuilds on next library load (v16+).'
  },
  {
    key: 'mapWinrate',
    label: 'Win%',
    get: (t) => t.mapWinrate,
    cell: (t) => (t.maps > 0 ? pct(t.mapWinrate) : '—'),
    avgOf: (t) => (t.maps > 0 && Number.isFinite(t.mapWinrate) ? t.mapWinrate : null),
    avgFormat: pct,
    tip: (t) =>
      tip([
        `Map wins: ${t.mapWins}`,
        `Map losses: ${t.mapLosses}`,
        `Rounds won: ${t.roundsWon}`,
        `Rounds lost: ${t.roundsLost}`,
        `Round difference: ${t.roundDiff > 0 ? '+' : ''}${t.roundDiff}`
      ])
  },
  {
    key: 'opkRate',
    label: 'OPK rate',
    get: (t) => t.opkRate,
    cell: (t) => (t.openKills + t.openDeaths > 0 ? pct(t.opkRate) : '—'),
    avgOf: (t) =>
      t.openKills + t.openDeaths > 0 && Number.isFinite(t.opkRate) ? t.opkRate : null,
    avgFormat: pct,
    tip: (t) => tip([`Opening kills: ${t.openKills}`, `Opening deaths: ${t.openDeaths}`])
  },
  {
    key: 'conv5v4',
    label: '5v4',
    get: (t) => t.conv5v4,
    cell: (t) => (t.openKills > 0 ? pct(t.conv5v4) : '—'),
    avgOf: (t) => (t.openKills > 0 && Number.isFinite(t.conv5v4) ? t.conv5v4 : null),
    avgFormat: pct,
    tip: (t) =>
      tip([
        `After the opening kill: ${t.conv5v4Won} won, ${t.conv5v4Lost} lost`,
        `Rounds with the opening kill: ${t.openKills}`
      ])
  },
  {
    key: 'conv4v5',
    label: '4v5',
    get: (t) => t.conv4v5,
    cell: (t) => (t.openDeaths > 0 ? pct(t.conv4v5) : '—'),
    avgOf: (t) => (t.openDeaths > 0 && Number.isFinite(t.conv4v5) ? t.conv4v5 : null),
    avgFormat: pct,
    tip: (t) =>
      tip([
        `After the opening death: ${t.conv4v5Won} won, ${t.conv4v5Lost} lost`,
        `Rounds with the opening death: ${t.openDeaths}`
      ])
  },
  {
    key: 'utilDmg',
    label: 'Util dmg',
    get: (t) => (Number.isFinite(t.utilDmgPerRound) ? t.utilDmgPerRound : -1),
    cell: (t) => (Number.isFinite(t.utilDmgPerRound) ? f1(t.utilDmgPerRound) : '—'),
    avgOf: (t) => (Number.isFinite(t.utilDmgPerRound) ? t.utilDmgPerRound : null),
    avgFormat: f1,
    tip: (t) =>
      Number.isFinite(t.utilDmgPerRound)
        ? tip([
            `Average grenade damage per round: ${f1(t.utilDmgPerRound)}`,
            `HE + molotov / incendiary damage dealt by the team`,
            `Over ${t.utilDmgRounds || 0} rounds with utility data`,
            'Enemy damage only. Team and self damage never count.'
          ])
        : 'No utility damage data yet. Recalculate statistics from Admin → Tools if indexes are stale.'
  }
];

/** Default page size for library Statistics tables. */
export const STATS_PAGE_SIZE = 100;

function sortRows(rows, columns, sortKey, dir) {
  const col = columns.find((c) => c.key === sortKey) || columns.find((c) => c.key === 'rating');
  if (!col) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    if (typeof va === 'string') return sign * String(va).localeCompare(String(vb));
    return sign * ((va || 0) - (vb || 0));
  });
}

/**
 * @param {{ page: number, pages: number, total: number, pageSize: number }} opts
 */
function pagerHtml({ page, pages, total, pageSize }) {
  if (pages <= 1) return '';
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return `<div class="st-pager">
    <span class="st-pager-meta">${from}–${to} of ${total}</span>
    <div class="st-pager-btns">
      <button type="button" class="btn btn-sm" data-page="1"${
        page <= 1 ? ' disabled' : ''
      }>First</button>
      <button type="button" class="btn btn-sm" data-page="${page - 1}"${
        page <= 1 ? ' disabled' : ''
      }>Prev</button>
      <span class="st-pager-page">Page ${page} / ${pages}</span>
      <button type="button" class="btn btn-sm" data-page="${page + 1}"${
        page >= pages ? ' disabled' : ''
      }>Next</button>
      <button type="button" class="btn btn-sm" data-page="${pages}"${
        page >= pages ? ' disabled' : ''
      }>Last</button>
    </div>
  </div>`;
}

/**
 * Average footer over all filtered rows (not just the current page).
 * @param {object[]} rows
 * @param {object[]} columns
 * @param {number} sticky
 * @param {(s: string) => string} escapeHtml
 */
function averageFooterHtml(rows, columns, sticky, escapeHtml) {
  if (!rows.length) return '';
  // Rank column is always sticky-0; data columns shift by +1.
  const rankCell = `<td class="st-rank st-sticky st-sticky-0" aria-hidden="true"></td>`;
  const cells = columns
    .map((c, i) => {
      const stick = i < sticky ? ` st-sticky st-sticky-${i + 1}` : '';
      if (i === 0) {
        return `<td class="left st-avg-label${stick}">Average</td>`;
      }
      if (c.noAvg || !c.cell) {
        return `<td class="${c.align === 'left' ? 'left ' : ''}${stick.trim()}">—</td>`;
      }
      const vals = [];
      for (const r of rows) {
        const v = typeof c.avgOf === 'function' ? c.avgOf(r) : null;
        if (v == null || !Number.isFinite(v)) continue;
        vals.push(v);
      }
      if (!vals.length) {
        return `<td class="${c.align === 'left' ? 'left ' : ''}${stick.trim()}">—</td>`;
      }
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const text =
        typeof c.avgFormat === 'function' ? c.avgFormat(avg) : String(Math.round(avg * 100) / 100);
      const cls = [
        c.align === 'left' ? 'left' : '',
        c.strong ? 'strong' : '',
        stick.trim()
      ]
        .filter(Boolean)
        .join(' ');
      return `<td class="${cls}">${escapeHtml(text)}</td>`;
    })
    .join('');
  return `<tfoot><tr class="st-avg-row">${rankCell}${cells}</tr></tfoot>`;
}

/**
 * @param {object[]} rows
 * @param {{
 *   columns: object[],
 *   escapeHtml: (s: string) => string,
 *   sortKey?: string,
 *   sortDir?: 'asc'|'desc',
 *   page?: number,
 *   pageSize?: number,
 *   compact?: boolean,
 *   nameCell?: (r: object) => string,
 *   teamCell?: (r: object) => string,
 *   opponentCell?: (r: object) => string,
 *   fixedCount?: number,
 *   showAverage?: boolean
 * }} opts
 */
export function statsTableHtml(rows, opts) {
  const {
    columns,
    escapeHtml,
    sortKey = 'rating',
    sortDir = 'desc',
    page = 1,
    pageSize = 0,
    compact = false,
    nameCell = null,
    teamCell = null,
    opponentCell = null,
    fixedCount = 0,
    showAverage = false
  } = opts;
  if (!rows.length) {
    return '<p class="view-empty">Nothing matches these filters.</p>';
  }
  const sorted = sortRows(rows, columns, sortKey, sortDir);
  const total = sorted.length;
  const size = pageSize > 0 ? pageSize : total;
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, Number(page) || 1), pages);
  const slice = pageSize > 0 ? sorted.slice((safePage - 1) * size, safePage * size) : sorted;

  const sticky = Math.max(0, Math.min(fixedCount, columns.length));
  // Leading # column (sticky-0); data sticky cols are shifted by +1.
  const rankHead = `<th class="st-rank st-sticky st-sticky-0" title="Rank">#</th>`;
  const head = columns
    .map((c, i) => {
      const active = c.key === sortKey;
      const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      const stick = i < sticky ? ` st-sticky st-sticky-${i + 1}` : '';
      return `<th class="${c.align === 'left' ? 'left' : ''}${active ? ' sorted' : ''}${stick}"
        data-sort="${c.key}" title="Sort by ${escapeHtml(c.label)}">${escapeHtml(c.label)}${arrow}</th>`;
    })
    .join('');

  const rankOffset = (safePage - 1) * size;
  const body = slice
    .map((r, idx) => {
      const rank = rankOffset + idx + 1;
      const rankCell = `<td class="st-rank st-sticky st-sticky-0">${rank}</td>`;
      const cells = columns
        .map((c, i) => {
          const stick = i < sticky ? ` st-sticky st-sticky-${i + 1}` : '';
          if (!c.cell) {
            const label = nameCell ? nameCell(r) : escapeHtml(r.name);
            return `<td class="left name${stick}">${label}</td>`;
          }
          if (c.key === 'team' && teamCell) {
            const label = teamCell(r);
            const t = c.tip?.(r);
            const cls = [
              'left',
              c.em?.(r) ? '' : '',
              t ? 'has-tip' : '',
              stick.trim()
            ]
              .filter(Boolean)
              .join(' ');
            return t
              ? `<td class="${cls}" data-tip="${escapeHtml(t)}">${label}</td>`
              : `<td class="${cls}">${label}</td>`;
          }
          if (c.key === 'opponent' && opponentCell) {
            const label = opponentCell(r);
            return `<td class="left${stick}">${label}</td>`;
          }
          const text = c.cell(r);
          const t = c.tip?.(r);
          const cls = [
            c.align === 'left' ? 'left' : '',
            c.strong ? 'strong' : '',
            typeof c.cellClass === 'function' ? c.cellClass(r) : c.cellClass || '',
            t ? 'has-tip' : '',
            stick.trim()
          ]
            .filter(Boolean)
            .join(' ');
          const content = c.em?.(r) ? `<em>${escapeHtml(text)}</em>` : escapeHtml(text);
          return t
            ? `<td class="${cls}" data-tip="${escapeHtml(t)}">${content}</td>`
            : `<td class="${cls}">${content}</td>`;
        })
        .join('');
      return `<tr>${rankCell}${cells}</tr>`;
    })
    .join('');

  const foot =
    showAverage && total > 0 ? averageFooterHtml(sorted, columns, sticky, escapeHtml) : '';

  const table = `<div class="st-hscroll" data-st-hscroll>
    <div class="st-hscroll-bar" data-st-hscroll-bar tabindex="0" aria-label="Scroll columns">
      <div class="st-hscroll-spacer" data-st-hscroll-spacer></div>
    </div>
    <div class="st-hscroll-body" data-st-hscroll-body>
      <table class="st-table st-table-sticky${compact ? ' compact' : ''}">
        <thead><tr>${rankHead}${head}</tr></thead>
        <tbody>${body}</tbody>
        ${foot}
      </table>
    </div>
  </div>`;

  if (!(pageSize > 0) || pages <= 1) return table;
  return (
    table +
    pagerHtml({ page: safePage, pages, total, pageSize: size })
  );
}

/**
 * Pin sticky column `left` offsets from measured widths so scroll content
 * cannot paint over frozen columns.
 * @param {HTMLTableElement} table
 * @param {Record<number, number>} [forcedWidths] sticky index → px width
 */
function layoutStickyColumns(table, forcedWidths = null) {
  if (!table) return;
  const heads = [...table.querySelectorAll('thead th.st-sticky')];
  if (!heads.length) return;

  // Measure first (without writing) so reading width isn't affected mid-pass.
  const widths = heads.map((th, i) => {
    if (forcedWidths && Number.isFinite(forcedWidths[i])) return forcedWidths[i];
    return Math.ceil(th.getBoundingClientRect().width) || th.offsetWidth || 0;
  });
  let left = 0;
  for (let i = 0; i < heads.length; i++) {
    const width = Math.max(widths[i], 1);
    const cells = table.querySelectorAll(`.st-sticky-${i}`);
    // Later sticky cols keep a slightly lower z so left edges win on collision,
    // but all stay well above metric cells (z-index auto / 1).
    const zBody = String(10 + (heads.length - i));
    const zHead = String(20 + (heads.length - i));
    cells.forEach((cell) => {
      cell.style.left = `${left}px`;
      cell.style.width = `${width}px`;
      cell.style.minWidth = `${width}px`;
      cell.style.maxWidth = `${width}px`;
      cell.style.zIndex = cell.tagName === 'TH' ? zHead : zBody;
      cell.style.boxSizing = 'border-box';
    });
    left += width;
  }
  // Clear any leftover inline z-index on metrics (older renders set z-index:0
  // with position:relative, which painted over the frozen block).
  table.querySelectorAll('thead th:not(.st-sticky), tbody td:not(.st-sticky)').forEach((cell) => {
    cell.style.zIndex = '';
    cell.style.position = '';
  });
}

/**
 * Match boards: Team sticky col (index 2 after #) shares the wider of the two
 * team names.
 * @param {ParentNode} root
 */
export function syncMatchBoardTeamColWidths(root) {
  const boards = root.querySelector?.('.st-match-boards') || root;
  const tables = [...boards.querySelectorAll('table.st-table')];
  if (tables.length < 2) return;
  let maxW = 0;
  // sticky-0 = #, sticky-1 = Player, sticky-2 = Team
  const teamSticky = 2;
  for (const table of tables) {
    table.querySelectorAll(`.st-sticky-${teamSticky}`).forEach((c) => {
      maxW = Math.max(
        maxW,
        Math.ceil(c.scrollWidth) || 0,
        Math.ceil(c.getBoundingClientRect().width) || 0
      );
    });
  }
  if (maxW < 1) return;
  for (const table of tables) {
    layoutStickyColumns(table, { [teamSticky]: maxW });
  }
}

/**
 * Keep the top scrollbar in sync with the table body (call after render).
 * @param {ParentNode} root
 */
export function bindStatsHScroll(root) {
  root.querySelectorAll('[data-st-hscroll]').forEach((wrap) => {
    if (wrap.dataset.stHscrollBound === '1') {
      // Re-measure after a re-render that reused the binder path.
      const body = wrap.querySelector('[data-st-hscroll-body]');
      const table = body?.querySelector('table');
      const spacer = wrap.querySelector('[data-st-hscroll-spacer]');
      requestAnimationFrame(() => {
        layoutStickyColumns(table);
        if (spacer && body) spacer.style.width = `${body.scrollWidth}px`;
        syncMatchBoardTeamColWidths(root);
      });
      return;
    }
    wrap.dataset.stHscrollBound = '1';

    const bar = wrap.querySelector('[data-st-hscroll-bar]');
    const body = wrap.querySelector('[data-st-hscroll-body]');
    const spacer = wrap.querySelector('[data-st-hscroll-spacer]');
    const table = body?.querySelector('table');
    if (!bar || !body || !spacer) return;

    let lock = false;
    const sync = () => {
      layoutStickyColumns(table);
      spacer.style.width = `${body.scrollWidth}px`;
      syncMatchBoardTeamColWidths(root);
    };
    // After paint — getBoundingClientRect is wrong before layout.
    requestAnimationFrame(() => requestAnimationFrame(sync));

    bar.addEventListener('scroll', () => {
      if (lock) return;
      lock = true;
      body.scrollLeft = bar.scrollLeft;
      lock = false;
    });
    body.addEventListener('scroll', () => {
      if (lock) return;
      lock = true;
      bar.scrollLeft = body.scrollLeft;
      lock = false;
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => requestAnimationFrame(sync));
      ro.observe(body);
      if (table) ro.observe(table);
    }
  });
}

// ---------------------------------------------------------------------------
// Hover breakdowns
// ---------------------------------------------------------------------------

let tipEl = null;

function ensureTip() {
  if (tipEl?.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'st-tip';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  return tipEl;
}

/**
 * One delegated listener per panel drives every breakdown, so a table can be
 * re-rendered on any sort or filter change without rebinding anything.
 */
export function attachTips(root) {
  const show = (e) => {
    const cell = e.target.closest?.('[data-tip]');
    if (!cell || !root.contains(cell)) return hide();
    const el = ensureTip();
    el.textContent = cell.dataset.tip;
    el.hidden = false;
    const r = cell.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    let left = r.left + r.width / 2 - box.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    let top = r.top - box.height - 8;
    if (top < 8) top = r.bottom + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  const hide = () => {
    if (tipEl) tipEl.hidden = true;
  };
  root.addEventListener('mouseover', show);
  root.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !root.contains(e.relatedTarget)) hide();
  });
  root.addEventListener('mouseleave', hide);
  return () => {
    root.removeEventListener('mouseover', show);
    hide();
  };
}
