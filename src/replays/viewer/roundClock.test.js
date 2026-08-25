// Run: node src/replays/viewer/roundClock.test.js
//
// The clock above the map, and the one thing it has to get right in two
// different ways at once:
//
//   watching ONE round, a plant replaces the countdown with the 40 second bomb
//   timer, because that is what the game does and what the viewer is showing;
//
//   watching MANY rounds in the Analyzer, it must not, because there the clock
//   is the axis every round is aligned on (`freezeEndTick + pos * tickRate`).
//   Reading it off one reference round let a plant in that round rewrite the
//   shared readout: at 1:10 it jumped to 0:40 while every other round on screen
//   was still live, thirty seconds behind what the clock said.

import assert from 'node:assert';
import { clockAt, timingFor, ROUND_SECONDS, BOMB_SECONDS } from './roundClock.js';

let failures = 0;
function check(ok, msg) {
  if (ok) {
    console.log('  ok:', msg);
    return;
  }
  failures++;
  console.error('  FAIL:', msg);
}

const RATE = 64;
/** A round that goes live at tick 0 and is planted with 1:10 on the clock. */
const PLANT_AT_SECONDS = ROUND_SECONDS - 70; // 45 s after going live -> reads 1:10
const timing = timingFor({
  tickRate: RATE,
  startTick: -3 * RATE,
  freezeEndTick: 0,
  plantTick: PLANT_AT_SECONDS * RATE,
  endTick: 200 * RATE
});
/** Seconds after the round goes live -> tick. */
const at = (s) => s * RATE;

console.log('one round: the plant takes over the clock');
{
  check(clockAt(timing, at(0)).label === '01:55', 'live at the start');
  check(clockAt(timing, at(44)).label === '01:11', 'still counting down a second before the plant');
  const onPlant = clockAt(timing, at(PLANT_AT_SECONDS));
  check(onPlant.phase === 'planted', 'the plant tick enters the planted phase');
  check(onPlant.label === '00:40', `and reads a full ${BOMB_SECONDS} s bomb (${onPlant.label})`);
  check(clockAt(timing, at(PLANT_AT_SECONDS + 10)).label === '00:30', 'the bomb runs down');
  check(clockAt(timing, at(PLANT_AT_SECONDS + 35)).label === '5.00', 'and shows hundredths under 10 s');
}

console.log('the Analyzer: the countdown never jumps');
{
  const opt = { bombTimer: false };
  const before = clockAt(timing, at(44), opt);
  const onPlant = clockAt(timing, at(PLANT_AT_SECONDS), opt);
  const after = clockAt(timing, at(PLANT_AT_SECONDS + 1), opt);
  check(before.label === '01:11', 'a second before the plant, unchanged');
  check(onPlant.label === '01:10', `the plant tick still reads the round clock (${onPlant.label})`);
  check(after.label === '01:09', 'and it keeps counting down through the plant');
  // The bug, stated as the thing that must not happen.
  check(onPlant.label !== '00:40', 'it does NOT jump to the bomb timer');
  check(
    Math.abs(onPlant.seconds - 70) < 1e-6,
    `seconds match the axis, not the bomb (${onPlant.seconds})`
  );
  check(onPlant.planted === true, 'but it still reports that the bomb is down');
  check(onPlant.phase === 'live', 'and stays in the live phase');
}

console.log('monotonic across the plant');
{
  // Every step of the way, the Analyzer clock only ever decreases: that is the
  // property the jump broke, and the one a reader relies on.
  let prev = Infinity;
  let rose = 0;
  for (let s = 0; s <= ROUND_SECONDS; s += 0.5) {
    const v = clockAt(timing, at(s), { bombTimer: false }).seconds;
    if (v > prev + 1e-9) rose++;
    prev = v;
  }
  check(rose === 0, `the clock never runs backwards over the whole round (${rose} jumps)`);
}

console.log('a round with no plant is unaffected either way');
{
  const noPlant = timingFor({ tickRate: RATE, startTick: -3 * RATE, freezeEndTick: 0, endTick: 200 * RATE });
  check(clockAt(noPlant, at(45)).label === '01:10', 'default reads the countdown');
  check(
    clockAt(noPlant, at(45), { bombTimer: false }).label === '01:10',
    'and so does the Analyzer'
  );
  check(clockAt(noPlant, at(45)).planted === false, 'planted is false with no plant tick');
}

console.log('the phases around it still hold');
{
  const opt = { bombTimer: false };
  check(clockAt(timing, -1 * RATE, opt).phase === 'freeze', 'freeze time before the round goes live');
  check(clockAt(timing, at(250), opt).phase === 'over', 'and over once the round has ended');
  // A planted round runs past 1:55; the round-clock axis floors at zero.
  const late = clockAt(timing, at(ROUND_SECONDS + 5), opt);
  check(late.seconds === 0, 'past 1:55 the countdown floors at zero rather than going negative');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
