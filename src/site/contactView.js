// ---------------------------------------------------------------------------
// src/site/contactView.js
// /contact: open a ticket, and read the answers to your old ones.
//
// Works signed out — "I cannot sign in" is the most important ticket there is
// — with an optional email for the reply. Signed in, tickets attach to the
// account, replies arrive as notifications, and the conversation continues
// right here.
// ---------------------------------------------------------------------------

import { accessToken } from '../replays/api.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

async function headers() {
  const token = await accessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export function initContactView(host, { auth, escapeHtml }) {
  if (!host) return { onShow() {}, onHide() {} };
  const esc = escapeHtml;

  function shell() {
    const signedIn = auth.isLoggedIn;
    host.innerHTML = `
      <div class="view-pad page-narrow">
        <header class="page-head-block">
          <h1>Contact</h1>
          <p class="page-lede">Bugs, wrong team names, billing, ideas — everything here goes straight to the site admin.</p>
        </header>

        <form class="contact-form" id="contact-form">
          <label class="auth-field">
            <span>Subject</span>
            <input type="text" id="contact-subject" maxlength="120" placeholder="Wrong team name on my mirage match" />
          </label>
          <label class="auth-field">
            <span>What happened?</span>
            <textarea id="contact-body" maxlength="4000" rows="6" placeholder="The more specific, the faster the fix. Links to demos or rounds help a lot."></textarea>
          </label>
          ${
            signedIn
              ? `<p class="contact-hint">Signed in as <strong>${esc(auth.displayName || '')}</strong>. The reply will appear here and as a notification.</p>`
              : `<label class="auth-field">
                   <span>Email for the reply (optional)</span>
                   <input type="email" id="contact-email" maxlength="200" placeholder="you@example.com" />
                 </label>
                 <p class="contact-hint">You are not signed in. With an email we can answer you; without one, check back here is not possible — <a href="/account">sign in</a> to keep the conversation on the site.</p>`
          }
          <p class="auth-status" id="contact-status"></p>
          <button type="submit" class="btn btn-primary" id="contact-send">Send</button>
        </form>

        <div id="contact-tickets"></div>
      </div>`;

    host.querySelector('#contact-form').addEventListener('submit', (e) => {
      e.preventDefault();
      void send();
    });
    if (signedIn) void loadTickets();
  }

  function setStatus(msg, ok = true) {
    const el = host.querySelector('#contact-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !ok);
  }

  async function send() {
    const subject = host.querySelector('#contact-subject')?.value.trim() || '';
    const body = host.querySelector('#contact-body')?.value.trim() || '';
    const email = host.querySelector('#contact-email')?.value.trim() || '';
    if (subject.length < 3 || body.length < 10) {
      setStatus('Give it a subject and a sentence or two.', false);
      return;
    }
    const btn = host.querySelector('#contact-send');
    btn.disabled = true;
    setStatus('Sending…');
    try {
      await asJson(
        await fetch(`${API_BASE}/api/support/tickets`, {
          method: 'POST',
          headers: await headers(),
          body: JSON.stringify({ subject, body, email })
        })
      );
      host.querySelector('#contact-subject').value = '';
      host.querySelector('#contact-body').value = '';
      setStatus('Sent. Thank you — it has landed with the admin.');
      if (auth.isLoggedIn) void loadTickets();
    } catch (err) {
      setStatus(err.message, false);
    } finally {
      btn.disabled = false;
    }
  }

  async function loadTickets() {
    const slot = host.querySelector('#contact-tickets');
    if (!slot) return;
    try {
      const { tickets = [] } = await asJson(
        await fetch(`${API_BASE}/api/support/tickets`, { headers: await headers() })
      );
      if (!tickets.length) {
        slot.innerHTML = '';
        return;
      }
      slot.innerHTML = `
        <h2 class="contact-tickets-title">Your tickets</h2>
        ${tickets.map(ticketHtml).join('')}`;
      slot.querySelectorAll('[data-reply-form]').forEach((form) => {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          void reply(form.dataset.replyForm, form);
        });
      });
    } catch {
      slot.innerHTML = '';
    }
  }

  function ticketHtml(t) {
    const chip = { open: 'Open', answered: 'Answered', closed: 'Closed' }[t.status] || t.status;
    return `
      <article class="contact-ticket is-${esc(t.status)}">
        <header>
          <span class="contact-ticket-chip">${esc(chip)}</span>
          <h3>${esc(t.subject)}</h3>
          <time>${esc(String(t.updatedAt).slice(0, 10))}</time>
        </header>
        <div class="contact-thread">
          ${t.messages
            .map(
              (m) => `
              <div class="contact-msg is-${m.from === 'admin' ? 'admin' : 'user'}">
                <span class="contact-msg-by">${m.from === 'admin' ? 'aim4' : esc(m.by || 'you')}</span>
                <p>${esc(m.text)}</p>
              </div>`
            )
            .join('')}
        </div>
        ${
          t.status !== 'closed'
            ? `<form class="contact-reply" data-reply-form="${esc(t.id)}">
                 <input type="text" maxlength="4000" placeholder="Reply…" />
                 <button type="submit" class="btn btn-sm">Send</button>
               </form>`
            : ''
        }
      </article>`;
  }

  async function reply(id, form) {
    const input = form.querySelector('input');
    const text = input.value.trim();
    if (text.length < 2) return;
    form.querySelector('button').disabled = true;
    try {
      await asJson(
        await fetch(`${API_BASE}/api/support/tickets/${encodeURIComponent(id)}/reply`, {
          method: 'POST',
          headers: await headers(),
          body: JSON.stringify({ text })
        })
      );
      await loadTickets();
    } catch {
      form.querySelector('button').disabled = false;
    }
  }

  // The session restores asynchronously on a cold load; a page rendered a
  // beat too early would keep telling a signed-in person they are not.
  let visible = false;
  auth.onChange(() => {
    if (visible) shell();
  });

  return {
    onShow() {
      visible = true;
      shell();
    },
    onHide() {
      visible = false;
    }
  };
}
