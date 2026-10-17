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

import { accessToken } from '../api.js';
import { runAgentTurn } from './eyeAgent.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
const STATUS_POLL_MS = 3000;

/** The models the desktop app offers. Ids are the app's; sizes are the download. */
export const EYE_MODELS = [
  { id: 'qwen3.5-4b', label: 'Light (Qwen3.5 4B)', size: '2.7 GB', needs: '8 GB RAM' },
  { id: 'qwen3.5-9b', label: 'Standard (Qwen3.5 9B)', size: '5.7 GB', needs: '16 GB RAM or an 8 GB GPU' },
  { id: 'qwen3.5-35b-a3b', label: 'Large (Qwen3.5 35B-A3B)', size: '22 GB', needs: '32 GB RAM, or a 24 GB GPU' }
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

/** The desktop app's bridge, when this page runs inside it. */
const desktop = () => (typeof window !== 'undefined' ? window.aim4Desktop || null : null);

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
  find_rounds: 'Finding rounds',
  round_details: 'Reading a round',
  team_documents: 'Reading team documents',
  team_rankings: 'Reading the ranking',
  site_map: 'Reading the site map',
  screenshot_round: 'Looking at a round',
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
    <section class="an-card eye-status" id="eye-status"></section>
    <section class="an-card eye-chat" id="eye-chat">
      <div class="eye-log" id="eye-log" aria-live="polite"></div>
      <form class="eye-input" id="eye-form">
        <textarea class="site-input" id="eye-text" rows="2" placeholder="Ask about a team" aria-label="Message"></textarea>
        <div class="eye-input-row">
          <button type="button" class="eye-toggle" id="eye-think" aria-pressed="false">Think longer</button>
          <span class="eye-spacer"></span>
          <div class="eye-actions">
            <button type="button" class="eye-btn" id="eye-new">New chat</button>
            <button type="button" class="eye-btn" id="eye-stop" hidden>Stop</button>
            <button type="submit" class="eye-btn is-primary" id="eye-send">Send</button>
          </div>
        </div>
      </form>
    </section>`;
  const statusEl = el.querySelector('#eye-status');
  const chatEl = el.querySelector('#eye-chat');
  const logEl = el.querySelector('#eye-log');
  const form = el.querySelector('#eye-form');
  const textEl = el.querySelector('#eye-text');
  const sendBtn = el.querySelector('#eye-send');
  const stopBtn = el.querySelector('#eye-stop');
  const thinkBtn = el.querySelector('#eye-think');

  /** OpenAI-style history, without the system prompt. */
  let messages = [];
  let status = null;
  let statusError = '';
  let pollTimer = 0;
  let running = null;
  let shown = false;
  let linking = false;
  let thinkLonger = false;

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

  function modelOptions(dev) {
    const recommended = dev.hardware?.recommended || '';
    return EYE_MODELS.map(
      (m) =>
        `<option value="${m.id}"${m.id === (dev.model || recommended) ? ' selected' : ''}>${escapeHtml(m.label)}, ${m.size}${
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
      statusEl.innerHTML = `<div class="eye-status-row"><span class="eye-dot"></span><strong>aim4 eye is not running</strong><span class="eye-spacer"></span>${action}</div>`;
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
        <button type="button" class="eye-btn" data-eye-use>${dev.model ? 'Switch model' : 'Download and start'}</button>
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
    } catch (err) {
      statusError = `Could not link: ${err.message}`;
    }
    linking = false;
    await refreshStatus();
  }

  // ---- the conversation -----------------------------------------------------------

  function syncSend() {
    sendBtn.disabled = Boolean(running) || !ready();
    sendBtn.title = ready() ? '' : 'aim4 eye is not ready';
    stopBtn.hidden = !running;
    thinkBtn.disabled = Boolean(running);
  }

  function renderEmpty() {
    if (logEl.childElementCount) return;
    const intro = document.createElement('div');
    intro.className = 'eye-intro';
    intro.innerHTML = EXAMPLES.map((q) => `<button type="button" class="eye-example" data-eye-example>${escapeHtml(q)}</button>`).join('');
    logEl.appendChild(intro);
  }

  const nearBottom = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 90;
  const toBottom = () => {
    logEl.scrollTop = logEl.scrollHeight;
  };

  function bubble(cls, html = '') {
    const stick = nearBottom();
    const node = document.createElement('div');
    node.className = `eye-msg ${cls}`;
    node.innerHTML = html;
    logEl.appendChild(node);
    if (stick) toBottom();
    return node;
  }

  /** Ask the user, inline in the conversation, before the agent writes anything. */
  function confirmInline(question) {
    return new Promise((resolve) => {
      const node = bubble(
        'eye-confirm',
        `<p>${escapeHtml(question)}</p><div class="eye-confirm-row"><button type="button" class="eye-btn is-primary">Yes</button><button type="button" class="eye-btn">No</button></div>`
      );
      const [yes, no] = node.querySelectorAll('button');
      const done = (answer) => {
        yes.disabled = true;
        no.disabled = true;
        node.classList.add(answer ? 'is-yes' : 'is-no');
        resolve(answer);
      };
      yes.addEventListener('click', () => done(true));
      no.addEventListener('click', () => done(false));
    });
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

  async function ask(text) {
    const q = String(text || '').trim();
    if (!q || running || !ready()) return;
    logEl.querySelector('.eye-intro')?.remove();
    bubble('eye-user', `<p>${escapeHtml(q)}</p>`);
    messages.push({ role: 'user', content: q });
    textEl.value = '';
    const ctrl = new AbortController();
    running = ctrl;
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

    showPending(thinkLonger ? 'Thinking' : 'Working');

    const onEvent = (e) => {
      if (e.type === 'step') {
        closeReasoning();
        endReply();
        showPending(e.step === 0 ? (thinkLonger ? 'Thinking' : 'Working') : `Reading results, step ${e.step + 1}`);
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
        endReply();
        const node = bubble(
          'eye-tool is-running',
          `<div class="eye-tool-head">
            <span class="eye-tool-mark" aria-hidden="true"></span>
            <span class="eye-tool-name">${escapeHtml(TOOL_VERBS[e.name] || e.name)}</span>
            <span class="eye-tool-args">${escapeHtml(argsLine(e.args))}</span>
            <span class="eye-tool-time">0.0s</span>
          </div>
          <div class="eye-tool-status an-muted">Working</div>`
        );
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
        const link = e.result.link ? `<a href="${escapeHtml(e.result.link)}" target="_blank" rel="noopener">Open the rounds</a>` : '';
        const raw = String(e.result.content || '');
        const detail = `<details class="eye-tool-detail"><summary>Details</summary>
          <pre>${escapeHtml(JSON.stringify(e.args || {}, null, 2))}</pre>
          <pre>${escapeHtml(raw.length > 1500 ? `${raw.slice(0, 1500)}\n...` : raw)}</pre></details>`;
        const shots = (e.result.images || []).map((url) => `<img class="eye-shot" src="${escapeHtml(url)}" alt="${escapeHtml(e.result.display || 'Round screenshot')}" />`).join('');
        t.node.querySelector('.eye-tool-status').outerHTML = `<div class="eye-tool-result"><span class="an-muted">${escapeHtml(e.result.display || '')}</span>${link}</div>${shots}${detail}`;
        showPending('Reading results');
      }
    };
    try {
      const vision = Boolean((status?.devices || []).find((d) => d.state === 'ready')?.vision);
      await runAgentTurn(messages, { onEvent, signal: ctrl.signal, thinking: thinkLonger, vision, confirm: confirmInline });
    } catch (err) {
      hidePending();
      if (err.name !== 'AbortError') bubble('eye-error', `<p>${escapeHtml(err.message)}</p>`);
      else bubble('eye-error', '<p>Stopped.</p>');
    }
    hidePending();
    closeReasoning();
    endReply();
    for (const t of tools.values()) {
      clearInterval(t.timer);
      if (t.node.classList.contains('is-running')) t.node.classList.replace('is-running', 'is-error');
    }
    running = null;
    syncSend();
    void refreshStatus();
  }

  // ---- events -----------------------------------------------------------------------

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void ask(textEl.value);
  });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(textEl.value);
    }
  });
  thinkBtn.addEventListener('click', () => {
    thinkLonger = !thinkLonger;
    thinkBtn.setAttribute('aria-pressed', String(thinkLonger));
  });
  stopBtn.addEventListener('click', () => running?.abort());
  el.querySelector('#eye-new').addEventListener('click', () => {
    if (running) return;
    messages = [];
    logEl.replaceChildren();
    renderEmpty();
  });
  el.addEventListener('click', async (e) => {
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
  // The desktop app tells the page when its link or state changes.
  window.addEventListener('aim4-desktop', () => {
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
        if (app && !app.info?.eyeLinked && !statusError && !status?.online) void linkThisComputer();
      });
      schedulePoll();
    },
    hide() {
      shown = false;
      clearTimeout(pollTimer);
    }
  };
}
