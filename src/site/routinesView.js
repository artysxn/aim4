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
  mechanicLabel,
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
import { activityCalendarHtml } from './activityCalendarView.js';

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
  /** Where the default selection came from, for the line under the chips. */
  let weaknessNote = 'Pick the mechanics to train.';
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

  function chipHtml(m) {
    const on = picked.has(m.key);
    return `<button type="button" class="btn btn-sm rt-chip${on ? ' primary' : ''}" data-mechanic="${m.key}" aria-pressed="${on}">${esc(m.label)}</button>`;
  }

  function previewHtml() {
    if (!preview) return '';
    const rows = preview.items
      .map(
        (it) => `<div class="rt-row">
        <span class="rt-row-title">${esc(gamemodeTitle(it.scenario))}</span>
        <span class="rt-row-tags">${(SCENARIO_META[it.scenario]?.tags || [])
          .map((t) => `<span class="training-row-tag">${esc(t)}</span>`)
          .join('')}</span>
        <span class="rt-row-time">${Math.round(it.config.duration.value)}s</span>
      </div>`
      )
      .join('');
    return `<div class="rt-preview">
      <div class="rt-preview-head">
        <strong>${esc(preview.name)}</strong>
        <span class="rt-row-time">${esc(estimateLabel(preview.estimatedSeconds))}</span>
      </div>
      ${rows}
      <div class="rt-actions">
        <button type="button" class="btn primary" id="rt-save-preview">Save routine</button>
      </div>
    </div>`;
  }

  function savedHtml() {
    const list = loadPlaylists();
    if (!list.length) {
      return '<p class="view-empty">No routines saved yet.</p>';
    }
    return list
      .map((pl) => {
        const seconds = (pl.items || []).reduce(
          (s, it) => s + (Number(it.config?.duration?.value) || 60) + SWITCH_SECONDS,
          0
        );
        const modes = (pl.items || []).map((it) => gamemodeTitle(it.scenario)).join(', ');
        return `<div class="rt-saved" data-routine="${esc(pl.id)}">
          <div class="rt-saved-main">
            <strong>${esc(pl.name)}</strong>
            <span class="rt-saved-modes">${esc(modes)}</span>
          </div>
          <span class="rt-row-time">${esc(estimateLabel(seconds))}</span>
          <a class="btn btn-sm" href="/train">Open trainer</a>
          <button type="button" class="btn btn-sm" data-rt-share="${esc(pl.id)}">Copy code</button>
          <button type="button" class="btn btn-sm" data-rt-delete="${esc(pl.id)}">Delete</button>
        </div>`;
      })
      .join('');
  }

  function draftHtml() {
    if (!draft.length) return '<p class="view-empty">No modes added yet.</p>';
    return draft
      .map(
        (it, i) => `<div class="rt-row" data-draft-index="${i}">
        <span class="rt-row-title">${esc(gamemodeTitle(it.scenario))}</span>
        <input type="number" class="rt-seconds" data-draft-seconds="${i}" min="15" max="600" step="15" value="${it.seconds}" aria-label="Seconds" />
        <button type="button" class="btn btn-sm" data-draft-up="${i}" ${i === 0 ? 'disabled' : ''}>Up</button>
        <button type="button" class="btn btn-sm" data-draft-down="${i}" ${i === draft.length - 1 ? 'disabled' : ''}>Down</button>
        <button type="button" class="btn btn-sm" data-draft-remove="${i}">Remove</button>
      </div>`
      )
      .join('');
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
          <h2>Find Recommended Routine</h2>
          <div class="rt-controls">
            <input type="number" id="rt-minutes" class="rt-minutes" min="3" max="180" step="1" value="${DEFAULT_MINUTES}" aria-label="Minutes" />
            <span class="rt-unit">minutes</span>
            <button type="button" class="btn primary" id="rt-find">Find Recommended Routine</button>
          </div>
          <div class="rt-chips" id="rt-chips">${MECHANICS.map(chipHtml).join('')}</div>
          <p class="rt-note" id="rt-note">${esc(weaknessNote)}</p>
          <div id="rt-preview-slot">${previewHtml()}</div>
        </section>

        <section class="rt-card" id="rt-coach-card" hidden>
          <h2>Coach notes</h2>
          <div id="rt-coach-notes"></div>
        </section>

        <section class="rt-card">
          <h2>Build your own</h2>
          <div class="rt-controls">
            <input type="text" id="rt-name" class="rt-name" maxlength="60" placeholder="Routine name" value="${esc(draftName)}" spellcheck="false" autocomplete="off" />
            <select id="rt-add-mode" class="rt-mode-select" aria-label="Gamemode">${modeOptions()}</select>
            <button type="button" class="btn" id="rt-add">Add mode</button>
          </div>
          <div id="rt-draft">${draftHtml()}</div>
          <div class="rt-actions">
            <button type="button" class="btn primary" id="rt-save-draft">Save routine</button>
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
    weaknessNote = text;
    const el = host.querySelector('#rt-note');
    if (el) el.textContent = text;
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
      const cal = buildCalendar({ days, window: 90 });
      slot.innerHTML = activityCalendarHtml(cal, escapeHtml, {
        title: 'Your training',
        subtitle: 'Last 90 days'
      });
      card.hidden = false;
    } catch {
      /* the page is a routine builder first; the calendar is a bonus */
    }
  }

  // ---- behaviour ------------------------------------------------------------

  function bind() {
    host.querySelector('#rt-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-mechanic]');
      if (!chip) return;
      const key = chip.dataset.mechanic;
      if (picked.has(key)) picked.delete(key);
      else picked.add(key);
      chip.classList.toggle('primary', picked.has(key));
      chip.setAttribute('aria-pressed', String(picked.has(key)));
      repaintCoachNotes();
    });

    host.querySelector('#rt-find')?.addEventListener('click', () => {
      const minutes = Number(host.querySelector('#rt-minutes')?.value) || DEFAULT_MINUTES;
      const routine = recommendRoutine({ minutes, mechanics: [...picked] });
      if (!routine) {
        note('Pick at least one mechanic first.');
        preview = null;
      } else {
        preview = routine;
        note(
          `${routine.items.length} modes, about ${estimateLabel(routine.estimatedSeconds)}.`
        );
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
          share.textContent = 'Copied';
          setTimeout(() => {
            share.textContent = 'Copy code';
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
          note(`Your ${weakest.length} weakest, from your trainer runs: ${weakest
            .map(mechanicLabel)
            .join(', ')}.`);
          const chips = host.querySelector('#rt-chips');
          if (chips) chips.innerHTML = MECHANICS.map(chipHtml).join('');
          repaintCoachNotes();
        } else if (auth?.user?.id) {
          note('No rated trainer runs yet. Pick the mechanics to train.');
        } else {
          note('Sign in to score your weaknesses, or pick the mechanics to train.');
        }
      }
    },
    onHide() {}
  };
}
