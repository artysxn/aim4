// ---------------------------------------------------------------------------
// site/pitchContent.js
// The pitch, as data: the slides plus the two helpers that make them editable.
//
// Kept apart from pitchDeckView.js because two very different things read it:
// the deck renders it, and the admin panel edits it. The panel must not have to
// import the deck (and its keyboard handling, fullscreen and routing) just to
// list the sentences.
//
// Every slide carries a stable `id`. Saved edits are keyed by that id and by a
// path inside the slide ("points.2", "columns.1.lead"), never by position, so
// reordering or inserting a slide in this file cannot silently move somebody's
// wording onto the wrong slide.
//
// Prices come from the entitlements catalogue rather than being copied, so the
// deck can never contradict the pricing page. The revenue arithmetic is derived
// the same way, from a subscriber mix written down as data, so a total on a
// slide is always the sum of the rows printed above it.
// ---------------------------------------------------------------------------

import {
  PLAN_CAPACITY,
  PLAN_NAMES,
  PLAN_PRICE_CENTS,
  PLAN_TAGLINES,
  PLAN_TERM_BONUS,
  TERM_IDS,
  TERM_NAMES,
  isTeamPlan,
  priceForTerm
} from '../../shared/entitlements/catalogue.js';

/** 1234567 to "1,234,567". These numbers get read from the back of a room. */
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Cents to money. The catalogue's own `euros()` is the right spelling for one
 * price, but this deck adds prices up into five figures and "€37989.90" cannot
 * be read at a glance, so the thousands are separated here.
 */
const money = (cents) => {
  const [whole, fraction] = (Math.round(Number(cents) || 0) / 100).toFixed(2).split('.');
  return `€${group(whole)}.${fraction}`;
};

/** The headline monthly price of a plan, straight out of the catalogue. */
const price = (id) => money(PLAN_PRICE_CENTS[id]);

/** A discount fraction as a whole percentage: 0.08 to "8%". */
const pct = (fraction) => `${Math.round(fraction * 100)}%`;

/**
 * The rate the dollar figures on the revenue slide are converted at. Written
 * down on the slide as well as here, because a deck that quotes dollars without
 * its rate is quoting a number the reader cannot reproduce.
 */
const USD_PER_EUR = 1.08;
const usd = (cents) => `$${group(Math.round((cents / 100) * USD_PER_EUR))}`;

/** The six paid plans, strongest first: the order a pricing table is read in. */
const LADDER = Object.freeze([
  'team_tier1',
  'team_tier2',
  'team_tier3',
  'solo_elite',
  'solo_premium',
  'solo_lite'
]);

/** The three longer terms, in the order the pricing table lists them. */
const LONG_TERMS = Object.freeze(TERM_IDS.filter((term) => term !== 'month'));

/**
 * The bonus discount ladder, grouped by the plans that happen to share a run.
 *
 * Grouping rather than typing "Tier 2 and Solo Elite" keeps the sentence under
 * the table honest: if somebody moves one of those two in the catalogue, the
 * deck splits them into separate sentences instead of quietly claiming they
 * still discount alike.
 */
const BONUS_GROUPS = (() => {
  /** @type {Map<string, {run: number[], plans: string[]}>} */
  const byRun = new Map();
  for (const planId of LADDER) {
    const run = LONG_TERMS.map((term) => PLAN_TERM_BONUS[planId][term]);
    const key = run.join('/');
    if (!byRun.has(key)) byRun.set(key, { run, plans: [] });
    byRun.get(key).plans.push(planId);
  }
  return [...byRun.values()];
})();

/** "Team Tier 2 and Solo Elite: 5%, 6%, 7%." One group, one sentence. */
const bonusSentence = ({ run, plans }) => {
  const who = plans.map((id) => PLAN_NAMES[id]).join(' and ');
  return run.some((value) => value > 0) ? `${who}: ${run.map(pct).join(', ')}.` : `${who}: none.`;
};

/**
 * The subscriber mix the revenue slide does its arithmetic over, as plain data.
 *
 * Every figure on that slide, in euros and in dollars, is derived from this
 * array, because the one thing a revenue slide must never do is state a total
 * its own rows do not add up to. Change a count here and the table, the split
 * between the two ladders and the twelve-month comparison all move with it.
 */
const REVENUE_MIX = Object.freeze([
  ['team_tier1', 15],
  ['team_tier2', 25],
  ['team_tier3', 60],
  ['solo_elite', 60],
  ['solo_premium', 250],
  ['solo_lite', 600]
]);

const revenueLines = REVENUE_MIX.map(([planId, customers]) => ({
  planId,
  customers,
  monthlyCents: PLAN_PRICE_CENTS[planId] * customers,
  // What those same customers bill per month having bought twelve months up front.
  yearlyCents: priceForTerm(planId, 'year').perMonthCents * customers
}));

const teamLines = revenueLines.filter((line) => isTeamPlan(line.planId));
const soloLines = revenueLines.filter((line) => !isTeamPlan(line.planId));
const totalOf = (lines, pick) => lines.reduce((n, line) => n + pick(line), 0);

const REVENUE_TOTAL = totalOf(revenueLines, (l) => l.monthlyCents);
const REVENUE_TEAM = totalOf(teamLines, (l) => l.monthlyCents);
const REVENUE_SOLO = totalOf(soloLines, (l) => l.monthlyCents);
const REVENUE_ON_YEAR = totalOf(revenueLines, (l) => l.yearlyCents);
const REVENUE_CUSTOMERS = totalOf(revenueLines, (l) => l.customers);
const TEAM_CUSTOMERS = totalOf(teamLines, (l) => l.customers);
const SOLO_CUSTOMERS = totalOf(soloLines, (l) => l.customers);
const YEAR_SAVING_PCT = Math.round((1 - REVENUE_ON_YEAR / REVENUE_TOTAL) * 100);

/**
 * The pricing arithmetic and its spellings, shared with the talking deck.
 *
 * The two decks are shown to the same people, often a week apart, so they must
 * not be able to quote different totals off the same mix. pitchTalk.js imports
 * this instead of keeping a second copy of the numbers.
 */
export const PITCH_MONEY = Object.freeze({
  ladder: LADDER,
  lines: Object.freeze(revenueLines.map((line) => Object.freeze({ ...line }))),
  customers: REVENUE_CUSTOMERS,
  teamCustomers: TEAM_CUSTOMERS,
  soloCustomers: SOLO_CUSTOMERS,
  totalCents: REVENUE_TOTAL,
  onYearCents: REVENUE_ON_YEAR,
  yearSavingPct: YEAR_SAVING_PCT,
  group,
  money,
  price,
  pct,
  usd
});

/**
 * @typedef {{
 *   id: string, kicker?: string, title: string, lead?: string,
 *   points?: string[], columns?: {tag?: string, title: string, lead?: string, points?: string[]}[],
 *   table?: {head: string[], rows: string[][], highlight?: number, wrap?: boolean},
 *   stats?: {value: string, label: string}[],
 *   video?: {url: string, caption?: string},
 *   quote?: string, quoteBy?: string, note?: string, tableNote?: string,
 *   tone?: 'plus'|'minus'|'ask', center?: boolean, dense?: boolean, big?: string
 * }} Slide
 */

/** @type {Slide[]} */
export const PITCH_SLIDES = [
  // ---- the person and the product ---------------------------------------
  {
    id: 'title',
    kicker: 'aim4.io',
    title: 'Aim for trophies.',
    lead: 'One platform for Counter-Strike preparation: demo review, statistics, opponent scouting, strategy, and mechanical training. Made by players and analysts, shaped by feedback from teams, coaches and players at every level.',
    stats: [
      { value: '70,000+', label: 'hours of Counter-Strike behind it' },
      { value: '20+', label: 'years of shared team experience' }
    ],
    big: 'AIM4',
    center: true
  },
  {
    id: 'founder',
    kicker: 'Who built this',
    title: 'A player and analyst, not an outsider',
    stats: [
      { value: '15,000', label: 'hours in Counter-Strike' },
      { value: '7 years', label: 'IGL, analyst and coach' },
      { value: '3rd', label: 'ESEA Entry, season 57' }
    ],
    points: [
      'Won the Ukrainian Oldplayers Tour.',
      'Second place twice in the Norwegian national league.',
      'Seven years in the chair that decides what a team practises next: IGL, analyst, coach.',
      'A professional-level FPS aim: the trainer on this site is the routine that got me there, not a feature I specified from the outside.',
      'Worked alongside educated statisticians, including Norwegian CS2 coach Eybjorn Paulsen, MSc in statistical analysis.',
      'Educated graphic designer. aim4 is my first development venture, and it is written entirely by me.'
    ],
    note: 'The product exists because I needed it and nobody was building it.'
  },
  {
    id: 'product',
    kicker: 'The product',
    title: 'Everything a team does between matches',
    columns: [
      {
        title: 'Review',
        points: ['2D and 3D demo playback in the browser', 'Auto coach turns rounds into feedback', 'Utility and grenade archive']
      },
      {
        title: 'Understand',
        points: ['Player and team database over every round', 'Charts and pattern search across the library', 'Automatic anti-strat on any opponent']
      },
      {
        title: 'Prepare',
        points: ['Stratbook, documents, roles and positions', '2D strategy creator', 'Round and duel win probability models']
      },
      {
        title: 'Train',
        points: ['Aim trainer built into the same site', 'Routines targeted at your measured weaknesses', 'Replays of your own training']
      }
    ]
  },

  // ---- inspiration -------------------------------------------------------
  {
    id: 'inspiration',
    kicker: 'Inspiration',
    title: 'Where the name comes from',
    quote: 'Aim for four trophies, nothing less.',
    quoteBy: 'The line I have played by for years. aim4 is that sentence as a product.',
    points: [
      'Every feature answers one question: does this get the team closer to winning something?',
      'Not a stats toy. Not a highlight reel. Preparation that changes what happens on the server.'
    ],
    center: true
  },

  // ---- the full inventory, before the argument starts ---------------------
  {
    id: 'features',
    kicker: 'The full product',
    title: 'Everything in the box',
    lead: 'Not a roadmap. Every item below is built and running today, on one account, over one library.',
    dense: true,
    columns: [
      {
        title: 'Demo library',
        points: [
          'Upload and parse any CS2 demo',
          'Thousands of professional matches already parsed and searchable',
          'Playlists to group demos for a scouting job',
          'Private, team or public visibility per demo'
        ]
      },
      {
        title: 'Replay review',
        points: [
          '2D tactical viewer with full round control',
          '3D viewer running the real map geometry in the browser',
          'A round library that names what actually happened in a round',
          'Drawing board over any frame, for making the point once'
        ]
      },
      {
        title: 'Database',
        points: [
          'Every round of every demo, for players and for teams',
          'Over a hundred columns: duels, utility, timing, movement, AWP hold',
          'Rating 3.0, built for this game rather than inherited from 1.6',
          'Filter by map, side, economy, role or opponent and the table follows'
        ]
      },
      {
        title: 'Pattern Finder',
        points: [
          'Search the library by what happened, not by who was in it',
          'Explore and meta views for reading how the game is being played',
          'Per-player pattern breakdown across hundreds of rounds',
          'Charts with averages over any filtered set'
        ]
      },
      {
        title: 'Models and coach',
        points: [
          'Predicted round win probability, trained on the library',
          'Duel win probability for individual fights',
          'Opening kills, 5v4 and 4v5 conversion measured, not guessed',
          'Autocoach turns a week of demos into written feedback',
          'Automatic anti-strat document on any opponent'
        ]
      },
      {
        title: 'Performance',
        points: [
          'Player pages: rating, KD, swing, opening duels, fight win over time',
          'Team pages: game and round winrate, predicted winrate, conversions',
          'Peer comparison against everyone else in the library',
          'Leaderboards and public player profiles'
        ]
      },
      {
        title: 'Team room',
        points: [
          'Stratbook editor with rounds, notes and embedded diagrams',
          'Documents, roles and positions, shared across the roster',
          '2D strategy creator and a searchable utility archive',
          'Seats, roster management and a shared demo library'
        ]
      },
      {
        title: 'Training',
        points: [
          'Aim trainer in the browser, no install, several gamemodes',
          'Routines generated from your own measured weaknesses',
          'Map practice for the spots that actually cost you rounds',
          'Achievements, ELO, leaderboards and replays of your own runs'
        ]
      }
    ],
    note: 'Every one of these reads the same rounds and writes to the same profile. That is the part competitors cannot copy feature by feature: the connections between them.'
  },

  // ---- the pluses --------------------------------------------------------
  {
    id: 'demo-video',
    kicker: 'Demonstration',
    title: 'Two minutes inside the product',
    video: {
      // Paste the recording here, or in the admin editor. A YouTube link
      // becomes an embed; a direct file plays inline. Empty shows the caption.
      url: '',
      caption: 'Recording to follow. Until then the live product is at aim4.io, and every part of this deck can be tried there.'
    }
  },
  {
    id: 'plus-time',
    kicker: 'Strength',
    tone: 'plus',
    title: 'It buys back time',
    lead: 'The core promise. Everything below used to be manual hours; now it is a filter, a search, or a click.',
    table: {
      head: ['Task', 'Before', 'With aim4'],
      rows: [
        ['Anti-strat an opponent', 'Watch 10 demos, take notes', 'Filter the library, read the report'],
        ['Find a grenade lineup', 'Scrub YouTube and demos', 'Search the utility archive'],
        ['Build a stats table', 'Spreadsheet by hand', 'Query, sorted and filtered'],
        ['Review a bad round', 'Rewatch, guess why', 'Win probability and auto coach'],
        ['Plan practice', 'Coach intuition', 'Measured weakness, targeted routine']
      ]
    }
  },
  {
    id: 'plus-hub',
    kicker: 'Strength',
    tone: 'plus',
    title: 'One hub instead of six tools',
    lead: 'Teams currently stitch together a demo player, a stats site, Google Docs, a screenshot folder, a practice server and an aim trainer. None of them talk to each other.',
    points: [
      'Statistics and insight for the team and for the individual, from the same rounds.',
      'Grenade and utility database, stratbook, documents, calendar.',
      'Demo review in 2D and 3D, with the round library naming what actually happened.',
      'Aim training in the same account, measured against the same profile.',
      'Thousands of professional games as comparison material, already parsed.'
    ]
  },
  {
    id: 'plus-training',
    kicker: 'Strength',
    tone: 'plus',
    title: 'Training aimed at your actual weakness',
    lead: 'The site already measures crosshair placement, reaction, opening duels, utility damage and positioning. That measurement is what a routine should be built from.',
    points: [
      'Routines generated from your own numbers, not a generic playlist.',
      'The trainer was built by a professional-level FPS player, from the exercises that took me there. It is not a checkbox feature specified by someone who does not train.',
      'That makes a second audience reachable: the KovaaK’s and Aim Labs community already pays to train aim, and never opens a demo.',
      'Mechanical practice and match analysis living in one profile, so improvement is visible.',
      'The loop closes: measure in a real demo, train the gap, measure again.'
    ],
    note: 'Nobody else can offer an aim trainer with a credible name behind it and the demo data to tell you what to train. That combination is the moat.'
  },
  {
    id: 'plus-everyone',
    kicker: 'Strength',
    tone: 'plus',
    title: 'Works for everyone.',
    lead: 'Aimed at teams at the very top of the professional scene, and still of high use to players at every tier below. The same tools and the same depth, whoever is holding them.',
    columns: [
      { title: 'Solo player', points: ['Own stats and trends', 'Aim training and routines', 'Learn from pro demos'] },
      { title: 'Analyst / coach', points: ['Anti-strat automation', 'Pattern search', 'Report building'] },
      { title: 'Team', points: ['Stratbook and roles', 'Shared library and seats', 'Win models and auto coach'] }
    ],
    note: 'You can do everything from the website, including mechanical training suited to your needs. No install, no second account.'
  },
  // The roadmap sits here, right after the strengths, because where the
  // product is going is part of what it is. It used to come after pricing,
  // which was too late for the reader who decides in the first ten slides.
  {
    id: 'roadmap',
    kicker: 'Roadmap',
    title: 'Where the product goes',
    points: [
      'CS2 plugin integration: the same bot practice inside the real game, with your team.',
      'Neural networks and deep learning to build bots that feel like real players, tuned to a specific team or opponent.',
      'Automatic match import from ESEA, non-HLTV events and pug platforms.',
      'Continuous work on performance, analytical depth and model accuracy.',
      'TeamSpeak bot: review your in-match communication, and coach it.',
      'A sharper auto coach, until it genuinely saves a coach hours a week.',
      'A deeper anti-strat tool: more triggers, simpler output.'
    ]
  },

  // ---- the minuses -------------------------------------------------------
  {
    id: 'minus-today',
    kicker: 'Honest weakness',
    tone: 'minus',
    title: 'What is missing today',
    points: [
      'No marketing, no sales, no brand presence. The product has never been put in front of an audience.',
      'Billing has only just been switched on. Revenue today is effectively zero.',
      'No company structure, no legal or accounting function behind it.',
      'Support, onboarding and documentation are thin.'
    ]
  },

  // ---- market and competition -------------------------------------------
  {
    id: 'competition',
    kicker: 'Competition',
    title: 'Everyone covers a slice',
    table: {
      head: ['', 'Demo review', 'Team stats', 'Pattern search', 'Win models', 'Stratbook', 'Aim training'],
      highlight: 0,
      rows: [
        ['aim4.io', '2D + 3D', 'Yes', 'Yes', 'Round + duel', 'Yes', 'Yes'],
        ['Skybox Edge', '3D', 'Partial', 'No', 'No', 'No', 'No'],
        ['CS2Lens', '2D', 'Partial', 'No', 'No', 'No', 'No'],
        ['pracc.com', 'No', 'No', 'No', 'No', 'Partial', 'No'],
        ['Stratbase', 'No', 'No', 'No', 'No', 'Yes', 'No'],
        ['Refrag', 'No', 'Practice', 'No', 'No', 'No', 'Partial'],
        ['Leetify', 'Clips', 'Solo focus', 'No', 'Partial', 'No', 'No'],
        ['SCL.gg', 'No', 'League ops', 'No', 'No', 'No', 'No']
      ]
    },
    tableNote: 'Nobody covers the whole row. That gap is the product.'
  },
  {
    id: 'tiers',
    kicker: 'The playerbase',
    title: 'Five different players, one platform',
    lead: 'A Premier player and a top-50 team want opposite things from the same data. The tiers below are how one product serves both without becoming two products.',
    table: {
      // Prose cells, so this one wraps instead of scrolling sideways.
      wrap: true,
      head: ['Tier', 'Who they are', 'What they actually want', 'What they get here'],
      rows: [
        [
          'Tier 1',
          'MM / Premier, FACEIT 4–9',
          'A simple answer to "why do I keep losing?"',
          'Own demos in 2D, plain-language stats, the aim trainer, pro demos to copy'
        ],
        [
          'Tier 2',
          'Low FACEIT 10, 2000–2500 elo',
          'Consistency: aim, positioning, decisions',
          'Performance trends, routines from measured weakness, round library, duel model'
        ],
        [
          'Tier 3',
          'High FACEIT 10 2500–3000+, ESEA Open–Main',
          'The first real team structure',
          'Stratbook, roles and positions, team stats, anti-strat, shared library, seats'
        ],
        [
          'Tier 4',
          'ESEA Advanced up to top 50 VRS',
          'Opponent preparation, fast, every week',
          'Automatic anti-strat, pattern search, win models, Autocoach, utility archive'
        ],
        [
          'Tier 5',
          'Top 50 VRS and above',
          'Depth, ownership of their own data, an edge',
          'The whole library, unlimited everything, earliest models, direct line to the developer'
        ]
      ]
    },
    tableNote: 'Same data, same account, different depth. Nobody has to leave to grow, and nobody pays for depth they cannot use yet. These five are player tiers, counted up from the entry level. The plan names further on run the other way: Team Tier 1 is the top plan, not the cheapest one.'
  },
  {
    id: 'coverage',
    kicker: 'The opening',
    title: 'Nobody serves the whole ladder',
    lead: 'Every competitor picked a band and stayed in it. Read the rows: only one spans the ladder.',
    table: {
      head: ['Product', 'T1 MM / L4–9', 'T2 low L10', 'T3 high L10 / Open–Main', 'T4 Advanced–top 50', 'T5 top 50+'],
      highlight: 0,
      rows: [
        ['aim4.io', '●', '●', '●', '●', '●'],
        ['Leetify', '●', '●', '●', '·', '·'],
        ['scope.gg', '●', '●', '●', '·', '·'],
        ['SCL.gg', '·', '·', '●', '·', '·'],
        ['CS2Lens', '·', '·', '●', '●', '·'],
        ['Refrag', '·', '●', '●', '●', '·'],
        ['Skybox Edge', '·', '·', '●', '●', '●'],
        ['pracc.com', '·', '·', '●', '●', '●']
      ]
    },
    tableNote: 'The population is bottom-heavy and the budgets are top-heavy. Covering the ladder means acquiring where the players are and earning where the money is, inside one funnel: a Tier 1 player who learns on aim4 brings his Tier 3 team with him two years later.'
  },
  {
    id: 'market',
    kicker: 'Market',
    title: 'The buyers already pay for pieces',
    lead: 'Four kinds of buyer. Each already pays for parts of this, usually as two or three separate subscriptions, and each gets the whole of it here for one.',
    table: {
      wrap: true,
      head: ['Buyer', 'How many', 'Pays today for', 'On aim4'],
      rows: [
        [
          'Solo player',
          'Around a million online at any hour',
          'A stats site, an aim trainer and a practice server, each on its own subscription',
          'One solo plan, in the browser'
        ],
        [
          'Amateur team',
          'Thousands registered across ESEA, ESL, FACEIT and national leagues',
          'Servers, stats and practice tools, paid per person, plus a stratbook somewhere else',
          'One team plan for the whole roster, 5 to 14 seats'
        ],
        [
          'Professional team',
          'Hundreds of rostered organisations',
          'Analyst tooling at hundreds to over a thousand euros a month, plus a stats subscription on top',
          'One team plan, a fraction of that'
        ],
        [
          'Aim trainer crowd',
          'Millions of registered users across the two big trainers',
          'A separate app, installed, with its own account and its own subscription',
          'Free, in the browser, on the same account'
        ]
      ]
    },
    tableNote: 'Players arrive alone and bring their team later. The solo and aim-training tiers are the two doors into one funnel, and the team sale is the part that renews by season.'
  },
  {
    id: 'price-compare',
    // Eight rows and a footnote: the dense layout keeps it inside one screen.
    dense: true,
    kicker: 'Pricing',
    title: 'What the pieces cost today',
    lead: 'Public prices of the tools a player or a team pays for now, one slice each, next to the plans on aim4 that cover all of them.',
    table: {
      wrap: true,
      highlight: 7,
      head: ['Tool', 'Covers', 'Price'],
      rows: [
        ['Aimlabs+', 'Aim training', '$9.99 a month'],
        ["KovaaK's", 'Aim training', '$9.99 once, on Steam'],
        ['Leetify Pro', 'Solo stats and demo insights', 'About $10 a month'],
        ['Refrag', 'Practice server and routines', 'About $7 a month solo, about $15 a month for a team'],
        ['Skybox Edge', '3D demo viewing and analysis for teams', '€350 to €1,299 a month'],
        ['Scope.gg, CS2Lens', 'Stats and 2D demo tools', 'Not published, quoted on request'],
        ['Stratbase', 'Stratbook', 'Not published, quoted on request'],
        ['aim4.io', 'All of the above, one account', `${price('solo_lite')}–${price('team_tier3')} / mo`]
      ]
    },
    tableNote: 'List prices as published in September 2026, rounded. Stats, practice and a trainer alone come to roughly $25 to $30 a month per player before anyone has opened a demo.'
  },
  {
    id: 'pricing-ladder',
    kicker: 'Pricing',
    title: 'One ladder, read twice',
    lead: 'Four bands, free to high, and each paid band exists on both sides. A team plan is the solo plan of the same band plus everything that only works with a roster behind it: seats, stratbook, anti-strat, comms. That is the entire difference between the two sides, and it is why an organisation pays a multiple of what a player pays.',
    table: {
      // Prose in the last column, so this one wraps rather than scrolling.
      wrap: true,
      head: ['Plan', 'Per month', 'On 12 months', 'What it is'],
      rows: LADDER.map((planId) => [
        PLAN_NAMES[planId],
        price(planId),
        `${money(priceForTerm(planId, 'year').perMonthCents)} / mo`,
        PLAN_TAGLINES[planId]
      ])
    },
    tableNote: `Priced per subscription, not per seat: the ${PLAN_CAPACITY.team_tier3.seat_capacity} seats on a Team Tier 3 pay ${price(
      'team_tier3'
    )} between them. The daily allowances work the same way, so those ${PLAN_CAPACITY.team_tier3.seat_capacity} share one anti-strat report a day instead of getting ${PLAN_CAPACITY.team_tier3.seat_capacity}.`,
    note: 'Free is not a trial with an end date: the demo viewer, the aim trainer, the public performance overview and three demos held at a time, for as long as anyone wants them.'
  },
  {
    id: 'pricing-terms',
    kicker: 'Pricing',
    title: 'Paying up front costs less',
    lead: 'Three longer terms sit under every plan. Everyone gets the same discount for the term, and each plan adds a second one on top of it, larger the higher the plan, because that is where a long commitment is worth most.',
    table: {
      head: ['Term', 'Base discount', 'Team Tier 1 bonus', 'Team Tier 1', 'Solo Premium'],
      rows: TERM_IDS.map((term) => {
        const top = priceForTerm('team_tier1', term);
        const middle = priceForTerm('solo_premium', term);
        return [
          TERM_NAMES[term],
          pct(top.baseDiscount),
          pct(top.bonusDiscount),
          `${money(top.perMonthCents)} / mo`,
          `${money(middle.perMonthCents)} / mo`
        ];
      })
    },
    tableNote: `The two do not add. The second comes off what the first left: 20% and then 10% off €100 is €72, not €70. A year of Team Tier 1 bought up front is ${money(
      priceForTerm('team_tier1', 'year').totalCents
    )} against ${money(PLAN_PRICE_CENTS.team_tier1 * 12)} paid month by month.`,
    note: `The second discount, plan by plan, over 3, 6 and 12 months. ${BONUS_GROUPS.map(
      bonusSentence
    ).join(' ')}`
  },
  {
    id: 'pricing-revenue',
    kicker: 'Revenue',
    title: 'The ceiling, and the arithmetic under it',
    lead: `One plausible mix at market-leading share: ${TEAM_CUSTOMERS} organisations and ${SOLO_CUSTOMERS} solo subscriptions. The rows are the whole calculation, price times customers, added up.`,
    table: {
      head: ['Plan', 'Per month', 'Customers', 'Monthly'],
      rows: [
        ...revenueLines.map((line) => [
          PLAN_NAMES[line.planId],
          price(line.planId),
          group(line.customers),
          money(line.monthlyCents)
        ]),
        ['Total', '', group(REVENUE_CUSTOMERS), `${money(REVENUE_TOTAL)} / ${usd(REVENUE_TOTAL)}`]
      ],
      highlight: revenueLines.length
    },
    tableNote: `A modelled ceiling at market-leading share, not a forecast. Today the figure is zero. Team side ${usd(
      REVENUE_TEAM
    )}, solo side ${usd(REVENUE_SOLO)}, at ${USD_PER_EUR} USD per EUR.`,
    note: `Every row above is the monthly price. The same mix on twelve-month terms bills ${money(
      REVENUE_ON_YEAR
    )} a month, ${YEAR_SAVING_PCT}% less, with a year of it collected the day it is signed. Margin traded for cash and for a customer who cannot leave mid-season: that trade is what the long terms are for.`
  },

  // ---- roadmap -----------------------------------------------------------
  // ---- the asks ----------------------------------------------------------
  {
    id: 'ask',
    kicker: 'The ask',
    tone: 'ask',
    title: 'Three ways in',
    columns: [
      { tag: 'Option A', title: 'Investor', lead: 'Capital for a permanent share of revenue. No control, no operational role.' },
      { tag: 'Option B', title: 'Partner', lead: '49% of the company, income split 50/50, and the whole commercial side of the business.' },
      { tag: 'Option C', title: 'Full sale', lead: 'The product changes hands completely, against a permanent royalty.' }
    ],
    note: 'All three are open. The right one depends on how much of the business you want to run.'
  },
  {
    id: 'ask-investor',
    kicker: 'Option A',
    tone: 'ask',
    title: 'Investor',
    lead: 'You put in capital. You take a fixed percentage of gross subscription income, for as long as the product earns.',
    points: [
      'No equity and no board seat. What you do get is first priority on feedback, and direct cooperation on every upgrade.',
      'Paid from the first euro of revenue, not from profit.',
      'Runs in perpetuity, and is transferable.',
      'Capital goes to marketing, infrastructure and buying development time.'
    ],
    note: 'Amount and percentage to be set together. The pricing and revenue slides earlier in the deck are the basis for both.'
  },
  {
    id: 'ask-partner',
    kicker: 'Option B',
    tone: 'ask',
    title: 'Partner',
    lead: '49% of the company.',
    columns: [
      {
        title: 'What I am looking for assistance in',
        points: ['Promotion and marketing', 'Sales and partnerships', 'Logistics and operations', 'Legal and company structure']
      },
      {
        title: 'What I see in the partnership',
        points: [
          'A finished product, sold from day one',
          'Product and engineering stay in expert hands',
          'Growth decided together, income split equally',
          'Two people covering what one cannot'
        ]
      }
    ],
    note: 'Equity 51/49, income 50/50. The split is deliberate: control stays with the product, reward is equal.'
  },
  {
    id: 'ask-partner-gets',
    kicker: 'Option B',
    tone: 'ask',
    title: 'What the partner gets',
    points: [
      'Half the income of a product that already exists and works, with no build risk left to carry.',
      'A market with no complete competitor, entered before anyone owns the category.',
      'A technical founder who is also the domain expert, so product decisions do not need translating.',
      'A roadmap that widens the market rather than deepening a niche: plugin practice, AI bots, comms coaching.',
      'A higher buyout later: an operating, marketed business is worth a multiple of an unmarketed one.'
    ]
  },
  {
    id: 'ask-sale',
    kicker: 'Option C',
    tone: 'ask',
    title: 'Full private sale',
    lead: 'The entire product, source and platform, goes to the buyer. Full control, majority shares, the name.',
    points: [
      'One condition: 5% of income comes to me as a permanent royalty.',
      'Handover includes the codebase, infrastructure, data pipeline and documentation.',
      'I would like to keep working on the project after the sale. Trends and needs change every season, and I have the experience and knowledge to keep developing it under new ownership.',
      'Priced above both other options, because it ends my upside.'
    ],
    big: 'aim4',
    note: 'The 5% is the part I care about most. The rest is open to discussion.'
  },
  {
    id: 'close',
    kicker: 'aim4.io',
    title: 'Aim for trophies.',
    lead: 'The product is finished enough to sell and far from finished. What it needs next is reach, and the right people beside it. If that is you, the conversation starts here.',
    stats: [
      { value: '@artcs', label: 'Discord' },
      { value: '@artys4n', label: 'Twitter' }
    ],
    center: true,
    big: 'AIM4'
  }
];

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** Keys that describe layout rather than wording, and are never editable text. */
const NOT_TEXT = new Set(['id', 'tone', 'center', 'dense', 'highlight']);

/** Refuse the three keys that turn "set a value at a path" into a vulnerability. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Every editable sentence in a slide, as {path, value} pairs.
 *
 * Only strings are collected, so the walk cannot expose a boolean or an index
 * as something to type into. Paths address arrays by number: "points.2",
 * "table.rows.0.1", "columns.1.points.3".
 *
 * @param {object} value
 * @param {string} [prefix]
 * @param {{path: string, value: string}[]} [out]
 */
export function textLeaves(value, prefix = '', out = []) {
  for (const [key, child] of Object.entries(value)) {
    if (!prefix && NOT_TEXT.has(key)) continue;
    if (FORBIDDEN.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') out.push({ path, value: child });
    else if (child && typeof child === 'object') textLeaves(child, path, out);
  }
  return out;
}

/**
 * Overwrite one string, and only if a string is already there.
 *
 * The guard is the whole point: an override may replace wording that exists, it
 * may never create a field, grow an array or reach a prototype. A saved edit is
 * text, so the worst a bad one can do is read badly.
 *
 * @returns {boolean} whether anything changed
 */
function setStringAt(target, path, value) {
  const parts = String(path).split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (FORBIDDEN.has(key)) return false;
    node = node?.[key];
    if (!node || typeof node !== 'object') return false;
  }
  const last = parts[parts.length - 1];
  if (FORBIDDEN.has(last)) return false;
  if (typeof node?.[last] !== 'string') return false;
  if (node[last] === value) return false;
  node[last] = value;
  return true;
}

/**
 * Apply saved edits over the slides in this file.
 *
 * The file stays the source of truth for structure; the store only ever carries
 * replacement sentences. A slide with no edits is returned by reference, so the
 * common case allocates nothing.
 *
 * @param {Slide[]} slides
 * @param {Record<string, Record<string, string>>|null|undefined} overrides
 * @returns {Slide[]}
 */
export function applyPitchText(slides, overrides) {
  if (!overrides || typeof overrides !== 'object') return slides;
  return slides.map((slide) => {
    const patch = overrides[slide.id];
    if (!patch || typeof patch !== 'object') return slide;
    const copy = JSON.parse(JSON.stringify(slide));
    let touched = false;
    for (const [path, value] of Object.entries(patch)) {
      if (typeof value !== 'string') continue;
      if (setStringAt(copy, path, value)) touched = true;
    }
    return touched ? copy : slide;
  });
}
