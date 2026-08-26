// ---------------------------------------------------------------------------
// src/site/admin/uploadsPanel.js
// Every demo in the shared library, every uploader.
// Filter: demos missing a Valve standings (VRS) team name on either side.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, bytes, date, el, input, notice, row } from './dom.js';
import { spinnerNode } from '../../lib/spinner.js';

export function uploadsPanel() {
  const root = el('div', 'admin-uploads');
  let unnamedOnly = false;
  let busy = false;
  /** Last rescan progress/result line; survives the repaint `load()` does. */
  let rescanNote = '';
  /**
   * A notice to raise once the panel has repainted.
   *
   * Saving reloads the list, and the reload replaces every child of `root` —
   * including the notice that was just posted. Anything the admin has to READ
   * (how far a rename reached, most of all) has to outlive that.
   * @type {{ text: string, kind: string }|null}
   */
  let pendingNotice = null;

  /** Repaint, then say whatever the last action left to say. */
  function commit(wrap) {
    root.replaceChildren(wrap);
    if (!pendingNotice) return;
    const { text, kind } = pendingNotice;
    pendingNotice = null;
    notice(root, text, kind);
  }

  root.appendChild(spinnerNode());

  async function load() {
    try {
      const data = await adminApi.uploads({ unnamed: unnamedOnly, limit: 500 });
      paint(data);
    } catch (err) {
      root.replaceChildren(el('p', 'admin-error', err.message));
    }
  }

  /** A name field with the five players it is naming listed under it. */
  function renameSide(label, name, players) {
    const wrap = el('div', 'admin-rename-side');
    const field = input('text', name || '', label);
    field.className = 'ingest-field';
    field.setAttribute('aria-label', label);
    wrap.appendChild(field);
    if (players?.length) {
      const roster = el('div', 'admin-rename-roster');
      roster.setAttribute('aria-label', `${label} players`);
      for (const p of players) roster.appendChild(el('span', 'admin-rename-player', p));
      wrap.appendChild(roster);
    }
    return { wrap, field };
  }

  function openRename(item) {
    const overlay = el('div', 'admin-rename-overlay');
    const card = el('div', 'admin-rename-card');
    card.appendChild(el('h3', null, 'Rename teams'));
    card.appendChild(
      el('div', 'ingest-tools-meta', `${item.team1 || 'Team 1'} vs ${item.team2 || 'Team 2'}`)
    );
    // The roster is the identity; the name is a label on top of it. Seeing who
    // is on each side is what makes a parser-invented name recognisable, and
    // it is the same core the save below carries to the rest of the library.
    const side1 = renameSide('Team 1', item.team1, item.team1Players);
    const side2 = renameSide('Team 2', item.team2, item.team2Players);
    const t1 = side1.field;
    const t2 = side2.field;
    card.append(side1.wrap, side2.wrap);
    const save = button('Save', async () => {
      save.disabled = true;
      try {
        const res = await adminApi.renameUploadTeams(item.id, t1.value.trim(), t2.value.trim());
        overlay.remove();
        // Say how far the rename reached. Renaming one demo and silently
        // rewriting nine others is the kind of thing an admin has to be told.
        const extra = Number(res?.alsoRenamed) || 0;
        pendingNotice = res?.capped
          ? {
              text: 'Too many demos shared that roster, so only this one was renamed.',
              kind: 'error'
            }
          : {
              text: extra
                ? `Teams saved. ${extra} more ${extra === 1 ? 'demo' : 'demos'} with the same roster renamed.`
                : 'Teams saved.',
              kind: 'info'
            };
        load();
      } catch (err) {
        notice(root, err.message, 'error');
        save.disabled = false;
      }
    }, 'btn btn-primary btn-sm');
    const cancel = button('Cancel', () => overlay.remove(), 'btn btn-sm');
    card.appendChild(row(save, cancel));
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    t1.focus();
    t1.select();
  }

  /** Poll the rescan until it settles. The note outlives the repaint. */
  function watchRescan(meta, refresh) {
    const say = (text) => {
      rescanNote = text;
      meta.textContent = text;
    };
    const tick = async () => {
      let st;
      try {
        st = await adminApi.teamsRescanStatus();
      } catch {
        return;
      }
      if (st.running) {
        const phase = st.phase === 'analyze' ? 'analysing rosters' : 'renaming demos';
        say(`Re-scanning team names: ${phase}${st.total ? ` ${st.done}/${st.total}` : ''}`);
        window.setTimeout(tick, 1200);
        return;
      }
      if (st.error) {
        say(`Re-scan failed: ${st.error}`);
        return;
      }
      if (st.summary) {
        say(
          `Re-scan done: ${st.summary.renamedDemos} demos renamed, ` +
            `${st.summary.teams} teams identified`
        );
        refresh();
      }
    };
    tick();
  }

  function paint(data) {
    const wrap = el('div');
    const head = el('div', 'ingest-hero-top');
    head.appendChild(el('h3', 'ingest-title', 'Uploads'));
    // Library-wide identity pass: rosters link renamed teams, filenames name
    // the unnamed ones. Runs in the background; this button reads back its
    // position until it settles, then reloads the list with the new names.
    const rescanBtn = el('button', 'ingest-seg-btn', 'Re-scan team names');
    rescanBtn.type = 'button';
    rescanBtn.title =
      'Rebuild team identity for every demo: link lineups across name changes and name unnamed teams from demo filenames';
    head.appendChild(rescanBtn);
    wrap.appendChild(head);
    const rescanMeta = el('div', 'ingest-tools-meta', rescanNote);
    wrap.appendChild(rescanMeta);
    rescanBtn.addEventListener('click', async () => {
      if (rescanBtn.disabled) return;
      rescanBtn.disabled = true;
      try {
        await adminApi.teamsRescanStart();
      } catch (err) {
        rescanMeta.textContent = err.message;
        rescanBtn.disabled = false;
        return;
      }
      watchRescan(rescanMeta, () => {
        rescanBtn.disabled = false;
        load();
      });
    });

    const filterSeg = el('div', 'ingest-seg');
    filterSeg.setAttribute('role', 'group');
    filterSeg.setAttribute('aria-label', 'Upload filter');
    const allBtn = el('button', `ingest-seg-btn${!unnamedOnly ? ' is-on' : ''}`, 'All');
    allBtn.type = 'button';
    const unnamedBtn = el(
      'button',
      `ingest-seg-btn${unnamedOnly ? ' is-on' : ''}`,
      'Non-VRS'
    );
    unnamedBtn.type = 'button';
    unnamedBtn.title = 'Demos missing a Valve standings team name on either side';
    allBtn.addEventListener('click', () => {
      if (!unnamedOnly) return;
      unnamedOnly = false;
      root.replaceChildren(spinnerNode());
      load();
    });
    unnamedBtn.addEventListener('click', () => {
      if (unnamedOnly) return;
      unnamedOnly = true;
      root.replaceChildren(spinnerNode());
      load();
    });
    filterSeg.append(allBtn, unnamedBtn);
    wrap.appendChild(filterSeg);

    wrap.appendChild(
      el(
        'div',
        'ingest-tools-meta',
        unnamedOnly
          ? `${data.matched || 0} without full VRS names` +
              (data.items?.length < data.matched ? ` · showing ${data.items.length}` : '')
          : `${data.total || 0} in library` +
              (data.items?.length < data.total ? ` · showing ${data.items.length}` : '')
      )
    );

    if (!data.items?.length) {
      wrap.appendChild(el('div', 'ingest-tools-meta', 'Empty'));
      commit(wrap);
      return;
    }

    const table = el('table', 'admin-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['When', 'Uploader', 'Match', 'Map', 'Source', 'Vis', 'Size', '']) {
      hr.appendChild(el('th', null, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const item of data.items) {
      const tr = el('tr');
      tr.appendChild(el('td', null, item.uploadedAt ? date(item.uploadedAt) : ''));
      tr.appendChild(el('td', null, item.uploaderName ? `@${item.uploaderName}` : ''));
      const match = [item.team1, item.team2].filter(Boolean).join(' vs ') || item.id;
      const tdMatch = el('td');
      tdMatch.appendChild(el('div', null, match));
      tdMatch.appendChild(el('div', 'ingest-dim', item.id));
      if (unnamedOnly && (item.vrsTeam1 || item.vrsTeam2)) {
        tdMatch.appendChild(
          el(
            'div',
            'ingest-dim',
            `VRS: ${item.vrsTeam1 || '—'} vs ${item.vrsTeam2 || '—'}`
          )
        );
      }
      tr.appendChild(tdMatch);
      tr.appendChild(el('td', null, item.map || ''));
      tr.appendChild(el('td', null, item.source || ''));
      tr.appendChild(el('td', null, item.visibility || ''));
      tr.appendChild(el('td', null, bytes(item.sizeBytes || 0)));
      const tdAct = el('td');
      const aa = button('Aa', () => openRename(item), 'btn btn-sm');
      aa.title = 'Rename teams';
      aa.disabled = busy;
      tdAct.appendChild(aa);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    commit(wrap);
  }

  load();
  return root;
}
