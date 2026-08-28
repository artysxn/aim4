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
    date: '2026-08-28',
    title: 'Six plans, player scout, and team comms',
    tag: 'new',
    points: [
      'Plans are now two matching ladders. Solo Lite, Solo Premium and Solo Elite are for one player. Team Tier 3, Tier 2 and Tier 1 are the same three steps plus the team toolkit: stratbook, documents, roles, utility archive, team playlists, communication and anti-strat.',
      'The expensive tools are metered by the day instead of being switched off. The entry tiers get one anti-strat, one auto coach and one win-model run a day, the middle tiers three, and the top tiers as many as you want. On a team plan that allowance belongs to the roster, not to each seat.',
      'Pay for 3, 6 or 12 months and the price drops, by more on the higher tiers. Twelve months is 20% off for everyone and up to 28% off on Team Tier 1.',
      'Performance Overview is now open to everyone, signed in or not. Maps and Guns need any paid plan, as does Map Practice.',
      'Pattern Finder has a Players chapter. You can now pick one player on one map, choose the sections, and save a T and CT report into the team Documents tab. Opening Teams or Players is free. Analyze is what spends a daily anti-strat use.',
      'Team Communication is its own page. You can download the TeamSpeak recorder, link each voice to a roster player, and see who talks when across freeze time and the round, filtered by map, side, result and buy.',
      'The Database now shows expected rating (xRtg), overperformance (xRtg%) and true rating (True) after Rating. A Columns button lets you hide metrics you do not need. The choice saves to your account, and hidden columns are not downloaded.',
      'Demo Manager still opens on a first page with Load more when nothing is filtered. Any filter loads the full matching set instead, with no Load more. List rows no longer show who uploaded the demo. With one team selected, that team always sits on the left and the score flips with it.',
      'If you upload a demo that is already in the library, that file is cancelled after it parses. The status line names the file and the match already stored. Other files in the same drop keep uploading. Archives and multi-file drops can no longer take an account past its upload cap.',
      'On the timeline, a CT/T colored swap icon sits on the divider between halves, including overtime side switches.'
    ]
  },
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
