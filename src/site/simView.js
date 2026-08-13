// ---------------------------------------------------------------------------
// src/site/simView.js
// The /sim shell: run scripted matches, browse what ran, export the library.
//
// Renders nothing until GET /api/sim/me returns 200. On anything else it shows
// the same "Page not found" wording the router shows for an unknown path,
// because from outside there is no difference between the two, and there must
// not appear to be one.
//
// Copy rules per CLAUDE.md: no em dashes, no filler captions. Controls are
// plain fields and buttons; the section headers are the only labels.
// ---------------------------------------------------------------------------

import { simApi } from './simApi.js';
import { spinnerNode } from '../lib/spinner.js';

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function field(labelText, input) {
  const wrap = node('label', 'sim-field');
  wrap.append(node('span', 'sim-field-name', labelText), input);
  return wrap;
}

function select(options, value) {
  const el = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    if (o === value) opt.selected = true;
    el.append(opt);
  }
  return el;
}

function input(type, value, attrs = {}) {
  const el = document.createElement('input');
  el.type = type;
  el.value = value;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const MAPS = ['INF', 'ANC', 'ANU', 'CCH', 'DD2', 'MIR', 'NUK'];
const SKILLS = ['mix', 't3', 'average', 't2', 't1', 'pro'];

/**
 * @param {HTMLElement|null} host the `.view[data-view="sim"]` element
 */
export function initSimView(host) {
  if (!host) return { onShow() {}, onHide() {} };

  const root = node('div', 'sim-root');
  host.replaceChildren(root);

  let allowed = null;
  let checking = null;

  function showNotFound() {
    const pad = node('div', 'view-pad');
    pad.append(node('h1', null, 'Page not found'));
    root.replaceChildren(pad);
  }

  async function showShell(me) {
    const pad = node('div', 'view-pad');
    pad.append(node('h1', null, 'Sim'));
    pad.append(node('p', 'sim-status', `Signed in as ${me.username || me.id}.`));

    // ---- run a match --------------------------------------------------------
    pad.append(node('h2', null, 'Run'));
    const map = select(MAPS, 'INF');
    const seed = input('number', '1');
    const rounds = input('number', '24', { min: '1', max: '60' });
    const skillA = select(SKILLS, 'average');
    const skillB = select(SKILLS, 'average');
    const recordEvery = input('number', '1', { min: '1' });
    const runBtn = node('button', 'sim-run-btn', 'Run match');
    const runOut = node('pre', 'sim-run-out', '');

    const controls = node('div', 'sim-controls');
    controls.append(
      field('Map', map),
      field('Seed', seed),
      field('Rounds', rounds),
      field('Team A', skillA),
      field('Team B', skillB),
      field('Record every', recordEvery),
      runBtn
    );
    pad.append(controls, runOut);

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runOut.textContent = 'Running.';
      try {
        const r = await simApi.run({
          map: map.value,
          seed: Number(seed.value),
          rounds: Number(rounds.value),
          skillA: skillA.value,
          skillB: skillB.value,
          recordEvery: Number(recordEvery.value)
        });
        if (r.error) {
          runOut.textContent = r.error;
        } else {
          const m = r.match;
          runOut.textContent =
            `${m.id}\n${m.score.A}-${m.score.B}` +
            (m.winner ? ` (${m.winner} wins)` : '') +
            `\n${m.rounds.length} rounds, ${m.storedRounds} stored, ${m.elapsedMs} ms\n` +
            m.rounds
              .map(
                (x) =>
                  `R${String(x.round).padStart(2)} ${x.winner.padEnd(2)} ` +
                  `${x.reason.padEnd(12)} kills ${String(x.kills).padStart(2)}` +
                  (x.recorded ? '  [stored]' : '')
              )
              .join('\n');
          await refreshMatches();
        }
      } catch (err) {
        runOut.textContent = err.message;
      } finally {
        runBtn.disabled = false;
      }
    });

    // ---- stored matches -----------------------------------------------------
    pad.append(node('h2', null, 'Matches'));
    const matchList = node('div', 'sim-matches');
    pad.append(matchList);

    async function refreshMatches() {
      const { matches } = await simApi.matches();
      matchList.replaceChildren();
      if (!matches.length) {
        matchList.append(node('p', 'sim-empty', 'No stored matches on this host.'));
        return;
      }
      for (const m of matches) {
        const row = node('div', 'sim-match-row');
        row.append(
          node('code', null, m.id),
          node('span', null, ` ${m.score.A}-${m.score.B}, ${m.storedRounds} rounds stored`)
        );
        matchList.append(row);
      }
    }

    // ---- dataset export -----------------------------------------------------
    pad.append(node('h2', null, 'Export'));
    const exportList = node('div', 'sim-export');
    const exportStatus = node('p', 'sim-export-status', '');
    pad.append(exportList, exportStatus);

    async function refreshExport() {
      const { demos } = await simApi.exportList();
      exportList.replaceChildren();
      if (!demos.length) {
        exportList.append(node('p', 'sim-empty', 'No demos in the library on this host.'));
        return;
      }
      const mb = (b) => (b / (1024 * 1024)).toFixed(1);
      const picked = new Set();
      const total = node('p', 'sim-export-total', '');
      const updateTotal = () => {
        let bytes = 0;
        for (const d of demos) if (picked.has(d.id)) bytes += d.bytes;
        total.textContent = picked.size
          ? `${picked.size} selected, ${mb(bytes)} MB`
          : `${demos.length} demos in the library`;
      };

      for (const d of demos) {
        const row = node('label', 'sim-export-row');
        const box = input('checkbox', '');
        box.addEventListener('change', () => {
          if (box.checked) picked.add(d.id);
          else picked.delete(d.id);
          updateTotal();
        });
        row.append(
          box,
          node('code', null, d.id),
          node('span', null, ` ${d.map || '?'} ${d.teams?.join(' vs ') || ''} ` +
            `${d.rounds ?? '?'} rounds, ${mb(d.bytes)} MB`)
        );
        exportList.append(row);
      }

      const dl = node('button', 'sim-export-btn', 'Download selected');
      dl.addEventListener('click', async () => {
        dl.disabled = true;
        let n = 0;
        try {
          for (const id of picked) {
            n += 1;
            exportStatus.textContent = `Downloading ${n} of ${picked.size}.`;
            const { filename, blob } = await simApi.exportDownload(id);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
          }
          exportStatus.textContent = picked.size ? `Done, ${picked.size} files.` : 'Nothing selected.';
        } catch (err) {
          exportStatus.textContent = err.message;
        } finally {
          dl.disabled = false;
        }
      });
      exportList.append(total, dl);
      updateTotal();
    }

    root.replaceChildren(pad);
    await Promise.all([refreshMatches().catch(() => {}), refreshExport().catch(() => {})]);
  }

  async function check() {
    if (checking) return checking;
    root.replaceChildren(spinnerNode());
    checking = simApi
      .me()
      .then((me) => {
        allowed = true;
        return showShell(me);
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
    onHide() {}
  };
}
