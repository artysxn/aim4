// ---------------------------------------------------------------------------
// replays/eye/eyePanel.js
// Pattern Finder > aim4 eye: chat with the analyst model running on your own
// computer.
//
// The model lives in the aim4 desktop app. This page asks the server whether
// that app is connected for this account, lets the user pick which model it
// runs, and holds the conversation (eyeAgent.js does the asking and the
// tools). Inside the desktop app's own window the page can also link the app
// to the account in one click, since it is signed in already.
// ---------------------------------------------------------------------------

import { accessToken, gifImageUrl } from '../api.js';
import { gifPageUrl, gifShareUrl } from '../gif/gifCapture.js';
import { desktopApp } from '../../site/desktopApp.js';
import { SYSTEM_PROMPT, gradeLessonsNote, runAgentTurn, summarizeChat, systemWith } from './eyeAgent.js';
import { HISTORY_BUDGET } from './eyeContext.js';
import {
  COMMANDS,
  SUMMARY_PROMPT,
  compactedMessages,
  contextStats,
  exportJson,
  exportMarkdown,
  exportName,
  matchCommands,
  parseCommand,
  transcriptOf
} from './eyeCommands.js';
import { attachChoices, roundsOfTeam, toolsFor } from './eyeTools.js';
import { noteRounds, roundIdsIn } from './roundRefs.js';
import { createRoundPlayer } from './eyeRoundPlayer.js';
import './eye.css';
import chatsIcon from '../../icons/sideicons/sideicon_chats.svg?raw';
import { adminApi } from '../../site/admin/adminApi.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

/** Ratings go to the admin training store (stage 6); only admins can write there. */
let rateable = null;
const canRate = () => (rateable ||= adminApi.labelStats().then(() => true, () => false));
/**
 * The corrections written under "Bad" answers, as the note the system prompt
 * ends with (eyeAgent.js gradeLessonsNote): a grade changes the next answer,
 * not only the next fine-tune. Admins only; refetched after a new grade.
 */
let lessonsNote = null;
const gradeNote = async () => {
  if (!(await canRate())) return '';
  lessonsNote ||= adminApi.gradeLessons().then(gradeLessonsNote, () => '');
  return lessonsNote;
};
/** A tool result kept in a rated trace is cut to this; the whole record must stay under 240 KB. */
const TRACE_TOOL_CHARS = 6000;

/**
 * One finished turn as training data (and a chat as it is saved): images left out, long tool
 * results cut, and what the agent folds to fit the model left out too: it folds it again as needed.
 */
export function traceOf(turn) {
  return turn.map(({ compacted, callsCompacted, ui, full, fullCalls, stepFolded, progress, ...m }) => {
    // A result shortened to fit the model's context is kept whole here.
    if (full !== undefined) m = { ...m, content: full };
    if (fullCalls) m = { ...m, tool_calls: fullCalls };
    if (Array.isArray(m.content)) {
      return { ...m, content: m.content.map((part) => (part.type === 'image_url' ? { type: 'text', text: '[picture]' } : part)) };
    }
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > TRACE_TOOL_CHARS) {
      return { ...m, content: `${m.content.slice(0, TRACE_TOOL_CHARS)}… [cut]` };
    }
    return m;
  });
}
const STATUS_POLL_MS = 3000;
/** The key that queues a question while an answer runs. */
const QUEUE_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Cmd+Enter' : 'Ctrl+Enter';

/** The models the desktop app offers. Ids are the app's; sizes are the download. */
export const EYE_MODELS = [
  { id: 'qwen3.5-4b', label: 'Light (Qwen3.5 4B)', size: '2.7 GB', needs: '8 GB RAM' },
  { id: 'qwen3.5-9b', label: 'Standard (Qwen3.5 9B)', size: '5.7 GB', needs: '16 GB RAM or an 8 GB GPU' },
  { id: 'qwen3.8-27b', label: 'Large (Qwen3.8 27B)', size: '17 GB', needs: '32 GB RAM, or a 24 GB GPU' }
];

const EXAMPLES = [
  'In HAVU T rounds on Nuke where they have 1+ players in Silo before 1:20, how often do they go A or B?',
  "Prepare and review HAVU's antistrat on all the maps they play.",
  "What are HAVU's biggest tactical weaknesses?"
];

async function call(method, path, body) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/** The desktop app's bridge, when this page runs inside it (in a tab too). */
const desktop = desktopApp;

/**
 * A model's reply as safe HTML: escaped first, then **bold**, `code`, line
 * breaks and "- " bullet lists. Nothing the model writes can become markup.
 */
export function replyHtml(text, escapeHtml) {
  const lines = escapeHtml(String(text || '')).split('\n');
  const out = [];
  let list = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(raw);
    if (bullet) {
      list ||= [];
      list.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) {
      out.push(`<ul>${list.join('')}</ul>`);
      list = null;
    }
    if (raw.trim()) out.push(`<p>${inline(raw.replace(/^#+\s*/, ''))}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

const TOOL_VERBS = {
  list_teams: 'Listing teams',
  map_zones: 'Reading map callouts',
  query_rounds: 'Querying rounds',
  database_query: 'Querying the Database',
  list_matches: 'Listing matches',
  match_summary: 'Reading a match',
  find_rounds: 'Finding rounds',
  round_details: 'Reading a round',
  round_timeline: 'Watching a round',
  show_round: 'Showing a round',
  strategy_draft: 'Drafting a strategy',
  save_strategy: 'Saving a strategy',
  team_documents: 'Reading team documents',
  team_rankings: 'Reading the ranking',
  site_map: 'Reading the site map',
  recall_earlier: 'Looking back at an earlier question',
  classify_rounds: 'Sorting rounds by kind of hit',
  player_patterns: 'Reading how the players play',
  screenshot_round: 'Looking at a round',
  make_gif: 'Making a GIF',
  antistrat_summary: 'Reading antistrat',
  create_antistrat_document: 'Creating document'
};

/** The arguments of a tool call on one line: scalars as "key value", lists and objects as a count. */
export function argsLine(args) {
  const out = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) out.push(`${k.replace(/_/g, ' ')} x${v.length}`);
    else if (typeof v === 'object') out.push(`${k.replace(/_/g, ' ')} set`);
    else out.push(`${k.replace(/_/g, ' ')} ${v}`);
  }
  return out.join(' · ');
}

const seconds = (ms) => (ms < 950 ? `${Math.max(1, Math.round(ms / 100)) / 10}s` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);

/** What the desktop app is doing to get a model ready, as a short list of stages. */
function bootStages(dev) {
  const downloading = dev.state === 'downloading';
  const loading = dev.state === 'loading';
  const hasModel = Boolean(dev.model);
  return [
    { label: 'App connected', done: true },
    { label: downloading ? `Downloading model${Number.isFinite(dev.progress) ? ` (${Math.round(dev.progress * 100)}%)` : ''}` : 'Model downloaded', done: hasModel && !downloading, active: downloading },
    { label: 'Loading model into memory', done: hasModel && !downloading && !loading, active: loading }
  ];
}

/**
 * @param {{ escapeHtml: (s: string) => string }} deps
 */
export function createEyePanel({ escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'eye-panel';
  el.innerHTML = `
    <section class="eye-status" id="eye-status"></section>
    <section class="eye-chat" id="eye-chat">
      <div class="eye-log" id="eye-log" aria-live="polite"></div>
      <form class="eye-composer" id="eye-form">
        <div class="eye-pop eye-cmd-pop" id="eye-cmd-pop" role="listbox" aria-label="Commands" hidden></div>
        <div class="eye-queue" id="eye-queue" aria-label="Queued" hidden></div>
        <div class="eye-chips" id="eye-chips" hidden></div>
        <div class="eye-composer-main">
          <div class="eye-menu-host">
            <button type="button" class="eye-icon-btn" id="eye-plus" aria-label="Attach context" aria-haspopup="true"><span class="eye-plus"></span></button>
            <div class="eye-pop" id="eye-attach-pop" hidden></div>
          </div>
          <textarea class="site-input" id="eye-text" rows="1" placeholder="Ask about a team" aria-label="Message"></textarea>
          <button type="button" class="eye-send-btn" id="eye-stop" aria-label="Stop" hidden><span class="eye-stop-mark"></span></button>
          <button type="submit" class="eye-send-btn" id="eye-send" aria-label="Send">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          </button>
        </div>
      </form>
      <div class="eye-bar">
        <span class="eye-spacer"></span>
        <div class="eye-menu-host">
          <button type="button" class="eye-model-btn" id="eye-model-btn" aria-haspopup="true"></button>
          <div class="eye-pop is-right" id="eye-model-pop" hidden></div>
        </div>
        <button type="button" class="eye-icon-btn eye-history-btn" id="eye-history-btn" aria-label="Past chats" title="Past chats">${chatsIcon}</button>
        <button type="button" class="eye-icon-btn" id="eye-new" aria-label="New chat" title="New chat"><span class="eye-plus"></span></button>
      </div>
      <input type="file" id="eye-file" accept="image/*" multiple hidden />
    </section>
    <aside class="eye-history" id="eye-history" hidden aria-label="Past chats"></aside>`;
  const statusEl = el.querySelector('#eye-status');
  const chatEl = el.querySelector('#eye-chat');
  const logEl = el.querySelector('#eye-log');
  const form = el.querySelector('#eye-form');
  const textEl = el.querySelector('#eye-text');
  const sendBtn = el.querySelector('#eye-send');
  const stopBtn = el.querySelector('#eye-stop');
  const chipsEl = el.querySelector('#eye-chips');
  const queueEl = el.querySelector('#eye-queue');
  const plusBtn = el.querySelector('#eye-plus');
  const attachPop = el.querySelector('#eye-attach-pop');
  const cmdPop = el.querySelector('#eye-cmd-pop');
  const modelBtn = el.querySelector('#eye-model-btn');
  const modelPop = el.querySelector('#eye-model-pop');
  const fileEl = el.querySelector('#eye-file');
  const historyEl = el.querySelector('#eye-history');
  const newBtn = el.querySelector('#eye-new');
  const historyBtn = el.querySelector('#eye-history-btn');

  /** OpenAI-style history, without the system prompt. */
  let messages = [];
  let status = null;
  let statusError = '';
  let pollTimer = 0;
  let running = null;
  let shown = false;
  let linking = false;
  let linkError = '';
  /** The saved-chat id of this conversation, made with its first question. */
  let chatId = '';
  /** A title for the chat when its first message is not a question (a compacted chat). */
  let titleOverride = '';
  /** The command picked in the list under the cursor. */
  let cmdIndex = 0;
  /** What the user attached to the message being written: { kind, label, value, url? }. */
  let attachments = [];
  /** Questions queued with Ctrl+Enter while an answer runs: { text, atts }, sent in order as each answer ends. */
  let queued = [];
  /** The "Ctrl+Enter queues it" hint was shown during this answer. */
  let hinted = false;
  let choices = null;

  // ---- status: is the app running, which model ----------------------------------

  async function refreshStatus() {
    try {
      status = await call('GET', '/api/eye/status');
      statusError = '';
    } catch (err) {
      status = null;
      statusError = err.status === 401 ? 'Sign in to use aim4 eye.' : err.message;
    }
    renderStatus();
    syncSend();
    // Questions queued while the model was not ready go once it is.
    if (!running && queued.length) sendNextQueued();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    // Off screen (another page or chapter), stop asking; showing it again
    // starts the poll again.
    if (!el.isConnected || el.offsetParent === null) shown = false;
    if (!shown) return;
    // Faster while a model is on its way, so the progress bar moves.
    const busy = status?.devices?.some((d) => d.state === 'downloading' || d.state === 'loading');
    pollTimer = setTimeout(async () => {
      await refreshStatus();
      schedulePoll();
    }, busy ? 1200 : STATUS_POLL_MS);
  }

  const ready = () => Boolean(status?.ready);
  const liveDevice = () => (status?.devices || []).find((d) => d.state === 'ready' || d.state === 'busy') || null;
  const visionOn = () => Boolean(liveDevice()?.vision);

  /** The model chosen in the status card's list; kept so the 3-second refresh does not undo the choice. */
  let pickedModel = '';
  const pickOf = (dev) => pickedModel || dev.model || dev.hardware?.recommended || '';
  /** The app says which models are already on this computer: those start without a download. */
  const onDisk = (dev, id) => Boolean(dev.hardware?.models?.find((m) => m.id === id)?.downloaded);
  const useLabel = (dev, id) => (dev.model ? 'Switch model' : onDisk(dev, id) ? 'Start' : 'Download and start');

  function modelOptions(dev) {
    const recommended = dev.hardware?.recommended || '';
    const pick = pickOf(dev);
    return EYE_MODELS.map(
      (m) =>
        `<option value="${m.id}"${m.id === pick ? ' selected' : ''}>${escapeHtml(m.label)}, ${onDisk(dev, m.id) ? 'downloaded' : m.size}${
          m.id === recommended ? ' (recommended)' : ''
        }</option>`
    ).join('');
  }

  function renderStatus() {
    const app = desktop();
    chatEl.hidden = false;
    if (statusError) {
      chatEl.hidden = true;
      statusEl.innerHTML = `<div class="eye-status-row"><span class="eye-dot is-bad"></span><span>${escapeHtml(statusError)}</span></div>`;
      return;
    }
    if (!status) {
      chatEl.hidden = true;
      statusEl.innerHTML = `<div class="eye-boot" role="status">
        <div class="eye-boot-head"><span class="eye-spinner" aria-hidden="true"></span><strong>Connecting to aim4 eye</strong></div>
        <div class="eye-skeleton"><span></span><span></span><span></span></div>
      </div>`;
      return;
    }
    const dev = status.devices.find((d) => d.state === 'ready') || status.devices[0];
    if (!dev) {
      chatEl.hidden = true;
      const action = app
        ? app.info?.eyeLinked
          ? '<span class="an-muted">Waiting for the app to connect</span>'
          : `<button type="button" class="eye-btn is-primary" data-eye-link ${linking ? 'disabled' : ''}>${linking ? 'Linking…' : 'Link this computer'}</button>`
        : '<a class="eye-btn is-primary" href="/api/recorder/download">Download the aim4 desktop app</a>';
      const failed = linkError ? `<span class="an-muted">${escapeHtml(linkError)}</span>` : '';
      statusEl.innerHTML = `<div class="eye-status-row"><span class="eye-dot"></span><strong>aim4 eye is not running</strong>${failed}<span class="eye-spacer"></span>${action}</div>`;
      return;
    }
    const model = EYE_MODELS.find((m) => m.id === dev.model);
    const ram = dev.hardware?.ramGb ? `${dev.hardware.ramGb} GB RAM` : '';
    const booting = dev.state === 'downloading' || dev.state === 'loading' || (dev.state !== 'ready' && dev.state !== 'busy' && dev.state !== 'error');
    const stateText =
      dev.state === 'ready' || dev.state === 'busy'
        ? model?.label || dev.model || 'ready'
        : dev.state === 'error'
          ? `Error: ${dev.message || 'something went wrong'}`
          : dev.model
            ? 'Starting'
            : 'No model loaded';
    const dot = dev.state === 'ready' || dev.state === 'busy' ? 'is-on' : dev.state === 'error' ? 'is-bad' : 'is-wait';
    const pick = `
      <div class="eye-pick">
        <select class="site-select eye-select" id="eye-model" aria-label="Model">${modelOptions(dev)}</select>
        <button type="button" class="eye-btn" data-eye-use>${useLabel(dev, pickOf(dev))}</button>
      </div>`;
    let boot = '';
    if (booting) {
      chatEl.hidden = true;
      const stages = bootStages(dev);
      const pct = dev.state === 'downloading' && Number.isFinite(dev.progress) ? Math.round(dev.progress * 100) : null;
      boot = dev.model
        ? `<div class="eye-boot" role="status">
            <ol class="eye-stages">${stages
              .map((st) => `<li class="${st.done ? 'is-done' : st.active ? 'is-active' : ''}"><span class="eye-stage-mark"></span>${escapeHtml(st.label)}</li>`)
              .join('')}</ol>
            <div class="eye-progress${pct == null ? ' is-indeterminate' : ''}"><span style="width:${pct == null ? 40 : pct}%"></span></div>
            ${dev.message ? `<p class="an-muted">${escapeHtml(dev.message)}</p>` : ''}
          </div>`
        : '';
    }
    if (dev.state === 'ready' || dev.state === 'busy') {
      statusEl.innerHTML = '';
      renderModelButton();
      return;
    }
    statusEl.innerHTML = `
      <div class="eye-status-row">
        <span class="eye-dot ${dot}"></span>
        <strong>${escapeHtml(dev.name || 'Your computer')}</strong>
        <span class="an-muted">${escapeHtml(stateText)}${ram ? ` · ${escapeHtml(ram)}` : ''}${dev.vision ? ' · Vision' : ''}</span>
        <span class="eye-spacer"></span>
        ${pick}
      </div>
      ${boot}`;
    syncSend();
  }

  async function linkThisComputer() {
    const app = desktop();
    if (!app || linking) return;
    linking = true;
    renderStatus();
    try {
      const { token } = await call('POST', '/api/eye/link', { name: app.info?.deviceName || 'aim4 desktop' });
      app.send({ type: 'eye-link', token });
      linkError = '';
    } catch (err) {
      // Kept apart from statusError: the status refresh below would clear it before anyone saw it.
      linkError = `Could not link: ${err.message}`;
    }
    linking = false;
    await refreshStatus();
  }

  // ---- the composer: model, attachments ------------------------------------------------

  const popups = [attachPop, modelPop, cmdPop];
  function closePops(except) {
    for (const pop of popups) if (pop !== except) pop.hidden = true;
  }

  function renderModelButton() {
    const dev = liveDevice();
    const m = EYE_MODELS.find((x) => x.id === dev?.model);
    const [short, detail] = m ? [m.label.replace(/\s*\(.*\)$/, ''), /\((.*)\)/.exec(m.label)?.[1] || ''] : ['Model', ''];
    modelBtn.innerHTML = `<span>${escapeHtml(short)}</span>${detail ? `<span class="eye-model-detail">${escapeHtml(detail)}</span>` : ''}<span class="eye-caret" aria-hidden="true"></span>`;
    modelBtn.disabled = !dev;
  }

  function openModelMenu() {
    const dev = liveDevice();
    const recommended = dev?.hardware?.recommended || '';
    modelPop.innerHTML = EYE_MODELS.map(
      (m) => `<button type="button" class="eye-pop-item${m.id === dev?.model ? ' is-current' : ''}" data-eye-model="${m.id}">
        <span class="eye-pop-main">${escapeHtml(m.label)}${m.id === recommended ? ' <em>recommended</em>' : ''}</span>
        <span class="eye-pop-sub">${escapeHtml(m.size)} download, ${escapeHtml(m.needs)}</span>
      </button>`
    ).join('');
    closePops(modelPop);
    modelPop.hidden = false;
  }

  async function useModel(id) {
    modelPop.hidden = true;
    if (!id || id === liveDevice()?.model) return;
    try {
      await call('POST', '/api/eye/command', { command: 'use-model', args: { model: id } });
    } catch (err) {
      statusError = err.message;
    }
    void refreshStatus();
  }

  const KIND_LABEL = { image: 'Image', round: 'Round', team: 'Team', player: 'Player' };

  function renderChips() {
    chipsEl.hidden = !attachments.length;
    chipsEl.innerHTML = attachments
      .map(
        (a, i) => `<span class="eye-chip" title="${escapeHtml(KIND_LABEL[a.kind])}">
          ${a.kind === 'image' ? `<img src="${escapeHtml(a.value)}" alt="" />` : `<span class="eye-chip-kind">${KIND_LABEL[a.kind]}</span>`}
          <span class="eye-chip-label">${escapeHtml(a.label)}</span>
          <button type="button" class="eye-chip-x" data-eye-unattach="${i}" aria-label="Remove">×</button>
        </span>`
      )
      .join('');
  }

  // ---- the queue: questions written while an answer runs ------------------------------

  function renderQueue() {
    queueEl.hidden = !queued.length;
    queueEl.innerHTML = queued
      .map(
        (x, i) => `<div class="eye-queued">
          <span class="eye-queued-tag">Queued</span>
          <button type="button" class="eye-queued-text" data-eye-requeue="${i}" title="Edit">${escapeHtml(x.text)}</button>
          ${x.atts.length ? `<span class="eye-queued-tag">+${x.atts.length}</span>` : ''}
          <button type="button" class="eye-chip-x" data-eye-unqueue="${i}" aria-label="Remove">×</button>
        </div>`
      )
      .join('');
  }

  /** The text being written goes to the queue, with what is attached to it. */
  function enqueue() {
    const text = textEl.value.trim();
    if (!text) return;
    queued.push({ text, atts: attachments });
    attachments = [];
    renderChips();
    textEl.value = '';
    textEl.style.height = '';
    renderCommands();
    renderQueue();
  }

  /** Queued questions back in the composer, after what is being written, with what was attached to them. */
  function toComposer(items) {
    if (!items.length) return;
    textEl.value = [textEl.value.trim(), ...items.map((x) => x.text)].filter(Boolean).join('\n\n');
    for (const a of items.flatMap((x) => x.atts)) if (!attachments.some((b) => b.kind === a.kind && b.value === a.value)) attachments.push(a);
    renderChips();
    textEl.dispatchEvent(new Event('input'));
  }

  /**
   * The next queued question, now that nothing runs. A command (/compact) runs as if typed: one that
   * is over at once lets the next go straight after it, one that runs sends the next when it ends.
   */
  function sendNextQueued() {
    if (running || !queued.length || !ready()) return;
    const next = queued.shift();
    renderQueue();
    const parsed = parseCommand(next.text);
    if (!parsed) return void ask(next.text, null, next);
    runCommand(parsed);
    if (!running) sendNextQueued();
  }

  /** After an answer: a finished one sends the next queued question; a stopped or failed one puts the queue back to edit. */
  function afterAnswer(failed) {
    if (!failed) return sendNextQueued();
    toComposer(queued);
    queued = [];
    renderQueue();
  }

  function attach(item) {
    if (attachments.some((a) => a.kind === item.kind && a.value === item.value)) return;
    attachments.push(item);
    attachPop.hidden = true;
    renderChips();
    textEl.focus();
  }

  function openAttachMenu() {
    closePops(attachPop);
    const vision = visionOn();
    const hint = {
      image: vision ? 'A screenshot or a photo' : 'Needs a model that reads pictures',
      round: 'One round of a team',
      team: 'A team of the library',
      player: 'A player of the library'
    };
    attachPop.innerHTML = ['image', 'round', 'team', 'player']
      .map((k) => {
        const off = k === 'image' && !vision;
        return `<button type="button" class="eye-pop-item" data-eye-attach="${k}"${off ? ' disabled' : ''}>
          <span class="eye-pop-main">${KIND_LABEL[k]}</span>
          <span class="eye-pop-sub">${hint[k]}</span>
        </button>`;
      })
      .join('');
    attachPop.hidden = false;
  }

  /** A search box and a list, for choosing a team, a player or a round. */
  function openPicker(kind, team = '') {
    const title = kind === 'round' && team ? `${team}, pick a round` : kind === 'round' ? 'Pick the team of the round' : `Pick a ${kind}`;
    attachPop.innerHTML = `<div class="eye-pick-head"><button type="button" class="eye-pick-back" data-eye-back aria-label="Back">‹</button><span>${escapeHtml(title)}</span></div>
      <input type="text" class="eye-pick-search" placeholder="${kind === 'round' && team ? 'Filter the rounds' : 'Search'}" aria-label="Search" />
      <div class="eye-pick-list"><p class="eye-pop-sub">Loading…</p></div>`;
    const search = attachPop.querySelector('.eye-pick-search');
    const list = attachPop.querySelector('.eye-pick-list');
    let rows = [];
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      // A pasted round id can be attached as it is.
      const pasted = kind === 'round' ? roundIdsIn(search.value)[0] || '' : '';
      const hits = rows.filter((r) => r.label.toLowerCase().includes(q)).slice(0, 40);
      list.innerHTML =
        (pasted ? `<button type="button" class="eye-pop-item" data-i="paste"><span class="eye-pop-main">Use this round id</span><span class="eye-pop-sub">${escapeHtml(pasted)}</span></button>` : '') +
        (hits.length
          ? hits.map((r) => `<button type="button" class="eye-pop-item" data-i="${rows.indexOf(r)}"><span class="eye-pop-main">${escapeHtml(r.label)}</span></button>`).join('')
          : pasted
            ? ''
            : '<p class="eye-pop-sub">Nothing found.</p>');
    };
    list.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      if (b.dataset.i === 'paste') {
        const id = roundIdsIn(search.value)[0];
        return attach({ kind: 'round', label: `${id.slice(0, 18)}…`, value: id });
      }
      const row = rows[Number(b.dataset.i)];
      if (kind === 'round' && !team) return openPicker('round', row.value);
      attach({ kind, label: row.label, value: row.value });
    };
    search.addEventListener('input', draw);
    search.focus();
    (async () => {
      try {
        if (kind === 'round' && team) {
          rows = (await roundsOfTeam(team)).map((r) => ({ label: r.label, value: r.file }));
        } else {
          choices ||= await attachChoices();
          rows = kind === 'player' ? choices.players.map((pl) => ({ label: pl.name, value: pl.id })) : choices.teams.map((t) => ({ label: t, value: t }));
        }
        draw();
      } catch (err) {
        choices = null;
        list.innerHTML = `<p class="eye-error">${escapeHtml(err.message || 'Could not load the library.')}</p>`;
      }
    })();
  }

  /** A picture shrunk to what a model reads, as a JPEG data URL. */
  async function shrinkImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  async function addImages(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/') || attachments.filter((a) => a.kind === 'image').length >= 4) continue;
      try {
        attach({ kind: 'image', label: file.name || 'Image', value: await shrinkImage(file) });
      } catch {
        /* an unreadable picture is skipped */
      }
    }
  }

  /** The message the model reads: the question, plus what was attached as plain text and pictures. */
  function messageWith(question, atts) {
    const lines = atts
      .filter((a) => a.kind !== 'image')
      .map((a) => (a.kind === 'round' ? `- Round: ${a.value} (${a.label})` : a.kind === 'player' ? `- Player: ${a.label} (id ${a.value})` : `- Team: ${a.label}`));
    const text = lines.length ? `${question}\n\nAttached by the user:\n${lines.join('\n')}` : question;
    noteRounds(atts.filter((a) => a.kind === 'round').map((a) => a.value));
    const images = atts.filter((a) => a.kind === 'image');
    const content = images.length ? [{ type: 'text', text }, ...images.map((a) => ({ type: 'image_url', image_url: { url: a.value } }))] : text;
    return { role: 'user', content, ui: { text: question, chips: atts.map((a) => ({ kind: a.kind, label: a.label })) } };
  }

  // ---- past chats -------------------------------------------------------------------

  const newChatId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

  const chatTitle = () =>
    titleOverride || String(messages.find((m) => m.ui && m.ui.text !== '/compact')?.ui.text || messages.find((m) => typeof m.content === 'string')?.content || 'New chat').slice(0, 60);

  function saveChat() {
    if (!messages.length) return;
    chatId ||= newChatId();
    const title = chatTitle();
    const saved = traceOf(messages).map((m, i) => (messages[i].ui ? { ...m, ui: messages[i].ui } : m));
    void call('PUT', `/api/eye/chats/${chatId}`, { title, messages: saved }).catch(() => {});
  }

  const when = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  async function openHistory() {
    historyEl.hidden = false;
    historyEl.innerHTML = '<p class="eye-pop-sub">Loading…</p>';
    try {
      const { chats } = await call('GET', '/api/eye/chats');
      historyEl.innerHTML = chats.length
        ? chats
            .map(
              (c) => `<div class="eye-hist-row${c.id === chatId ? ' is-current' : ''}">
                <button type="button" class="eye-hist-item" data-eye-open="${c.id}"><span>${escapeHtml(c.title)}</span><span class="eye-pop-sub">${escapeHtml(when(c.updatedAt))}</span></button>
                <button type="button" class="eye-chip-x" data-eye-delete="${c.id}" aria-label="Delete this chat">×</button>
              </div>`
            )
            .join('')
        : '<p class="eye-pop-sub">No past chats yet.</p>';
    } catch (err) {
      historyEl.innerHTML = `<p class="eye-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function startNewChat() {
    if (running) return;
    messages = [];
    chatId = '';
    titleOverride = '';
    attachments = [];
    renderChips();
    historyEl.hidden = true;
    logEl.replaceChildren();
    renderEmpty();
  }

  async function openChat(id) {
    if (running) return;
    try {
      const chat = await call('GET', `/api/eye/chats/${id}`);
      messages = Array.isArray(chat.messages) ? chat.messages : [];
      chatId = id;
      titleOverride = '';
      historyEl.hidden = true;
      noteRounds(messages.flatMap((m) => (typeof m.content === 'string' ? roundIdsIn(m.content) : [])));
      renderSaved();
    } catch (err) {
      historyEl.innerHTML = `<p class="eye-error">${escapeHtml(err.message)}</p>`;
    }
  }

  /** A saved conversation back on screen. */
  function renderSaved() {
    logEl.replaceChildren();
    const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, String(m.full ?? m.content ?? '')]));
    const widgets = new Map(messages.filter((m) => m.role === 'tool' && m.ui?.widget).map((m) => [m.tool_call_id, m.ui.widget]));
    for (const m of messages) {
      if (m.role === 'user' && (m.ui || typeof m.content === 'string')) {
        userBubble(m.ui?.text ?? m.content, m.ui?.chips);
      } else if (m.role === 'assistant') {
        if (String(m.content || '').trim()) {
          if (m.tool_calls?.length) {
            bubble('eye-note').textContent = noteText(m.content);
          } else {
            const node = bubble('eye-bot', replyHtml(m.content, escapeHtml));
            node.appendChild(copyButton(() => m.content));
          }
        }
        for (const tc of m.tool_calls || []) {
          let args = {};
          try {
            args = JSON.parse(tc.function?.arguments || '{}');
          } catch {
            /* shown without arguments */
          }
          const node = bubble('eye-tool', toolHtml(tc.function?.name, args), 'details');
          node.querySelector('.eye-tool-time').remove();
          const raw = results.get(tc.id) || '';
          node.classList.toggle('is-error', raw.startsWith('Error'));
          fillTool(node, { args, raw });
          if (widgets.has(tc.id)) showWidget(widgets.get(tc.id));
        }
      }
    }
    toBottom();
  }

  /** A round the model put in the chat: a small player, a still of one moment that plays on, or a GIF it made. */
  function showWidget(spec) {
    if (spec?.gif?.id) {
      const stick = nearBottom();
      logEl.appendChild(gifWidget(spec.gif));
      if (stick) toBottom();
      return;
    }
    if (!spec?.file) return;
    const stick = nearBottom();
    const node = createRoundPlayer(spec, escapeHtml);
    node.classList.add('eye-msg');
    logEl.appendChild(node);
    if (stick) toBottom();
  }

  /**
   * A saved GIF in the chat: the picture, its title, and its two links: the
   * share page (the GIF with its title and description) and the GIF itself,
   * which embeds where it is pasted.
   */
  function gifWidget(gif) {
    const id = String(gif.id || '');
    const node = document.createElement('figure');
    node.className = 'eye-msg eye-gif';
    const size = gif.width && gif.height ? ` width="${Number(gif.width) | 0}" height="${Number(gif.height) | 0}"` : '';
    node.innerHTML = `<img src="${escapeHtml(gifImageUrl(id))}" alt="${escapeHtml(gif.title || 'GIF')}"${size} />
      <figcaption>
        <span>${escapeHtml(gif.title || 'GIF')}</span>
        <button type="button" class="eye-gif-copy" data-copy="page" title="A page with the GIF, its title and its description">Page link</button>
        <button type="button" class="eye-gif-copy" data-copy="image" title="The GIF file itself, which plays wherever it is pasted">Image link</button>
        <a href="/bookmarks?tab=gifs" target="_blank" rel="noopener">Saved GIFs</a>
      </figcaption>`;
    for (const btn of node.querySelectorAll('.eye-gif-copy')) {
      btn.addEventListener('click', async () => {
        const link = btn.dataset.copy === 'page' ? gifPageUrl(id) : gifShareUrl(id);
        try {
          await navigator.clipboard.writeText(link);
          btn.textContent = 'Copied';
        } catch {
          window.prompt('Copy the link:', link);
        }
      });
    }
    return node;
  }

  /** The first line of what the model said before a tool call, cut short. */
  const noteText = (text) => {
    const line = String(text).trim().split('\n')[0].replace(/[*_`#>]/g, '').trim();
    return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  };

  /** One tool call's gray line, with a body the user can open. */
  const toolHtml = (name, args) => `<summary>
      <span class="eye-tool-mark" aria-hidden="true"></span>
      <span class="eye-tool-name">${escapeHtml(TOOL_VERBS[name] || name || 'Tool')}</span>
      <span class="eye-tool-time">0.0s</span>
    </summary>
    <div class="eye-tool-body"><div class="eye-tool-status">Working</div></div>`;

  function fillTool(node, { args, raw, display = '', link = '', images = [] }) {
    const shots = images.map((url) => `<img class="eye-shot" src="${escapeHtml(url)}" alt="${escapeHtml(display || 'Round screenshot')}" />`).join('');
    const open = link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">Open the rounds</a>` : '';
    const argLine = argsLine(args);
    node.querySelector('.eye-tool-body').innerHTML = `${argLine ? `<div class="eye-tool-argline">${escapeHtml(argLine)}</div>` : ''}${display || open ? `<div class="eye-tool-result"><span>${escapeHtml(display)}</span>${open}</div>` : ''}${shots}
      <pre>${escapeHtml(JSON.stringify(args || {}, null, 2))}</pre>
      <pre>${escapeHtml(raw.length > 1500 ? `${raw.slice(0, 1500)}\n...` : raw)}</pre>`;
  }

  /** The user's message: what they attached, then the words, in a bubble. */
  function userBubble(text, chips = []) {
    const sent = (chips || []).map((c) => `${KIND_LABEL[c.kind] || ''}: ${c.label}`).join(', ');
    return bubble('eye-user-wrap', `<div class="eye-user"><p>${escapeHtml(text)}</p></div>${sent ? `<div class="eye-sent">${escapeHtml(sent)}</div>` : ''}`);
  }

  // ---- the conversation -----------------------------------------------------------

  function syncSend() {
    sendBtn.disabled = !ready();
    sendBtn.title = ready() ? '' : 'aim4 eye is not ready';
    sendBtn.hidden = Boolean(running);
    stopBtn.hidden = !running;
    textEl.placeholder = running ? `${QUEUE_KEY} queues a follow-up` : 'Ask about a team';
    renderModelButton();
  }

  function renderEmpty() {
    if (logEl.childElementCount) return;
    const intro = document.createElement('div');
    intro.className = 'eye-intro';
    intro.innerHTML = EXAMPLES.map((q) => `<button type="button" class="eye-example" data-eye-example>${escapeHtml(q)}</button>`).join('');
    logEl.appendChild(intro);
  }

  // Follow the output only while the reader wants it: scrolling up lets go, reaching the bottom again re-attaches.
  let pinned = true;
  const atBottom = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  logEl.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) pinned = false;
  }, { passive: true });
  logEl.addEventListener('touchmove', () => {
    pinned = false;
  }, { passive: true });
  logEl.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) pinned = false;
  });
  logEl.addEventListener('scroll', () => {
    if (atBottom()) pinned = true;
    else if (!programmatic) pinned = false;
  }, { passive: true });
  let programmatic = false;
  const nearBottom = () => pinned;
  const toBottom = () => {
    pinned = true;
    programmatic = true;
    logEl.scrollTop = logEl.scrollHeight;
    requestAnimationFrame(() => {
      programmatic = false;
    });
  };

  function bubble(cls, html = '', tag = 'div') {
    const stick = nearBottom();
    const node = document.createElement(tag);
    node.className = `eye-msg ${cls}`;
    node.innerHTML = html;
    logEl.appendChild(node);
    if (stick) toBottom();
    return node;
  }

  function copyButton(getText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eye-copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getText());
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Could not copy';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    });
    return btn;
  }

  /** "Good" / "Bad" under an answer, for admins: the turn becomes fine-tune data. */
  async function offerRating(question, turn, answer, note = '') {
    if (!(await canRate())) return;
    const model = String((status?.devices || []).find((d) => d.model)?.model || 'unknown').toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 32) || 'unknown';
    const row = bubble(
      'eye-rate',
      `<span class="an-muted">Train aim4 eye on this answer:</span><button type="button" class="eye-btn" data-v="yes">Good</button><button type="button" class="eye-btn" data-v="no">Bad</button>`
    );
    const save = async (verdict, comment = '') => {
      row.innerHTML = '<span class="an-muted">Saving…</span>';
      try {
        await adminApi.saveLabel(6, {
          engine: model,
          verdict,
          comment,
          subject: { question, model },
          bot: { text: answer, system: systemWith(note), tools: toolsFor({ vision: false }), messages: traceOf(turn) }
        });
        // A new correction is in the next answer's prompt.
        if (verdict === 'no' && comment) lessonsNote = null;
        row.innerHTML = `<span class="an-muted">Saved as a ${verdict === 'yes' ? 'good' : 'bad'} example.</span>`;
      } catch (err) {
        row.innerHTML = `<span class="eye-error">${escapeHtml(err.message || 'Could not save.')}</span>`;
      }
    };
    row.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      if (b.dataset.v === 'yes') return void save('yes');
      row.innerHTML =
        '<input type="text" class="eye-rate-note" placeholder="What was wrong? (optional)" maxlength="2000"><button type="button" class="eye-btn is-primary" data-save>Save</button>';
      const note = row.querySelector('input');
      note.focus();
      const go = () => save('no', note.value.trim());
      row.querySelector('[data-save]').addEventListener('click', go);
      note.addEventListener('keydown', (k) => k.key === 'Enter' && go());
    });
  }

  // ---- slash commands ---------------------------------------------------------------

  /** A line from the panel itself (a command's answer), not from the model. It is not part of the chat. */
  function info(html) {
    logEl.querySelector('.eye-intro')?.remove();
    return bubble('eye-info', html);
  }

  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /** What a reviewer needs to reproduce the chat: model, prompt, tools. */
  function chatMeta() {
    const dev = liveDevice() || (status?.devices || []).find((d) => d.model) || null;
    return {
      title: chatTitle(),
      chatId,
      exportedAt: new Date().toISOString(),
      page: location.origin,
      model: dev?.model || '',
      reasoning: true,
      vision: visionOn(),
      systemPrompt: SYSTEM_PROMPT,
      tools: toolsFor({ vision: visionOn() }).map((t) => t.function.name)
    };
  }

  async function exportChat(args) {
    if (!messages.length) return void info('Nothing to export yet.');
    const chat = { messages, meta: chatMeta() };
    const mode = args.toLowerCase();
    if (mode === 'copy') {
      try {
        await navigator.clipboard.writeText(exportJson(chat));
        info('Copied the chat as JSON.');
      } catch {
        info('Could not copy. Use <code>/export</code> to download it instead.');
      }
      return;
    }
    const md = mode === 'md' || mode === 'markdown';
    const text = md ? exportMarkdown(chat) : exportJson(chat);
    const name = exportName(chat.meta.title, md ? 'md' : 'json');
    download(name, text, md ? 'text/markdown' : 'application/json');
    info(`Saved <code>${escapeHtml(name)}</code> (${Math.max(1, Math.round(text.length / 1024))} KB) to your downloads. If nothing appeared, <code>/export copy</code> puts it on the clipboard.`);
  }

  async function copyLastAnswer() {
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && !m.tool_calls?.length && String(m.content || '').trim());
    if (!last) return void info('No answer to copy yet.');
    try {
      await navigator.clipboard.writeText(last.content);
      info('Copied the last answer.');
    } catch {
      info('Could not copy.');
    }
  }

  /** Replace the chat with the model's summary of it. The full chat stays in the past chats. */
  async function compactChat() {
    if (running) return void info('Wait for the answer, or stop it first.');
    if (!ready()) return void info('aim4 eye is not ready.');
    if (messages.length < 4) return void info('There is not enough to summarise yet.');
    const before = contextStats(messages, HISTORY_BUDGET).chars;
    const title = chatTitle();
    saveChat();
    const ctrl = new AbortController();
    running = ctrl;
    syncSend();
    const row = bubble('eye-pending', '<span class="eye-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="eye-pending-text">Summarising the chat</span>');
    let failed = false;
    try {
      const summary = await summarizeChat(transcriptOf(messages), SUMMARY_PROMPT, { signal: ctrl.signal });
      if (!summary) throw new Error('The model returned no summary.');
      messages = compactedMessages(summary);
      chatId = '';
      titleOverride = `${title} (compacted)`.slice(0, 60);
      renderSaved();
      const after = contextStats(messages, HISTORY_BUDGET).chars;
      info(`Compacted from ${before.toLocaleString()} to ${after.toLocaleString()} characters. The full chat is still in your past chats.`);
      saveChat();
    } catch (err) {
      row.remove();
      info(err.name === 'AbortError' ? 'Stopped. The chat is unchanged.' : `Could not summarise: ${escapeHtml(err.message)}. The chat is unchanged.`);
      failed = true;
    } finally {
      row.remove();
      running = null;
      syncSend();
    }
    afterAnswer(failed);
  }

  /** Ask the last question again, with what was attached to it; the answer to it is dropped. */
  function retryLast() {
    if (running) return void info('Wait for the answer, or stop it first.');
    if (!ready()) return void info('aim4 eye is not ready.');
    let at = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].ui && messages[i].ui.text !== '/compact') {
        at = i;
        break;
      }
    }
    if (at < 0) return void info('There is no question to ask again.');
    const again = messages[at];
    messages = messages.slice(0, at);
    if (messages.length) renderSaved();
    else logEl.replaceChildren();
    void ask(again.ui.text, again);
  }

  function showContext() {
    const s = contextStats(messages, HISTORY_BUDGET);
    info(
      `${s.messages} messages, ${s.questions} question${s.questions === 1 ? '' : 's'}, ${s.toolCalls} tool result${s.toolCalls === 1 ? '' : 's'}. ` +
        `About ${s.chars.toLocaleString()} of ${s.budget.toLocaleString()} characters (${s.percent}%) before old results are shortened${s.shortened ? `; ${s.shortened} already shortened` : ''}. ` +
        (s.stepsFolded ? `${s.stepsFolded} older step${s.stepsFolded === 1 ? ' is' : 's are'} folded into a line per call. ` : '') +
        (s.folded ? `${s.folded} earlier question${s.folded === 1 ? ' is' : 's are'} folded into a summary. ` : '') +
        'Older steps and questions make room on their own as the chat grows.'
    );
  }

  function showHelp() {
    info(
      `<div class="eye-help">${COMMANDS.map(
        (c) => `<div><code>/${c.name}${c.args ? ` ${escapeHtml(c.args)}` : ''}</code><span>${escapeHtml(c.about)}${c.aliases?.length ? ` (also /${c.aliases.join(', /')})` : ''}</span></div>`
      ).join('')}</div>`
    );
  }

  function runCommand(parsed) {
    if ('unknown' in parsed) return void info(`There is no command <code>/${escapeHtml(parsed.unknown)}</code>. <code>/help</code> lists them.`);
    switch (parsed.command.name) {
      case 'export':
        return void exportChat(parsed.args);
      case 'compact':
        return void compactChat();
      case 'retry':
        return retryLast();
      case 'copy':
        return void copyLastAnswer();
      case 'context':
        return showContext();
      case 'new':
        return startNewChat();
      default:
        return showHelp();
    }
  }

  /** A line from the composer: a command, or a question. */
  function submit(text) {
    const parsed = parseCommand(text);
    if (!parsed) return void ask(text);
    textEl.value = '';
    textEl.style.height = '';
    renderCommands();
    runCommand(parsed);
  }

  /** The list under the cursor while a line starts with "/" and no command has been completed. */
  function renderCommands() {
    const list = matchCommands(textEl.value);
    if (!list.length) {
      cmdPop.hidden = true;
      return;
    }
    cmdIndex = Math.min(cmdIndex, list.length - 1);
    cmdPop.hidden = false;
    cmdPop.innerHTML = list
      .map(
        (c, i) => `<button type="button" class="eye-pop-item${i === cmdIndex ? ' is-current' : ''}" role="option" data-eye-cmd="${c.name}">
          <span class="eye-pop-main"><code>/${c.name}</code>${c.args ? `<em>${escapeHtml(c.args)}</em>` : ''}</span>
          <span class="eye-pop-sub">${escapeHtml(c.about)}</span>
        </button>`
      )
      .join('');
  }

  /** @param {string} name */
  function completeCommand(name) {
    textEl.value = `/${name}`;
    textEl.focus();
    cmdPop.hidden = true;
  }

  /**
   * @param {string} text
   * @param {object} [again]  a user message to send as it was (the /retry command), attachments and all
   * @param {{ atts: object[] }} [fromQueue]  a question queued with Ctrl+Enter: it carries its own
   *   attachments, and the composer (where the next one may be being written) is left alone
   */
  async function ask(text, again, fromQueue) {
    const q = String(text || '').trim();
    if (!q || running || !ready()) return;
    logEl.querySelector('.eye-intro')?.remove();
    const atts = again ? [] : fromQueue ? fromQueue.atts : attachments;
    if (!again && !fromQueue) {
      attachments = [];
      renderChips();
    }
    userBubble(q, again ? again.ui?.chips : atts.map((a) => ({ kind: a.kind, label: a.label })));
    const turnStart = messages.length;
    let failed = false;
    /** The grade corrections this turn's prompt carried, saved with its rating. */
    let turnNote = '';
    messages.push(again || messageWith(q, atts));
    if (!fromQueue) {
      textEl.value = '';
      textEl.style.height = '';
    }
    const ctrl = new AbortController();
    running = ctrl;
    hinted = false;
    syncSend();
    toBottom();

    let reply = null;
    let replyText = '';
    let reasoning = null;
    let pending = null;
    const tools = new Map();

    /** The "working" row shown between events, so the page never looks stuck. */
    const showPending = (label) => {
      if (!pending) {
        pending = bubble('eye-pending', '<span class="eye-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="eye-pending-text"></span>');
      }
      pending.querySelector('.eye-pending-text').textContent = label;
      logEl.appendChild(pending);
    };
    const hidePending = () => {
      pending?.remove();
      pending = null;
    };
    const closeReasoning = () => {
      if (!reasoning) return;
      const r = reasoning;
      reasoning = null;
      clearInterval(r.timer);
      r.node.open = false;
      r.node.classList.remove('is-live');
      r.label.textContent = `Thought for ${seconds(Date.now() - r.t0)}`;
    };
    const endReply = () => {
      if (reply && replyText.trim()) {
        const text = replyText;
        reply.appendChild(copyButton(() => text));
      } else if (reply) {
        reply.remove();
      }
      reply = null;
      replyText = '';
    };
    /** Text written before a tool call is narration, not the answer: one gray line. */
    const demoteReply = () => {
      if (reply && replyText.trim()) {
        reply.className = 'eye-msg eye-note';
        reply.textContent = noteText(replyText);
        reply = null;
        replyText = '';
      } else endReply();
    };

    showPending('Thinking');

    const onEvent = (e) => {
      if (e.type === 'step') {
        closeReasoning();
        endReply();
        showPending(e.step === 0 ? 'Thinking' : `Reading results, step ${e.step + 1}`);
      } else if (e.type === 'retry') {
        closeReasoning();
        showPending(
          e.reason === 'room'
            ? 'Out of room, folding older steps and asking again'
            : e.why === 'hedging'
              ? 'Going back and forth, acting on the first plan'
              : e.reason === 'overthought'
                ? 'Thought too long, acting on the plan'
                : 'No reply, asking again'
        );
      } else if (e.type === 'folding') {
        showPending(`Summarising ${e.questions} earlier question${e.questions === 1 ? '' : 's'} to make room`);
      } else if (e.type === 'folded') {
        hidePending();
        const note = bubble('eye-note');
        note.textContent = `Summarised ${e.questions} earlier question${e.questions === 1 ? '' : 's'} to make room. They stay in this chat and the eye can look them up.`;
        showPending('Thinking');
      } else if (e.type === 'thinking') {
        hidePending();
        if (!reasoning) {
          const node = document.createElement('details');
          node.className = 'eye-msg eye-reason is-live';
          node.open = true;
          node.innerHTML = '<summary><span class="eye-reason-label">Thinking</span></summary><div class="eye-reason-body"></div>';
          const stick = nearBottom();
          logEl.appendChild(node);
          if (stick) toBottom();
          const label = node.querySelector('.eye-reason-label');
          const t0 = Date.now();
          const timer = setInterval(() => (label.textContent = `Thinking ${seconds(Date.now() - t0)}`), 200);
          reasoning = { node, label, body: node.querySelector('.eye-reason-body'), t0, timer };
        }
        const stick = nearBottom();
        reasoning.body.textContent += e.text;
        reasoning.body.scrollTop = reasoning.body.scrollHeight;
        if (stick) toBottom();
      } else if (e.type === 'text') {
        hidePending();
        closeReasoning();
        const stick = nearBottom();
        reply ||= bubble('eye-bot');
        replyText += e.text;
        reply.innerHTML = replyHtml(replyText, escapeHtml);
        if (stick) toBottom();
      } else if (e.type === 'tool-start') {
        hidePending();
        closeReasoning();
        // A tool call ends whatever text came before it in this step.
        demoteReply();
        const node = bubble('eye-tool is-running', toolHtml(e.name, e.args), 'details');
        const timeEl = node.querySelector('.eye-tool-time');
        const t0 = Date.now();
        const timer = setInterval(() => (timeEl.textContent = seconds(Date.now() - t0)), 150);
        tools.set(e.id, { node, t0, timer, timeEl });
      } else if (e.type === 'tool-progress') {
        const t = tools.get(e.id);
        if (t) t.node.querySelector('.eye-tool-status').textContent = e.label;
      } else if (e.type === 'tool-done') {
        const t = tools.get(e.id);
        if (!t) return;
        clearInterval(t.timer);
        t.timeEl.textContent = seconds(Date.now() - t.t0);
        const failed = String(e.result.content || '').startsWith('Error');
        t.node.classList.remove('is-running');
        t.node.classList.toggle('is-error', failed);
        fillTool(t.node, { args: e.args, raw: String(e.result.content || ''), display: e.result.display || '', link: e.result.link || '', images: e.result.images || [] });
        if (e.result.widget) showWidget(e.result.widget);
        showPending('Reading results');
      }
    };
    try {
      const live = (status?.devices || []).find((d) => d.state === 'ready');
      // An app whose model server ends reasoning itself says so; the agent then does not stop replies.
      const systemNote = await gradeNote();
      turnNote = systemNote;
      await runAgentTurn(messages, { onEvent, signal: ctrl.signal, vision: Boolean(live?.vision), serverBudget: live?.reasoningBudget || 0, systemNote });
    } catch (err) {
      failed = true;
      hidePending();
      if (err.name !== 'AbortError') bubble('eye-error', `<p>${escapeHtml(err.message)}</p>`);
      else bubble('eye-error', '<p>Stopped.</p>');
    }
    hidePending();
    closeReasoning();
    const finalText = replyText;
    endReply();
    if (!failed && finalText.trim()) void offerRating(q, messages.slice(turnStart), finalText, turnNote);
    for (const t of tools.values()) {
      clearInterval(t.timer);
      if (t.node.classList.contains('is-running')) t.node.classList.replace('is-running', 'is-error');
    }
    running = null;
    syncSend();
    saveChat();
    void refreshStatus();
    afterAnswer(failed);
  }

  // ---- events -----------------------------------------------------------------------

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(textEl.value);
  });
  textEl.addEventListener('keydown', (e) => {
    // Ctrl+Enter (Cmd+Enter on a Mac): while an answer runs, the question is queued to go after it; otherwise it goes now.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      cmdPop.hidden = true;
      if (running) enqueue();
      else submit(textEl.value);
      return;
    }
    // The command list: arrows pick, Tab (or Enter on a partial word) completes, Escape closes.
    if (!cmdPop.hidden) {
      const list = matchCommands(textEl.value);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        cmdIndex = (cmdIndex + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
        renderCommands();
        return;
      }
      const picked = list[cmdIndex];
      const typed = textEl.value.slice(1).toLowerCase();
      const exact = list.some((c) => c.name === typed || c.aliases?.includes(typed));
      if (picked && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact))) {
        e.preventDefault();
        completeCommand(picked.name);
        return;
      }
      if (e.key === 'Escape') {
        cmdPop.hidden = true;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // A question cannot go while an answer runs: say once how to queue it. A command still runs now.
      if (running && textEl.value.trim() && !parseCommand(textEl.value)) {
        if (!hinted) info(`${QUEUE_KEY} queues it to go after this answer.`);
        hinted = true;
        return;
      }
      submit(textEl.value);
    }
  });
  stopBtn.addEventListener('click', () => running?.abort());
  newBtn.addEventListener('click', startNewChat);
  historyBtn.addEventListener('click', () => (historyEl.hidden ? void openHistory() : (historyEl.hidden = true)));
  plusBtn.addEventListener('click', () => (attachPop.hidden ? openAttachMenu() : (attachPop.hidden = true)));
  modelBtn.addEventListener('click', () => (modelPop.hidden ? openModelMenu() : (modelPop.hidden = true)));
  statusEl.addEventListener('change', (e) => {
    if (e.target.id !== 'eye-model') return;
    pickedModel = e.target.value;
    const dev = (status?.devices || []).find((d) => d.state === 'ready') || status?.devices?.[0];
    const btn = statusEl.querySelector('[data-eye-use]');
    if (dev && btn) btn.textContent = useLabel(dev, pickedModel);
  });
  fileEl.addEventListener('change', () => {
    void addImages([...fileEl.files]);
    fileEl.value = '';
  });
  textEl.addEventListener('input', () => {
    textEl.style.height = 'auto';
    textEl.style.height = `${Math.min(textEl.scrollHeight, 200)}px`;
    cmdIndex = 0;
    renderCommands();
  });
  textEl.addEventListener('paste', (e) => {
    const pics = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (pics.length && visionOn()) {
      e.preventDefault();
      void addImages(pics);
    }
  });
  // A click elsewhere closes the open menu.
  document.addEventListener('click', (e) => {
    if (!el.isConnected) return;
    // The path is read at dispatch, so it still holds a menu that a click just redrew.
    const inside = (cls) => e.composedPath().some((n) => n.classList?.contains(cls));
    if (!inside('eye-menu-host')) closePops();
    if (!historyEl.hidden && !inside('eye-history') && !inside('eye-history-btn')) historyEl.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePops();
      historyEl.hidden = true;
    }
  });
  el.addEventListener('click', async (e) => {
    const cmd = e.target.closest('[data-eye-cmd]')?.dataset.eyeCmd;
    if (cmd) {
      completeCommand(cmd);
      return;
    }
    const kind = e.target.closest('[data-eye-attach]')?.dataset.eyeAttach;
    if (kind) {
      if (kind === 'image') {
        attachPop.hidden = true;
        fileEl.click();
      } else {
        openPicker(kind);
      }
      return;
    }
    if (e.target.closest('[data-eye-back]')) {
      openAttachMenu();
      return;
    }
    const model = e.target.closest('[data-eye-model]')?.dataset.eyeModel;
    if (model) {
      void useModel(model);
      return;
    }
    const unattach = e.target.closest('[data-eye-unattach]');
    if (unattach) {
      attachments.splice(Number(unattach.dataset.eyeUnattach), 1);
      renderChips();
      return;
    }
    const unqueue = e.target.closest('[data-eye-unqueue]');
    if (unqueue) {
      queued.splice(Number(unqueue.dataset.eyeUnqueue), 1);
      renderQueue();
      return;
    }
    // A queued question clicked goes back in the composer to edit; Ctrl+Enter queues it again.
    const requeue = e.target.closest('[data-eye-requeue]');
    if (requeue) {
      toComposer(queued.splice(Number(requeue.dataset.eyeRequeue), 1));
      renderQueue();
      textEl.focus();
      return;
    }
    const open = e.target.closest('[data-eye-open]');
    if (open) {
      void openChat(open.dataset.eyeOpen);
      return;
    }
    const del = e.target.closest('[data-eye-delete]');
    if (del) {
      try {
        await call('DELETE', `/api/eye/chats/${del.dataset.eyeDelete}`);
        if (del.dataset.eyeDelete === chatId) startNewChat();
      } catch {
        /* the list below shows what is left */
      }
      void openHistory();
      return;
    }
    const shot = e.target.closest('.eye-shot');
    if (shot) {
      shot.classList.toggle('is-large');
      return;
    }
    const ex = e.target.closest('[data-eye-example]');
    if (ex) {
      textEl.value = ex.textContent;
      textEl.focus();
      return;
    }
    if (e.target.closest('[data-eye-link]')) {
      void linkThisComputer();
      return;
    }
    if (e.target.closest('[data-eye-use]')) {
      const model = el.querySelector('#eye-model')?.value;
      if (!model) return;
      try {
        await call('POST', '/api/eye/command', { command: 'use-model', args: { model } });
      } catch (err) {
        statusError = err.message;
      }
      void refreshStatus();
    }
  });
  // The desktop app tells the page when its link or state changes. Through the bridge, not the
  // window event: in a tab that event fires on the top window only.
  desktop()?.on(() => {
    if (shown) renderStatus();
  });

  renderStatus();
  renderEmpty();
  syncSend();

  return {
    el,
    show() {
      shown = true;
      void refreshStatus().then(() => {
        // Inside the desktop app and signed in, but never linked: do it now.
        const app = desktop();
        // Only once the app has answered (info): before that "not linked" is unknown, and linking then
        // made new links the app never got, evicting the one it had (20 Oct: 8 links in 11 s).
        if (app?.info && !app.info.eyeLinked && !statusError && !status?.online) void linkThisComputer();
      });
      schedulePoll();
    },
    hide() {
      shown = false;
      closePops();
      historyEl.hidden = true;
      clearTimeout(pollTimer);
    }
  };
}
