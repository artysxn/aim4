// ---------------------------------------------------------------------------
// replays/eye/eyeJobs.js
// aim4 eye's background queue: jobs that take the model a while (a round
// written up as a strategy, ~25 s each) run one after another while the user
// keeps working, and each one says when it is done.
//
// The user's model serves one request at a time anyway (the app's
// llama-server runs one slot), so running jobs in turn costs nothing and keeps
// a burst of five strategies from timing out behind each other. A small pill
// in the corner shows what is running and how many wait; a toast says when one
// finishes or fails. In the desktop app the toast goes to the top window, so a
// job finishing behind another tab is still seen.
//
// Jobs live in this page. Closing the page (or the app) drops what is still
// queued, and the pill says so while anything is.
// ---------------------------------------------------------------------------

import { showToast } from '../../site/notify.js';

/** @type {Array<{ id: string, label: string, run: (job: object) => Promise<object>, status: string }>} */
const queue = [];
let running = null;
let seq = 0;
const listeners = new Set();
let pill = null;

/** The document the user is looking at: the desktop app's top window when it is ours. */
function noticeDocument() {
  try {
    if (window.top && window.top !== window && window.top.location.origin === window.location.origin) return window.top.document;
  } catch {
    /* a cross-origin parent */
  }
  return document;
}

/** What is queued and running, for the pill and for anyone listening. */
export function eyeJobsState() {
  return {
    running: running ? { id: running.id, label: running.label, status: running.status } : null,
    waiting: queue.map((j) => ({ id: j.id, label: j.label }))
  };
}

/** Called with the state on every change. Returns the unsubscribe. */
export function onEyeJobs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed() {
  const state = eyeJobsState();
  for (const l of listeners) {
    try {
      l(state);
    } catch {
      /* a listener's own problem */
    }
  }
  renderPill(state);
}

function renderPill(state) {
  if (typeof document === 'undefined') return;
  if (!state.running && !state.waiting.length) {
    pill?.remove();
    pill = null;
    return;
  }
  if (!pill) {
    pill = document.createElement('div');
    pill.className = 'eye-jobs-pill';
    pill.setAttribute('role', 'status');
    pill.title = 'Queued aim4 eye jobs run while this page stays open';
    document.body.appendChild(pill);
  }
  const now = state.running ? `${state.running.label}: ${state.running.status || 'working…'}` : '';
  const more = state.waiting.length ? `${state.waiting.length} queued` : '';
  pill.textContent = ['aim4 eye', now, more].filter(Boolean).join(' · ');
}

/**
 * Queue a job. `run(job)` does the work and may call `job.setStatus(text)`;
 * what it resolves to is the notice: `{ title, body }`. A thrown error becomes
 * a "failed" notice with its message.
 *
 * @param {{ label: string, run: (job: { setStatus: (text: string) => void }) => Promise<{ title: string, body?: string }> }} spec
 * @returns {{ id: string, position: number }} position 0 means it starts now
 */
export function enqueueEyeJob({ label, run }) {
  const job = { id: `eyejob${++seq}`, label: String(label || 'aim4 eye job'), run, status: 'queued' };
  job.setStatus = (text) => {
    job.status = String(text || '');
    if (running === job) changed();
  };
  queue.push(job);
  const position = running ? queue.length : 0;
  changed();
  void pump();
  return { id: job.id, position };
}

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) {
    changed();
    return;
  }
  running = job;
  job.status = 'starting…';
  changed();
  let notice;
  try {
    notice = (await job.run(job)) || { title: `${job.label}: done` };
  } catch (err) {
    notice = { title: `${job.label}: failed`, body: err?.message || 'Something went wrong.', failed: true };
  }
  running = null;
  showToast({ id: job.id, title: notice.title, body: notice.body || '', doc: noticeDocument() });
  changed();
  void pump();
}
