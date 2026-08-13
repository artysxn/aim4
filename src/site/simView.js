// ---------------------------------------------------------------------------
// src/site/simView.js
// The /sim panel: run matches, watch what they produced, export the library.
//
// Renders nothing until GET /api/sim/me returns 200. On anything else it shows
// the same "Page not found" wording the router shows for an unknown path,
// because from outside there is no difference between the two and there must
// not appear to be one.
//
// Four tabs rather than one column, because the three jobs here have nothing to
// do with each other: setting a match running, watching a stored round, and
// picking a training sample out of a 10 GB library are separate sittings.
//
// The viewer reuses RadarRenderer, the same class the replay timeline draws
// with, fed from the parser's own tick format. That is the whole point of
// encoding sim rounds in that format (SIM-PLAN 1): a sim round is a round
// nobody had to play, so it draws with the code that already exists.
//
// Style: .cursor/rules/aim4-ui-controls.mdc. Flat fields, the analyzer seg for
// tabs, no captions under controls, no em dashes.
// ---------------------------------------------------------------------------

import './sim.css';
import { simApi } from './simApi.js';
import { spinnerNode } from '../lib/spinner.js';
import { readHeader, readRecord, PLAYER_SLOTS } from '../replays/shared/tickFormat.js';

const SKILLS = ['mix', 't3', 'average', 't2', 't1', 'pro'];

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function field(name, control) {
  const wrap = node('label', 'sim-field');
  wrap.append(node('span', 'sim-field-name', name), control);
  return wrap;
}

function select(options, value) {
  const el = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = typeof o === 'string' ? o : o.value;
    opt.textContent = typeof o === 'string' ? o : o.label;
    if (opt.value === value) opt.selected = true;
    el.append(opt);
  }
  return el;
}

function numberInput(value, attrs = {}) {
  const el = document.createElement('input');
  el.type = 'number';
  el.value = String(value);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function table(headers) {
  const t = node('table', 'sim-table');
  const thead = node('thead');
  const tr = node('tr');
  for (const h of headers) {
    const th = node('th', null, typeof h === 'string' ? h : h.label);
    if (typeof h !== 'string' && h.align === 'right') th.style.textAlign = 'right';
    tr.append(th);
  }
  thead.append(tr);
  const tbody = node('tbody');
  t.append(thead, tbody);
  return { table: t, tbody };
}

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
const sidePill = (side) =>
  node('span', `sim-pill sim-pill-${side === 'T' ? 't' : 'ct'}`, side);

/**
 * @param {HTMLElement|null} host the `.view[data-view="sim"]` element
 */
export function initSimView(host) {
  if (!host) return { onShow() {}, onHide() {} };

  const root = node('div', 'sim-root');
  host.replaceChildren(root);

  let allowed = null;
  let checking = null;
  /** Cancels the viewer's animation loop when the view is hidden. */
  let stopPlayback = null;

  function showNotFound() {
    root.replaceChildren(node('h1', null, 'Page not found'));
  }

  // -------------------------------------------------------------------------

  async function build(me) {
    root.replaceChildren();

    const head = node('div', 'sim-head');
    head.append(node('h1', null, 'Sim'), node('span', 'sim-who', me.username || me.id));
    root.append(head);

    const tabs = node('div', 'sim-tabs');
    const panels = {};
    const tabNames = ['Run', 'Matches', 'Viewer', 'Export'];
    const tabButtons = {};

    for (const name of tabNames) {
      const btn = node('button', 'sim-tab', name);
      btn.setAttribute('role', 'tab');
      btn.addEventListener('click', () => selectTab(name));
      tabs.append(btn);
      tabButtons[name] = btn;
      const panel = node('section', 'sim-panel');
      panel.hidden = true;
      panels[name] = panel;
    }
    root.append(tabs, ...Object.values(panels));

    function selectTab(name) {
      for (const [n, btn] of Object.entries(tabButtons)) {
        btn.setAttribute('aria-selected', String(n === name));
        panels[n].hidden = n !== name;
      }
      if (name !== 'Viewer' && stopPlayback) stopPlayback();
    }

    // ---- Run -------------------------------------------------------------

    const mapsRes = await simApi.maps().catch(() => ({ maps: [] }));
    const playable = mapsRes.maps.filter((m) => m.angles).map((m) => m.map);
    const mapSel = select(playable.length ? playable : ['INF'], playable[0] || 'INF');
    const seed = numberInput(1, { min: '0' });
    const rounds = numberInput(24, { min: '1', max: '60' });
    const skillA = select(SKILLS, 'average');
    const skillB = select(SKILLS, 'average');
    const recordEvery = numberInput(1, { min: '1' });
    const runBtn = node('button', 'sim-btn sim-btn-primary', 'Run match');

    const runControls = node('div', 'sim-controls');
    runControls.append(
      field('Map', mapSel),
      field('Seed', seed),
      field('Rounds', rounds),
      field('T side', skillA),
      field('CT side', skillB),
      field('Record 1 in', recordEvery),
      runBtn
    );
    const runStatus = node('p', 'sim-note', '');
    const runResult = node('div', 'sim-scroll');
    panels.Run.append(runControls, runStatus, runResult);

    if (!playable.length) {
      runStatus.className = 'sim-error';
      runStatus.textContent = 'No baked maps on this host.';
    }

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runStatus.className = 'sim-note';
      runStatus.textContent = 'Running.';
      runResult.replaceChildren();
      try {
        const r = await simApi.run({
          map: mapSel.value,
          seed: Number(seed.value),
          rounds: Number(rounds.value),
          skillA: skillA.value,
          skillB: skillB.value,
          recordEvery: Number(recordEvery.value)
        });
        if (r.error) {
          runStatus.className = 'sim-error';
          runStatus.textContent = r.error;
          return;
        }
        const m = r.match;
        runStatus.textContent =
          `${m.id}: ${m.score.A} to ${m.score.B}` +
          (m.winner ? `, ${m.winner} wins` : '') +
          `, ${m.storedRounds} of ${m.rounds.length} rounds stored, ${m.elapsedMs} ms`;

        const { table: tbl, tbody } = table([
          '#',
          'Winner',
          'How',
          { label: 'Kills', align: 'right' },
          'Score',
          ''
        ]);
        for (const x of m.rounds) {
          const tr = node('tr');
          const num = node('td', 'sim-num', String(x.round));
          const win = node('td');
          win.append(sidePill(x.winner));
          const tds = [
            num,
            win,
            node('td', 'sim-dim', x.reason),
            node('td', 'sim-num', String(x.kills)),
            node('td', 'sim-num', `${x.score.A}-${x.score.B}`)
          ];
          const act = node('td');
          if (x.recorded) {
            const b = node('button', 'sim-row-btn', 'Watch');
            b.addEventListener('click', () => openRound(m.id, x.round, m.map));
            act.append(b);
          }
          tds.push(act);
          tr.append(...tds);
          tbody.append(tr);
        }
        runResult.append(tbl);
        await refreshMatches();
      } catch (err) {
        runStatus.className = 'sim-error';
        runStatus.textContent = err.message;
      } finally {
        runBtn.disabled = false;
      }
    });

    // ---- Matches ---------------------------------------------------------

    const matchWrap = node('div', 'sim-scroll');
    panels.Matches.append(matchWrap);

    async function refreshMatches() {
      const { matches } = await simApi.matches();
      matchWrap.replaceChildren();
      if (!matches.length) {
        matchWrap.append(node('p', 'sim-empty', 'Nothing has been run on this host yet.'));
        return;
      }
      const { table: tbl, tbody } = table([
        'Match',
        'Map',
        'Sides',
        'Score',
        { label: 'Stored', align: 'right' },
        'Rounds'
      ]);
      for (const m of matches) {
        const tr = node('tr');
        const stored = m.rounds.filter((r) => r.recorded);
        const links = node('td');
        for (const r of stored.slice(0, 12)) {
          const b = node('button', 'sim-row-btn', `R${r.round}`);
          b.addEventListener('click', () => openRound(m.id, r.round, m.map));
          links.append(b);
        }
        tr.append(
          node('td', 'sim-dim', m.id),
          node('td', null, m.map),
          node('td', 'sim-dim', `${m.skillA} vs ${m.skillB}`),
          node('td', 'sim-num', `${m.score.A}-${m.score.B}`),
          node('td', 'sim-num', String(m.storedRounds)),
          links
        );
        tbody.append(tr);
      }
      matchWrap.append(tbl);
    }

    // ---- Viewer ----------------------------------------------------------

    const viewer = node('div', 'sim-viewer');
    const left = node('div');
    const canvasWrap = node('div', 'sim-canvas-wrap');
    const canvas = document.createElement('canvas');
    canvasWrap.append(canvas);
    const transport = node('div', 'sim-transport');
    const playBtn = node('button', 'sim-btn', 'Play');
    const scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.min = '0';
    scrub.max = '0';
    scrub.value = '0';
    const clock = node('span', 'sim-clock', '');
    transport.append(playBtn, scrub, clock);
    left.append(canvasWrap, transport);

    const sideBar = node('div');
    const roster = node('div', 'sim-side-list');
    sideBar.append(roster);
    viewer.append(left, sideBar);

    const viewerEmpty = node('p', 'sim-empty', 'Pick a stored round from Run or Matches.');
    panels.Viewer.append(viewerEmpty, viewer);
    viewer.hidden = true;

    /** Loaded round: header, decoded frames, meta. */
    let round = null;
    let renderer = null;

    async function openRound(matchId, roundNo, map) {
      selectTab('Viewer');
      viewerEmpty.textContent = 'Loading.';
      viewerEmpty.hidden = false;
      viewer.hidden = true;
      if (stopPlayback) stopPlayback();

      try {
        const [meta, bytes] = await Promise.all([
          simApi.roundMeta(matchId, roundNo),
          simApi.roundTicks(matchId, roundNo)
        ]);
        const header = readHeader(bytes);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        // Decode once into plain frames. A round is a few thousand rows of ten
        // records; doing it up front keeps the draw loop free of parsing.
        const frames = [];
        const out = {};
        for (let row = 0; row < header.tickCount; row += 1) {
          const states = [];
          for (let slot = 0; slot < PLAYER_SLOTS; slot += 1) {
            readRecord(view, row, slot, out);
            states.push({
              x: out.x,
              y: out.y,
              z: out.z,
              yaw: out.yaw,
              health: out.health,
              alive: out.alive,
              side: out.side,
              flags: out.flags,
              weapon: ''
            });
          }
          frames.push(states);
        }

        round = { meta, header, frames, map: map || meta.map };

        if (!renderer) {
          const { RadarRenderer } = await import('../replays/viewer/radarRenderer.js');
          renderer = new RadarRenderer(canvas);
        }
        await renderer.setMap(round.map);

        scrub.max = String(frames.length - 1);
        scrub.value = '0';
        viewerEmpty.hidden = true;
        viewer.hidden = false;
        drawFrame(0);
      } catch (err) {
        viewerEmpty.textContent = err.message;
      }
    }

    function drawFrame(row) {
      if (!round || !renderer) return;
      const states = round.frames[row] || [];
      const players = states.map((s, slot) => ({
        id: `p${slot}`,
        slot,
        name: round.meta.players?.[slot]?.name || `p${slot}`,
        team: s.side === 'CT' ? 2 : 1,
        side: s.side
      }));

      renderer.render({
        players,
        states,
        tick: (round.header.firstTick || 0) + row,
        tickRate: round.header.tickRate || 64,
        grenades: [],
        mapCode: round.map
      });

      // Clock: the round's own phase, from the meta the engine wrote.
      const tick = (round.header.firstTick || 0) + row;
      const rate = round.header.tickRate || 64;
      const live = round.meta.freezeEndTick ?? 0;
      const secs = (tick - live) / rate;
      clock.textContent = secs < 0 ? `freeze ${(-secs).toFixed(1)}` : `${secs.toFixed(1)}s`;

      roster.replaceChildren();
      for (const side of ['T', 'CT']) {
        roster.append(node('h3', null, side));
        states.forEach((s, slot) => {
          if (s.side !== side) return;
          const rowEl = node('div', `sim-player${s.alive ? '' : ' is-dead'}`);
          const dot = node('span', 'sim-dot');
          dot.style.background = side === 'T' ? '#f0b43c' : '#5a96e6';
          rowEl.append(dot, node('span', null, round.meta.players?.[slot]?.name || `p${slot}`));
          rowEl.append(node('span', 'sim-hp', s.alive ? String(s.health) : 'dead'));
          roster.append(rowEl);
        });
      }
    }

    scrub.addEventListener('input', () => drawFrame(Number(scrub.value)));

    playBtn.addEventListener('click', () => {
      if (stopPlayback) {
        stopPlayback();
        return;
      }
      if (!round) return;
      playBtn.textContent = 'Pause';
      let raf = 0;
      let last = performance.now();
      let acc = 0;
      const rate = round.header.tickRate || 64;
      const tick = (now) => {
        acc += (now - last) / 1000;
        last = now;
        const advance = Math.floor(acc * rate);
        if (advance > 0) {
          acc -= advance / rate;
          const next = Number(scrub.value) + advance;
          if (next >= round.frames.length - 1) {
            scrub.value = String(round.frames.length - 1);
            drawFrame(round.frames.length - 1);
            stopPlayback();
            return;
          }
          scrub.value = String(next);
          drawFrame(next);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      stopPlayback = () => {
        cancelAnimationFrame(raf);
        stopPlayback = null;
        playBtn.textContent = 'Play';
      };
    });

    // ---- Export ----------------------------------------------------------

    const exportControls = node('div', 'sim-controls');
    const mapFilter = select([{ value: '', label: 'All maps' }], '');
    const total = node('span', 'sim-field-name', '');
    const dlBtn = node('button', 'sim-btn sim-btn-primary', 'Download selected');
    dlBtn.disabled = true;
    exportControls.append(field('Map', mapFilter), dlBtn, total);
    const exportStatus = node('p', 'sim-note', '');
    const exportWrap = node('div', 'sim-scroll');
    panels.Export.append(exportControls, exportStatus, exportWrap);

    const picked = new Set();
    let demos = [];

    function renderExport() {
      exportWrap.replaceChildren();
      const rows = demos.filter((d) => !mapFilter.value || d.map === mapFilter.value);
      if (!rows.length) {
        exportWrap.append(node('p', 'sim-empty', 'No demos in the library on this host.'));
        return;
      }
      const { table: tbl, tbody } = table([
        '',
        'Map',
        'Teams',
        { label: 'Rounds', align: 'right' },
        { label: 'Size', align: 'right' },
        'Id'
      ]);
      for (const d of rows) {
        const tr = node('tr');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = picked.has(d.id);
        box.addEventListener('change', () => {
          if (box.checked) picked.add(d.id);
          else picked.delete(d.id);
          updateTotal();
        });
        const cbCell = node('td');
        cbCell.append(box);
        tr.append(
          cbCell,
          node('td', null, d.map || ''),
          node('td', null, d.teams?.length ? d.teams.join(' vs ') : ''),
          node('td', 'sim-num', d.rounds == null ? '' : String(d.rounds)),
          node('td', 'sim-num', `${mb(d.bytes)} MB`),
          node('td', 'sim-dim', d.id)
        );
        tbody.append(tr);
      }
      exportWrap.append(tbl);
    }

    function updateTotal() {
      let bytes = 0;
      for (const d of demos) if (picked.has(d.id)) bytes += d.bytes;
      total.textContent = picked.size
        ? `${picked.size} selected, ${mb(bytes)} MB`
        : `${demos.length} demos`;
      dlBtn.disabled = picked.size === 0;
    }

    mapFilter.addEventListener('change', renderExport);

    dlBtn.addEventListener('click', async () => {
      dlBtn.disabled = true;
      const ids = [...picked];
      let n = 0;
      try {
        for (const id of ids) {
          n += 1;
          exportStatus.textContent = `Downloading ${n} of ${ids.length}.`;
          const { filename, blob } = await simApi.exportDownload(id);
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          a.click();
          URL.revokeObjectURL(a.href);
        }
        exportStatus.textContent = `Done, ${ids.length} files.`;
      } catch (err) {
        exportStatus.className = 'sim-error';
        exportStatus.textContent = err.message;
      } finally {
        dlBtn.disabled = picked.size === 0;
      }
    });

    async function refreshExport() {
      const res = await simApi.exportList();
      demos = res.demos || [];
      const maps = [...new Set(demos.map((d) => d.map).filter(Boolean))].sort();
      mapFilter.replaceChildren();
      for (const o of [{ value: '', label: 'All maps' }, ...maps.map((m) => ({ value: m, label: m }))]) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        mapFilter.append(opt);
      }
      renderExport();
      updateTotal();
    }

    selectTab('Run');
    await Promise.all([refreshMatches().catch(() => {}), refreshExport().catch(() => {})]);
  }

  async function check() {
    if (checking) return checking;
    root.replaceChildren(spinnerNode());
    checking = simApi
      .me()
      .then((me) => {
        allowed = true;
        return build(me);
      })
      .catch(() => {
        allowed = false;
        showNotFound();
      })
      .finally(() => {
        checking = null;
      });
    return checking;
  }

  return {
    async onShow() {
      if (allowed === false) {
        showNotFound();
        return;
      }
      await check();
    },
    onHide() {
      if (stopPlayback) stopPlayback();
    }
  };
}
