// ---------------------------------------------------------------------------
// src/cs3d/practiceImport.js
// Game search + round pick for the map explorer. Lists library demos on this
// map via GET /api/replays/demos. Round numbers come from the listing. Ticks
// load one round at a time from the library, not the whole-match package.
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Shared so the pause panel and the HUD overlay do not each hit the library. */
const listCache = { key: '', demos: [], promise: null };

export function gameLabel(d) {
  const a = typeof d.team1 === 'object' ? d.team1?.name : d.team1;
  const b = typeof d.team2 === 'object' ? d.team2?.name : d.team2;
  const left = String(a || '').trim() || 'Team 1';
  const right = String(b || '').trim() || 'Team 2';
  return `${left} vs ${right}`;
}

export function gameSearchText(d) {
  return [gameLabel(d), d.filename, d.name, d.map, d.mapName].filter(Boolean).join(' ').toLowerCase();
}

export function demoHasRounds(d) {
  if (Array.isArray(d?.rounds) && d.rounds.length) return true;
  return Number(d?.roundCount) > 0;
}

export function filterGames(demos, query, mapCode) {
  const q = String(query || '').trim().toLowerCase();
  const code = String(mapCode || '').toUpperCase();
  return (demos || []).filter((d) => {
    if ((d.status || 'ready') !== 'ready') return false;
    if (!demoHasRounds(d)) return false;
    if (code && String(d.map || '').toUpperCase() !== code) return false;
    if (q && !gameSearchText(d).includes(q)) return false;
    return true;
  });
}

export function roundChoices(demo) {
  const rounds = demo?.rounds || [];
  if (rounds.length) {
    return rounds.map((r, i) => ({
      index: i,
      label: `Round ${r.round ?? r.meta?.round ?? i + 1}`
    }));
  }
  const n = Number(demo?.roundCount) || 0;
  return Array.from({ length: n }, (_, i) => ({ index: i, label: `Round ${i + 1}` }));
}

function loadGameList(mapCode, fetchDemos) {
  const key = String(mapCode || '').toUpperCase();
  if (listCache.key === key && listCache.demos.length) return Promise.resolve(listCache.demos);
  if (listCache.key === key && listCache.promise) return listCache.promise;
  listCache.key = key;
  listCache.promise = Promise.resolve()
    .then(() => fetchDemos({ limit: 500, map: mapCode }))
    .then((res) => {
      listCache.demos = res?.demos || [];
      return listCache.demos;
    })
    .catch((err) => {
      listCache.promise = null;
      throw err;
    });
  return listCache.promise;
}

/**
 * Searchable game field, then a round list, then playback buttons.
 *
 * `data-embed="1"` on `root` skips the open button: the host (pause Import
 * panel) calls `show()` when that window opens.
 *
 * @param {HTMLElement} root
 * @param {object} o
 * @param {string} o.mapCode
 * @param {(record: object, roundIndex: number) => Promise<object>} o.loadRound
 * @param {(demo: object) => void} o.onImport
 * @param {() => Promise<{demos?: object[]}>} o.fetchDemos
 */
export function bindImportRound(root, { mapCode, loadRound, onImport, fetchDemos }) {
  if (!root) return;
  if (root.dataset.bound) return root._aim4Import;
  root.dataset.bound = '1';
  root.classList.add('c3-import');
  const embed = root.dataset.embed === '1';
  root.innerHTML = `
    ${embed ? '' : '<button type="button" class="c3-import-open" data-k="open">Import round</button>'}
    <div class="c3-import-pick" data-k="pick" ${embed ? '' : 'hidden'}>
      <input class="c3-import-search" data-k="search" type="text" placeholder="Game" autocomplete="off" spellcheck="false">
      <div class="c3-import-list" data-k="games" hidden></div>
      <select class="c3-import-round" data-k="round" hidden aria-label="Round"></select>
      <p class="c3-import-status" data-k="status" hidden></p>
    </div>
    <div class="c3-import-play" data-k="play" hidden>
      <button type="button" data-act="pause">Pause</button>
      <button type="button" data-act="restart">Restart</button>
      <button type="button" data-act="exit">Exit</button>
    </div>
  `;
  const node = {};
  root.querySelectorAll('[data-k]').forEach((n) => (node[n.dataset.k] = n));
  let all = [];
  let selected = null;
  let pickGen = 0;

  const setStatus = (msg) => {
    node.status.hidden = !msg;
    node.status.textContent = msg || '';
  };

  const paintGames = () => {
    const rows = filterGames(all, node.search.value, mapCode).slice(0, 40);
    node.games.hidden = false;
    if (!rows.length) {
      node.games.innerHTML = '<p class="c3-import-empty">No games on this map.</p>';
      return;
    }
    node.games.innerHTML = rows
      .map((d) => {
        const on = selected && d.id === selected.id ? ' is-on' : '';
        return `<button type="button" class="c3-import-game${on}" data-id="${esc(d.id)}">${esc(gameLabel(d))}</button>`;
      })
      .join('');
  };

  const paintRounds = (demo) => {
    const choices = roundChoices(demo);
    node.round.hidden = !choices.length;
    node.round.innerHTML =
      `<option value="">Round</option>` +
      choices.map((c) => `<option value="${c.index}">${esc(c.label)}</option>`).join('');
    if (!choices.length) setStatus('No rounds stored for this game.');
  };

  const showPicker = async () => {
    node.pick.hidden = false;
    node.search.focus();
    if (all.length) {
      paintGames();
      return;
    }
    node.games.hidden = false;
    node.games.innerHTML = '<p class="c3-import-empty">Loading</p>';
    setStatus('');
    try {
      all = await loadGameList(mapCode, fetchDemos);
      paintGames();
    } catch (err) {
      node.games.innerHTML = '';
      node.games.hidden = true;
      setStatus(err.message || 'Could not list games.');
    }
  };

  node.open?.addEventListener('click', () => {
    void showPicker();
  });

  node.search.addEventListener('input', paintGames);
  node.search.addEventListener('keydown', (e) => e.stopPropagation());
  node.games.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    selected = all.find((d) => d.id === btn.dataset.id);
    if (!selected) return;
    pickGen += 1;
    node.search.value = gameLabel(selected);
    paintGames();
    paintRounds(selected);
    setStatus('');
  });
  node.round.addEventListener('change', async () => {
    if (!selected || node.round.value === '') return;
    const index = Number(node.round.value);
    if (!Number.isFinite(index)) return;
    const gen = ++pickGen;
    setStatus('Loading round');
    node.round.disabled = true;
    try {
      const demo = await loadRound(selected, index);
      if (gen !== pickGen) return;
      setStatus('');
      onImport?.(demo);
    } catch (err) {
      if (gen !== pickGen) return;
      setStatus(err.message || 'This game has no 3D replay data.');
    } finally {
      if (gen === pickGen) node.round.disabled = false;
    }
  });

  const api = {
    show: showPicker,
    setPlayback(on, playing) {
      node.play.hidden = !on;
      const pause = node.play.querySelector('[data-act="pause"]');
      if (pause) pause.textContent = playing ? 'Pause' : 'Play';
    },
    onAction(fn) {
      node.play.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act) fn(act);
      });
    }
  };
  root._aim4Import = api;
  return api;
}
