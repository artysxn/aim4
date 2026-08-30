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
    date: '2026-08-30',
    title: 'Fair use, legal pages, and a steadier viewer',
    tag: 'new',
    points: [
      'Your account is for one player. A sign-in from a different country on a different device of the same kind, within six hours of the last one, is flagged: an iPhone and then another iPhone. A phone and then your PC is not, and the same device never is.',
      'The first flag is a warning with a 60 second wait before you carry on. A second puts the account on probation, which drops it to the free tier until you show the sign-ins were yours. Your subscription keeps running and is not cancelled.',
      'Probation lists your last few sign-ins with the country and device for each, so you can see what was matched. A VPN can trip this, because it changes the country your connection appears to come from. Open a ticket from the contact page and it gets lifted.',
      'New Terms of Service and Privacy pages, linked in the footer: what is stored, how long it is kept, who processes it, and your responsibility for consent when you upload voice recordings. The documentation page now has a section for every page on the site.',
      'Uploads no longer stall while the background ingest is running, and two upload tabs no longer fight each other. Large bulk drops finish instead of failing part way through.',
      'Loading the database, opening demos, anti-strat and the Pattern Finder no longer slow the site down for everyone else while they run.',
      'In the 2D timeline, a round you have opened once switches back instantly. The map also sits clear of the score bar instead of running under it.',
      'The 3D viewer holds the right weapon, utility included, and draws thrown grenades as real models instead of coloured circles. Outlines and names disappear when you turn away from a player, bodies keep animating after a round change, and switching player while paused draws the hands as well as the gun.',
      'The 3D scoreboard uses T red and CT blue, with one square per player and the player you are watching marked. In the POV view their name sits above the playback buttons.',
      'In aim training modes where you click static targets with a pistol, there is no spray pattern and no ammo to run out of.'
    ]
  },
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
