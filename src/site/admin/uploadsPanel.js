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

  root.appendChild(spinnerNode());

  async function load() {
    try {
      const data = await adminApi.uploads({ unnamed: unnamedOnly, limit: 500 });
      paint(data);
    } catch (err) {
      root.replaceChildren(el('p', 'admin-error', err.message));
    }
  }

  function openRename(item) {
    const overlay = el('div', 'admin-rename-overlay');
    const card = el('div', 'admin-rename-card');
    card.appendChild(el('h3', null, 'Rename teams'));
    card.appendChild(
      el('div', 'ingest-tools-meta', `${item.team1 || 'Team 1'} vs ${item.team2 || 'Team 2'}`)
    );
    const t1 = input('text', item.team1 || '', 'Team 1');
    t1.className = 'ingest-field';
    t1.setAttribute('aria-label', 'Team 1');
    const t2 = input('text', item.team2 || '', 'Team 2');
    t2.className = 'ingest-field';
    t2.setAttribute('aria-label', 'Team 2');
    card.append(t1, t2);
    const save = button('Save', async () => {
      save.disabled = true;
      try {
        await adminApi.renameUploadTeams(item.id, t1.value.trim(), t2.value.trim());
        overlay.remove();
        notice(root, 'Teams saved.');
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

  function paint(data) {
    const wrap = el('div');
    const head = el('div', 'ingest-hero-top');
    head.appendChild(el('h3', 'ingest-title', 'Uploads'));
    wrap.appendChild(head);

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
      root.replaceChildren(wrap);
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
    root.replaceChildren(wrap);
  }

  load();
  return root;
}
