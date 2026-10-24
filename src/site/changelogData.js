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
    date: '2026-10-24',
    title: 'Major update: GIFs, Bookmarks and share links',
    tag: 'new',
    points: [
      'A GIF button in the round viewer turns any part of a round into a GIF. In 2D, drag a box over the part of the radar you want, or keep the whole map. In 3D, follow a player in first or third person, or park the camera where you want it and keep it there.',
      'Pick the part of the round on a slider that shows every kill. GIFs run at 18 FPS in 2D and 24 FPS in 3D by default, and quality goes from 1 to 3: 2D starts at half the resolution on screen and 3D at three quarters, up to full resolution at 3. The round clock is stamped in the corner, unless you switch it off.',
      'Give a GIF a title and a description. Anything you write between < and > becomes a link that copies itself, so <setpos 123 456 78; setang 0 90 0> in a description copies that setpos with one click.',
      'A finished GIF downloads straight away and is saved to Bookmarks with what it shows: the map, the round, both teams with their side and buy, and who won.',
      'Demo Playlists is now Bookmarks, below Performance in the sidebar, with two tabs in the top right. Playlists can be searched by name. Saved GIFs is an image wall you can search and filter by 2D or 3D, map, team, side, buy and the side that won.',
      'Click a GIF to open it next to the rest of the wall: the GIF on the left, and on the right a Copy link button, the title, the description and everything the GIF was saved with.',
      'The link is the GIF itself on aim4.io (aim4.io/g/...gif), so it plays wherever you paste it: Discord, Slack, a forum. aim4.io/g/... without the .gif opens a page with the title, the description and its copy links, for anyone with the link.',
      'aim4 eye can make GIFs for you in the chat, saved to your Bookmarks. The antistrat summary can add GIF highlights at the end of a document: executes, opening kills and retakes from the rounds the sheet was written from.'
    ]
  },
  {
    date: '2026-10-24',
    title: 'Similar Rounds, and what a play was worth',
    tag: 'new',
    points: [
      'A Similar rounds button in the desktop app\'s viewer finds every round on the map that went through the same situation as the one on screen, at the same moment on the clock. Players are matched by how they moved over the last ten seconds and what they carry, and utility by where the same kind landed over the last thirty. Ask about T, CT or both.',
      'Draw on the map to ask your own question: a line with the T or CT pen is a path someone walked, a dot is a spot someone stood on.',
      'Rounds are only compared with rounds of the same buy. Each result shows its dominance, how little win chance that side gave up on the way, and you can filter by it, by won or lost, and to the closest few. A result opens at the same moment in a new tab.',
      'The scan runs on your own PC\'s cores inside the desktop app, and a second scan of the same map reuses what the first one read.',
      'The desktop app learns what is default on each map from your library and reads every round as plays: for T a default, execute, split, rush or contact hit (with fakes), lurk, rotation, post-plant or save; for CT a setup, stack, push, rotation, retake or save. Each play says how usual it is and what it did to the win chance.',
      'Any play can be judged against similar rounds: what other teams chose from the same spot and how each choice went, whether this one went better or worse than the others who chose the same, and which grenades and timings went with winning. The verdict is split into the choice and how it was carried out.'
    ]
  },
  {
    date: '2026-10-24',
    title: 'aim4 eye: playlists, round notes, plays',
    tag: 'improved',
    points: [
      'Ask the eye to make, change or delete a playlist, or to pick rounds for you: for example eight pistol rounds on Ancient that the T side won without ever being two players down.',
      'It writes a short coach\'s note on each round of a playlist, where the round viewer shows it, and can brief you on several rounds at once.',
      'Reviewing a document now edits the points and sections in place and keeps its links, tables and layout.',
      'In the desktop app the eye reads rounds as plays and judges them against similar rounds, guessing first and then checking itself.',
      'Ctrl+Enter queues a follow-up while an answer is still being written. The 27B model writes about twice as fast on the same PC, and two chats at once no longer run each other out of room.',
      'The eye decides once and follows what you asked, instead of reasoning in circles. Admins: a Bad grade with a note is remembered from the eye\'s next answer on.'
    ]
  },
  {
    date: '2026-10-24',
    title: 'Strategies from rounds, written like a coach',
    tag: 'new',
    points: [
      'Add strategy in the viewer writes one note per player the way a coach writes a stratbook: the buy in stratbook shorthand (K, SFF, SF+P250), where they go, what they throw and who they trade. With aim4 eye running, the eye writes the notes from what the round actually shows.',
      'It runs in the background with a small badge in the corner, and tells you when the strategy is saved. The strategy keeps a link to the round it came from.',
      'Setpos in notes writes each grenade as its setpos and setang instead of a link, for teams that keep their book in a sheet.',
      'The Stratbook Editor can copy one map or the whole book, and My Strategies can copy everything, as rows that paste straight into a spreadsheet.'
    ]
  },
  {
    date: '2026-10-24',
    title: 'Desktop app, 3D maps and fixes',
    tag: 'improved',
    points: [
      'The desktop app carries its own server, so it works offline on any PC with the demos stored on it, and goes back to your aim4.io library when it is online.',
      'Tabs are a desktop app feature. In a browser the address bar now shows the page you are actually on.',
      'Links copied or saved in the desktop app point at aim4.io instead of your own PC, including team invites, shared documents and strategies saved to the stratbook.',
      'Demo Manager can filter rounds by the side that won, read from each round\'s recorded result.',
      'The 3D maps light surfaces from the direction the light really comes from, so wall and floor detail shows in the shade too. Maps open faster.',
      'Fixed: icons and the logo sometimes showed as empty squares. Notes you save now show in the viewer straight away.'
    ]
  },
  {
    date: '2026-10-18',
    title: 'aim4 eye: longer chats, kinds of hit, player habits',
    tag: 'new',
    points: [
      'aim4 eye now runs Qwen3.8 27B as its large model. Long chats no longer run out of room: older questions are summarised on their own, and the eye can still look any of them up.',
      'The eye tells an execute from a split by where the players came from, and finds the best rounds of each kind for any team.',
      'Player notes describe how each player plays: where he starts, early fights, trades, utility timing, rotations and lurks, with what to do against him.',
      'The desktop app keeps working offline with the last account that signed in and the demos on your PC. Demos added offline are uploaded when the connection is back.',
      'Admins can publish desktop app builds from the admin page, which is what the download buttons serve.'
    ]
  },
  {
    date: '2026-08-31',
    title: 'See which keys a player is holding',
    tag: 'new',
    points: [
      'A new button in the 3D viewer shows the keys of the player you are watching: W, A, S, D, Ctrl, Shift, Space and both mouse buttons, lit red while they are down. It appears in 3D only, and hides in free roam, where you are nobody.',
      'A demo does not record keypresses. Crouch, walk, scope, jumps and shots come straight from what it does store, and the movement keys are worked back out of the motion using the same equations CS2 uses to turn a key into speed. Counter-strafing shows the key that is braking, not the direction the player is still sliding.',
      'Scored against the game movement code with known inputs: the movement keys are right 95.7% of the time counting every single tick, and 98.1% while a key is being held. Some inputs leave no trace at all, such as holding a direction through a jump without turning, and those are carried from before the jump rather than guessed at.',
      'Included with every subscription.'
    ]
  },
  {
    date: '2026-08-31',
    title: 'Routines, adaptive difficulty, and a coach',
    tag: 'new',
    points: [
      'A Routines page that builds a training playlist for you. Tell it how long you have, and Find routine picks the modes that cover the mechanics you are worst at, measured from your own runs. You can also build one by hand, and anything you save is already in the trainer under Playlists.',
      'Adaptive is a third way to play every gamemode, next to Training and Competitive. It uses competitive rules at your level: target size, speed and tracking duration shift slightly with how you performed, and each mode keeps its own rating starting at 1000. Adjustments are 10 to 50 points a run, so the targets never become a different game.',
      'Leaderboards are split into Standard and Adaptive, so a normalized run is never ranked against a tuned one.',
      'When a mechanic you are training scores worse than your last run on the same mode, the post-game screen says so and gives you something to do about it, with a graph of that category over time.',
      'An activity calendar on the Routines and Performance pages, with a grid for training and a separate one for demos. Hovering a day tells you what you did on it. It is public on every account.'
    ]
  },
  {
    date: '2026-08-31',
    title: 'Aim ratings on a real curve, and CS-exact sensitivity',
    tag: 'improved',
    points: [
      'Aim ratings are recalibrated against the library instead of against fixed guesses. 1.00 is now the average of everyone measured, 2.00 the top 3%, and 0.10 the bottom 3%, on a bell curve. Component scores follow the same shape at 50, 100 and 0. The averages recompute themselves as the library grows.',
      'The Database and a player profile now agree. The Database was serving an older outcome-only rating for players whose motion had since been measured.',
      'Speed and Tension are no longer dropped from demos that every other category could score. They needed more samples than a normal match provides.',
      'The aim trainer now turns exactly as CS2 does, from the game movement code rather than an approximation. Your existing sensitivity was converted rather than reinterpreted, so the number in the settings box has changed but your aim has not. 800 CPI at 1.0 is 51.95 cm for a full turn, as it is in game.',
      'Time spent in the Timeline and Analyzer counts toward your activity. It only counts while the tab is in front and you are actually doing something.'
    ]
  },
  {
    date: '2026-08-31',
    title: 'A cleaner trainer, and a tidier performance page',
    tag: 'improved',
    points: [
      'The in-run HUD is one strip with icons instead of six labelled boxes, and the end-of-run stats now match it. Pausing gives you Resume with Restart and Quit on one row.',
      'The Play page and the in-game gamemode list read the same way: icon, name, then the launch buttons flush against each other. Tag pills and mode counts are gone, and Adaptive is on the website too, showing your level for a mode once it has moved off 1000.',
      'The Routines page uses proper switches for mechanics and icons for row actions, with the duplicate headings and captions removed.',
      'On the Aim chapter, the explanation of what a number means and what average is has moved onto hover, so the table is a table. A category still short of samples keeps its count on screen, because that is something to act on.',
      'The activity calendars sit under the Aim tables rather than across the whole page, and scale to whatever width they are given instead of wrapping into a tall stack.'
    ]
  },
  {
    date: '2026-08-30',
    title: 'Affiliate codes, bigger libraries, faster uploads',
    tag: 'new',
    points: [
      'Account has an Affiliate tab. Share your code, and you earn 20% of what anyone who signs up with it pays, on their first payment and every renewal after it. The tab shows what is pending, what is approved and what has been paid. Commission is worked out on what actually reaches us after payment fees, and is held for 30 days before it becomes payable, in case of a refund.',
      'Paid demo limits are four times larger. Solo Lite holds 100 demos, Solo Premium 300, Team Tier 3 holds 400, and Solo Elite, Team Tier 2 and Team Tier 1 are unlimited.',
      'Uploading a batch no longer means waiting for the whole batch. Each demo starts parsing the moment it finishes uploading, while the rest are still on their way, and when several people upload at once everyone gets a turn instead of the largest drop taking the queue.'
    ]
  },
  {
    date: '2026-08-30',
    title: 'Rename one demo, name the rest',
    tag: 'improved',
    points: [
      'When you give a demo a real team name, other unnamed demos that share that lineup get the same name. Public matches still sitting under a player name are included. A side that already has a proper name is left alone.',
      'The page tells you how many other demos came with it. Saving the same names again does not run another sweep.'
    ]
  },
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
