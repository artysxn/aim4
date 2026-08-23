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
// deck can never contradict the pricing page.
// ---------------------------------------------------------------------------

import { PLAN_PRICES } from '../../shared/entitlements/catalogue.js';

const price = (id) => `€${PLAN_PRICES[id].monthly.toFixed(2)}`;

/**
 * @typedef {{
 *   id: string, kicker?: string, title: string, lead?: string,
 *   points?: string[], columns?: {tag?: string, title: string, lead?: string, points?: string[]}[],
 *   table?: {head: string[], rows: string[][], highlight?: number},
 *   stats?: {value: string, label: string}[],
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
    lead: 'One platform for Counter-Strike preparation: demo review, statistics, opponent scouting, strategy, and mechanical training. Built by a competitor, for competitors.',
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
    title: 'Not only teams. Anyone.',
    lead: 'The team toolkit is the deep end. The shallow end is every solo player who wants to get better, and it is a far larger market.',
    columns: [
      { title: 'Solo player', points: ['Own stats and trends', 'Aim training and routines', 'Learn from pro demos'] },
      { title: 'Analyst / coach', points: ['Anti-strat automation', 'Pattern search', 'Report building'] },
      { title: 'Team', points: ['Stratbook and roles', 'Shared library and seats', 'Win models and auto coach'] }
    ],
    note: 'You can do everything from the website, including mechanical training suited to your needs. No install, no second account.'
  },

  // ---- the minuses -------------------------------------------------------
  {
    id: 'minus-today',
    kicker: 'Honest weakness',
    tone: 'minus',
    title: 'What is missing today',
    points: [
      'One developer. Every line is mine, which is the biggest single risk in this deck.',
      'No marketing, no sales, no brand presence. The product has never been put in front of an audience.',
      'Billing is built but not switched on. Revenue today is zero.',
      'No company structure, no legal or accounting function behind it.',
      'Support, onboarding and documentation are thin.'
    ]
  },
  {
    id: 'minus-risks',
    kicker: 'Honest weakness',
    tone: 'minus',
    title: 'What could go wrong',
    points: [
      'Competitors are funded and can buy attention faster than I can earn it.',
      'The product depends on demo formats and third-party data sources that I do not control.',
      'First development venture: the engineering is proven by the product, not by a track record.',
      'Team software sells slowly. The buying cycle is a season, not a click.',
      'Infrastructure cost grows with the library. It scales, but it is not free.'
    ],
    note: 'Every one of these is a gap a partner or an investor fills. That is the point of this conversation.'
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
    tableNote: 'Same data, same account, different depth. Nobody has to leave to grow, and nobody pays for depth they cannot use yet.'
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
    stats: [
      { value: '~1M', label: 'CS2 concurrent players' },
      { value: '1,000s', label: 'registered amateur teams' },
      { value: '5-14', label: 'seats per team sale' }
    ],
    points: [
      'ESEA, ESL, FACEIT and national leagues are full of teams already paying for servers, stats and practice tools.',
      'The buyer is the team or the coach, so one sale is five to fourteen seats and renews by season.',
      'The solo tier feeds the funnel: players arrive alone and bring their team later.',
      'The aim-training crowd is a second door into the same funnel, and it already has the habit of paying for practice software.'
    ]
  },
  {
    id: 'model-a',
    kicker: 'Revenue model A',
    title: 'Priced per seat, as built today',
    lead: 'What the site currently charges. The composition that reaches roughly $33,000 a month, if aim4 becomes the tool teams default to.',
    table: {
      head: ['Tier', 'Price', 'Subscribers', 'Monthly'],
      rows: [
        ['Premium (solo)', `${price('premium')}`, '500', '€5,000'],
        ['Team Premium', `${price('team_premium')}`, '700', '€21,000'],
        ['Team Elite', `${price('team_elite')}`, '80', '€4,800'],
        ['Total', '', '', '€30,800 / ~$33,000']
      ],
      highlight: 3
    },
    tableNote: 'A modelled ceiling at market-leading share, not a forecast. Today the figure is zero.'
  },
  {
    id: 'model-b',
    kicker: 'Revenue model B',
    title: 'Priced per organisation',
    lead: 'The alternative. Sell to the org rather than the seat, and let the tier decide how much of the cutting edge it gets.',
    columns: [
      {
        tag: 'Tier 1',
        title: '699 / month',
        lead: 'Everything, limitless. Exclusive access to the newest models and tools, plus all of Tier 2.'
      },
      {
        tag: 'Tier 2',
        title: '199 / month',
        lead: 'Good but bounded access to the cutting-edge features, plus all of Tier 3.'
      },
      {
        tag: 'Tier 3',
        title: '89 / month',
        lead: 'Very limited cutting edge, bounded access to some Tier 2 tools, and every basic paid feature without limits.'
      }
    ],
    note: 'Solo mirrors the same ladder: Lite at 9 is a Tier 3 for one player without the team management, Premium at 19 is a Tier 2 for one player.'
  },
  {
    id: 'model-b-math',
    kicker: 'Revenue model B',
    title: 'The same ceiling, a ninth of the customers',
    lead: 'The reason to prefer it: 91 organisations instead of 780 team subscriptions, for the same money.',
    table: {
      head: ['Product', 'Price', 'Customers', 'Monthly'],
      rows: [
        ['Team Tier 1', '€699', '19', '€13,281'],
        ['Team Tier 2', '€199', '15', '€2,985'],
        ['Team Tier 3', '€89', '57', '€5,073'],
        ['Solo Premium', '€19', '230', '€4,370'],
        ['Solo Lite', '€9', '550', '€4,950'],
        ['Total', '', '871', '€30,659 / ~$33,100']
      ],
      highlight: 5
    },
    tableNote: 'Team side ~$23,000, solo side ~$10,000, at 1.08 USD per EUR. Fewer, larger contracts: slower to close, far cheaper to service.'
  },

  // ---- roadmap -----------------------------------------------------------
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
      'No equity, no board seat, no say in the roadmap.',
      'Paid from the first euro of revenue, not from profit.',
      'Runs in perpetuity, and is transferable.',
      'Capital goes to marketing, infrastructure and buying development time.'
    ],
    note: 'Amount and percentage to be set together. The revenue model two slides back is the basis for both.'
  },
  {
    id: 'ask-partner',
    kicker: 'Option B',
    tone: 'ask',
    title: 'Partner',
    lead: '49% of the company. Income split 50/50. I keep 51% and the product direction; you take everything I am not equipped to do.',
    columns: [
      {
        title: 'You bring',
        points: ['Promotion and marketing', 'Sales and partnerships', 'Logistics and operations', 'Legal and company structure']
      },
      {
        title: 'I bring',
        points: ['The product, entirely built', 'Development and roadmap', 'Domain expertise and network', 'Ongoing engineering']
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
      'One condition, non-negotiable: 5% of income comes to me as a permanent royalty.',
      'Handover includes the codebase, infrastructure, data pipeline and documentation.',
      'A transition period of development support can be agreed on top.',
      'Priced above both other options, because it ends my upside.'
    ],
    big: 'aim4',
    note: 'Everything is negotiable except the 5%.'
  },
  {
    id: 'close',
    kicker: 'aim4.io',
    title: 'Aim for trophies.',
    lead: 'The product is finished enough to sell and far from finished. What it is missing is not engineering.',
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
