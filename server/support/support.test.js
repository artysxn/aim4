// Run: node server/support/support.test.js
//
// Tickets and notifications, and the coupling between them: a ticket arriving
// notifies the admins, an answer notifies the asker, and read state is per
// account so one admin dismissing news does not dismiss it for the other.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-support-'));
process.env.AIM4_SUPPORT_DIR = DIR;

const {
  createTicket,
  listNotificationsFor,
  listTickets,
  listTicketsFor,
  markNotificationsRead,
  countOpenTickets,
  replyToTicket,
  setTicketStatus
} = await import('./store.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ADMIN_A = { signedIn: true, id: 'admin-a', admin: true };
const ADMIN_B = { signedIn: true, id: 'admin-b', admin: true };
const PLAYER = { signedIn: true, id: 'player-1', admin: false };

// ---- creation, and the admin notification it emits ---------------------------
{
  const bad = await createTicket({ subject: 'x', body: 'too short' });
  assert(bad.error, 'a subject of one letter is refused');

  const anon = await createTicket({
    subject: 'Demo stuck on parsing',
    body: 'My demo from last night never finished parsing, id was abc123.',
    email: 'someone@example.com'
  });
  assert(anon.ticket?.id, 'anonymous tickets are allowed');
  assert(!('email' in anon.ticket), 'the contact address is not echoed back');

  const mine = await createTicket({
    subject: 'Wrong team name on my match',
    body: 'The mirage match from Tuesday shows the wrong org for us.',
    userId: PLAYER.id,
    username: 'player_one'
  });
  assert(mine.ticket.username === 'player_one', 'signed-in tickets carry the name');

  const forAdmins = await listNotificationsFor(ADMIN_A);
  assert(forAdmins.length === 2, `both tickets notified the admins (got ${forAdmins.length})`);
  assert(forAdmins[0].title === 'New support ticket', 'as new-ticket news');
  const forPlayer = await listNotificationsFor(PLAYER);
  assert(forPlayer.length === 0, 'the asker is not notified about their own ask');
  assert((await listNotificationsFor({ signedIn: false })).length === 0, 'signed out sees nothing');
}

// ---- scoping -----------------------------------------------------------------
{
  const mine = await listTicketsFor(PLAYER.id);
  assert(mine.length === 1 && mine[0].subject === 'Wrong team name on my match', 'owners see only their own');

  const all = await listTickets({});
  assert(all.length === 2, 'admins see everything');
  const anonRow = all.find((t) => !t.userId);
  assert(anonRow.email === 'someone@example.com', 'including the contact address');
  assert(await countOpenTickets() === 2, 'both open');
}

// ---- the answer flows back ---------------------------------------------------
{
  const [mine] = await listTicketsFor(PLAYER.id);
  const answered = await replyToTicket(mine.id, {
    text: 'Fixed: the org was renamed and the rescan picked it up.',
    asAdmin: true,
    by: 'artysan'
  });
  assert(answered.ticket.status === 'answered', 'answering marks it answered');

  const forPlayer = await listNotificationsFor(PLAYER);
  assert(forPlayer.length === 1 && forPlayer[0].title === 'Your ticket got a reply', 'the asker hears back');
  assert(forPlayer[0].read === false, 'unread until dismissed');

  // The asker replies again: back to open, admins notified again.
  const again = await replyToTicket(mine.id, {
    text: 'Thanks, looks right now!',
    asAdmin: false,
    by: 'player_one',
    userId: PLAYER.id
  });
  assert(again.ticket.status === 'open', 'a user reply reopens');

  const stranger = await replyToTicket(mine.id, {
    text: 'let me in',
    asAdmin: false,
    userId: 'someone-else'
  });
  assert(stranger.error, 'nobody replies to a ticket they do not own');
}

// ---- read state is per account -----------------------------------------------
{
  const aBefore = await listNotificationsFor(ADMIN_A);
  const unreadIds = aBefore.filter((n) => !n.read).map((n) => n.id);
  const marked = await markNotificationsRead(ADMIN_A, unreadIds);
  assert(marked.marked === unreadIds.length, 'admin A dismissed the lot');

  const aAfter = await listNotificationsFor(ADMIN_A);
  assert(aAfter.every((n) => n.read), 'read for A');
  const bAfter = await listNotificationsFor(ADMIN_B);
  assert(bAfter.some((n) => !n.read), 'still unread for B');

  const theft = await markNotificationsRead(PLAYER, unreadIds);
  assert(theft.marked === 0, 'a player cannot mark admin news read');
}

// ---- closing -----------------------------------------------------------------
{
  const [mine] = await listTicketsFor(PLAYER.id);
  const closed = await setTicketStatus(mine.id, 'closed');
  assert(closed.ticket.status === 'closed', 'closes');
  assert((await setTicketStatus(mine.id, 'weird')).error, 'unknown status refused');
  assert(await countOpenTickets() === 1, 'one open remains (the anonymous one)');
}

await fsp.rm(DIR, { recursive: true, force: true });
console.log('support: all assertions passed');
