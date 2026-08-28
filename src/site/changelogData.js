// ---------------------------------------------------------------------------
// src/site/changelogData.js
// The changelog, written by hand.
//
// Deliberately a file an admin edits, not something generated from commits:
// a commit log says what changed in the code, a changelog says what changed
// for the person using the site, and only a person can tell the difference.
//
// To publish an update: add an entry to the TOP of the list, rebuild, deploy.
// Keep entries in user language ("you can now…"), one entry per release-worth
// of changes, newest first. `tag` is a short chip next to the date: 'new',
// 'improved', or 'fixed' reads best.
// ---------------------------------------------------------------------------

export const CHANGELOG = Object.freeze([
  {
    date: '2026-08-27',
    title: 'Accounts, tips, and the road to subscriptions',
    tag: 'new',
    points: [
      'Create an account with just a username and password. Link Google or Steam later to upload demos; everything else works right away.',
      'Link your Steam account from Account → Connections, verified through Steam sign-in.',
      'The 3D loading screen now shows the map you are about to enter, with rotating tips on things the site can do.',
      'The Subscription page has real plan cards with monthly and yearly pricing. Payments open soon; prices are final.',
      'New: this changelog, a documentation page, and a contact page where you can reach the admin directly.'
    ]
  },
  {
    date: '2026-08-27',
    title: 'Voice comms in the viewer',
    tag: 'new',
    points: [
      'Attach recorded TeamSpeak comms to any demo with the mic button in the viewer. Captions appear over the player who spoke, synced to the round clock.',
      'The aim4 comms recorder is one small program: record your channel, say "record, three, two, one" in round 1 freeze time, and the file syncs itself.',
      'Comms files pack a whole map of voice into about 2 MB and count toward your storage like everything else.'
    ]
  },
  {
    date: '2026-08-15',
    title: 'Practice like it is the real game',
    tag: 'improved',
    points: [
      'All seven competitive maps are walkable in your browser, deathmatch bots included.',
      'Wallbangs use CS2 penetration values, surface by surface.',
      'The doors gamemode holds dust2 mid doors against real pro CT rounds.',
      'Grenade practice and map practice now share one thrower and one movement core, so a lineup that works in one works in the other.'
    ]
  },
  {
    date: '2026-08-01',
    title: 'A faster library',
    tag: 'improved',
    points: [
      'Stats pages read from a hot store: the database, charts, and player pages paint without waiting on a library scan.',
      'Team names are unified across rosters and filenames, and renames update everything at once.',
      'Round links open the exact moment: share a round, not a match.'
    ]
  }
]);
