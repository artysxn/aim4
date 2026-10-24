// ---------------------------------------------------------------------------
// src/site/docsContent.js
// What /docs says: every feature of the site, what it is for, how to use it,
// and how to get the most out of it, in plain words.
//
// Data, not markup scattered through a view, for the same reason the
// changelog is (changelogData.js): it is text a person edits, and keeping it
// in one place keeps it reviewable. docsView.js renders it: the groups as the
// section list on the left, every section in order on the right, and a search
// that narrows both.
//
// Rules for what goes in here:
//   * Only what the site does today. A feature that is not open yet gets one
//     line saying so, never a description of what it will do.
//   * Simple words. Say what to click and what comes back.
//   * Every section that has a better and a worse way to use it ends with
//     "For the best results".
//   * No em dashes anywhere (CLAUDE.md).
//
// `html` is trusted, hand-written markup. A literal < in the text is &lt;.
// ---------------------------------------------------------------------------

/** "For the best results" list, the same shape in every section. */
const best = (items) => `<h3>For the best results</h3><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

export const KEYS = [
  ['Space', 'Play / pause'],
  ['← / →', 'Step 2 seconds (hold Shift for 10)'],
  ['O / P', 'Jump 15 seconds back / forward'],
  ['J / K', 'Previous / next round'],
  ['M', 'Cycle playback speed'],
  ['1 to 0', 'Spectate a player by seat'],
  ['V', 'Toggle POV'],
  ['Tab (hold)', 'Stats board'],
  ['F', '3D: follow the spectated player'],
  ['G', '3D: free camera'],
  ['X', '3D: x-ray through walls'],
  ['Q (hold)', '3D: radar overview'],
  ['Scroll', '3D: cycle cameras'],
  ['E', 'Clear your drawings'],
  ['S', 'Copy a setpos for the hovered player']
];

/**
 * @typedef {{ id: string, title: string, html: string }} DocSection
 * @typedef {{ label: string, sections: DocSection[] }} DocGroup
 */

/** @type {DocGroup[]} */
export const DOC_GROUPS = [
  {
    label: 'Start here',
    sections: [
      {
        id: 'start',
        title: 'Getting started',
        html: `
          <p>aim4 turns Counter-Strike 2 demos into something you can watch, search, measure and learn from, and it has an aim trainer and walkable maps for practice.</p>
          <p>You can watch demos, browse the Database and practise <strong>without an account</strong>. An account adds uploads, teams, Bookmarks and settings that follow you between devices.</p>
          <p>Two ways to sign up: <strong>Continue with Google</strong>, or a <strong>username and password</strong>. A username account can do everything except upload demos. For uploads, link Google or Steam once on <a href="/account">Account</a> (the sign-in marks next to your name), so every demo in the shared library has a real person behind it.</p>
          <h3>Finding your way</h3>
          <p>The sidebar has three groups:</p>
          <ul>
            <li><strong>Analytics</strong>: your demos and everything that reads them. Demo Manager, Database, Pattern Finder, aim4 eye, Performance, Bookmarks, My Uploads.</li>
            <li><strong>Team</strong>: what a team works on together. Overview, Documents, Roles &amp; Positions, Stratbook Editor, My Strategies, Drawing Board, Utility Archive, Matches, Communication, 2D Strategy Creator.</li>
            <li><strong>Training</strong>: practice. Play (the aim trainer), Map Practice, Routines, Achievements, Leaderboards, Replay Viewer.</li>
          </ul>
          <p>Signed in, the home page shows where you left off, the demos that landed since your last visit, and how your training is going.</p>
          ${best([
            'Upload your own team\'s matches <em>and</em> your next opponents\' matches. Almost every tool gets better with more rounds of the team you are looking at.',
            'Set a team up early (Team → Overview) so documents, strategies and playlists are shared from the start.',
            'Install the desktop app if you can. aim4 eye, Similar Rounds and the play reviews run there.'
          ])}`
      },
      {
        id: 'desktop',
        title: 'The desktop app',
        html: `
          <p>The aim4 desktop app is the whole site in its own window, plus what only your own PC can do. It is one <code>.exe</code> with nothing to install.</p>
          <ul>
            <li><strong>aim4 eye</strong>, the analyst you chat with, runs on your PC through the app.</li>
            <li><strong>Similar Rounds</strong> and the <strong>play reviews</strong> run on your PC's own processor cores.</li>
            <li><strong>Offline</strong>: the app carries its own server. Without a connection it keeps working with the last account that signed in and the demos stored on that PC. Demos you add offline upload when the connection is back.</li>
            <li><strong>Tabs</strong> along the top, like a browser. Each tab keeps its page and any work in progress, so an aim4 eye answer keeps writing while you look at something else.</li>
            <li>The <strong>comms recorder</strong> opens from the sidebar, under Communication.</li>
            <li>Links you copy or save in the app point at aim4.io, so they work for whoever you send them to.</li>
          </ul>
          <p>When a newer build is out, the app shows a notice with a button that installs it and restarts.</p>
          ${best([
            'Keep the app open while you analyse: the eye, Similar Rounds and play reviews are all faster the second time you ask about a map, because the app keeps what it has read.',
            'If a page says the server is older than the page, close the app and open it again so it starts its newest server.'
          ])}`
      }
    ]
  },
  {
    label: 'Your demos',
    sections: [
      {
        id: 'upload',
        title: 'Uploading demos',
        html: `
          <p>Go to <a href="/uploads">My Uploads</a> and drag in a <code>.dem</code> file, or a <code>.zip</code>, <code>.rar</code> or <code>.gz</code> holding several. The server unpacks it, parses each map, names the teams and files every round into your library. A best-of-three archive becomes its maps automatically.</p>
          <p>Each demo has a <strong>visibility</strong>, set before you upload and changeable later, one demo at a time or several at once:</p>
          <ul>
            <li><strong>Public</strong>: anyone on the site can watch it.</li>
            <li><strong>Unlisted</strong>: your team, and anyone with the link.</li>
            <li><strong>Private</strong>: only you, link or not. This is the default.</li>
          </ul>
          <p>The list of your uploads lets you set visibility per demo, or tick several demos and set it for all of them at once. On each demo you can also write your own <strong>tags</strong> (comma separated) and <strong>rename the teams</strong> when a demo named them badly. A demo that failed to parse has a <strong>Retry</strong> button.</p>
          <p>Everything you upload counts toward one storage meter: demos, extracted rounds and voice comms together. See it under <a href="/account/data">Account → Data</a>.</p>
          ${best([
            'Upload full matches rather than single maps cut from them: round numbers, halves and economy all read from the whole demo.',
            'Fix team names straight away with Rename teams. Filters, documents and Performance group by team, and a misnamed team splits in two.',
            'Use Unlisted for scrims you want your team to see but not the rest of the site.'
          ])}`
      },
      {
        id: 'demo-manager',
        title: 'Demo Manager: finding rounds',
        html: `
          <p><a href="/demos">Demo Manager</a> lists your library match by match, and every round inside each match. The filters on the left narrow it down to exactly the rounds you want, across the whole library.</p>
          <h3>The filters</h3>
          <ul>
            <li><strong>Search teams</strong> and <strong>Any map</strong>: pick one or more teams and maps.</li>
            <li><strong>Team 1's buy</strong> and <strong>Team 2's buy</strong> (pistol, eco, half buy, force buy, full buy), each with an <strong>AWP</strong> switch.</li>
            <li><strong>Side</strong> (T or CT): with one team picked, the side that team played.</li>
            <li><strong>Won</strong> / <strong>Lost</strong>: rounds the team you picked won, or lost. Click the lit button again to turn it off.</li>
            <li><strong>T won</strong> / <strong>CT won</strong>: the side that won, read from the round's own result.</li>
            <li><strong>Dominance</strong>: a slider with two handles. Keep rounds whose dominance is between them, from clean wins (90 to 100) to scrappy rounds (0 to 40). See <a href="#dominance">Dominance</a>.</li>
            <li><strong>Round type</strong> and <strong>vs round type</strong>: the kind of round a side played on that map, and what the other side played against it. Pick one map and a side first.</li>
            <li><strong>Rank</strong>: the world ranking of each team at the time.</li>
            <li><strong>Decided Midround</strong> / <strong>Decided Lateround</strong>: when the round was really decided.</li>
            <li><strong>Opening</strong> (4v4, 5v4, 5v3, 4v5, 3v5): with one team picked, how the first fights went for that team and whether it kept the advantage.</li>
            <li><strong>Tags</strong>: your own labels from My Uploads, as chips.</li>
            <li><strong>Public</strong> / <strong>My Uploads</strong>: the whole shared library, or only yours.</li>
          </ul>
          <h3>What to do with the rounds</h3>
          <ul>
            <li>Click rounds to select them, or <strong>Select all</strong>, then <strong>Load rounds</strong> to watch them back to back in the viewer.</li>
            <li><strong>Analyzer</strong> lays every selected round over one radar. See <a href="#analyzer">Analyzer</a>.</li>
            <li><strong>Database</strong> opens the stats for the selection. On each match, the chart button opens the Database for that match only.</li>
            <li>A note icon on a round means it has notes; a bookmark icon means it is in a playlist.</li>
          </ul>
          ${best([
            'Start broad and add one filter at a time: you will see which filter empties the list.',
            'For anti-stratting, pick the opponent, the map and their side, then their buy. That one combination is usually all you need.',
            'Use Select all and Load rounds to watch every match of a situation in a row; the viewer skips the buy time by itself.'
          ])}`
      },
      {
        id: 'dominance',
        title: 'Dominance',
        html: `
          <p>Dominance says how cleanly a side won a round: how little of its chance to win it gave up on the way. It runs from 0 to 100.</p>
          <ul>
            <li><strong>100</strong>: the side's win chance never dropped. It was in control from the first second to the last.</li>
            <li><strong>90</strong>: it gave up 10 points of win chance in total along the way, for example one fight it lost before taking the round anyway.</li>
            <li><strong>50 or less</strong>: a scrappy round, or one the side lost.</li>
          </ul>
          <p>Every drop counts and nothing else does. A side that starts at 5% and climbs to the win scores 100: it never lost ground. A side that starts at 50%, dips to 40% and wins scores 90.</p>
          <p>The win chance comes from aim4's round model: players alive and their health, equipment, the bomb, the clock and the economy, read through the whole round.</p>
          <h3>Where you find it</h3>
          <ul>
            <li><strong>Demo Manager</strong>: the Dominance slider. Drag the left handle up for clean rounds, or the right handle down for close ones. It reads the dominance of the team you picked; with no team, the side in the Side filter; with neither, the side that won. Each round in the list then shows its number.</li>
            <li><strong>Similar Rounds</strong> shows it on every result and can filter by it.</li>
          </ul>
          ${best([
            'To study how a team wins cleanly, pick the team and the map, then drag Dominance to 90 to 100. Those rounds are the ones worth copying.',
            'To find the rounds a team nearly threw, pick the team and Won, then drag Dominance down to 0 to 40.',
            'To find a team\'s best rounds on one side, set Side as well: Dominance then reads that side.',
            'The first time you filter a large library it takes a moment to read every round; after that it is instant.'
          ])}`
      }
    ]
  },
  {
    label: 'Watching rounds',
    sections: [
      {
        id: 'watch',
        title: 'The round viewer',
        html: `
          <p>Open any round from Demo Manager, the Database, a playlist or a shared link. The viewer starts on the 2D radar; the <strong>3D button</strong> rebuilds the same moment inside the real map, in your browser. Both views share one clock, so switching mid-round moves nothing.</p>
          <ul>
            <li><strong>Playback</strong>: play/pause, 10-second jumps back and forward, and the speed button in the bottom-left corner.</li>
            <li><strong>The timeline</strong> under the map: drag it anywhere in the round. Buy time, the plant and the defuse are coloured on it, and kills are marked. Dropping into the buy keeps you there; otherwise playing into a round skips straight to the first live second.</li>
            <li><strong>Round chips</strong> above the timeline switch between the rounds you loaded.</li>
            <li><strong>The clock</strong> at the top: click it to copy a link to this exact moment. Links work for people without an account.</li>
            <li><strong>The scoreboard and kill feed</strong> follow the clock. Hold <kbd>Tab</kbd> for the full stats board.</li>
            <li><strong>The side panel</strong> shows the predicted win rate of each side and map control in percent, live.</li>
            <li>Click a player's number to spectate them; <kbd>V</kbd> shows only what they could see.</li>
          </ul>
          ${best([
            'Learn the keys (next section). Stepping 2 seconds with the arrows is the fastest way to study a fight.',
            'Copy the link to a moment instead of describing it: whoever opens it lands on the same tick.',
            'Load several rounds at once from Demo Manager and step through them with J and K.'
          ])}`
      },
      {
        id: 'keys',
        title: 'Keyboard shortcuts',
        html: '' // the table is rendered from KEYS by docsView
      },
      {
        id: '3d',
        title: 'The 3D view',
        html: `
          <p>The 3D view rebuilds the round inside the real map: bodies, guns, grenades, smokes, fire, flashes, dropped weapons and shots.</p>
          <p>Camera modes, cycled with the mouse wheel:</p>
          <ul>
            <li><strong>Walk</strong> and <strong>fly</strong>: move around freely, like Map Practice. <kbd>G</kbd> switches to these.</li>
            <li><strong>First person</strong>: through the spectated player's eyes, as recorded. <kbd>F</kbd> switches to the follow cameras; click a roster number to change player.</li>
            <li><strong>Third person</strong>: just behind that same player.</li>
          </ul>
          <p><kbd>X</kbd> turns on x-ray through walls, and holding <kbd>Q</kbd> shows the radar overview. Right click (or the free-look button) looks around without moving.</p>
          ${best([
            'Use first person to judge a peek or a flash: you see what the player saw.',
            'Use x-ray with the free camera to check who was holding which angle at the moment of a fight.',
            'Large maps take a few seconds the first time; switching between 2D and 3D after that is instant.'
          ])}`
      },
      {
        id: 'viewer-tools',
        title: 'Analysis tools in the viewer',
        html: `
          <p>The buttons around the map add layers to the round. Each one is a toggle.</p>
          <ul>
            <li><strong>Map positions (zones)</strong>: the named positions of the map, coloured by who is active in them, who controls them and which are contested.</li>
            <li><strong>Win chance chart</strong>: both sides' chance to win over the whole round. The big steps are the moments that decided it.</li>
            <li><strong>Duels</strong>: every live gunfight with each player's chance to win it, and <strong>xK</strong> beside each fighter: their win chances added up over all the fights they are in. Hover a player or a line for the numbers.</li>
            <li><strong>Team POV</strong>: the round as one team knew it. Enemies show only while someone on that team can see them, and only that team's own map control is painted.</li>
            <li><strong>Keypresses</strong>: which keys a player was holding (W, A, S, D, crouch, jump, scope, shoot), worked out from how they moved.</li>
            <li><strong>Coach</strong>: mistake notes for one team, sorted into Carelessness, Mechanical error, Quality, Synchronization and Well played. Each note sits at the tick it happened and can be accepted or dismissed.</li>
            <li><strong>Drawing</strong>: pens in several colours, including a T and a CT pen, and an eraser that removes a line you drag over. Right click always draws. <kbd>E</kbd> clears your drawings.</li>
            <li><strong>Notes</strong>: write a note at any moment of a round; it appears when playback reaches it, and the round shows a note icon in Demo Manager.</li>
            <li><strong>Voice comms</strong>: attach a recorded TeamSpeak session to the demo. See <a href="#comms">Voice comms</a>.</li>
          </ul>
          ${best([
            'Open the win chance chart first, then jump to the biggest steps: those are the moments worth your time.',
            'Use Duels to separate bad decisions from bad luck. A death in a fight the player was favoured to win is variance; a death in a fight they were already losing is the mistake.',
            'Use Team POV to judge rotations and calls: it shows only what the team actually had to go on.',
            'Coach notes are a checklist, not a verdict. Accept the ones that are right and dismiss the rest; that keeps the round\'s notes useful for the next person.'
          ])}`
      },
      {
        id: 'analyzer',
        title: 'Analyzer',
        html: `
          <p>The Analyzer lays every selected round over one radar, all synced from the end of the buy time, so you see a team's habits at a glance instead of round by round.</p>
          <ol>
            <li>In Demo Manager, select rounds on one map with one team picked.</li>
            <li>Click <strong>Analyzer</strong>.</li>
            <li>Filter by that team's side, buy and players (each player keeps one colour) and choose which utility to show.</li>
          </ol>
          <p>Hover a round to preview it on its own, click to open it, or box-select a group of paths to open those rounds in the viewer.</p>
          ${best([
            'Keep it to one side and one buy: mixing T and CT, or full buys and ecos, turns the overlay into noise.',
            'Turn players on one at a time to read each player\'s routes, then turn them all on to read the team\'s shape.'
          ])}`
      },
      {
        id: 'similar',
        title: 'Similar Rounds',
        html: `
          <p>Similar Rounds (desktop app) finds every round on the map that went through the same situation as the one on screen, at the same moment on the clock. It is how you answer "what do teams usually do from here, and how does it go?"</p>
          <ol>
            <li>Pause the round at the moment you care about.</li>
            <li>Open <strong>Similar rounds</strong> from the viewer's tools.</li>
            <li>Choose the side the question is about (T, CT or both sides), and what to compare: <strong>Round</strong> (positions, weapons and utility), <strong>Drawing</strong> (what you drew on the map), or <strong>Both</strong>.</li>
            <li>Press <strong>Scan</strong>.</li>
          </ol>
          <p>Players are matched by how they moved over the last ten seconds and what they carry; utility by where the same kind of grenade landed over the last thirty seconds. Rounds are only ever compared with rounds of the same buy.</p>
          <p>To ask your own question, draw on the map first: a line with the T or CT pen means "someone of that side walked here", a dot means "someone stood here".</p>
          <p>Each result shows how similar it is (in percent), whether that side won, and its <a href="#dominance">dominance</a>. Filter the results by minimum dominance, by won or lost, and to the closest few. A result opens in a new tab at the same moment of its own round.</p>
          ${best([
            'Ask at a moment where something is about to happen (just before a hit, a rotation, a retake), not in the middle of a fight.',
            'Filter to won rounds with high dominance to see what worked; then to lost rounds to see what did not.',
            'The first scan of a map reads every round on it and takes the longest; scans after that reuse it.',
            'A small library gives loose matches. The more rounds of that map you have, the closer the results.'
          ])}`
      },
      {
        id: 'plays',
        title: 'Plays: default or play, and was it good',
        html: `
          <p>In the desktop app, aim4 can read any round as <strong>plays</strong>: the decisions each side made, as opposed to its <strong>default</strong>. It learns what is default on each map from your library: where each side usually stands, per buy, every ten seconds of the round.</p>
          <p>What it reads:</p>
          <ul>
            <li><strong>T side</strong>: default, execute, split, rush, contact hit (each with any fake before it), lurk, rotation, post-plant, save.</li>
            <li><strong>CT side</strong>: setup (and whether it is a common one), stack, push, one player's aggression, rotation, retake, save.</li>
            <li>The <strong>opening kill</strong>.</li>
          </ul>
          <p>Every play comes with how usual it is on the map ("12% of full buys"), when it started, who was in it, and what it did to the side's win chance.</p>
          <p>Any play can then be <strong>judged against similar rounds</strong>: what other teams chose from the same spot and how often each choice won, how this one went compared with the others that chose the same, and which grenades and timings went with winning. For example: "similar A executes with a flash on the site won 9 of 14, without it 6 of 16". The verdict is split in two: the <strong>choice</strong> (against the alternatives) and the <strong>execution</strong> (against the same choice). When there are too few similar rounds to measure anything, the autocoach's rules are shown instead, marked as rules.</p>
          <p>You use this through aim4 eye: ask "what did each side do in this round?" or "was T's B execute at 1:05 a good play, and how could it have been better?"</p>
          ${best([
            'Trust the verdict as far as it says: "trust: good" rests on close similar rounds, "loose" or "thin" is a lean, not a finding.',
            'Read the decision and the execution separately. A good call can be played badly, and a bad call can work.',
            'The improvements come with their counts. A difference of a few rounds is a hint; a difference over dozens of rounds is worth changing your strat for.'
          ])}`
      },
      {
        id: 'gifs',
        title: 'GIFs',
        html: `
          <p>The <strong>Create GIF</strong> button in the viewer turns any part of a round into a GIF.</p>
          <ol>
            <li>Choose <strong>2D</strong> or <strong>3D</strong>. In 2D, <strong>Select area</strong> and drag a box over the part of the radar you want, or keep the whole map. In 3D, follow a player in first or third person, or keep the camera where it is.</li>
            <li>Pick the part of the round on the slider. It is tied to the round's own timeline: drag either end and the round shows that moment; move the round's timeline and the part moves with it, keeping its length. The white line on the slider is where the round is now.</li>
            <li>Choose the <strong>quality</strong> (1 to 3) and the <strong>FPS</strong>. 2D defaults to 18 FPS and 3D to 24.</li>
            <li>Give it a title and a description. Anything between &lt; and &gt; in the description becomes a link that copies itself, so &lt;setpos 123 456 78; setang 0 90 0&gt; copies that setpos with one click.</li>
            <li>In 3D, tick <strong>Automatically append setpos</strong> (next to Round clock) to add a line for every grenade thrown in the part, such as <code>01:43 dex Flash &lt;setpos ...; setang ... 0&gt;</code>. The position and aim are read the tick before the grenade leaves the thrower's hand, so the setpos stands you on the lineup. The line under the settings counts the grenades it will add.</li>
            <li>Press <strong>Create GIF</strong>.</li>
          </ol>
          <p>The GIF downloads straight away and is saved to <a href="/bookmarks?tab=gifs">Bookmarks → Saved GIFs</a> with what it shows: the map, the round, both teams with their side and buy, and who won. Bookmarks keep GIFs up to 40 MB; a bigger one still downloads in full, and a smaller copy is made and saved for Bookmarks automatically. The round clock is stamped in the corner unless you switch it off.</p>
          <p><strong>Copy link</strong> gives the GIF's own address on aim4.io, so it plays wherever you paste it (Discord, Slack, a forum). The same link without <code>.gif</code> opens a page with the title, description and its copy links.</p>
          ${best([
            '2D GIFs are small and sharp; use them for setups, rotations and utility. Use 3D for a peek, a flash or a clutch.',
            'Keep 3D GIFs short. A few seconds at quality 2 is usually clearer than a long one at quality 3, and it stays under the Bookmarks limit.',
            'Select an area in 2D to cut out the half of the map nothing happens on: the GIF gets bigger where it matters.',
            'Put the setpos of the key spot in the description so your teammates can practise it straight from the GIF. For a GIF of an execute, Automatically append setpos does it for every grenade at once.',
            'A jump throw\'s setpos is in the air, because that is where the thrower was the tick before release. Paste it, then jump-throw from there as usual.'
          ])}`
      },
      {
        id: 'bookmarks',
        title: 'Bookmarks: playlists and saved GIFs',
        html: `
          <p><a href="/bookmarks">Bookmarks</a> has two tabs, top right.</p>
          <h3>Playlists</h3>
          <p>A playlist is a list of rounds from any matches, in the order you want. In the viewer, the bookmark button saves the round on screen to a playlist or creates a new one. A playlist is <strong>Private</strong> or shared with your <strong>Team</strong>, and can be searched by name.</p>
          <h3>Saved GIFs</h3>
          <p>Every GIF you made is here as an image wall. Search it and filter by 2D or 3D, map, team, side, buy and the side that won. Click a GIF to open it next to the rest of the wall: the GIF on the left, and on the right <strong>Copy link</strong>, the title, the description and everything it was saved with. You can edit the title and description or delete it.</p>
          ${best([
            'Build one playlist per idea ("NAVI B executes, Mirage") rather than one per match. A playlist that answers one question is one you will open again.',
            'Share prep playlists with your team so everyone watches the same rounds before a match.',
            'aim4 eye can build playlists for you from a description, and write a short coach\'s note on every round of one.'
          ])}`
      },
      {
        id: 'strategy-from-round',
        title: 'Add strategy from a round',
        html: `
          <p>Found a round worth running yourself? In the viewer's playlist panel, <strong>Add strategy</strong> turns it into a stratbook strategy.</p>
          <ul>
            <li>It writes one note per player the way a coach writes a stratbook: the buy in stratbook shorthand (K, SFF, SF+P250), where they go, what they throw and who they trade.</li>
            <li>With aim4 eye running, the eye writes the notes from what the round actually shows.</li>
            <li>It runs in the background with a small badge in the corner and tells you when the strategy is saved. The strategy keeps a link to the round it came from.</li>
            <li><strong>Setpos in notes</strong> writes each grenade as its setpos and setang instead of a link, for teams that keep their book in a sheet.</li>
          </ul>
          ${best([
            'Pick the side, the call type and the economy the strategy is for before you save; they decide where it is filed in the stratbook.',
            'Read the notes once and trim them. The draft is a starting point; your players will run what you leave in.'
          ])}`
      }
    ]
  },
  {
    label: 'Stats and scouting',
    sections: [
      {
        id: 'database',
        title: 'Database',
        html: `
          <p>The <a href="/database">Database</a> is every parsed round in two tables: <strong>players</strong> and <strong>teams</strong>.</p>
          <ul>
            <li>Filter by map, side, your buy and the enemy's buy, result, team, dates, both teams' ranks, and a minimum number of rounds.</li>
            <li>The <strong>Columns</strong> picker adds or removes columns, each with a plain description of what it measures (rating, KAST, ADR, opening kills, utility damage, AWP accuracy and many more).</li>
            <li>Sort by any column. Turning a column off also makes the page lighter to load.</li>
          </ul>
          <p>Click a player's name to open their <a href="#player-pages">player page</a>.</p>
          ${best([
            'Always set a minimum number of rounds. A player with 12 rounds at a 1.80 rating tells you nothing.',
            'Compare like with like: full buys against full buys, one map at a time.',
            'Use the buy filters to see who wins anti-ecos and forces, not just full buys.'
          ])}`
      },
      {
        id: 'player-pages',
        title: 'Player pages',
        html: `
          <p>Every player in the library has a page of their own, with one address you can share: their rounds, maps and sides, and the splits that answer "what does he do on Mirage as CT". Click a player's name anywhere on the site to open it.</p>
          ${best(['Use the map and side splits to prepare for one opponent: a player\'s habits are usually specific to one map and one side.'])}`
      },
      {
        id: 'pattern-finder',
        title: 'Pattern Finder: Search',
        html: `
          <p><a href="/patterns">Pattern Finder</a> searches your whole library for rounds that match a situation you describe, and shows how they went. It has four chapters: <strong>Search</strong>, <strong>Teams</strong>, <strong>Players</strong> and <strong>Charts</strong>.</p>
          <h3>Search</h3>
          <ol>
            <li>Pick a map first, then filter by teams or players, buys and AWPs.</li>
            <li>Draw a selection on the radar and choose what it means: <strong>Player in</strong>, <strong>Kill from</strong>, <strong>Died in</strong>, <strong>First duel in</strong>, <strong>Grenade in</strong> (with which grenades count) or <strong>Map control in</strong>.</li>
            <li>Give each selection its own clock window (for example 1:40 to 1:20), or keep the whole round.</li>
            <li>Add more selections; a round must match all of them.</li>
          </ol>
          <p>The matching rounds appear on the left, with stats on the right (by players or by teams). <strong>Play in Timeline</strong> opens them in the viewer.</p>
          ${best([
            'Ask one question at a time: "when they have someone in B apartments before 1:20, do they go B?" is one selection and one window.',
            'Map control in is the odd one out: it keeps every round and tells you how they split by who held that ground. Use it to measure whether controlling a spot matters.',
            'Check the count before you trust a rate. Under about eight rounds, it is an impression.'
          ])}`
      },
      {
        id: 'antistrat',
        title: 'Pattern Finder: Teams (anti-strat documents)',
        html: `
          <p>The <strong>Teams</strong> chapter scouts one team on one map and writes what it finds into a document in your team's Documents.</p>
          <ol>
            <li>Search for the team, then pick the map (it warns you when there are too few matches).</li>
            <li>Tick the matches to include and the categories you want.</li>
            <li>Choose the kind of document: <strong>Detailed</strong> (every number the scan has), <strong>Summary</strong> (the prep sheet a coach writes for a match, as a Full summary, a Simple outline or a Sixpack of six boxes per side) or <strong>Internal</strong> (the same scan on your own rounds, to find what loses them).</li>
            <li>Generate. The document lands in <a href="/team/documents">Team → Documents</a>.</li>
          </ol>
          <p>The summary reads like a coach's sheet: positions, pistols, pace, tells ("this smoke means that site, 12 of 13"), what to do against them, forces and anti-ecos, default utility, repeated smokes, dangerous rounds and players. It can add GIF highlights at the end: executes, opening kills and retakes from the rounds it was written from. You can queue several teams and maps at once.</p>
          <p>Anti-strat documents are a daily allowance shared by everyone on the subscription.</p>
          ${best([
            'Use recent matches. A team changes its book every few weeks; old demos describe a team that no longer exists.',
            'Five or more matches on the map is where the tells become reliable.',
            'Ask aim4 eye to review the document afterwards: it checks every number against the data and points out thin or missing points.'
          ])}`
      },
      {
        id: 'scout-players',
        title: 'Pattern Finder: Players',
        html: `
          <p>The <strong>Players</strong> chapter does the same for one player: what they repeat (where they play, when they move, what they throw, how they take fights) and what they do instead. It writes a document the same way, in the same three kinds.</p>
          ${best(['Scout the opponent\'s AWPer and entry first: their habits decide most rounds.'])}`
      },
      {
        id: 'charts',
        title: 'Pattern Finder: Charts',
        html: `
          <p><strong>Charts</strong> builds graphs from any stat. On the left: the chart type, what one point is (a player, a team, a match...), both axes each with their own filters, how to split it into series, and options. On the right: the chart, a fitted trend line and a table of the points.</p>
          ${best([
            'Put the stat you want to explain on the vertical axis and the one you think explains it on the horizontal one.',
            'Filter each axis to the same map and buy, or the chart mixes situations.'
          ])}`
      },
      {
        id: 'performance',
        title: 'Performance',
        html: `
          <p><a href="/performance">Performance</a> shows one player, or one team, over time. Search for the player or team, then narrow it by dates or the last few matches, map, side, buy, the enemy's buy and AWP.</p>
          <ul>
            <li><strong>Summary</strong>: rating, form over time, roles and recent matches (for a team, its roster).</li>
            <li><strong>Guns</strong>: how each weapon goes (players only).</li>
            <li><strong>Maps</strong>: a table per map and side of every kind of round played, with how it went.</li>
            <li><strong>Zones</strong>: the map with every position on it and the rating there.</li>
            <li><strong>Aim</strong>: the aim numbers read from the demos.</li>
          </ul>
          ${best([
            'Look at form over the last ten matches, not the career number: it is what has changed recently that you can act on.',
            'Zones shows where a player is strong and weak on one map. Put them where they win.'
          ])}`
      }
    ]
  },
  {
    label: 'aim4 eye',
    sections: [
      {
        id: 'eye',
        title: 'aim4 eye',
        html: `
          <p><a href="/eye">aim4 eye</a> is an analyst you chat with. It reads your library round by round and answers in plain words, with the numbers behind them. The model runs on your own PC through the desktop app; nothing you ask leaves your computer except the questions it sends to your own library.</p>
          <h3>Setting it up</h3>
          <ol>
            <li>Install and open the <a href="#desktop">desktop app</a>, signed in.</li>
            <li>Open the aim4 eye page inside the app. It links your computer by itself (or press <strong>Link this computer</strong>). Then pick a model: <strong>Light</strong> (2.7 GB, needs 8 GB of RAM), <strong>Standard</strong> (5.7 GB, 16 GB of RAM or an 8 GB GPU) or <strong>Large</strong> (17 GB, 32 GB of RAM or a 24 GB GPU). It downloads once.</li>
            <li>Ask a question.</li>
          </ol>
          <h3>What it can do</h3>
          <ul>
            <li>Tell you what happened in a round, like a commentator, and what each side's plays were.</li>
            <li>Say what decided a round and judge a play or a death with the win-chance numbers.</li>
            <li>Find a team's weaknesses and tells, with the rounds behind each one.</li>
            <li>Count anything over many rounds ("when they have someone in B before 1:20, where do they go?").</li>
            <li>Look up stats for players and teams, scores and top performers of a match, and the world ranking.</li>
            <li>Write, review and rewrite anti-strat documents, and queue many at once.</li>
            <li>Build, change and delete playlists, pick rounds for you ("eight pistol rounds on Ancient the T side won without ever being two down"), and write a note on every round of a playlist.</li>
            <li>Turn a round into a stratbook strategy, and make GIFs.</li>
            <li>With a model that reads pictures, look at a screenshot or a photo you attach.</li>
          </ul>
          <h3>Commands</h3>
          <p>Type <code>/</code> in the box for the list: <code>/new</code> starts a new chat, <code>/retry</code> asks the last question again, <code>/copy</code> copies the last answer, <code>/export</code> downloads the chat, <code>/compact</code> summarises the chat so far to make room, <code>/context</code> shows how full it is, <code>/help</code> lists them. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> queues a follow-up while an answer is still being written.</p>
          ${best([
            'Name the team, the map and the side: "how do FaZe play T side on Mirage?" gets a far better answer than "how do they play?"',
            'Ask one thing at a time and follow up. Long chats are folded into a summary to make room, and the eye can look back at anything folded.',
            'Ask for counts, not opinions: "in how many of their rounds..." makes it count over the library instead of describing a few rounds.',
            'Use the largest model your PC can run. It is slower, and noticeably better at long documents.',
            'Answers come with their numbers. If one looks wrong, ask "which rounds is that from?" and open them.'
          ])}`
      },
      {
        id: 'eye-grades',
        title: 'Teaching aim4 eye',
        html: `
          <p>Admins see <strong>Good</strong> and <strong>Bad</strong> under every answer. A Good answer is saved as an example of how to answer. A Bad answer takes a short note on what was wrong; that note is part of the eye's instructions from its next answer on, so a correction works straight away, not only after the next round of training.</p>
          <p>The graded answers, and the rounds of the library itself, are what the eye's model is trained on. Training runs on a PC with a graphics card or on a rented one, and teaches the eye to guess a round's plays first and then check itself against the measurements.</p>
          ${best([
            'Write the note as an instruction: "Say how many rounds it rests on" is a correction the eye can follow; "wrong" is not.',
            'Grade the answers you would want every time, not only the bad ones: good examples teach as much as corrections.'
          ])}`
      }
    ]
  },
  {
    label: 'Team',
    sections: [
      {
        id: 'team',
        title: 'Team overview',
        html: `
          <p><a href="/team">Team → Overview</a> is your roster. Create a team with a name, then invite players with an invite link (make a new one whenever you like) or let them join with the team's code. The owner can kick, ban (and lift a ban), hand over ownership, and anyone can leave.</p>
          <p>A team plan lends its seats: teammates get the plan's features without paying separately.</p>
          ${best(['Add every player and coach before your first prep. Documents, strategies and playlists shared with the team reach everyone on the roster.'])}`
      },
      {
        id: 'documents',
        title: 'Documents',
        html: `
          <p><a href="/team/documents">Documents</a> are your team's shared write-ups: anti-strat sheets, prep notes, anything.</p>
          <ul>
            <li>The editor has text size and line spacing, bold, italic and underline, dividers, links, indenting with <kbd>Tab</kbd> and <kbd>Shift</kbd>+<kbd>Tab</kbd>, and lists that start themselves when you type <code>* </code>, <code>- </code> or <code>1. </code>.</li>
            <li>Generated documents carry live widgets: the team's utility on a map, heatmaps, grenade throw lines, and player spacing after the opening kill. Their round-clock sliders and buy pickers work inside the document.</li>
            <li>Point links open the rounds they came from.</li>
            <li>Share a document by link: anyone with it can read it, without an account.</li>
          </ul>
          <p>aim4 eye can review a document (it checks every number against the data) and edit the points and sections in place, keeping links, tables and layout. A review always makes a new reviewed copy unless you ask it to overwrite.</p>
          ${best([
            'Keep one document per opponent and map, and regenerate it before each match: the numbers move as new demos come in.',
            'Add your own notes in a section of their own at the end, so regenerating the numbers never overwrites them.'
          ])}`
      },
      {
        id: 'roles',
        title: 'Roles & Positions',
        html: `
          <p><a href="/team/roles">Roles &amp; Positions</a> sets who plays what. The roster marks each member as a player or a coach, with their permissions. The positions table gives every player a position on every map, for T and for CT. Admins can add placeholder seats and drag a member onto one to take over its positions.</p>
          ${best(['Fill the positions in before you write strategies: the stratbook gives every position its own column.'])}`
      },
      {
        id: 'stratbook',
        title: 'Stratbook Editor and My Strategies',
        html: `
          <p>The <a href="/team/stratbook">Stratbook Editor</a> is your team's book: strategies per map and side, each with a column per position saying what that player does. Each strategy can be shown to the whole team or only to chosen members.</p>
          <ul>
            <li>File each strategy by call type (pistol, set call, default, opener, midround, lateround, cheap execute on T; setup and retake on CT) and economy (pistol, full buy, full buy with AWP, anti-force, force, eco).</li>
            <li>Write grenades as links: <code>&lt;Window smoke&gt;&lt;!ab12&gt;</code> shows "Window smoke" and copies the setpos of throw ab12 from the Utility Archive on click. <code>&lt;URL=https://...&gt;</code> opens a page. Placeholders and links can be added from the buttons.</li>
            <li>Each strategy keeps links to the rounds and demos that prove it.</li>
            <li><strong>Copy</strong> one map or <strong>Copy all</strong> as rows that paste straight into Google Sheets or Excel.</li>
          </ul>
          <p><a href="/team/strategies">My Strategies</a> lists the strategies you made yourself, ready to copy.</p>
          ${best([
            'Write notes the way players read them in a timeout: who, where, what they throw, when. Two short sentences per player is plenty.',
            'Link every grenade. A player who can copy the setpos learns the throw in a minute.'
          ])}`
      },
      {
        id: 'drawing-board',
        title: 'Drawing Board',
        html: `
          <p>The <a href="/team/drawing-board">Drawing Board</a> is a shared tactics board on the map radar: paint, drag players and utility onto the map, and save boards by name to load later. Zoom and pan work like the viewer.</p>
          ${best(['Save one board per strat with the strat\'s name, so it can be opened in the middle of a practice.'])}`
      },
      {
        id: 'utility-archive',
        title: 'Utility Archive',
        html: `
          <p>The <a href="/team/utility-archive">Utility Archive</a> is your team's grenade database. Drag a grenade onto where it lands, click where it is thrown from, and save it with a name. Every saved throw has a short id that stratbook notes link to.</p>
          ${best(['Name throws the way your team calls them ("Jungle smoke from T roof"), so a link in a strategy reads like a call.'])}`
      },
      {
        id: 'matches',
        title: 'Matches (auto coach)',
        html: `
          <p><a href="/team/replays">Matches</a> runs the auto coach over your team's matches and shows each player's week: how many moments were flagged per round, by category, and whether that is going down. <strong>Playlist of this week</strong> collects a player's flagged rounds, and <strong>Write weekly digest</strong> writes the week up as a team document.</p>
          ${best(['Go through the week\'s playlist with each player for ten minutes. Watching their own flagged moments does more than any number.'])}`
      },
      {
        id: 'comms',
        title: 'Communication and voice comms',
        html: `
          <p><a href="/team/communication">Communication</a> is where your team's voice comms come together.</p>
          <ul>
            <li><strong>The recorder</strong>: one small program (in the desktop app, under Communication). It joins your TeamSpeak channel, records every speaker separately and transcribes on your own PC; nothing leaves your PC until you upload the finished file. Thirteen languages, one per recording.</li>
            <li><strong>The sync</strong>: during round 1's buy time, say <em>"record, three, two, one"</em> so each number lands on a second of the freeze clock. That lines the recording up with the demo.</li>
            <li><strong>Who is who</strong>: link each roster player to their Steam ID and their TeamSpeak voice, so every recording knows who is speaking.</li>
            <li><strong>Talk time</strong>: who calls in the buy, who talks mid-round and who goes quiet, filterable by map, side, won or lost, buy, round number and demo.</li>
          </ul>
          <p>In the viewer, the <strong>microphone button</strong> attaches a recording to a demo. Captions appear over the player who spoke in 2D, and in a sidebar in 3D, in time with the round.</p>
          ${best([
            'Do the sync every time, in round 1. It takes three seconds and is what lines every word up with the round.',
            'Compare talk time in won and lost rounds: teams that lose often go quiet mid-round.'
          ])}`
      },
      {
        id: 'creator',
        title: '2D Strategy Creator',
        html: `
          <p>The <a href="/team/creator">2D Strategy Creator</a> builds a round that never happened: you play each player on the 2D radar one at a time, and every player you already recorded plays back alongside, the way a team walks a strat. Movement accelerates and stops like the game, and walls block you (hold the noclip key to pass one). Rounds are filed by map and side, and a share link opens one read-only for anyone.</p>
          ${best(['Record the player who sets the timing first (usually the entry), then everyone else around them.'])}`
      }
    ]
  },
  {
    label: 'Training',
    sections: [
      {
        id: 'play',
        title: 'Play: the aim trainer',
        html: `
          <p><a href="/training">Play</a> lists the aim trainer's modes by category: precision, tracking, speed, flicking, sniping, general and challenges. Every mode runs three ways:</p>
          <ul>
            <li><strong>Training</strong>: practise with no pressure.</li>
            <li><strong>Competitive</strong>: a scored run for the leaderboards.</li>
            <li><strong>Adaptive</strong>: competitive rules, set to your level.</li>
          </ul>
          <p>Each mode also has a shortcut to its leaderboard. Everything runs in the browser. For something lighter, <a href="/football">Football</a> is a multiplayer minigame with public lobbies or a code to join friends.</p>
          ${best([
            'Warm up with a short Training run before a Competitive one.',
            'Use Adaptive for the mechanic you are worst at: it keeps you at the edge of what you can do.',
            'Let a routine choose for you (see Routines).'
          ])}`
      },
      {
        id: 'routines',
        title: 'Routines',
        html: `
          <p><a href="/routines">Routines</a> builds a training playlist from what you are worst at. <strong>Find routine</strong> asks how long you have and which mechanics to train (your five weakest are picked for you, read from your demos or your trainer runs) and picks the modes that cover them. You can also build one by hand: pick modes, give each a duration, order them and save. A saved routine is already in the trainer's playlists the next time you open it.</p>
          ${best(['Keep the time honest. Fifteen focused minutes every day beat an hour once a week.'])}`
      },
      {
        id: 'map-practice',
        title: 'Map Practice',
        html: `
          <p><a href="/map-practice">Map Practice</a> lets you walk every ported map in your browser: Dust2, Mirage, Inferno, Nuke, Ancient, Anubis and Cache (for example <a href="/dust2">aim4.io/dust2</a>). Deathmatch with bots runs on all of them. Grenades follow real CS2 trajectories, wallbangs use CS2 penetration, and the doors mode has you hold mid doors against real pro CT rounds. Map Practice is part of the paid plans.</p>
          ${best(['Learn a new smoke here before you take it into a server: copy the setpos from a strategy or a GIF and throw it until it lands every time.'])}`
      },
      {
        id: 'leaderboards',
        title: 'Leaderboards, Replay Viewer and Achievements',
        html: `
          <p><a href="/leaderboards">Leaderboards</a> has a <strong>Ranked ELO</strong> board, an <strong>Aim Rating</strong> board and a board for every mode. The <a href="/replay-viewer">Replay Viewer</a> shows your trainer profile and your last and best runs, which you can watch back. Achievements are coming soon.</p>
          ${best(['Watch your best run of a mode next to your last one: the difference is usually in the first second, not the last.'])}`
      }
    ]
  },
  {
    label: 'Account',
    sections: [
      {
        id: 'account',
        title: 'Your account',
        html: `
          <p><a href="/account">Account</a> has six tabs:</p>
          <ul>
            <li><strong>Overview</strong>: your display name, your @ tag, the site language, and the sign-in services linked to your account (Google, Steam).</li>
            <li><strong>Subscription</strong>: your plan, what each plan includes, and billing.</li>
            <li><strong>Teams</strong>: the teams you are on.</li>
            <li><strong>Affiliate</strong>: your referral code and what it has earned.</li>
            <li><strong>Data</strong>: your storage meter, a full export of your data, and account deletion.</li>
            <li><strong>Security</strong>: which ways of signing in your account has, and signing out.</li>
          </ul>`
      },
      {
        id: 'plans',
        title: 'Plans and storage',
        html: `
          <p>Free covers watching, browsing and trying the tools. Paid plans come in two ladders with three steps each: <strong>Solo Lite, Solo Premium, Solo Elite</strong> for one player, and <strong>Team Tier 3, Tier 2, Tier 1</strong> for a roster. A team plan is the solo plan of the same step plus everything that needs a roster: team pages, anti-strat documents and comms.</p>
          <p>The heavy tools (anti-strat documents, auto coach and the like) are daily allowances for the whole subscription, not per seat. The full list of what each plan includes is on <a href="/account/subscription">Account → Subscription</a>.</p>
          <p>When a plan lapses, nothing is deleted: demos over the free limit are locked, and you choose what to keep.</p>`
      },
      {
        id: 'terms',
        title: 'Terms of service',
        html: `
          <p>The short version of the <a href="/terms">terms</a>: accounts are <strong>personal</strong>, one account for one person, and sharing is detected automatically (an account used from another country on different hardware within hours gets a warning; a repeat means probation, where premium features pause until it is reviewed). What you upload stays yours; you must have the right to upload it, which for voice recordings means everyone recorded agreed. Cancelling keeps access to the end of the period, and a lapsed plan locks over-limit content instead of deleting it, with 90 days to export or trim. The full text is a five-minute read at <a href="/terms">aim4.io/terms</a>.</p>`
      },
      {
        id: 'privacy',
        title: 'Privacy',
        html: `
          <p>The short version of the <a href="/privacy">privacy page</a>: no ads, no third-party analytics, no selling data. aim4 keeps your account details, your content, and security data per sign-in (IP address, country, device) used only for the sharing checks; the country is looked up on aim4's own server, so your IP address never goes to a third party. Voice recordings are made and transcribed on <em>your</em> PC and only uploaded when you choose. aim4 eye runs on your PC too. Export everything or delete your account yourself under <a href="/account/data">Account → Data</a>; deletion waits 14 days and is cancelled by signing back in.</p>`
      },
      {
        id: 'help',
        title: 'Getting help',
        html: `
          <p>Something broken, confusing or missing? <a href="/contact">Open a ticket</a>: it goes straight to the site admin, and if you are signed in, the reply comes back as a notification here. The <a href="/changelog">changelog</a> lists what changed recently.</p>`
      }
    ]
  }
];

/** Every section in page order. */
export const DOC_SECTIONS = DOC_GROUPS.flatMap((g) => g.sections);
