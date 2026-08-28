// ---------------------------------------------------------------------------
// src/site/docsView.js
// /docs: how to use the website, on one page.
//
// One long page with a sticky section list, not a docs site: everything a
// new user needs fits in a ten-minute read, and a single page can be
// Cmd+F'd. Every claim in here describes something the site actually does —
// the keyboard table lists the keys timelineViewer.js binds, nothing more.
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'start', label: 'Getting started' },
  { id: 'upload', label: 'Uploading demos' },
  { id: 'watch', label: 'Watching demos' },
  { id: 'keys', label: 'Keyboard shortcuts' },
  { id: 'comms', label: 'Voice comms' },
  { id: 'stats', label: 'Stats and analytics' },
  { id: 'team', label: 'Team tools' },
  { id: 'practice', label: 'Practice' },
  { id: 'plans', label: 'Plans and storage' },
  { id: 'help', label: 'Getting help' }
];

const KEYS = [
  ['Space', 'Play / pause'],
  ['← / →', 'Step 2 seconds (hold Shift for 10)'],
  ['O / P', 'Jump 15 seconds back / forward'],
  ['J / K', 'Previous / next round'],
  ['M', 'Cycle playback speed'],
  ['1–0', 'Spectate a player by seat'],
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

export function initDocsView(host, { escapeHtml }) {
  if (!host) return { onShow() {}, onHide() {} };
  let rendered = false;
  const esc = escapeHtml;

  function render() {
    if (rendered) return;
    rendered = true;
    host.innerHTML = `
      <div class="view-pad docs-layout">
        <nav class="docs-nav" aria-label="Sections">
          ${SECTIONS.map((s) => `<a href="#${s.id}">${esc(s.label)}</a>`).join('')}
        </nav>
        <div class="docs-main page-narrow">
          <header class="page-head-block">
            <h1>How to use aim4</h1>
            <p class="page-lede">Everything on this page exists on the site today. Ten minutes here covers it all; the <a href="/changelog">changelog</a> covers what is new.</p>
          </header>

          <section id="start">
            <h2>Getting started</h2>
            <p>You can watch demos, browse the database, and practise on every map <strong>without an account</strong>. An account adds uploads, teams, playlists, and settings that follow you between devices.</p>
            <p>Two ways in: <strong>Continue with Google</strong>, or create an account with just a <strong>username and password</strong>. A username account does everything except upload demos — for that, link Google or Steam once under <a href="/account">Account</a> → Connections, so every demo in the shared library has a real identity behind it.</p>
          </section>

          <section id="upload">
            <h2>Uploading demos</h2>
            <p>Go to <a href="/uploads">My Uploads</a> and drag a <code>.dem</code> file in — or a <code>.zip</code>, <code>.rar</code> or <code>.gz</code> holding several. The server unpacks, parses each map, names the teams, and files the rounds into your library. A best-of-three archive becomes its maps automatically.</p>
            <p>Everything you upload counts toward one storage meter — demos, extracted rounds, and voice comms together. Check it under <a href="/account/data">Account → Data</a>.</p>
          </section>

          <section id="watch">
            <h2>Watching demos</h2>
            <p>Open any match from <a href="/demos">Demo Manager</a> or the <a href="/database">Database</a>. The viewer starts on the 2D radar; the <strong>3D button</strong> rebuilds the round inside the real map, in your browser. The two views share one clock — switch mid-round and nothing moves.</p>
            <p>The toolbar holds the rest: <strong>drawing tools</strong> for sketching executes on the radar, <strong>zones</strong> for position names, the <strong>win chance chart</strong>, the <strong>duels</strong> panel, <strong>coach</strong> notes flagging one team's mistakes, <strong>playlists</strong> for collecting rounds across matches, and <strong>notes</strong>. Every round has its own link — share the exact moment, and it works for people without an account.</p>
          </section>

          <section id="keys">
            <h2>Keyboard shortcuts</h2>
            <div class="docs-table-wrap"><table class="docs-keys">
              <tbody>
                ${KEYS.map(([k, what]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(what)}</td></tr>`).join('')}
              </tbody>
            </table></div>
          </section>

          <section id="comms">
            <h2>Voice comms</h2>
            <p>The <strong>mic button</strong> in the viewer attaches a recorded TeamSpeak session to a demo. Captions appear over the player who spoke in 2D, and in a sidebar in 3D, synced to the round clock.</p>
            <p>Recording is one small program you download from the site. It joins your TeamSpeak channel, records every speaker separately, and transcribes on your own machine — nothing leaves your PC until you upload the finished file. The sync ceremony is one sentence: during round 1's freeze time, say <em>"record, three, two, one"</em> so each number lands on that second of the freeze clock. Thirteen languages are supported, one per recording.</p>
          </section>

          <section id="stats">
            <h2>Stats and analytics</h2>
            <p>The <a href="/database">Database</a> is every parsed round, filterable by map, team, player, economy and more. <a href="/patterns">Pattern Finder</a> searches your whole library for rounds that match a setup, and its Charts chapter builds graphs from any stat column. <a href="/performance">Performance</a> tracks form over time. Upload your <em>opponents'</em> matches too and the antistrat tools read their habits.</p>
          </section>

          <section id="team">
            <h2>Team tools</h2>
            <p>On a team plan, <a href="/team">Team</a> unlocks the <strong>stratbook</strong> (strategies per map, linked to the demos that prove them), shared <strong>documents</strong>, the <strong>utility archive</strong>, a live <strong>drawing board</strong>, roles and positions, and team-wide match review. A team plan lends seats, so teammates get the plan without paying separately.</p>
          </section>

          <section id="practice">
            <h2>Practice</h2>
            <p>Every ported map is walkable in your browser: <a href="/dust2">aim4.io/dust2</a>, /mirage, /inferno, /nuke, /ancient, /anubis and /cache. Deathmatch with bots runs on all seven. Grenade practice uses real CS2 trajectories, wallbangs use CS2 penetration values, and the doors gamemode holds mid doors against real pro CT rounds. The <a href="/train">aim trainer</a> and <a href="/training">Play</a> modes run in the browser too.</p>
          </section>

          <section id="plans">
            <h2>Plans and storage</h2>
            <p>Free covers watching, browsing, and trying the tools. Paid plans raise upload limits, unlock full analytics, and add the team toolkit — the full feature matrix lives on <a href="/account/subscription">Account → Subscription</a>. When a plan lapses, nothing is deleted: over-limit demos lock and you choose what to keep.</p>
          </section>

          <section id="help">
            <h2>Getting help</h2>
            <p>Something broken, confusing, or missing? <a href="/contact">Open a ticket</a> — it lands directly with the site admin, and if you are signed in the reply comes back as a notification here. The <a href="/changelog">changelog</a> lists what shipped recently.</p>
          </section>
        </div>
      </div>`;
  }

  return {
    onShow() {
      render();
      // Deep links to a section land on it once the content exists.
      const hash = window.location.hash.slice(1);
      if (hash) document.getElementById(hash)?.scrollIntoView();
    },
    onHide() {}
  };
}
