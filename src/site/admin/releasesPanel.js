// ---------------------------------------------------------------------------
// src/site/admin/releasesPanel.js
// The aim4 desktop app's builds: publish one, see what is out, pull a bad one.
//
// The newest published build is what /api/recorder/download serves (the
// site's download buttons) and what running apps update to through
// /api/recorder/latest. A build is the .exe from `cargo build --release`, sent
// as the request body with its version in a header (server/recorder/routes.js).
// ---------------------------------------------------------------------------

import { accessToken } from '../../replays/api.js';
import { button, el, field, input } from './dom.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

async function call(method, path, { body, headers = {} } = {}) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const mb = (n) => `${(Number(n || 0) / 1024 / 1024).toFixed(1)} MB`;
const when = (t) => (t ? new Date(t).toLocaleString() : '');

export function releasesPanel() {
  const root = el('div', 'admin-releases');
  const list = el('div');
  const status = el('p', 'admin-hint');

  const file = input('file');
  file.accept = '.exe';
  const version = input('text', '', '0.3.0');
  const notes = input('text', '', 'What changed');

  async function refresh() {
    list.replaceChildren(el('p', 'admin-hint', 'Loading…'));
    try {
      const { releases } = await call('GET', '/api/recorder/releases');
      if (!releases?.length) {
        list.replaceChildren(el('p', 'admin-hint', 'Nothing published yet. The download buttons on the site stay hidden or say so until a build is here.'));
        return;
      }
      const rows = releases.map((r, i) => {
        const line = el('div', 'admin-row');
        line.append(
          el('strong', '', `v${r.version}${i === 0 ? ' (latest)' : ''}`),
          el('span', 'admin-hint', `${mb(r.sizeBytes)} · ${when(r.publishedAt)}${r.notes ? ` · ${r.notes}` : ''}`),
          button(
            'Pull',
            async () => {
              if (!window.confirm(`Pull v${r.version}? Apps on it keep running; new downloads get the next newest build.`)) return;
              try {
                await call('DELETE', `/api/recorder/releases/${encodeURIComponent(r.version)}`);
                await refresh();
              } catch (err) {
                status.textContent = err.message;
              }
            },
            'btn btn-sm'
          )
        );
        return line;
      });
      list.replaceChildren(...rows);
    } catch (err) {
      list.replaceChildren(el('p', 'admin-hint', err.message));
    }
  }

  const publish = button(
    'Publish build',
    async () => {
      const f = file.files?.[0];
      const v = version.value.trim();
      if (!f) return void (status.textContent = 'Pick the .exe first.');
      if (!/^\d+\.\d+\.\d+$/.test(v)) return void (status.textContent = 'The version looks like 1.2.3, and must match the app (recorder/Cargo.toml).');
      if (!window.confirm(`Publish v${v} (${mb(f.size)})? Every running app will offer to update to it.`)) return;
      publish.disabled = true;
      status.textContent = `Uploading ${mb(f.size)}…`;
      try {
        await call('POST', '/api/recorder/releases', {
          body: f,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Aim4-Version': v, 'X-Aim4-Notes': encodeURIComponent(notes.value.trim()).slice(0, 400) }
        });
        status.textContent = `Published v${v}.`;
        file.value = '';
        await refresh();
      } catch (err) {
        status.textContent = err.message;
      } finally {
        publish.disabled = false;
      }
    },
    'btn primary'
  );

  root.append(
    el('h3', '', 'Desktop app builds'),
    field('Build (.exe)', file),
    field('Version', version),
    field('Notes', notes),
    publish,
    status,
    el('h3', '', 'Published'),
    list
  );
  void refresh();
  return root;
}
