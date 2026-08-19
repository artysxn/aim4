// ---------------------------------------------------------------------------
// src/cs3d/practiceImport.js
// Game search + round pick for the map explorer. Lists library demos on this
// map via GET /api/replays/demos, then loads the same package drop-demo uses.
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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

export function filterGames(demos, query, mapCode) {
  const q = String(query || '').trim().toLowerCase();
  const code = String(mapCode || '').toUpperCase();
  return (demos || []).filter((d) => {
    if ((d.status || 'ready') !== 'ready') return false;
    if (code && String(d.map || '').toUpperCase() !== code) return false;
    if (q && !gameSearchText(d).includes(q)) return false;
    return true;
  });
}

export function roundChoices(demo) {
  const rounds = demo?.rounds || [];
  return rounds.map((r, i) => ({
    index: i,
    label: `Round ${r.round ?? r.meta?.round ?? i + 1}`
  }));
}

/**
 * Searchable game field, then a round list, then playback buttons.
 *
 * @param {HTMLElement} root
 * @param {object} o
 * @param {string} o.mapCode
 * @param {(id: string) => Promise<object>} o.loadDemo  package → demo
 * @param {(demo: object, roundIndex: number) => void} o.onImport
 * @param {() => Promise<{demos?: object[]}>} o.fetchDemos
 */
export function bindImportRound(root, { mapCode, loadDemo, onImport, fetchDemos }) {
  if (!root || root.dataset.bound) return;
  root.dataset.bound = '1';
  root.classList.add('c3-import');
  root.innerHTML = `
    <button type="button" class="c3-import-open" data-k="open">Import round</button>
    <div class="c3-import-pick" data-k="pick" hidden>
      <input class="c3-import-search" data-k="search" type="text" placeholder="Game" autocomplete="off" spellcheck="false">
      <div class="c3-import-list" data-k="games" hidden></div>
      <select class="c3-import-round" data-k="round" hidden aria-label="Round"></select>
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
  let loaded = null;

  const paintGames = () => {
    const rows = filterGames(all, node.search.value, mapCode).slice(0, 40);
    node.games.hidden = !rows.length;
    node.games.innerHTML = rows
      .map(
        (d) =>
          `<button type="button" class="c3-import-game" data-id="${esc(d.id)}">${esc(gameLabel(d))}</button>`
      )
      .join('');
  };

  const paintRounds = () => {
    const choices = roundChoices(loaded);
    node.round.hidden = !choices.length;
    node.round.innerHTML =
      `<option value="">Round</option>` + choices.map((c) => `<option value="${c.index}">${esc(c.label)}</option>`).join('');
  };

  node.open.addEventListener('click', async () => {
    node.pick.hidden = false;
    node.search.focus();
    if (all.length) {
      paintGames();
      return;
    }
    node.games.hidden = false;
    node.games.textContent = 'Loading';
    try {
      const res = await fetchDemos({ limit: 500 });
      all = res?.demos || [];
      paintGames();
    } catch (err) {
      node.games.textContent = err.message || 'Could not list games';
    }
  });

  node.search.addEventListener('input', paintGames);
  node.search.addEventListener('keydown', (e) => e.stopPropagation());
  node.games.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    selected = all.find((d) => d.id === btn.dataset.id);
    if (!selected) return;
    node.search.value = gameLabel(selected);
    node.games.hidden = true;
    node.round.hidden = false;
    node.round.innerHTML = '<option>Loading</option>';
    try {
      loaded = await loadDemo(selected.id);
      paintRounds();
    } catch (err) {
      node.round.innerHTML = `<option>${esc(err.message || 'Failed')}</option>`;
    }
  });
  node.round.addEventListener('change', () => {
    if (!loaded || node.round.value === '') return;
    const index = Number(node.round.value);
    if (!Number.isFinite(index)) return;
    onImport?.(loaded, index);
  });

  return {
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
}
