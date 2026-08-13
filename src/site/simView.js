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
import { readHeader, readRecord, FLAG_HAS_HELMET, PLAYER_SLOTS } from '../replays/shared/tickFormat.js';

const SKILLS = ['mix', 't3', 'average', 't2', 't1', 'pro'];
/**
 * The brains that are not files. Everything else on the dropdown comes from
 * the host's model registry, so a model trained ten minutes ago is playable
 * without a deploy (SIM-PLAN 9.9).
 */
const BUILTIN_BRAINS = ['scripted', 'desire'];
/** How often a watched job is re-read while it runs. */
const JOB_POLL_MS = 1500;

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
    if (typeof o !== 'string') {
      if (o.disabled) opt.disabled = true;
      if (o.title) opt.title = o.title;
    }
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
    const tabNames = ['Run', 'Jobs', 'Matches', 'Viewer', 'Export'];
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
      if (name === 'Jobs') refreshJobs().catch(() => {});
    }

    /** Shared with Jobs extract: select on Export, train from that sample. */
    const picked = new Set();
    let demos = [];

    // ---- Run -------------------------------------------------------------

    const [mapsRes, modelsRes] = await Promise.all([
      simApi.maps().catch(() => ({ maps: [] })),
      simApi.models().catch(() => ({ models: [], host: null }))
    ]);
    const playable = mapsRes.maps.filter((m) => m.angles).map((m) => m.map);
    // A broken model stays on the list, disabled, with its reason: "bc0 is
    // missing" and "bc0 speaks an older observation version" are different
    // problems and the panel should not flatten them into an empty dropdown.
    const brainOptions = [
      ...BUILTIN_BRAINS.map((b) => ({ value: b, label: b })),
      ...(modelsRes.models || []).map((m) => ({
        value: m.name,
        label: m.ok
          ? `${m.name}${m.valAccuracy != null ? ` (${(m.valAccuracy * 100).toFixed(0)}%)` : ''}`
          : `${m.name} (broken)`,
        disabled: !m.ok,
        title: m.ok ? `${m.source}, trained ${m.trainedAt?.slice(0, 10) || ''}` : m.error
      }))
    ];
    const mapSel = select(playable.length ? playable : ['INF'], playable[0] || 'INF');
    const seed = numberInput(1, { min: '0' });
    const rounds = numberInput(24, { min: '1', max: '60' });
    const skillA = select(SKILLS, 'average');
    const skillB = select(SKILLS, 'average');
    const brainA = select(brainOptions, 'desire');
    const brainB = select(brainOptions, 'scripted');
    const recordEvery = numberInput(1, { min: '1' });
    const runBtn = node('button', 'sim-btn sim-btn-primary', 'Run match');

    const runControls = node('div', 'sim-controls');
    runControls.append(
      field('Map', mapSel),
      field('Seed', seed),
      field('Rounds', rounds),
      field('T side', skillA),
      field('T brain', brainA),
      field('CT side', skillB),
      field('CT brain', brainB),
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

    /**
     * Watch a queued job to its end, reporting progress into `statusEl`.
     * Polling rather than a socket: a job's whole output is one line of text
     * and the panel is open for minutes, not hours.
     */
    async function watchJob(id, statusEl, onDone) {
      for (;;) {
        await new Promise((r) => setTimeout(r, JOB_POLL_MS));
        let job;
        try {
          ({ job } = await simApi.job(id));
        } catch (err) {
          statusEl.className = 'sim-error';
          statusEl.textContent = err.message;
          return null;
        }
        if (jobsPanelVisible()) renderJobsSoon();
        if (job.state === 'queued') {
          statusEl.textContent = 'Queued.';
        } else if (job.state === 'running') {
          const secs = Math.round((job.elapsedMs || 0) / 1000);
          statusEl.textContent = `${job.progress || 'Running.'} (${secs}s)`;
        } else {
          if (job.state === 'error') {
            statusEl.className = 'sim-error';
            statusEl.textContent = job.error || 'Job failed.';
          } else {
            statusEl.className = 'sim-note';
            statusEl.textContent = job.result || 'Done.';
          }
          if (onDone) await onDone(job);
          return job;
        }
      }
    }

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runStatus.className = 'sim-note';
      runStatus.textContent = 'Queued.';
      runResult.replaceChildren();
      try {
        const r = await simApi.run({
          map: mapSel.value,
          seed: Number(seed.value),
          rounds: Number(rounds.value),
          skillA: skillA.value,
          skillB: skillB.value,
          brainA: brainA.value,
          brainB: brainB.value,
          recordEvery: Number(recordEvery.value)
        });
        if (r.error) {
          runStatus.className = 'sim-error';
          runStatus.textContent = r.error;
          return;
        }
        await watchJob(r.job.id, runStatus, async (job) => {
          await refreshMatches();
          if (job.state !== 'done') return;
          // The match is on disk now; show its rounds from the stored list
          // rather than from a response the job never sent back.
          const { matches } = await simApi.matches();
          const m = matches[0];
          if (!m) return;
          runResult.replaceChildren(matchRoundsTable(m));
        });
      } catch (err) {
        runStatus.className = 'sim-error';
        runStatus.textContent = err.message;
      } finally {
        runBtn.disabled = false;
      }
    });

    /** The per-round table a finished match shows, with Watch buttons. */
    function matchRoundsTable(m) {
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
        const win = node('td');
        win.append(sidePill(x.winner));
        const act = node('td');
        if (x.recorded) {
          const b = node('button', 'sim-row-btn', 'Watch');
          b.addEventListener('click', () => openRound(m.id, x.round, m.map));
          act.append(b);
        }
        tr.append(
          node('td', 'sim-num', String(x.round)),
          win,
          node('td', 'sim-dim', x.reason),
          node('td', 'sim-num', String(x.kills)),
          node('td', 'sim-num', `${x.score.A}-${x.score.B}`),
          act
        );
        tbody.append(tr);
      }
      return tbl;
    }

    // ---- Jobs ------------------------------------------------------------
    //
    // The control surface SIM-PLAN 9.2b says has to exist: what is running,
    // what this host will and will not do, and a way to stop it. Without it a
    // run started from a browser is a run nobody can find again.

    const hostBox = node('div', 'sim-host');
    const trainControls = node('div', 'sim-controls');
    const trainStatus = node('p', 'sim-note', '');
    const jobsWrap = node('div', 'sim-scroll');

    const tMap = select(playable.length ? playable : ['INF'], playable[0] || 'INF');
    const tMatches = numberInput(6, { min: '1', max: '200' });
    const tRounds = numberInput(12, { min: '1', max: '30' });
    const tSeed = numberInput(40, { min: '0' });
    const collectBtn = node('button', 'sim-btn', 'Collect dataset');

    const tDataset = document.createElement('input');
    tDataset.type = 'text';
    tDataset.placeholder = 'path to a .jsonl dataset';
    tDataset.className = 'sim-text';
    const tEpochs = numberInput(60, { min: '1', max: '500' });
    const tEmbed = numberInput(16, { min: '0', max: '64' });
    const tName = document.createElement('input');
    tName.type = 'text';
    tName.value = 'bc0';
    tName.className = 'sim-text';
    const trainBtn = node('button', 'sim-btn sim-btn-primary', 'Train model');
    const extractBtn = node('button', 'sim-btn', 'Extract selected demos');
    const evalBtn = node('button', 'sim-btn', 'Eval gates');
    const rlBtn = node('button', 'sim-btn', 'RL fine-tune');

    trainControls.append(
      field('Map', tMap),
      field('Matches', tMatches),
      field('Rounds', tRounds),
      field('Seed', tSeed),
      collectBtn,
      extractBtn,
      field('Dataset', tDataset),
      field('Epochs', tEpochs),
      field('Embed', tEmbed),
      field('Name', tName),
      trainBtn,
      evalBtn,
      rlBtn
    );
    panels.Jobs.append(hostBox, trainControls, trainStatus, jobsWrap);

    collectBtn.addEventListener('click', async () => {
      collectBtn.disabled = true;
      trainStatus.className = 'sim-note';
      trainStatus.textContent = 'Queued.';
      try {
        const r = await simApi.startJob('collect', {
          map: tMap.value,
          matches: Number(tMatches.value),
          rounds: Number(tRounds.value),
          seed: Number(tSeed.value)
        });
        if (r.error) {
          trainStatus.className = 'sim-error';
          trainStatus.textContent = r.error;
          return;
        }
        await watchJob(r.job.id, trainStatus, async (job) => {
          // The runner picked the written dataset out of the stream, so
          // Collect then Train is two clicks with nothing typed between them.
          if (job.artifacts?.dataset) tDataset.value = job.artifacts.dataset;
          await refreshJobs();
        });
      } catch (err) {
        trainStatus.className = 'sim-error';
        trainStatus.textContent = err.message;
      } finally {
        collectBtn.disabled = false;
      }
    });

    extractBtn.addEventListener('click', async () => {
      const ids = [...picked];
      if (!ids.length) {
        trainStatus.className = 'sim-error';
        trainStatus.textContent = 'Select demos on Export.';
        return;
      }
      extractBtn.disabled = true;
      trainStatus.className = 'sim-note';
      trainStatus.textContent = 'Queued.';
      try {
        const r = await simApi.startJob('extract', {
          demos: ids.join(','),
          name: tName.value.trim() || 'demos'
        });
        if (r.error) {
          trainStatus.className = 'sim-error';
          trainStatus.textContent = r.error;
          return;
        }
        await watchJob(r.job.id, trainStatus, async (job) => {
          if (job.artifacts?.dataset) tDataset.value = job.artifacts.dataset;
          await refreshJobs();
        });
      } catch (err) {
        trainStatus.className = 'sim-error';
        trainStatus.textContent = err.message;
      } finally {
        extractBtn.disabled = false;
      }
    });

    trainBtn.addEventListener('click', async () => {
      trainBtn.disabled = true;
      trainStatus.className = 'sim-note';
      trainStatus.textContent = 'Queued.';
      try {
        const r = await simApi.startJob('train', {
          dataset: tDataset.value.trim(),
          epochs: Number(tEpochs.value),
          embedDim: Number(tEmbed.value),
          name: tName.value.trim() || 'bc0'
        });
        if (r.error) {
          trainStatus.className = 'sim-error';
          trainStatus.textContent = r.error;
          return;
        }
        await watchJob(r.job.id, trainStatus, () => refreshJobs());
      } catch (err) {
        trainStatus.className = 'sim-error';
        trainStatus.textContent = err.message;
      } finally {
        trainBtn.disabled = false;
      }
    });

    evalBtn.addEventListener('click', async () => {
      evalBtn.disabled = true;
      trainStatus.className = 'sim-note';
      trainStatus.textContent = 'Queued.';
      try {
        const r = await simApi.startJob('eval', {
          model: tName.value.trim() || 'bc0',
          baseline: 'scripted',
          maps: tMap.value,
          matches: Number(tMatches.value),
          rounds: Number(tRounds.value)
        });
        if (r.error) {
          trainStatus.className = 'sim-error';
          trainStatus.textContent = r.error;
          return;
        }
        await watchJob(r.job.id, trainStatus, () => refreshJobs());
      } catch (err) {
        trainStatus.className = 'sim-error';
        trainStatus.textContent = err.message;
      } finally {
        evalBtn.disabled = false;
      }
    });

    rlBtn.addEventListener('click', async () => {
      rlBtn.disabled = true;
      trainStatus.className = 'sim-note';
      trainStatus.textContent = 'Queued.';
      try {
        const r = await simApi.startJob('rl-train', {
          dataset: tDataset.value.trim(),
          init: tName.value.trim() || 'bc0',
          epochs: Math.min(8, Number(tEpochs.value) || 8),
          name: 'gen1',
          aux: true
        });
        if (r.error) {
          trainStatus.className = 'sim-error';
          trainStatus.textContent = r.error;
          return;
        }
        await watchJob(r.job.id, trainStatus, () => refreshJobs());
      } catch (err) {
        trainStatus.className = 'sim-error';
        trainStatus.textContent = err.message;
      } finally {
        rlBtn.disabled = false;
      }
    });

    const jobsPanelVisible = () => !panels.Jobs.hidden;
    let jobsSoon = null;
    function renderJobsSoon() {
      if (jobsSoon) return;
      jobsSoon = setTimeout(() => {
        jobsSoon = null;
        refreshJobs().catch(() => {});
      }, JOB_POLL_MS);
    }

    async function refreshJobs() {
      const { jobs, host } = await simApi.jobs();

      hostBox.replaceChildren();
      if (host) {
        const line = (label, value, cls) => {
          const row = node('div', 'sim-host-row');
          row.append(node('span', 'sim-field-name', label), node('span', cls || null, value));
          return row;
        };
        hostBox.append(
          line('Heavy jobs', host.heavyJobs ? 'on' : 'off (set AIM4_SIM_WORKERS)', host.heavyJobs ? null : 'sim-dim'),
          line(
            'Trainer',
            host.trainer?.ok ? `${host.trainer.version}, numpy ${host.trainer.numpy}` : 'no python with numpy',
            host.trainer?.ok ? null : 'sim-dim'
          ),
          line('Cores', String(host.cpus)),
          line('Queue', host.parserBusy ? 'waiting on demo parsing' : `${host.queued} waiting`)
        );
      }

      jobsWrap.replaceChildren();
      if (!jobs.length) {
        jobsWrap.append(node('p', 'sim-empty', 'Nothing has been queued on this host yet.'));
        return;
      }
      const { table: tbl, tbody } = table(['Job', 'What', 'State', 'Elapsed', 'Last line', '']);
      for (const j of jobs) {
        const tr = node('tr');
        const act = node('td');
        if (j.state === 'running' || j.state === 'queued') {
          const stop = node('button', 'sim-row-btn', 'Stop');
          stop.addEventListener('click', async () => {
            stop.disabled = true;
            await simApi.stopJob(j.id).catch(() => {});
            await refreshJobs();
          });
          act.append(stop);
        }
        tr.append(
          node('td', 'sim-dim', j.kind),
          node('td', null, j.label || ''),
          node('td', j.state === 'error' ? 'sim-error' : null, j.state),
          node('td', 'sim-num', `${Math.round((j.elapsedMs || 0) / 1000)}s`),
          node('td', 'sim-dim', (j.error || j.progress || '').slice(0, 90)),
          act
        );
        tbody.append(tr);
      }
      jobsWrap.append(tbl);
      // Keep the list live while anything is still moving.
      if (jobs.some((j) => j.state === 'running' || j.state === 'queued') && jobsPanelVisible()) {
        renderJobsSoon();
      }
    }

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
        const sidesLabel =
          m.brainA || m.brainB
            ? `${m.brainA || 'scripted'} ${m.skillA} vs ${m.brainB || 'scripted'} ${m.skillB}`
            : `${m.skillA} vs ${m.skillB}`;
        tr.append(
          node('td', 'sim-dim', m.id),
          node('td', null, m.map),
          node('td', 'sim-dim', sidesLabel),
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
    // The decision feed (6.17): what each bot wanted and why, in English,
    // following the scrub. This is the reason the page is worth opening.
    const motiveFeed = node('div', 'sim-motives');
    sideBar.append(roster, motiveFeed);
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
        const [meta, bytes, motives] = await Promise.all([
          simApi.roundMeta(matchId, roundNo),
          simApi.roundTicks(matchId, roundNo),
          simApi.roundMotives(matchId, roundNo).catch(() => null)
        ]);
        // One sorted feed across both sides; a scripted side simply has none.
        const decisions = [];
        for (const team of ['A', 'B']) {
          for (const d of motives?.[team] || []) decisions.push({ team, ...d });
        }
        decisions.sort((a, b) => a.tick - b.tick);
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
              armor: out.armor,
              flash: out.flash,
              // Dictionary index, resolved through meta.weapons at draw time,
              // exactly as the timeline viewer does it.
              weapon: out.weapon
            });
          }
          frames.push(states);
        }

        round = { meta, header, frames, map: map || meta.map, decisions };

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
      const players = states.map((s, slot) => {
        const p = round.meta.players?.[slot];
        return {
          id: p?.id || `p${slot}`,
          slot,
          name: p?.name || `p${slot}`,
          team: p?.team ?? (slot < 5 ? 1 : 2),
          side: s.side
        };
      });

      renderer.render({
        players,
        states,
        tick: (round.header.firstTick || 0) + row,
        tickRate: round.header.tickRate || 64,
        // The parser-shaped events and the roster-to-side map are what the
        // utility layer draws from: smokes, fires, flashes, flights.
        events: round.meta.events || { kills: [], shots: [], grenades: [], bomb: [] },
        weapons: round.meta.weapons || [],
        teamSides: { 1: round.meta.team1Side, 2: round.meta.team2Side },
        mapCode: round.map
      });

      // Clock: the round's own phase, from the meta the engine wrote.
      const tick = (round.header.firstTick || 0) + row;
      const rate = round.header.tickRate || 64;
      const live = round.meta.freezeEndTick ?? 0;
      const secs = (tick - live) / rate;
      clock.textContent = secs < 0 ? `freeze ${(-secs).toFixed(1)}` : `${secs.toFixed(1)}s`;

      // Utility still in the pocket: the freeze-end loadout minus everything
      // this player has thrown by the scrub position.
      const NADE_LETTER = {
        smokegrenade: 'S',
        flashbang: 'F',
        hegrenade: 'H',
        molotov: 'M',
        incgrenade: 'M',
        decoy: 'D'
      };
      const utilAt = (playerId) => {
        const held = [];
        for (const item of round.meta.stats?.[playerId]?.loadout || []) {
          if (NADE_LETTER[item]) held.push(item);
        }
        for (const g of round.meta.events?.grenades || []) {
          if (g.player !== playerId || g.throwTick > tick) continue;
          const i = held.indexOf(g.type);
          if (i >= 0) held.splice(i, 1);
        }
        return held.map((n) => NADE_LETTER[n]).join(' ');
      };

      roster.replaceChildren();
      for (const side of ['T', 'CT']) {
        roster.append(node('h3', null, side));
        states.forEach((s, slot) => {
          if (s.side !== side) return;
          const p = round.meta.players?.[slot];
          const rowEl = node('div', `sim-player${s.alive ? '' : ' is-dead'}`);
          const dot = node('span', 'sim-dot');
          dot.style.background = side === 'T' ? '#f0b43c' : '#5a96e6';
          rowEl.append(dot, node('span', null, p?.name || `p${slot}`));
          if (s.alive) {
            const weapon = round.meta.weapons?.[s.weapon] || '';
            if (weapon && weapon !== 'knife') rowEl.append(node('span', 'sim-eq', weapon));
            const util = utilAt(p?.id || `p${slot}`);
            if (util) rowEl.append(node('span', 'sim-util', util));
            if (s.armor > 0) {
              rowEl.append(node('span', 'sim-armor', s.flags & FLAG_HAS_HELMET ? 'HK' : 'K'));
            }
          }
          rowEl.append(node('span', 'sim-hp', s.alive ? String(s.health) : 'dead'));
          roster.append(rowEl);
        });
      }

      // The last few decisions up to the scrub position, newest on top.
      motiveFeed.replaceChildren();
      if (round.decisions?.length) {
        motiveFeed.append(node('h3', null, 'Decisions'));
        const upTo = round.decisions.filter((d) => d.tick <= tick).slice(-8).reverse();
        if (!upTo.length) {
          motiveFeed.append(node('p', 'sim-empty', 'Nothing decided yet.'));
        }
        for (const d of upTo) {
          const rowEl = node('div', 'sim-motive');
          const at = ((d.tick - live) / rate).toFixed(1);
          rowEl.append(
            node('span', 'sim-dim', `${at}s p${d.slot}`),
            node('span', 'sim-motive-id', d.id),
            node('span', 'sim-motive-why', d.motive || '')
          );
          motiveFeed.append(rowEl);
        }
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
    const selectAllBtn = node('button', 'sim-btn', 'Select all');
    const dlBtn = node('button', 'sim-btn sim-btn-primary', 'Download selected');
    dlBtn.disabled = true;
    exportControls.append(field('Map', mapFilter), selectAllBtn, dlBtn, total);
    const exportStatus = node('p', 'sim-note', '');
    const exportWrap = node('div', 'sim-scroll');
    panels.Export.append(exportControls, exportStatus, exportWrap);

    function renderExport() {
      exportWrap.replaceChildren();
      const rows = demos.filter((d) => !mapFilter.value || d.map === mapFilter.value);
      if (!rows.length) {
        exportWrap.append(
          node(
            'p',
            'sim-empty',
            demos.length
              ? 'No demos for this map.'
              : 'No demos in the library on this host.'
          )
        );
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

    selectAllBtn.addEventListener('click', () => {
      const rows = demos.filter((d) => !mapFilter.value || d.map === mapFilter.value);
      for (const d of rows) picked.add(d.id);
      renderExport();
      updateTotal();
    });

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
      exportStatus.className = 'sim-note';
      exportStatus.textContent = '';
      const res = await simApi.exportList();
      demos = res.demos || [];
      if (res.error) {
        exportStatus.className = 'sim-error';
        exportStatus.textContent = res.error;
      }
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
    await Promise.all([
      refreshMatches().catch(() => {}),
      refreshExport().catch((err) => {
        exportStatus.className = 'sim-error';
        exportStatus.textContent = err.message || 'Export list failed.';
      })
    ]);
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
