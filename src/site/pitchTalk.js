// ---------------------------------------------------------------------------
// site/pitchTalk.js
// The talking version of the pitch: thirteen slides, no prose.
//
// The full deck (pitchContent.js) reads on its own — it is written to be sent
// to someone and understood without me in the room. This one is the opposite:
// labels, numbers and matrices only, sized to be read from the back of a room
// while I talk over it. Nothing here explains itself, on purpose.
//
// The explanation lives in `script`, one array of spoken paragraphs per slide,
// shown in the transcript panel that slides in from the right edge. That is what
// makes the shared link usable too: a reader who was not in the room can open
// the transcript and hear the same talk.
//
// Same slide contract as the full deck, plus three primitives this one needs:
//   lists  — grouped bullet lists, for inventories
//   flow   — a sequence with arrows, for a loop
//   bars   — labelled magnitudes, scaled against the largest on the slide
//
// Ids are prefixed `t-` so both decks can share one override store.
// ---------------------------------------------------------------------------

import { PLAN_PRICES } from '../../shared/entitlements/catalogue.js';

const price = (id) => `€${PLAN_PRICES[id].monthly.toFixed(2)}`;

/** @type {import('./pitchContent.js').Slide[]} */
export const TALK_SLIDES = [
  {
    id: 't-title',
    kicker: 'aim4.io',
    title: 'Aim for trophies.',
    center: true,
    big: 'AIM4',
    script: [
      "I'm Daniel. I have played Counter-Strike at a competitive level for about fifteen years, and for the last seven of those I have been the one in the team who decides what we practise next.",
      'aim4 is the tool I built because that job was harder than it needed to be. It is a preparation platform: demo review, statistics, scouting, strategy and mechanical training, in one place.',
      'Everything I am going to show you is built and running today. None of it is a plan. This takes about twenty minutes — stop me whenever you want.'
    ]
  },

  {
    id: 't-who',
    kicker: 'Who',
    title: 'Built by a competitor',
    stats: [
      { value: '15,000', label: 'hours in CS' },
      { value: '7 yrs', label: 'IGL · analyst · coach' },
      { value: '3rd', label: 'ESEA Entry S57' },
      { value: '1', label: 'developer' }
    ],
    lists: [
      {
        title: 'Results',
        items: ['Ukrainian Oldplayers Tour — 1st', 'Norwegian national league — 2nd ×2', 'Professional-level FPS aim']
      },
      {
        title: 'Behind it',
        items: ['Written entirely by me', 'Educated graphic designer', 'Advised by an MSc statistician', 'First development venture']
      }
    ],
    script: [
      'Fifteen thousand hours in the game. Third place in ESEA Entry season 57, a win in the Ukrainian Oldplayers Tour, and two second places in the Norwegian national league.',
      'Seven years as in-game leader, analyst and coach. That is the seat that decides what a team works on, and it is the seat this product is built for.',
      'I also aim at a professional level, which matters when we get to the trainer: it is my own routine, not a feature I specified from a distance.',
      'And the part you should weigh carefully. I built all of this alone — every line of code is mine. I am an educated graphic designer, this is my first development venture, and I have worked alongside statisticians, including a Norwegian CS2 coach with a master’s in statistical analysis, to keep the numbers honest.'
    ]
  },

  {
    id: 't-what',
    kicker: 'The product',
    title: 'Everything in the box',
    dense: true,
    lists: [
      {
        title: 'Demos',
        items: ['Upload & parse', 'Thousands of pro matches', 'Playlists', 'Private · team · public']
      },
      {
        title: 'Review',
        items: ['2D viewer', '3D viewer, real geometry', 'Round library', 'Drawing board']
      },
      {
        title: 'Data',
        items: ['Every round', '100+ columns', 'Rating 3.0', 'Players & teams', 'Any filter']
      },
      {
        title: 'Search',
        items: ['Pattern finder', 'Explore', 'Meta', 'Charts + averages']
      },
      {
        title: 'Models',
        items: ['Round win probability', 'Duel win probability', 'Openings · 5v4 · 4v5', 'Autocoach', 'Auto anti-strat']
      },
      {
        title: 'Prepare',
        items: ['Stratbook', 'Documents', 'Roles & positions', '2D strategy creator', 'Utility archive']
      },
      {
        title: 'Perform',
        items: ['Player trends', 'Team trends', 'Peer comparison', 'Leaderboards', 'Public profiles']
      },
      {
        title: 'Train',
        items: ['Aim trainer in browser', 'Routines from your data', 'Map practice', 'Run replays', 'ELO & achievements']
      }
    ],
    script: [
      'This is the whole product on one slide. Eight areas.',
      'Demos: upload and parse anything, plus thousands of professional matches already parsed and searchable. Review: 2D and 3D playback in the browser, and a round library that names what actually happened in a round instead of leaving you to describe it.',
      'Data: every round, for players and for teams, over a hundred columns, and our own rating built for this game rather than inherited from 1.6. Search: find rounds by what happened, not by who was in them.',
      'Models: round win probability, duel win probability, opening kills and man-advantage conversion — and an automatic anti-strat document on any opponent.',
      'Then the team room: stratbook, documents, roles, a 2D strategy creator, a utility archive. And training: an aim trainer in the same browser tab, with routines built from your own measured weaknesses.',
      'The important part is not the list. It is that all of it reads the same rounds and writes to the same profile. That is the thing a competitor cannot copy one feature at a time.'
    ]
  },

  {
    id: 't-replaces',
    kicker: 'Why',
    title: 'Six tools, one tab',
    columns: [
      {
        title: 'Today',
        lists: ['Demo player', 'Stats site', 'Google Docs', 'Screenshot folder', 'Practice server', 'Aim trainer']
      },
      {
        title: 'With aim4',
        lists: ['One account', 'One library', 'One profile']
      }
    ],
    table: {
      wrap: true,
      head: ['Job', 'Before', 'Now'],
      rows: [
        ['Anti-strat', '10 demos, notes', 'Filter → report'],
        ['Lineups', 'YouTube scrubbing', 'Search'],
        ['Stats table', 'Spreadsheet by hand', 'Query'],
        ['Lost round', 'Rewatch and guess', 'Win probability'],
        ['Practice plan', 'Coach intuition', 'Measured weakness']
      ]
    },
    script: [
      'Right now a team does this with six things that do not talk to each other: a demo player, a stats site, Google Docs, a folder of screenshots, a practice server and an aim trainer. Nothing carries across, so everything is copied by hand.',
      'And everything in that table used to be an evening. Anti-stratting an opponent meant watching ten demos and taking notes — now it is a filter and a report. Finding a lineup meant scrubbing YouTube — now it is a search. Understanding why a round was lost meant rewatching and guessing — now the model shows you where the round actually turned.',
      'That is the core promise. It buys back time, and time is what every amateur team is shortest of.'
    ]
  },

  {
    id: 't-loop',
    kicker: 'Training',
    title: 'The loop nobody else closes',
    flow: ['Play a match', 'Measured weakness', 'Targeted routine', 'Measure again'],
    lists: [
      {
        title: 'Already measured',
        items: ['Crosshair placement', 'Reaction', 'Opening duels', 'Utility damage', 'Positioning', 'Movement']
      },
      {
        title: 'Second audience',
        items: ['KovaaK’s', 'Aim Labs', 'Built by a pro-level aimer', 'No install']
      }
    ],
    script: [
      'This is the loop that makes the training half worth anything.',
      'The site already measures crosshair placement, reaction, opening duels, utility damage, positioning, movement. So a routine does not have to be a generic playlist — it is built from your own numbers. You train the gap, you play, and it measures again.',
      'Two things nobody has together. The trainer was built by someone who aims at a professional level, from the exercises that got me there. And the demo data to tell you which exercise you actually need.',
      'It also opens a second audience. The KovaaK’s and Aim Labs crowd already pays to train aim and never opens a demo. That is a second door into the same funnel, and it is a big one.'
    ]
  },

  {
    id: 't-tiers',
    kicker: 'Playerbase',
    title: 'Five tiers, one platform',
    table: {
      wrap: true,
      head: ['', 'Who', 'Wants', 'Gets'],
      rows: [
        ['T1', 'MM / Premier · FACEIT 4–9', 'Why do I lose?', 'Own demos, plain stats, trainer'],
        ['T2', 'FACEIT 10 · 2000–2500', 'Consistency', 'Trends, routines, duel model'],
        ['T3', 'FACEIT 10 2500+ · Open–Main', 'First team structure', 'Stratbook, roles, team stats, seats'],
        ['T4', 'ESEA Advanced – top 50', 'Weekly opponent prep', 'Anti-strat, patterns, models, Autocoach'],
        ['T5', 'Top 50 VRS and up', 'Depth and an edge', 'Everything, unlimited, earliest']
      ]
    },
    script: [
      'Here is how one product serves five very different players.',
      'A Premier player wants a simple answer to why he keeps losing. A low level-ten wants consistency — aim, positioning, decisions. A high level-ten or an ESEA Open team is building real structure for the first time. An Advanced-to-top-fifty team wants opponent preparation, fast, every week. And a top-fifty team wants depth, ownership of its own data, and an edge nobody else has.',
      'Same rounds, same account, different depth. Nobody has to leave the platform to grow, and nobody pays for depth they cannot use yet.'
    ]
  },

  {
    id: 't-coverage',
    kicker: 'The gap',
    title: 'Nobody serves the ladder',
    table: {
      head: ['', 'T1', 'T2', 'T3', 'T4', 'T5'],
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
    script: [
      'This is the opening. Every competitor picked a band and stayed in it.',
      'Leetify and scope.gg live at the bottom, with solo players. SCL is almost entirely tier three. CS2Lens sits at three and four. Skybox Edge and pracc are three to five, for teams.',
      'Only one row spans the ladder. The population is bottom-heavy and the budgets are top-heavy, so covering the whole thing means acquiring where the players are and earning where the money is, inside one funnel. The tier-one player who learns on aim4 brings his tier-three team with him two years later.'
    ]
  },

  {
    id: 't-vs',
    kicker: 'The gap',
    title: 'Feature by feature',
    table: {
      head: ['', 'Review', 'Team stats', 'Patterns', 'Models', 'Stratbook', 'Aim'],
      highlight: 0,
      rows: [
        ['aim4.io', '● 2D+3D', '●', '●', '●', '●', '●'],
        ['Skybox Edge', '● 3D', '◐', '·', '·', '·', '·'],
        ['CS2Lens', '● 2D', '◐', '·', '·', '·', '·'],
        ['pracc.com', '·', '·', '·', '·', '◐', '·'],
        ['Stratbase', '·', '·', '·', '·', '●', '·'],
        ['Refrag', '·', '◐', '·', '·', '·', '◐'],
        ['Leetify', '◐ clips', '◐ solo', '·', '◐', '·', '·'],
        ['SCL.gg', '·', '◐ league', '·', '·', '·', '·']
      ]
    },
    script: [
      'Same competitors, feature by feature.',
      'Some do demo review. Some do statistics. One does a stratbook. One does practice servers. Nobody does review, team statistics, pattern search, win models, a stratbook and mechanical training in one place.',
      'I am not claiming to be better than each of them at their one thing. I am claiming that a team today pays three or four of them, and still moves everything between the tools by hand.'
    ]
  },

  {
    id: 't-market',
    kicker: 'Market',
    title: 'Who pays, and how often',
    stats: [
      { value: '~1M', label: 'CS2 concurrent' },
      { value: '1,000s', label: 'registered teams' },
      { value: '5–14', label: 'seats per sale' },
      { value: 'Season', label: 'renewal cycle' }
    ],
    lists: [
      {
        title: 'Where they already pay',
        items: ['ESEA', 'ESL', 'FACEIT', 'National leagues', 'Practice servers', 'Stats sites', 'Aim trainers']
      },
      { title: 'Two doors', items: ['Solo player → brings the team', 'Aim trainee → opens the demo'] }
    ],
    script: [
      'Roughly a million people play CS2 at any given moment. Thousands of amateur teams are registered in ESEA, ESL, FACEIT and the national leagues, and they already pay for servers, statistics and practice tools. That habit is the important part — I am not creating a new spending category.',
      'The buyer is a team or a coach, so one sale is five to fourteen seats, and it renews by season rather than by month.',
      'Two doors into the funnel. Solo players who arrive alone and bring their team later, and the aim-training community that already pays for practice software.'
    ]
  },

  {
    id: 't-money',
    kicker: 'Money',
    title: 'Two models, one ceiling',
    columns: [
      {
        tag: 'Model A',
        title: 'Per seat',
        bars: [
          { label: 'Solo Premium', value: `${price('premium')} × 500`, n: 5000 },
          { label: 'Team Premium', value: `${price('team_premium')} × 700`, n: 21000 },
          { label: 'Team Elite', value: `${price('team_elite')} × 80`, n: 4800 }
        ],
        foot: '€30,800 / mo · 1,280 subscriptions'
      },
      {
        tag: 'Model B',
        title: 'Per organisation',
        bars: [
          { label: 'Team Tier 1', value: '€699 × 19', n: 13281 },
          { label: 'Team Tier 2', value: '€199 × 15', n: 2985 },
          { label: 'Team Tier 3', value: '€89 × 57', n: 5073 },
          { label: 'Solo Premium', value: '€19 × 230', n: 4370 },
          { label: 'Solo Lite', value: '€9 × 550', n: 4950 }
        ],
        foot: '€30,659 / mo · 91 orgs + 780 solo'
      }
    ],
    script: [
      'Two ways to price it. Both land in the same place: about thirty-three thousand dollars a month at market-leading share. That is a modelled ceiling, not a forecast — today the number is zero, because billing is built but not switched on.',
      'Model A is what the site charges now, per seat. Five hundred solo subscriptions, seven hundred team premium, eighty elite.',
      'Model B sells to the organisation instead. Tier one at six ninety-nine gets everything, unlimited, with exclusive access to the newest models. Tier two at one ninety-nine gets bounded access to that cutting edge plus everything below it. Tier three at eighty-nine gets every basic paid feature unlimited and a taste of the rest. Solo mirrors the same ladder at nine and nineteen euro.',
      'Same ceiling, ninety-one organisations instead of seven hundred and eighty subscriptions. Slower to close, far cheaper to service. I lean towards B, and I would like your read on it.'
    ]
  },

  {
    id: 't-honest',
    kicker: 'Honest',
    title: 'What is missing',
    lists: [
      {
        title: 'Gaps',
        items: ['One developer', 'No marketing', 'No sales', 'Revenue €0', 'No company structure', 'Thin support & docs']
      },
      {
        title: 'Risks',
        items: ['Funded competitors', 'Third-party data sources', 'Season-long buying cycle', 'Cost scales with library', 'First venture']
      }
    ],
    script: [
      'The honest half, and I would rather say it than have you find it.',
      'One developer. That is the single biggest risk in this deck. No marketing, no sales, no brand presence — this product has never been put in front of an audience. Revenue is zero. There is no company structure behind it, and support and documentation are thin.',
      'The risks: competitors are funded and can buy attention faster than I can earn it. I depend on demo formats and data sources I do not control. Team software sells by the season, not by the click. And infrastructure cost grows with the library.',
      'Every one of those is a gap somebody else fills. That is exactly why I am in the room.'
    ]
  },

  {
    id: 't-roadmap',
    kicker: 'Next',
    title: 'Roadmap',
    lists: [
      { title: 'In game', items: ['CS2 plugin practice', 'Neural-net bots', 'Tuned to one opponent'] },
      { title: 'Data', items: ['ESEA import', 'Pug platforms', 'Non-HLTV events', 'Model accuracy'] },
      { title: 'Coaching', items: ['TeamSpeak comms review', 'Sharper auto coach', 'Deeper anti-strat'] }
    ],
    script: [
      'Where it goes next.',
      'In game: a CS2 plugin so the same bot practice runs inside the real game, with your own team. And neural networks to build bots that behave like real players, tuned to a specific team or a specific opponent you are about to face.',
      'Data: automatic match import from ESEA, pug platforms and the events HLTV does not cover, plus continuous work on model accuracy.',
      'Coaching: a TeamSpeak bot that reviews your in-match communication, a sharper auto coach, and a deeper anti-strat tool — more triggers, simpler output.',
      'Every one of those widens the market rather than deepening a niche.'
    ]
  },

  {
    id: 't-ask',
    kicker: 'The ask',
    tone: 'ask',
    title: 'Three ways in',
    big: 'aim4',
    columns: [
      {
        tag: 'A',
        title: 'Investor',
        lists: ['Capital in', '% of gross income', 'No equity, no control', 'Perpetual & transferable']
      },
      {
        tag: 'B',
        title: 'Partner',
        lists: ['49% of the company', 'Income 50 / 50', 'You: sales, marketing, legal', 'I keep 51% and the product']
      },
      {
        tag: 'C',
        title: 'Full sale',
        lists: ['Code, infra, data, name', '5% royalty — non-negotiable', 'Priced highest', 'Transition support optional']
      }
    ],
    script: [
      'Three ways in, and all three are open.',
      'A: you invest. Capital in, a fixed percentage of gross subscription income out, for as long as the product earns. No equity, no board seat, no say in the roadmap. Paid from the first euro of revenue, not from profit.',
      'B: you partner. Forty-nine per cent of the company, income split fifty-fifty. You take promotion, sales, logistics, legal and structure — everything I am not equipped to do. I keep fifty-one per cent and the product direction. Control stays with the product, reward is equal.',
      'C: you buy it. Everything transfers — the codebase, the infrastructure, the data pipeline, the name. One condition that is not negotiable: five per cent of income comes to me as a permanent royalty. It is priced above the other two, because it ends my upside.',
      'So: which of those is the conversation you want to have?'
    ]
  }
];
