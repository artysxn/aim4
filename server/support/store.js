// ---------------------------------------------------------------------------
// server/support/store.js
// Tickets and notifications, on disk.
//
// One module for both because they are one conversation: a ticket arriving
// notifies the admins, an admin answering notifies the person who asked, and
// keeping the emit next to the write is what stops the two from drifting.
//
// JSON files under server/data/support/, like teams.json and every other
// store on this box: one process owns them, writes are serialized through a
// chain, and the volume carries them across deploys. If aim4 ever runs more
// than one API process, these move to Postgres with everything else.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.AIM4_SUPPORT_DIR || path.join(ROOT, 'server', 'data', 'support');
const TICKETS = () => path.join(DIR, 'tickets.json');
const NOTIFICATIONS = () => path.join(DIR, 'notifications.json');

export const TICKET_STATUSES = Object.freeze(['open', 'answered', 'closed']);

/** Input caps. A ticket is a message, not an upload. */
export const MAX_SUBJECT = 120;
export const MAX_BODY = 4000;
export const MAX_MESSAGES = 60;
/** Kept overall; older rows scroll off. */
const MAX_TICKETS = 2000;
const MAX_NOTIFICATIONS = 1000;

// ---------------------------------------------------------------------------
// Load / persist. Same serialized-chain shape as the Drive queue: loggers and
// handlers both write, and two writers renaming one tmp file is a race.
// ---------------------------------------------------------------------------

const cache = { tickets: null, notifications: null };
let persistChain = Promise.resolve();
let persistSeq = 0;

async function load(kind, file) {
  if (cache[kind]) return cache[kind];
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    cache[kind] = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache[kind] = [];
  }
  return cache[kind];
}

function persist(kind, file) {
  const rows = cache[kind];
  if (!rows) return Promise.resolve();
  persistChain = persistChain
    .then(async () => {
      await fsp.mkdir(DIR, { recursive: true });
      const tmp = `${file}.tmp-${persistSeq++}`;
      await fsp.writeFile(tmp, JSON.stringify(rows, null, 2));
      await fsp.rename(tmp, file);
    })
    .catch((err) => console.warn('[support] write failed:', err?.message || err));
  return persistChain;
}

/** Only for tests. */
export function _resetSupportStore() {
  cache.tickets = null;
  cache.notifications = null;
}

const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

const clip = (s, n) => String(s || '').trim().slice(0, n);

// ---------------------------------------------------------------------------
// Tickets.
// ---------------------------------------------------------------------------

/** What a signed-out reader may see of a ticket: nothing. What its owner and
 *  the admins see is the whole thing minus other people's contact details. */
function ticketView(t, { admin = false } = {}) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    username: t.username || '',
    // The contact address is for the admin's eyes: the owner already knows it.
    ...(admin ? { email: t.email || '', userId: t.userId || '' } : {}),
    messages: t.messages.map((m) => ({ from: m.from, by: m.by || '', text: m.text, at: m.at }))
  };
}

export async function createTicket({ subject, body, email = '', userId = '', username = '' }) {
  const cleanSubject = clip(subject, MAX_SUBJECT);
  const cleanBody = clip(body, MAX_BODY);
  if (cleanSubject.length < 3) return { error: 'Give the ticket a subject.' };
  if (cleanBody.length < 10) return { error: 'Say a little more than that.' };

  const tickets = await load('tickets', TICKETS());
  const ticket = {
    id: newId('t'),
    subject: cleanSubject,
    status: 'open',
    email: clip(email, 200),
    userId: String(userId || ''),
    username: clip(username, 40),
    createdAt: now(),
    updatedAt: now(),
    messages: [{ from: 'user', by: clip(username, 40), text: cleanBody, at: now() }]
  };
  tickets.push(ticket);
  if (tickets.length > MAX_TICKETS) tickets.splice(0, tickets.length - MAX_TICKETS);
  await persist('tickets', TICKETS());

  await notify(
    { audience: 'admins' },
    {
      kind: 'ticket',
      title: 'New support ticket',
      body: `${ticket.username || 'Someone'}: ${ticket.subject}`,
      link: '/admin'
    }
  );
  return { ticket: ticketView(ticket) };
}

export async function listTickets({ status = '' } = {}) {
  const tickets = await load('tickets', TICKETS());
  const rows = status ? tickets.filter((t) => t.status === status) : tickets;
  return rows
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((t) => ticketView(t, { admin: true }));
}

export async function listTicketsFor(userId) {
  if (!userId) return [];
  const tickets = await load('tickets', TICKETS());
  return tickets
    .filter((t) => t.userId === userId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((t) => ticketView(t));
}

export async function countOpenTickets() {
  const tickets = await load('tickets', TICKETS());
  return tickets.filter((t) => t.status === 'open').length;
}

/**
 * Append one message. `asAdmin` flips who is talking, marks the status, and
 * decides who gets notified — the two directions are mirror images.
 */
export async function replyToTicket(id, { text, asAdmin = false, by = '', userId = '' }) {
  const tickets = await load('tickets', TICKETS());
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return { error: 'No such ticket.' };
  if (!asAdmin && ticket.userId !== userId) return { error: 'No such ticket.' };
  if (ticket.messages.length >= MAX_MESSAGES) return { error: 'This ticket is full. Open a new one.' };
  const clean = clip(text, MAX_BODY);
  if (clean.length < 2) return { error: 'Write a reply first.' };

  ticket.messages.push({ from: asAdmin ? 'admin' : 'user', by: clip(by, 40), text: clean, at: now() });
  ticket.status = asAdmin ? 'answered' : 'open';
  ticket.updatedAt = now();
  await persist('tickets', TICKETS());

  if (asAdmin && ticket.userId) {
    await notify(
      { userId: ticket.userId },
      {
        kind: 'ticket',
        title: 'Your ticket got a reply',
        body: ticket.subject,
        link: '/contact'
      }
    );
  } else if (!asAdmin) {
    await notify(
      { audience: 'admins' },
      {
        kind: 'ticket',
        title: 'Ticket updated',
        body: `${ticket.username || 'Someone'}: ${ticket.subject}`,
        link: '/admin'
      }
    );
  }
  return { ticket: ticketView(ticket, { admin: asAdmin }) };
}

export async function setTicketStatus(id, status) {
  if (!TICKET_STATUSES.includes(status)) return { error: 'Unknown status.' };
  const tickets = await load('tickets', TICKETS());
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return { error: 'No such ticket.' };
  ticket.status = status;
  ticket.updatedAt = now();
  await persist('tickets', TICKETS());
  return { ticket: ticketView(ticket, { admin: true }) };
}

// ---------------------------------------------------------------------------
// Notifications.
//
// A row targets either one user (`userId`) or every admin (`audience:
// 'admins'`, resolved against `me.admin` at read time — admins change, and a
// row written to a list of admin ids would go stale with them). Read state is
// per account: one admin dismissing "new ticket" must not dismiss it for the
// other, so reads are a map of userId -> readAt on the row.
// ---------------------------------------------------------------------------

export async function notify(target, { kind = 'info', title, body = '', link = '' }) {
  const cleanTitle = clip(title, 140);
  if (!cleanTitle) return null;
  const rows = await load('notifications', NOTIFICATIONS());
  const row = {
    id: newId('n'),
    userId: String(target.userId || ''),
    audience: target.audience === 'admins' ? 'admins' : '',
    kind: clip(kind, 24),
    title: cleanTitle,
    body: clip(body, 400),
    link: clip(link, 300),
    createdAt: now(),
    readBy: {}
  };
  rows.push(row);
  if (rows.length > MAX_NOTIFICATIONS) rows.splice(0, rows.length - MAX_NOTIFICATIONS);
  await persist('notifications', NOTIFICATIONS());
  return row.id;
}

export async function listNotificationsFor(me, { limit = 50 } = {}) {
  if (!me?.signedIn) return [];
  const rows = await load('notifications', NOTIFICATIONS());
  return rows
    .filter((n) => n.userId === me.id || (n.audience === 'admins' && me.admin))
    .slice(-limit)
    .reverse()
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link,
      createdAt: n.createdAt,
      read: Boolean(n.readBy[me.id])
    }));
}

export async function markNotificationsRead(me, ids) {
  if (!me?.signedIn || !Array.isArray(ids) || !ids.length) return { marked: 0 };
  const rows = await load('notifications', NOTIFICATIONS());
  const wanted = new Set(ids.map(String));
  let marked = 0;
  for (const n of rows) {
    if (!wanted.has(n.id)) continue;
    if (n.userId !== me.id && !(n.audience === 'admins' && me.admin)) continue;
    if (!n.readBy[me.id]) {
      n.readBy[me.id] = now();
      marked++;
    }
  }
  if (marked) await persist('notifications', NOTIFICATIONS());
  return { marked };
}
