// ---------------------------------------------------------------------------
// replays/training/opinions.js
// The training bot forming its own opinions from an antistrat summary.
//
// The summary states facts and makes no calls; this is the part that does.
// Each rule puts two facts the sheet already printed side by side and says
// what follows from them for the team playing against this one:
//
//   anchor-pinned    an anchor on one spot at 1:30 + no smoke by 1:35
//                    -> a default molotov on that spot catches him
//   anchor-spent     an anchor's molotov is always gone by 1:35
//                    -> late hits on his site meet no molotov from him
//   awp-settled      the AWP's spot at 1:15 + the same spot at 1:30
//                    -> flash or smoke it before taking that side late
//   spot-tell        a player's spot at 1:30 + what comes with it
//                    -> seeing him there tells you the rest
//   lurk-aggressive  a lurker going at the site + before the team hits
//                    -> expect contact there, not a quiet flank
//   lurk-leaves      a lurker leaving + how long before the hit
//                    -> the player on that side can push or rotate early
//   core-empty       where the core shows itself + who is elsewhere
//                    -> the empty side is free to rotate off or flank through
//   core-pushers     where the core shows itself + the other side pushing
//                    -> contact on both sides at once
//   reactive-bait    utility only ever thrown as an answer + what sets it off
//                    -> fake the trigger, wait for it, then go
//   reactive-still   utility after a death + the team holding still
//                    -> a re-hit right after the opening kill meets no change
//
// Every opinion carries the facts it was built from and the rounds behind
// them, which is what the admin sees next to it on /admin/training_5.
// ---------------------------------------------------------------------------

export const OPINION_ENGINE = 'rules-1';
const MAX_FILES = 40;
const MAX_OPINIONS = 24;

/** Every structured fact the summary attached to its lines, in sheet order. */
export function factsOf(report) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node.fact && typeof node.fact === 'object' && !seen.has(node.fact)) {
      seen.add(node.fact);
      out.push(node.fact);
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'fact' && v && typeof v === 'object') walk(v);
  };
  walk(report?.sides);
  return out;
}

const filesOf = (...lists) => [...new Set(lists.flat(Infinity).filter((f) => typeof f === 'string' && f))].slice(0, MAX_FILES);
const inArea = (area) => (area === 'A' || area === 'B' ? `on the ${area} side` : area === 'mid' ? 'in mid' : `at ${area}`);
const areaName = (area) => (area === 'A' || area === 'B' ? `the ${area} side` : area === 'mid' ? 'mid' : area);
const siteOfRole = (role) => (/\b([AB])\b/i.exec(role || '') || [])[1]?.toUpperCase() || '';

/**
 * @param {object} report  buildSummaryReport output
 * @returns {Array<{ rule: string, key: string, text: string, because: string[], files: string[] }>}
 */
export function opinionsFrom(report) {
  const facts = factsOf(report);
  const of = (kind) => facts.filter((f) => f.kind === kind);
  const spotsOf = (id) => of('spots').find((f) => f.id === id) || null;
  const out = [];
  const add = (rule, key, text, because, files) => {
    if (out.some((o) => o.key === `${rule}:${key}`)) return;
    out.push({ rule, key: `${rule}:${key}`, text, because, files: filesOf(files) });
  };

  for (const a of of('anchor')) {
    const spots = spotsOf(a.id);
    const top = spots?.spots?.[0];
    const site = siteOfRole(a.role);
    if (top && top.share >= 40 && a.smoke < 25) {
      add(
        'anchor-pinned',
        a.id,
        `${a.name} (${a.role}) is at ${top.pos} at 1:30 in ${top.share}% of 5v5s and has a smoke out by 1:35 in only ${a.smoke}%, so in late rounds a molotov on ${top.pos} from the default leaves him nowhere to go: an easy kill or free ground.`,
        [`${a.name} at ${top.pos} at 1:30: ${top.share}% of ${spots.n} 5v5s`, `${a.name} smoke by 1:35: ${a.smoke}% of ${a.n} full buys`],
        [top.files, a.files]
      );
    }
    const spent = a.spots?.[0];
    if (a.share >= 85 && spent && spent.share >= 60) {
      add(
        'anchor-spent',
        a.id,
        `${a.name} has his ${spent.name} out by 1:35 in ${spent.share}% of full buys, so a hit on ${site || 'his site'} after 1:20 meets no utility from him: let it burn, then go.`,
        [`${a.name} uses a smoke or molo by 1:35 in ${a.share}%`, `${spent.name} by 1:35: ${spent.share}%`],
        [a.files]
      );
    }
  }

  for (const w of of('awp')) {
    const top = w.spots?.[0];
    if (!top || top.share < 40) continue;
    const early = w.id ? spotsOf(w.id)?.spots?.find((s) => s.pos === top.pos) : null;
    add(
      'awp-settled',
      top.pos,
      `Their AWP${w.name ? ` (${w.name})` : ''} sits ${top.pos} at 1:15 in ${top.share}% of quiet 5v5s${
        early ? ` and is already there at 1:30 in ${early.share}%` : ''
      }: flash or smoke ${top.pos} before taking that side late.`,
      [`AWP at 1:15: ${top.pos} ${top.share}% of ${w.n}`, ...(early ? [`${w.name} at ${top.pos} at 1:30: ${early.share}%`] : [])],
      [top.files, early?.files]
    );
  }

  let tells = 0;
  for (const f of of('spots')) {
    for (const s of f.spots || []) {
      for (const t of s.tells || []) {
        if (t.share < 80 || t.of < 5 || tells >= 5) continue;
        tells++;
        const means =
          t.kind === 'player'
            ? `where ${t.words.split(' ')[0]} is`
            : t.kind === 'stack'
              ? `they are stacking`
              : `the ${t.words} is coming`;
        add(
          'spot-tell',
          `${f.id}:${s.pos}:${t.words}`,
          `When ${f.name} is ${s.pos} at 1:30, ${t.words} comes with it in ${t.share}% (${t.hits} of ${t.of}): seeing him there tells you ${means}.`,
          [`${f.name} at ${s.pos} at 1:30: ${s.share}% of ${f.n}`, `${t.words} in those rounds: ${t.share}%`],
          [t.files]
        );
      }
    }
  }

  for (const l of of('lurk')) {
    if (l.push && l.push.n * 2 >= l.n && l.push.before * 2 >= l.push.n) {
      add(
        'lurk-aggressive',
        l.id,
        `Their lurker ${inArea(l.area)}, ${l.name}, goes at ${l.push.where || 'the site'} himself before the hit (${l.push.before} of ${l.n} lurks, around ${l.push.clock}): the player on ${areaName(l.area)} should expect contact there, not a quiet flank.`,
        [`${l.name} lurks ${inArea(l.area)} in ${l.n} of ${l.basis} full buys`, `goes at the site in ${l.push.n}, ${l.push.before} before the team hits`],
        [l.files]
      );
    }
    if (l.rotate && l.rotate.n * 10 >= l.n * 6 && l.rotate.gap < 0) {
      add(
        'lurk-leaves',
        l.id,
        `${l.name} gives up his lurk ${inArea(l.area)} about ${-l.rotate.gap}s before the hit (${l.rotate.n} of ${l.n}): once he is gone, the player on ${areaName(l.area)} can push for information or rotate early.`,
        [`${l.name} lurks ${inArea(l.area)} in ${l.n} of ${l.basis} full buys`, `leaves for the hit in ${l.rotate.n}, about ${-l.rotate.gap}s before it`],
        [l.files]
      );
    }
  }

  for (const c of of('core')) {
    if (c.n < 6) continue;
    for (const o of c.others || []) {
      if (o.nobody >= 70) {
        add(
          'core-empty',
          `${c.area}:${o.area}`,
          `When their core shows itself ${inArea(c.area)}, ${areaName(o.area)} is empty in ${o.nobody}% (${c.n} rounds): a fast rotation off ${areaName(o.area)}, or a flank through it, meets nobody.`,
          [`Core ${inArea(c.area)} in ${c.n} of ${c.basis} full buys, around ${c.clock}`, `${areaName(o.area)} empty at that moment in ${o.nobody}%`],
          [c.files]
        );
      }
      const pushes = o.does?.push || 0;
      const total = Object.values(o.does || {}).reduce((n, k) => n + k, 0);
      if (total >= 4 && pushes * 2 >= total) {
        add(
          'core-pushers',
          `${c.area}:${o.area}`,
          `While their core fights ${inArea(c.area)}, the player on ${areaName(o.area)} pushes in ${pushes} of ${total}: expect contact on ${areaName(o.area)} at the same time as the main fight.`,
          [`Core ${inArea(c.area)} in ${c.n} rounds, around ${c.clock}`, `${areaName(o.area)}: ${pushes} of ${total} push within 10 seconds`],
          [o.files]
        );
      }
    }
  }

  for (const r of of('reactive')) {
    if (r.group !== 'spot' || r.reactive * 4 < r.n * 3) continue;
    const word = r.type === 'molotov' ? 'molo' : 'smoke';
    const singles = Object.entries(r.single || {}).sort((a, b) => b[1] - a[1]);
    if (singles.length && singles[0][1] >= 2) {
      const [type, k] = singles[0];
      const bait = { smokegrenade: 'a smoke', flashbang: 'a flash', molotov: 'a molotov', hegrenade: 'an HE' }[type] || 'utility';
      add(
        'reactive-bait',
        r.words,
        `Their ${r.label} ${word}${r.thrower ? ` (${r.thrower})` : ''} only comes as an answer (${r.reactive} of ${r.n}), and ${bait} on its own sets it off ${k} times: fake it with ${bait}, wait for the ${word}, then go.`,
        [`${r.words}: ${r.reactive} of ${r.n} thrown as an answer`, `set off by a single T ${bait.replace(/^an? /, '')}: ${k}`],
        [r.files]
      );
    }
    if (r.after?.does === 'still' && r.after.of >= 3) {
      add(
        'reactive-still',
        r.words,
        `After a death, their ${r.label} ${word} goes down and the team holds still (${r.after.n} of ${r.after.of}): a re-hit right after the opening kill meets the same setup behind that ${word}.`,
        [`${r.words} thrown after a death in ${r.deaths}`, `the team holds still afterwards: ${r.after.n} of ${r.after.of}`],
        [r.files]
      );
    }
  }

  return out.slice(0, MAX_OPINIONS);
}
