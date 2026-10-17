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

/**
 * @param {{ escapeHtml: (s: string) => string }} deps
 */
export function createEyePanel({ escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'eye-panel';
  el.innerHTML = `
    <section class="an-card eye-status" id="eye-status"></section>
    <section class="an-card eye-chat">
      <div class="eye-log" id="eye-log"></div>
      <form class="eye-input" id="eye-form">
        <textarea class="site-input" id="eye-text" rows="2" placeholder="Ask aim4 eye about a team…"></textarea>
        <div class="eye-input-row">
          <label class="eye-think"><input type="checkbox" id="eye-think" /> Think longer</label>
          <span class="eye-spacer"></span>
          <button type="button" class="btn btn-sm" id="eye-new">New chat</button>
          <button type="button" class="btn btn-sm" id="eye-stop" hidden>Stop</button>
          <button type="submit" class="btn primary btn-sm" id="eye-send">Send</button>
        </div>
      </form>
    </section>`;
  const statusEl = el.querySelector('#eye-status');
  const logEl = el.querySelector('#eye-log');
  const form = el.querySelector('#eye-form');
  const textEl = el.querySelector('#eye-text');
  const sendBtn = el.querySelector('#eye-send');
  const stopBtn = el.querySelector('#eye-stop');
  const thinkEl = el.querySelector('#eye-think');

  /** OpenAI-style history, without the system prompt. */
  let messages = [];
  let status = null;
  let statusError = '';
  let pollTimer = 0;
  let running = null;
  let shown = false;
  let linking = false;

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
    pollTimer = setTimeout(async () => {
      await refreshStatus();
      schedulePoll();
    }, STATUS_POLL_MS);
  }

  const ready = () => Boolean(status?.ready);

  function renderStatus() {
    const app = desktop();
    if (statusError) {
      statusEl.innerHTML = `<p class="an-muted">${escapeHtml(statusError)}</p>`;
      return;
    }
    if (!status) {
      statusEl.innerHTML = '<p class="an-muted">Checking for aim4 eye…</p>';
      return;
    }
    const dev = status.devices.find((d) => d.state === 'ready') || status.devices[0];
    if (!dev) {
      const linkRow = app
        ? `<p>This is the aim4 desktop app${app.info?.eyeLinked ? ', and it is linked to your account. It will appear here once it has connected.' : '. Link it to your account to run aim4 eye on this computer.'}</p>
           ${app.info?.eyeLinked ? '' : `<button type="button" class="btn primary btn-sm" data-eye-link ${linking ? 'disabled' : ''}>${linking ? 'Linking…' : 'Link this computer'}</button>`}`
        : `<p>aim4 eye runs on your own computer, inside the aim4 desktop app. Download it, open it and sign in: while it runs you can chat with it here, from any browser.</p>
           <a class="btn primary btn-sm" href="/api/recorder/download">Download the aim4 desktop app</a>`;
      statusEl.innerHTML = `<h3 class="an-section-title">aim4 eye is not running</h3>${linkRow}`;
      return;
    }
    const model = EYE_MODELS.find((m) => m.id === dev.model);
    const ram = dev.hardware?.ramGb ? `${dev.hardware.ramGb} GB RAM` : '';
    const state =
      dev.state === 'ready'
        ? `ready, running ${model?.label || dev.model}`
        : dev.state === 'downloading'
          ? `downloading ${model?.label || dev.model}${Number.isFinite(dev.progress) ? ` (${Math.round(dev.progress * 100)}%)` : ''}`
          : dev.state === 'loading'
            ? `loading ${model?.label || dev.model}…`
            : dev.state === 'busy'
              ? 'answering…'
              : dev.state === 'error'
                ? `error: ${dev.message || 'something went wrong'}`
                : 'running, no model loaded';
    const recommended = dev.hardware?.recommended || '';
    const options = EYE_MODELS.map(
      (m) =>
        `<option value="${m.id}"${m.id === (dev.model || recommended) ? ' selected' : ''}>${escapeHtml(m.label)}, ${m.size}${
          m.id === recommended ? ' (recommended)' : ''
        }</option>`
    ).join('');
    statusEl.innerHTML = `
      <div class="eye-status-row">
        <span class="eye-dot ${dev.state === 'ready' ? 'is-on' : dev.state === 'error' ? 'is-bad' : ''}"></span>
        <strong>aim4 eye on ${escapeHtml(dev.name || 'your computer')}</strong>
        <span class="an-muted">${escapeHtml(state)}${ram ? ` · ${escapeHtml(ram)}` : ''}</span>
      </div>
      ${dev.message && dev.state !== 'error' ? `<p class="an-muted">${escapeHtml(dev.message)}</p>` : ''}
      <div class="eye-status-row">
        <select class="site-select an-select" id="eye-model" aria-label="Model">${options}</select>
        <button type="button" class="btn btn-sm" data-eye-use>${dev.model ? 'Switch model' : 'Download and start'}</button>
        <span class="an-muted" id="eye-model-need">${escapeHtml(EYE_MODELS.find((m) => m.id === (dev.model || recommended))?.needs || '')}</span>
      </div>`;
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
  }

  function renderEmpty() {
    if (logEl.childElementCount) return;
    const intro = document.createElement('div');
    intro.className = 'eye-intro';
    intro.innerHTML = `<p>Ask about any team in the library. aim4 eye looks the answer up in the rounds, and every number links to the rounds it came from.</p>
      <p class="an-muted">For example:</p>
      <ul>${EXAMPLES.map((q) => `<li><button type="button" class="eye-example" data-eye-example>${escapeHtml(q)}</button></li>`).join('')}</ul>`;
    logEl.appendChild(intro);
  }

  function bubble(cls, html = '') {
    const node = document.createElement('div');
    node.className = `eye-msg ${cls}`;
    node.innerHTML = html;
    logEl.appendChild(node);
    logEl.scrollTop = logEl.scrollHeight;
    return node;
  }

  /** Ask the user, inline in the conversation, before the agent writes anything. */
  function confirmInline(question) {
    return new Promise((resolve) => {
      const node = bubble(
        'eye-confirm',
        `<p>${escapeHtml(question)}</p><div class="eye-confirm-row"><button type="button" class="btn primary btn-sm">Yes</button><button type="button" class="btn btn-sm">No</button></div>`
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

    let reply = null;
    let replyText = '';
    let thinking = null;
    const tools = new Map();
    const onEvent = (e) => {
      if (e.type === 'step') {
        reply = null;
        replyText = '';
        thinking = null;
      } else if (e.type === 'thinking') {
        thinking ||= bubble('eye-thinking', '<details><summary>Thinking</summary><p></p></details>');
        thinking.querySelector('p').textContent += e.text;
      } else if (e.type === 'text') {
        reply ||= bubble('eye-bot');
        replyText += e.text;
        reply.innerHTML = replyHtml(replyText, escapeHtml);
        logEl.scrollTop = logEl.scrollHeight;
      } else if (e.type === 'tool-start') {
        // A tool call ends whatever text came before it in this step.
        if (reply && !replyText.trim()) reply.remove();
        reply = null;
        replyText = '';
        tools.set(e.id, bubble('eye-tool is-running', `<span class="eye-tool-name">${escapeHtml(e.name)}</span> <span class="an-muted">working…</span>`));
      } else if (e.type === 'tool-progress') {
        const node = tools.get(e.id);
        if (node) node.querySelector('.an-muted').textContent = e.label;
      } else if (e.type === 'tool-done') {
        const node = tools.get(e.id);
        if (!node) return;
        node.classList.remove('is-running');
        node.classList.toggle('is-error', e.result.content.startsWith('Error'));
        const link = e.result.link
          ? ` <a href="${escapeHtml(e.result.link)}" target="_blank" rel="noopener">open the rounds</a>`
          : '';
        node.innerHTML = `<span class="eye-tool-name">${escapeHtml(e.name)}</span> <span class="an-muted">${escapeHtml(e.result.display || '')}</span>${link}`;
      }
    };
    try {
      await runAgentTurn(messages, { onEvent, signal: ctrl.signal, thinking: thinkEl.checked, confirm: confirmInline });
    } catch (err) {
      if (err.name !== 'AbortError') bubble('eye-error', `<p>${escapeHtml(err.message)}</p>`);
      else bubble('eye-error', '<p>Stopped.</p>');
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
  stopBtn.addEventListener('click', () => running?.abort());
  el.querySelector('#eye-new').addEventListener('click', () => {
    if (running) return;
    messages = [];
    logEl.replaceChildren();
    renderEmpty();
  });
  el.addEventListener('click', async (e) => {
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
  el.addEventListener('change', (e) => {
    if (e.target.id === 'eye-model') {
      const need = el.querySelector('#eye-model-need');
      if (need) need.textContent = EYE_MODELS.find((m) => m.id === e.target.value)?.needs || '';
    }
  });
  // The desktop app tells the page when its link or state changes.
  window.addEventListener('aim4-desktop', () => {
    if (shown) renderStatus();
  });

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
