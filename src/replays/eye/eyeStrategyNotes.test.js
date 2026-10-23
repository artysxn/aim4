// ---------------------------------------------------------------------------
// aim4 eye writing a strategy's notes: what it is shown, how its answer is
// read, and what it is not allowed to get away with. The model is scripted.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { finishEyeNote, parseEyeNotes, strategyFactSheet, writeNotesWithEye } from './eyeStrategyNotes.js';

/** Seconds into the round for a clock: 1:45 is 10. */
const at = (clock) => {
  const [m, s] = clock.split(':').map(Number);
  return 115 - (m * 60 + s);
};

const WINDOW_SMOKE = { type: 'smokegrenade' };
const CON_FLASH = { type: 'flashbang' };
const B_MOLO = { type: 'molotov' };

/** Two Ts on Mirage: one smokes Window and flashes Con from mid, one burns B. */
const FACTS = {
  side: 'T',
  window: { from: 0, to: 115 },
  cutoff: { sec: at('1:08'), why: 'plant' },
  exec: { from: at('1:25'), to: at('1:15') },
  plant: { sec: at('1:08'), site: 'B', player: 'bbb' },
  firstIn: null,
  players: new Map([
    [
      'aaa',
      {
        name: 'ropz',
        note: '<Smoke Window insta><!wnd1>, Stay Top mid until 1:30, <Flash Con 1:24><!con1>, Fight Jungle from Con',
        died: at('1:18'),
        bomb: false,
        route: [
          { zone: 'T Spawn', from: 0, to: 6 },
          { zone: 'Mid', from: 6, to: at('1:18') }
        ],
        holds: [{ position: 'Top mid', from: at('1:45'), to: at('1:30'), aim: 'Window' }],
        nades: [
          { grenade: WINDOW_SMOKE, sec: 1, word: 'Smoke', spot: 'Window', from: 'T Spawn', throwId: 'wnd1', insta: true, lineup: '', synced: '' },
          { grenade: CON_FLASH, sec: at('1:24'), word: 'Flash', spot: 'Con', from: 'Top mid', throwId: 'con1', insta: false, lineup: '', synced: '' }
        ]
      }
    ],
    [
      'bbb',
      {
        name: 'frozen',
        note: 'Take bomb. <Molo B Site 1:20><!bmol>',
        died: null,
        bomb: true,
        route: [
          { zone: 'T Spawn', from: 0, to: 8 },
          { zone: 'B Apps', from: 8, to: at('1:12') },
          { zone: 'B Site', from: at('1:12'), to: at('1:10') }
        ],
        holds: [{ position: 'B Apps', from: at('1:40'), to: at('1:22'), aim: '' }],
        nades: [{ grenade: B_MOLO, sec: at('1:20'), word: 'Molo', spot: 'B Site', from: 'B Apps', throwId: 'bmol', insta: false, lineup: '', synced: '' }]
      }
    ]
  ])
};
const SEATS = ['aaa', 'bbb'];
const COLUMNS = ['Mid', 'B'];
const META = {
  team1Side: 'T',
  team2Side: 'CT',
  players: [
    { id: 'aaa', name: 'ropz', team: 1, slot: 0 },
    { id: 'bbb', name: 'frozen', team: 1, slot: 1 },
    { id: 'ccc', name: 'jL', team: 2, slot: 2 },
    { id: 'ddd', name: 'b1t', team: 2, slot: 3 }
  ]
};

const sheet = () => strategyFactSheet({ facts: FACTS, columns: COLUMNS, seats: SEATS, mapCode: 'MIR', name: 'B burn', category: 'Set call', economy: 'Full buy' });

test('the sheet names every column, tags grenades in throw order, and shows the call', () => {
  const s = sheet();
  assert.match(s.text, /Strategy "B burn", Mirage, T side, Full buy, Set call\./);
  assert.match(s.text, /The call runs from 1:55 to 1:08, where it ends because the bomb was planted\./);
  assert.match(s.text, /The bomb is planted on B at 1:08 by frozen\./);
  assert.match(s.text, /1\. Mid: ropz/);
  assert.match(s.text, /2\. B: frozen/);
  // Throw order across the side: the insta smoke, the molotov at 1:20, the flash at 1:24.
  assert.deepEqual([...s.tags.keys()], ['g1', 'g2', 'g3']);
  assert.equal(s.tags.get('g1').throwId, 'wnd1');
  assert.equal(s.tags.get('g2').throwId, 'con1');
  assert.equal(s.tags.get('g3').throwId, 'bmol');
  assert.match(s.text, /g1 smoke landing Window, thrown insta, from T Spawn/);
  assert.match(s.text, /Holds: Top mid 1:45 to 1:30, watching Window/);
  assert.match(s.text, /His facts stop at 1:18, where he died: write nothing after it/);
  assert.match(s.text, /Job: carries the bomb out of spawn, plants on B at 1:08/);
  // The rules' draft carries this sheet's tags, never the archive's ids.
  assert.match(s.text, /Rules wrote: <Smoke Window insta><!g1>, Stay Top mid until 1:30, <Flash Con 1:24><!g2>/);
  assert.ok(!s.text.includes('wnd1'), 'an archive id leaked into the sheet');
});

test('the answer is read by column number, however it is dressed', () => {
  const reply = [
    'Here are the notes:',
    '**1:** Insta the window smoke.',
    '- 2) Take the bomb to B apps.',
    '3: a third column that does not exist',
    '1: a second answer for column one is ignored',
    'Description: Burn B and plant behind it.'
  ].join('\n');
  const { byColumn, description } = parseEyeNotes(reply, 2);
  assert.equal(byColumn.get(1), 'Insta the window smoke.');
  assert.equal(byColumn.get(2), 'Take the bomb to B apps.');
  assert.equal(byColumn.size, 2);
  assert.equal(description, 'Burn B and plant behind it.');
  // A clock is not a column number.
  assert.equal(parseEyeNotes('1:45 throw the smoke', 2).byColumn.size, 0);
});

const check = (raw, playerId = 'aaa') => {
  const s = sheet();
  return finishEyeNote(raw, {
    playerId,
    name: FACTS.players.get(playerId).name,
    column: COLUMNS[SEATS.indexOf(playerId)],
    tags: s.tags,
    clocks: s.clocks.get(playerId),
    enemyNames: ['jL', 'b1t']
  });
};

test("his own tags become the archive's ids, and the note opens with his name", () => {
  const out = check('Insta <Window smoke><!g1> from spawn, hold Top mid until 1:30, then <Con flash><!g2> at 1:24.');
  assert.equal(out.ok, true, out.why);
  assert.equal(out.text, 'ropz: Insta <Window smoke><!wnd1> from spawn, hold Top mid until 1:30, then <Con flash><!con1> at 1:24.');
  assert.equal(out.linked, 2);
});

test('a column or name the model repeated is dropped', () => {
  assert.equal(check('Mid (ropz): Hold Top mid until 1:30.').text, 'ropz: Hold Top mid until 1:30.');
  assert.equal(check('ropz: Hold Top mid until 1:30.').text, 'ropz: Hold Top mid until 1:30.');
});

test("a teammate's grenade is unlinked when named with him, and refused when given to the wrong man", () => {
  const behind = check('Go B apps and enter behind frozen\'s <B molo><!g3> at 1:20.', 'aaa');
  assert.equal(behind.ok, true, behind.why);
  assert.ok(!behind.text.includes('<!'), behind.text);
  const stolen = check('Throw <B molo><!g3> at 1:20.', 'aaa');
  assert.equal(stolen.ok, false);
});

test('made-up markup and ids never survive', () => {
  const out = check('Hold <Top mid> until 1:30, <!zz99> then <Con flash><!g9> at 1:24.');
  assert.equal(out.ok, true, out.why);
  // The made-up tag goes; "Con flash" is his own flash in plain words, so it is linked to the real one.
  assert.equal(out.text, 'ropz: Hold Top mid until 1:30, then <Con flash><!con1> at 1:24.');
});

test('a time that is not in the round is refused; a second or two off is not', () => {
  assert.equal(check('Hold Top mid until 1:31.').ok, true);
  const out = check('Hold Top mid until 0:50.');
  assert.equal(out.ok, false);
  assert.match(out.why, /0:50/);
});

test('naming the other team is refused', () => {
  assert.equal(check('Hold Top mid until 1:30, watch for jL in Window.').ok, false);
  // A word that merely contains a name is not the name.
  assert.equal(check('Hold Top mid until 1:30, jLook at Window.').ok, true);
});

test('a column the model gets wrong keeps the rules\' note; the rest are its own', async () => {
  const notes = new Map([
    ['aaa', 'ropz: <Smoke Window insta><!wnd1>, Stay Top mid until 1:30'],
    ['bbb', 'frozen: Take bomb. <Molo B Site 1:20><!bmol>']
  ]);
  const seen = [];
  const written = await writeNotesWithEye({
    facts: FACTS,
    notes,
    seats: SEATS,
    columns: COLUMNS,
    meta: META,
    mapCode: 'MIR',
    name: 'B burn',
    ask: async (messages) => {
      seen.push(messages);
      return [
        '1: Insta <Window smoke><!g1>, then hold Top mid watching Window until 1:30.',
        '2: Carry the bomb to B apps and burn <B site molo><!g3> at 0:40.',
        'Description: Smoke mid off spawn, burn B and plant.'
      ].join('\n');
    }
  });
  // The first answer, then one repair round for column 2 alone.
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0].role, 'system');
  assert.match(seen[0][1].content, /1\. Mid: ropz/);
  const fix = seen[1].at(-1).content;
  assert.match(fix, /^These lines need fixing:\n/);
  assert.match(fix, /\n2: 0:40 is not a time in his facts\./);
  // Column 1 was good but left his Con flash unlinked: it is asked to add it.
  assert.match(fix, /\n1: Link every grenade he throws with its tag: g2 flash landing Con\./);
  assert.equal(written.notes.get('aaa'), 'ropz: Insta <Window smoke><!wnd1>, then hold Top mid watching Window until 1:30.');
  // 0:40 is nowhere in the round: the rules' line stays.
  assert.equal(written.notes.get('bbb'), notes.get('bbb'));
  assert.equal(written.fromEye, 1);
  assert.deepEqual(written.fellBack.map((f) => f.column), ['B']);
  assert.equal(written.description, 'Smoke mid off spawn, burn B and plant.');
});

test('an answer in no usable shape is asked again without thinking, then is an error', async () => {
  const calls = [];
  await assert.rejects(
    writeNotesWithEye({
      facts: FACTS,
      notes: new Map(),
      seats: SEATS,
      columns: COLUMNS,
      meta: META,
      mapCode: 'MIR',
      ask: async (messages, opts) => {
        calls.push(opts.thinking);
        return 'I could not read this round.';
      }
    }),
    /shape/
  );
  assert.deepEqual(calls, [undefined, false]);
});

test('an empty answer that comes right the second time is used', async () => {
  let n = 0;
  const written = await writeNotesWithEye({
    facts: FACTS,
    notes: new Map([['aaa', 'ropz: rules'], ['bbb', 'frozen: rules']]),
    seats: SEATS,
    columns: COLUMNS,
    meta: META,
    mapCode: 'MIR',
    ask: async () => (++n === 1 ? '' : '1: Insta <window smoke><!g1>, hold Top mid, <con flash><!g2> 1:24.\n2: Take bomb. Burn <B site molo><!g3> 1:20.')
  });
  assert.equal(written.fromEye, 2);
  assert.equal(written.notes.get('bbb'), 'frozen: Take bomb. Burn <B site molo><!bmol> 1:20.');
});

test('two bare tags side by side are not a link', () => {
  assert.equal(check('Flash con 1:24 <!g2><!g2>, hold Top mid.').text, 'ropz: <Flash con><!con1> 1:24, hold Top mid.');
});

test('a note written backwards up the clock is refused', () => {
  const out = check('From Top mid <Con flash><!g2> at 1:24, then hold Top mid until 1:30.');
  assert.equal(out.ok, false);
  assert.match(out.why, /backwards \(1:24 before 1:30\)/);
  // Two grenades "at 1:41-1:42" are one moment, not a step back.
  assert.equal(check('Hold Top mid until 1:30, <Con flash><!g2> at 1:24-1:25.').ok, true);
});

test('a sentence about dying is dropped, the rest kept', () => {
  assert.equal(check('Hold Top mid until 1:30. Part ends at 1:18.').text, 'ropz: Hold Top mid until 1:30.');
  assert.equal(check('Hold Top mid until 1:30. He dies at 1:18.').text, 'ropz: Hold Top mid until 1:30.');
  assert.equal(check('Hold Top mid until 1:30 — then flash.').text, 'ropz: Hold Top mid until 1:30, then flash.');
});

test('the repair round can save a column', async () => {
  let calls = 0;
  const written = await writeNotesWithEye({
    facts: FACTS,
    notes: new Map([['aaa', 'ropz: rules'], ['bbb', 'frozen: rules']]),
    seats: SEATS,
    columns: COLUMNS,
    meta: META,
    mapCode: 'MIR',
    ask: async (messages, opts) => {
      calls++;
      if (calls === 1) return '1: Hold Top mid until 1:30.\n2: Burn <B site molo><!g3> at 1:20, then take B apps at 1:40.';
      assert.equal(opts.thinking, false, 'the repair is asked without thinking');
      return '2: Take B apps at 1:40 with the bomb, burn <B site molo><!g3> at 1:20.';
    }
  });
  assert.equal(calls, 2);
  assert.equal(written.fromEye, 2);
  assert.equal(written.notes.get('bbb'), 'frozen: Take B apps at 1:40 with the bomb, burn <B site molo><!bmol> at 1:20.');
});

test("the coach's 1.42 is read as a clock, and his lineup numbers go", () => {
  assert.equal(check('Hold Top mid until 1.30 (ID 136).').text, 'ropz: Hold Top mid until 1:30.');
  // "Smoke window" is his own smoke in plain words, so it is linked as well.
  assert.equal(check('Smoke window insta, ID 117 118, hold Top mid.').text, 'ropz: <Smoke window><!wnd1> insta, hold Top mid.');
  assert.equal(check('Flash con (97, 98) and hold Top mid.').text, 'ropz: <Flash con><!con1> and hold Top mid.');
  // Read as a clock, so checked as one: 0.50 is nowhere in his round.
  assert.equal(check('Hold Top mid until 0.50.').ok, false);
});

test('a buy in the facts is shown to the model', () => {
  const facts = { ...FACTS, players: new Map([...FACTS.players].map(([id, p]) => [id, id === 'bbb' ? { ...p, buy: 'SM' } : p])) };
  const s = strategyFactSheet({ facts, columns: COLUMNS, seats: SEATS, mapCode: 'MIR' });
  assert.match(s.text, /2\. B: frozen\n  Buy: SM\n/);
  assert.ok(!/1\. Mid: ropz\n  Buy:/.test(s.text), 'a player without a buy line got one');
});

test('a note that runs long is kept, and the repair round is asked to shorten it', async () => {
  const long = `Insta <window smoke><!g1>, hold Top mid watching Window until 1:30, ${'then keep holding the same angle and stay there, '.repeat(5)}then <con flash><!g2> 1:24.`;
  const short = 'Insta <window smoke><!g1>, hold Top mid until 1:30, then <con flash><!g2> 1:24.';
  let asked = '';
  const written = await writeNotesWithEye({
    facts: FACTS,
    notes: new Map([['aaa', 'ropz: rules'], ['bbb', 'frozen: rules']]),
    seats: SEATS,
    columns: COLUMNS,
    meta: META,
    mapCode: 'MIR',
    ask: async (messages) => {
      if (messages.length > 2) {
        asked = messages.at(-1).content;
        return `1: ${short}`;
      }
      return `1: ${long}\n2: Take the bomb, burn <B site molo><!g3> 1:20.`;
    }
  });
  assert.match(asked, /1: Too long/);
  assert.equal(written.notes.get('aaa'), `ropz: ${short.replace('<!g1>', '<!wnd1>').replace('<!g2>', '<!con1>')}`);
  assert.equal(written.fromEye, 2);
});

test('the buy that opens a note is his loadout, never the model', () => {
  const s = sheet();
  const run = (raw, buy) =>
    finishEyeNote(raw, { playerId: 'aaa', name: 'ropz', column: 'Mid', tags: s.tags, clocks: s.clocks.get('aaa'), buy }).text;
  // Made up on a full buy: removed.
  assert.equal(run('SFF. Hold Top mid until 1:30.', ''), 'ropz: Hold Top mid until 1:30.');
  // Wrong: replaced. Missing: put back.
  assert.equal(run('SFF. Hold Top mid until 1:30.', 'SM'), 'ropz: SM. Hold Top mid until 1:30.');
  assert.equal(run('Hold Top mid until 1:30.', 'K'), 'ropz: K. Hold Top mid until 1:30.');
  assert.equal(run('KSF+Tec9, hold Top mid until 1:30.', 'KSF+Tec9'), 'ropz: KSF+Tec9. Hold Top mid until 1:30.');
  // A note that opens with a word is left alone.
  assert.equal(run('Smoke window insta, hold Top mid.', ''), 'ropz: <Smoke window><!wnd1> insta, hold Top mid.');
});

test('a freezetime drop the model left out goes straight after the buy', () => {
  const s = sheet();
  const run = (raw) =>
    finishEyeNote(raw, { playerId: 'aaa', name: 'ropz', tags: s.tags, clocks: s.clocks.get('aaa'), buy: 'SF+P250', handed: ['Drop p250 to frozen.'] }).text;
  assert.equal(run('Hold Top mid until 1:30.'), 'ropz: SF+P250. Drop p250 to frozen. Hold Top mid until 1:30.');
  // Said already, in his own words: not said twice.
  assert.equal(run('SF+P250. Drop the p250 to frozen, hold Top mid until 1:30.'), 'ropz: SF+P250. Drop the p250 to frozen, hold Top mid until 1:30.');
});

test('a pistol note for a man who held and moved on, with no time in it, is sent back for its times', async () => {
  const asked = [];
  const written = await writeNotesWithEye({
    facts: FACTS,
    notes: new Map([['aaa', 'ropz: rules'], ['bbb', 'frozen: rules']]),
    seats: SEATS,
    columns: COLUMNS,
    meta: META,
    mapCode: 'MIR',
    economy: 'Pistol',
    ask: async (messages) => {
      asked.push(messages.at(-1).content);
      return messages.length > 2
        ? '1: Insta <window smoke><!g1>, hold Top mid until 1:30, then <con flash><!g2> 1:24.'
        : '1: Insta <window smoke><!g1>, hold Top mid, then <con flash><!g2>.\n2: Burn <B site molo><!g3> 1:20.';
    }
  });
  assert.match(asked[1], /1: Pistol round: time it/);
  assert.ok(!/\n2: /.test(asked[1]), `a timed note was sent back too: ${asked[1]}`);
  assert.equal(written.notes.get('aaa'), 'ropz: Insta <window smoke><!wnd1>, hold Top mid until 1:30, then <con flash><!con1> 1:24.');
});
