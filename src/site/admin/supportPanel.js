// ---------------------------------------------------------------------------
// src/site/admin/supportPanel.js
// The support inbox: every ticket from /contact, answerable in place.
//
// A list and a thread, nothing more. Answering marks the ticket answered and
// notifies its owner; closing files it; a user reply reopens it and the
// admin's own notification toast says so.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, el, input, notice } from './dom.js';

const FILTERS = [
  ['', 'All'],
  ['open', 'Open'],
  ['answered', 'Answered'],
  ['closed', 'Closed']
];

export function supportPanel() {
  const root = el('div', 'admin-support');
  let filter = 'open';
  let tickets = [];
  let openId = null;

  const head = el('div', 'admin-support-head');
  const filterRow = el('div', 'admin-support-filters');
  const countChip = el('span', 'ingest-chip is-stopped', '…');
  head.append(filterRow, countChip);
  const listEl = el('div', 'admin-support-list');
  root.append(head, listEl);

  function renderFilters() {
    filterRow.replaceChildren(
      ...FILTERS.map(([id, label]) => {
        const btn = el('button', `admin-tab${filter === id ? ' active' : ''}`, label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          filter = id;
          void load();
        });
        return btn;
      })
    );
  }

  function ticketCard(t) {
    const card = el('div', `admin-ticket is-${t.status}${openId === t.id ? ' is-open' : ''}`);
    const head = el('div', 'admin-ticket-head');
    head.appendChild(el('span', 'contact-ticket-chip', t.status));
    const title = el('span', 'admin-ticket-subject', t.subject);
    head.appendChild(title);
    head.appendChild(
      el('span', 'admin-ticket-who', t.username ? `@${t.username}` : t.email || 'anonymous')
    );
    head.appendChild(el('span', 'admin-ticket-when', String(t.updatedAt).slice(0, 16).replace('T', ' ')));
    head.addEventListener('click', () => {
      openId = openId === t.id ? null : t.id;
      renderList();
    });
    card.appendChild(head);

    if (openId === t.id) {
      const thread = el('div', 'contact-thread');
      for (const m of t.messages) {
        const msg = el('div', `contact-msg is-${m.from === 'admin' ? 'admin' : 'user'}`);
        msg.appendChild(el('span', 'contact-msg-by', m.from === 'admin' ? m.by || 'admin' : m.by || 'user'));
        const p = el('p');
        p.textContent = m.text;
        msg.appendChild(p);
        thread.appendChild(msg);
      }
      card.appendChild(thread);

      const replyRow = el('div', 'contact-reply');
      const field = input('text', '', 'Answer…');
      const send = button(
        'Reply',
        async () => {
          const text = field.value.trim();
          if (text.length < 2) return;
          send.disabled = true;
          try {
            await adminApi.supportReply(t.id, text);
            await load();
          } catch (err) {
            notice(card, err.message, 'error');
            send.disabled = false;
          }
        },
        'btn btn-primary btn-sm'
      );
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          send.click();
        }
      });
      replyRow.append(field, send);
      card.appendChild(replyRow);

      const actions = el('div', 'admin-ticket-actions');
      if (t.status !== 'closed') {
        actions.appendChild(
          button(
            'Close',
            async () => {
              await adminApi.supportStatus(t.id, 'closed').catch(() => {});
              await load();
            },
            'btn btn-sm'
          )
        );
      } else {
        actions.appendChild(
          button(
            'Reopen',
            async () => {
              await adminApi.supportStatus(t.id, 'open').catch(() => {});
              await load();
            },
            'btn btn-sm'
          )
        );
      }
      card.appendChild(actions);
    }
    return card;
  }

  function renderList() {
    renderFilters();
    if (!tickets.length) {
      listEl.replaceChildren(el('p', 'admin-empty', 'No tickets here. Quiet is good.'));
      return;
    }
    listEl.replaceChildren(...tickets.map(ticketCard));
  }

  async function load() {
    try {
      const res = await adminApi.supportTickets(filter);
      tickets = res.tickets || [];
      countChip.textContent = `${res.open ?? 0} open`;
      countChip.className = `ingest-chip ${res.open ? 'is-warn' : 'is-stopped'}`;
      renderList();
    } catch (err) {
      listEl.replaceChildren(el('p', 'admin-error', err.message));
    }
  }

  void load();
  return root;
}
