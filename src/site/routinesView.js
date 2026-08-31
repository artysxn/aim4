// ---------------------------------------------------------------------------
// site/routinesView.js
// Routines: build a training playlist from what you are worst at.
//
// Two ways in. "Find Recommended Routine" takes how long you have and which
// mechanics you want to train (defaulted to your five weakest, measured from
// your own trainer runs) and picks the modes whose tags cover them - the
// mapping lives in lib/routines.js. The manual builder underneath is the
// trainer's playlist editor brought to the site: pick modes, give each a
// duration, order them, save.
//
// Saved routines land in the SAME localStorage store the trainer's Playlists
// menu reads (lib/playlists.js, one origin, one key), so a routine built here
// is already in the trainer the next time it opens. Running one happens in the
// trainer - this page builds and manages, the game plays.
// ---------------------------------------------------------------------------

import {
  MECHANICS,
  TRAINER_TO_MECHANIC,
  estimateLabel,
  recommendRoutine,
  weakestMechanics,
  SWITCH_SECONDS
} from '../lib/routines.js';
import {
  createPlaylist,
  deletePlaylist,
  encodePlaylist,
  loadPlaylists,
  savePlaylist
} from '../lib/playlists.js';
import {
  GAMEMODE_IDS,
  SCENARIO_META,
  gamemodeTitle,
  isChallengeMode,
  sortModesByTitle
} from '../lib/gamemodeCatalog.js';
import {
  RATED_GAMEMODES,
  averageRatingsAcrossModes,
  baselinesForGamemode,
  composeRatingFromBestRuns,
  loadBaselines,
  syncBaselinesFromServer
} from '../lib/aim4Ratings.js';
import { fetchAimRuns } from '../lib/aimStats.js';
import { coachNoteFor } from '../lib/coachNotes.js';
import { buildCalendar } from '../lib/activityCalendar.js';
import { fetchActivity } from '../lib/activityFeed.js';
import { activityPairHtml } from './activityCalendarView.js';
import { SCENARIO_ICONS } from '../aim4/icons.js';

/* Row action glyphs. Inline so they inherit currentColor. */
const I_ADD = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';
const I_UP = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 8.6 18 14.6 16.6 16 12 11.4 7.4 16 6 14.6z"/></svg>';
const I_DOWN = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 15.4 6 9.4 7.4 8 12 12.6 16.6 8 18 9.4z"/></svg>';
const I_CLOSE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>';
const I_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 4h11a1 1 0 0 1 1 1v11h-2V6H8zM5 8h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1m1 2v8h8v-8z"/></svg>';
const I_CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="m9.6 16.2-4-4L4.2 13.6l5.4 5.4L20 8.6 18.6 7.2z"/></svg>';
const I_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7zm4 3v7h1.5v-7zm3 0v7h1.5v-7z"/></svg>';
const I_PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5.5 19 12 8 18.5z"/></svg>';

/** Mode glyph, in a fixed slot so titles line up whether or not one exists. */
function modeIconHtml(key) {
  const icon = SCENARIO_ICONS[key];
  return `<span class="rt-row-icon">${icon ? `<img src="${icon}" alt="" width="18" height="18" />` : ''}</span>`;
}

const DEFAULT_MINUTES = 20;
const DEFAULT_WEAK_COUNT = 5;


export function initRoutinesView({ auth, escapeHtml }) {
  const host = document.querySelector('.view[data-view="routines"] .view-pad');
  if (!host) return { onShow() {}, onHide() {} };

  /** Mechanic keys currently picked in the creator. */
  let picked = new Set();
  /** The last generated routine, awaiting a save. */
  let preview = null;
  /** Draft items in the manual builder: [{ scenario, seconds }]. */
  let draft = [];
  let draftName = '';
  /** One quiet status line: where the preselect came from, or what just happened. */
  let weaknessNote = '';
  let painted = false;

  // ---- weakness detection ---------------------------------------------------

  /**
   * The player's weakest mechanics, from their own trainer runs.
   *
   * Trainer telemetry scores the seven motion mechanics (0 to 2, per mode);
   * averaging across rated modes and taking the lowest is exactly how the
   * trainer's own radar reads. The six demo-side mechanics (placement,
   * readiness, first bullet...) have no trainer measurement, so they are never
   * auto-picked - they are there to pick by hand for anyone who read their
   * demo aim panel.
   */
  async function detectWeaknesses() {
    const userId = auth?.user?.id;
    if (!userId) return null;
    try {
      await syncBaselinesFromServer();
      const config = loadBaselines();
      const perMode = [];
      for (const mode of RATED_GAMEMODES) {
        const runs = await fetchAimRuns({ userId, scenario: mode });
        if (!runs.length) continue;
        const rating = composeRatingFromBestRuns(
          runs,
          { baselines: baselinesForGamemode(mode, config) },
          3
        );
        if (rating) perMode.push({ mode, rating });
      }
      if (!perMode.length) return null;
      const averaged = averageRatingsAcrossModes(perMode);
      const scores = {};
      for (const [trainerKey, mechanic] of Object.entries(TRAINER_TO_MECHANIC)) {
        if (Number.isFinite(averaged[trainerKey])) scores[mechanic] = averaged[trainerKey];
      }
      const weakest = weakestMechanics(scores, DEFAULT_WEAK_COUNT);
      return weakest.length ? weakest : null;
    } catch {
      return null;
    }
  }

  // ---- rendering ------------------------------------------------------------

  const esc = escapeHtml;

  function mechHtml(m) {
    const on = picked.has(m.key);
    return `<button type="button" class="rt-mech${on ? ' on' : ''}" data-mechanic="${m.key}" aria-pressed="${on}">${esc(m.label)}</button>`;
  }

  function previewHtml() {
    if (!preview) return '';
    const rows = preview.items
      .map(
        (it) => `<div class="rt-row">
        <div class="rt-row-main">
          ${modeIconHtml(it.scenario)}
          <span class="rt-row-title">${esc(gamemodeTitle(it.scenario))}</span>
        </div>
        <span class="rt-cell rt-cell-time">${Math.round(it.config.duration.value)}s</span>
      </div>`
      )
      .join('');
    return `<div class="rt-preview">
      <div class="rt-preview-head">
        <strong>${esc(preview.name)}</strong>
        <span class="rt-time-note">${esc(estimateLabel(preview.estimatedSeconds))}</span>
      </div>
      <div class="rt-rows">${rows}</div>
      <div class="rt-actions">
        <button type="button" class="btn primary btn-sm" id="rt-save-preview">Save routine</button>
      </div>
    </div>`;
  }

  function savedHtml() {
    const list = loadPlaylists();
    if (!list.length) {
      return '<p class="view-empty">No routines saved yet.</p>';
    }
    return `<div class="rt-rows">${list
      .map((pl) => {
        const seconds = (pl.items || []).reduce(
          (s, it) => s + (Number(it.config?.duration?.value) || 60) + SWITCH_SECONDS,
          0
        );
        const modes = (pl.items || []).map((it) => gamemodeTitle(it.scenario)).join(', ');
        return `<div class="rt-row rt-saved" data-routine="${esc(pl.id)}">
          <div class="rt-row-main">
            <div class="rt-saved-text">
              <strong>${esc(pl.name)}</strong>
              <span class="rt-saved-modes">${esc(modes)}</span>
            </div>
          </div>
          <span class="rt-cell rt-cell-time">${esc(estimateLabel(seconds))}</span>
          <a class="rt-cell rt-cell-icon" href="/train" title="Open in the trainer" aria-label="Open ${esc(pl.name)} in the trainer">${I_PLAY}</a>
          <button type="button" class="rt-cell rt-cell-icon" data-rt-share="${esc(pl.id)}" title="Copy code" aria-label="Copy ${esc(pl.name)} code">${I_COPY}</button>
          <button type="button" class="rt-cell rt-cell-icon" data-rt-delete="${esc(pl.id)}" title="Delete" aria-label="Delete ${esc(pl.name)}">${I_TRASH}</button>
        </div>`;
      })
      .join('')}</div>`;
  }

  function draftHtml() {
    if (!draft.length) return '<p class="view-empty">No modes added yet.</p>';
    return `<div class="rt-rows">${draft
      .map(
        (it, i) => `<div class="rt-row" data-draft-index="${i}">
        <div class="rt-row-main">
          ${modeIconHtml(it.scenario)}
          <span class="rt-row-title">${esc(gamemodeTitle(it.scenario))}</span>
        </div>
        <span class="rt-cell rt-cell-seconds"><input type="number" class="rt-seconds" data-draft-seconds="${i}" min="15" max="600" step="15" value="${it.seconds}" aria-label="Seconds" /><span class="rt-unit">s</span></span>
        <button type="button" class="rt-cell rt-cell-icon" data-draft-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up">${I_UP}</button>
        <button type="button" class="rt-cell rt-cell-icon" data-draft-down="${i}" ${i === draft.length - 1 ? 'disabled' : ''} title="Move down" aria-label="Move down">${I_DOWN}</button>
        <button type="button" class="rt-cell rt-cell-icon" data-draft-remove="${i}" title="Remove" aria-label="Remove">${I_CLOSE}</button>
      </div>`
      )
      .join('')}</div>`;
  }

  function modeOptions() {
    return sortModesByTitle(GAMEMODE_IDS.filter((m) => !isChallengeMode(m)))
      .map((m) => `<option value="${m}">${esc(gamemodeTitle(m))}</option>`)
      .join('');
  }

  function render() {
    host.innerHTML = `
      <div class="rt-page">
        <section class="rt-card" id="rt-activity-card" hidden>
          <div id="rt-activity"></div>
        </section>

        <section class="rt-card">
          <div class="rt-head">
            <h2>Recommended routine</h2>
            <div class="rt-head-controls">
              <span class="rt-field rt-field-minutes"><input type="number" id="rt-minutes" class="rt-minutes" min="3" max="180" step="1" value="${DEFAULT_MINUTES}" aria-label="Minutes" /><span class="rt-unit">min</span></span>
              <button type="button" class="btn primary btn-sm rt-btn" id="rt-find">Find routine</button>
            </div>
          </div>
          <div class="rt-mechs" id="rt-mechs">${MECHANICS.map(mechHtml).join('')}</div>
          <p class="rt-note" id="rt-note"${weaknessNote ? '' : ' hidden'}>${esc(weaknessNote)}</p>
          <div id="rt-preview-slot">${previewHtml()}</div>
        </section>

        <section class="rt-card" id="rt-coach-card" hidden>
          <h2>Coach notes</h2>
          <div id="rt-coach-notes"></div>
        </section>

        <section class="rt-card">
          <div class="rt-head">
            <h2>Build your own</h2>
          </div>
          <div class="rt-controls">
            <input type="text" id="rt-name" class="rt-name" maxlength="60" placeholder="Routine name" value="${esc(draftName)}" spellcheck="false" autocomplete="off" />
            <select id="rt-add-mode" class="rt-mode-select" aria-label="Gamemode">${modeOptions()}</select>
            <button type="button" class="rt-icon-btn" id="rt-add" title="Add mode" aria-label="Add mode">${I_ADD}</button>
          </div>
          <div id="rt-draft">${draftHtml()}</div>
          <div class="rt-actions">
            <button type="button" class="btn primary btn-sm rt-btn" id="rt-save-draft">Save routine</button>
          </div>
        </section>

        <section class="rt-card">
          <h2>Your routines</h2>
          <div id="rt-saved">${savedHtml()}</div>
        </section>
      </div>`;
    bind();
  }

  function repaintDraft() {
    const slot = host.querySelector('#rt-draft');
    if (slot) slot.innerHTML = draftHtml();
  }

  function repaintSaved() {
    const slot = host.querySelector('#rt-saved');
    if (slot) slot.innerHTML = savedHtml();
  }

  function repaintPreview() {
    const slot = host.querySelector('#rt-preview-slot');
    if (slot) slot.innerHTML = previewHtml();
  }

  function note(text) {
    weaknessNote = text || '';
    const el = host.querySelector('#rt-note');
    if (!el) return;
    el.textContent = weaknessNote;
    el.hidden = !weaknessNote;
  }

  /**
   * The full coach note for every picked mechanic, one collapsible each.
   * The first is open: the card should read as advice on arrival, not as a
   * wall of closed drawers.
   */
  function repaintCoachNotes() {
    const card = host.querySelector('#rt-coach-card');
    const slot = host.querySelector('#rt-coach-notes');
    if (!card || !slot) return;
    const notes = [...picked].map(coachNoteFor).filter(Boolean);
    card.hidden = !notes.length;
    slot.innerHTML = notes
      .map(
        (n, i) => `<details class="rt-coach"${i === 0 ? ' open' : ''}>
        <summary>${esc(n.title)}</summary>
        ${n.full.map((par) => `<p>${esc(par)}</p>`).join('')}
      </details>`
      )
      .join('');
  }

  /**
   * The activity calendar at the top of the page.
   *
   * Here it answers a different question than on Performance: not "how good is
   * this player" but "have I actually been showing up". A routine is a
   * commitment, and the calendar is the honest record of whether it was kept.
   */
  async function paintActivity() {
    const card = host.querySelector('#rt-activity-card');
    const slot = host.querySelector('#rt-activity');
    if (!card || !slot) return;
    const userId = auth?.user?.id || null;
    if (!userId) return;
    try {
      const days = await fetchActivity({ userId, days: 90 });
      if (!days.size) return;
      slot.innerHTML = activityPairHtml(
        days,
        (args) => buildCalendar({ window: 90, ...args }),
        escapeHtml,
        { heading: 'Your activity' }
      );
      card.hidden = false;
    } catch {
      /* the page is a routine builder first; the calendar is a bonus */
    }
  }

  // ---- behaviour ------------------------------------------------------------

  function bind() {
    host.querySelector('#rt-mechs')?.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-mechanic]');
      if (!cell) return;
      const key = cell.dataset.mechanic;
      if (picked.has(key)) picked.delete(key);
      else picked.add(key);
      cell.classList.toggle('on', picked.has(key));
      cell.setAttribute('aria-pressed', String(picked.has(key)));
      repaintCoachNotes();
    });

    host.querySelector('#rt-find')?.addEventListener('click', () => {
      const minutes = Number(host.querySelector('#rt-minutes')?.value) || DEFAULT_MINUTES;
      const routine = recommendRoutine({ minutes, mechanics: [...picked] });
      if (!routine) {
        note('Pick at least one mechanic first.');
        preview = null;
      } else {
        // The preview says everything the note would; one copy is enough.
        preview = routine;
        note('');
      }
      repaintPreview();
    });

    host.querySelector('#rt-preview-slot')?.addEventListener('click', (e) => {
      if (!e.target.closest('#rt-save-preview') || !preview) return;
      const pl = createPlaylist(preview.name, preview.items);
      pl.routine = true;
      pl.mechanics = preview.mechanics;
      savePlaylist(pl);
      preview = null;
      repaintPreview();
      repaintSaved();
      note('Saved. It is in the trainer under Playlists.');
    });

    host.querySelector('#rt-add')?.addEventListener('click', () => {
      const mode = host.querySelector('#rt-add-mode')?.value;
      if (!mode || !SCENARIO_META[mode]) return;
      draft.push({ scenario: mode, seconds: 60 });
      repaintDraft();
    });

    host.querySelector('#rt-name')?.addEventListener('input', (e) => {
      draftName = e.target.value;
    });

    host.querySelector('#rt-draft')?.addEventListener('click', (e) => {
      const up = e.target.closest('[data-draft-up]');
      const down = e.target.closest('[data-draft-down]');
      const remove = e.target.closest('[data-draft-remove]');
      if (up) {
        const i = Number(up.dataset.draftUp);
        [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]];
        repaintDraft();
      } else if (down) {
        const i = Number(down.dataset.draftDown);
        [draft[i], draft[i + 1]] = [draft[i + 1], draft[i]];
        repaintDraft();
      } else if (remove) {
        draft.splice(Number(remove.dataset.draftRemove), 1);
        repaintDraft();
      }
    });

    host.querySelector('#rt-draft')?.addEventListener('change', (e) => {
      const field = e.target.closest('[data-draft-seconds]');
      if (!field) return;
      const i = Number(field.dataset.draftSeconds);
      const v = Math.max(15, Math.min(600, Math.round(Number(field.value) / 15) * 15 || 60));
      draft[i].seconds = v;
      field.value = v;
    });

    host.querySelector('#rt-save-draft')?.addEventListener('click', () => {
      if (!draft.length) return;
      const items = draft.map((it) => ({
        scenario: it.scenario,
        config: { duration: { type: 'time', value: it.seconds } }
      }));
      const pl = createPlaylist(draftName || 'My routine', items);
      pl.routine = true;
      savePlaylist(pl);
      draft = [];
      draftName = '';
      const nameField = host.querySelector('#rt-name');
      if (nameField) nameField.value = '';
      repaintDraft();
      repaintSaved();
    });

    host.querySelector('#rt-saved')?.addEventListener('click', async (e) => {
      const share = e.target.closest('[data-rt-share]');
      const del = e.target.closest('[data-rt-delete]');
      if (share) {
        const pl = loadPlaylists().find((p) => p.id === share.dataset.rtShare);
        if (!pl) return;
        try {
          await navigator.clipboard.writeText(encodePlaylist(pl));
          share.innerHTML = I_CHECK;
          share.title = 'Copied';
          setTimeout(() => {
            share.innerHTML = I_COPY;
            share.title = 'Copy code';
          }, 1500);
        } catch {
          /* clipboard blocked: the trainer can still see the routine */
        }
      } else if (del) {
        deletePlaylist(del.dataset.rtDelete);
        repaintSaved();
      }
    });
  }

  return {
    async onShow() {
      if (!painted) {
        painted = true;
        render();
      } else {
        repaintSaved();
      }
      paintActivity();
      // Preselect the five weakest once per visit, without blocking the paint.
      if (!picked.size) {
        const weakest = await detectWeaknesses();
        if (weakest) {
          picked = new Set(weakest);
          note(`Preselected: your ${weakest.length} weakest, from your trainer runs.`);
          const cells = host.querySelector('#rt-mechs');
          if (cells) cells.innerHTML = MECHANICS.map(mechHtml).join('');
          repaintCoachNotes();
        } else if (!auth?.user?.id) {
          note('Sign in to preselect your weakest.');
        }
      }
    },
    onHide() {}
  };
}
