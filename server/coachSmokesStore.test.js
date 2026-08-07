import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyCoachSmokes, sanitizeCoachSmokes } from './coachSmokesStore.js';
import { coachUtilityId } from '../src/replays/coach/coachUtilityIds.js';

describe('coachUtilityId', () => {
  it('builds map_side_name_type slugs', () => {
    assert.equal(coachUtilityId('ANC', 't', 'Window', 'smokegrenade'), 'ancient_t_window_smoke');
    assert.equal(coachUtilityId('ANC', 'both', 'Heaven', 'flashbang'), 'ancient_both_heaven_flash');
    assert.equal(coachUtilityId('DD2', 'ct', 'B doors', 'molotov'), 'dust2_ct_b_doors_molly');
  });
});

describe('sanitizeCoachSmokes', () => {
  it('assigns stable ids from map side name type', () => {
    const out = sanitizeCoachSmokes('ANC', {
      utilities: [
        {
          name: 'Window',
          side: 't',
          type: 'smokegrenade',
          detonate: { x: 100, y: -200 }
        },
        {
          name: 'Heaven',
          side: 'both',
          type: 'flashbang',
          detonate: { x: 1, y: 2 }
        }
      ]
    });
    assert.equal(out.map, 'ANC');
    assert.equal(out.utilities.length, 2);
    assert.equal(out.utilities[0].id, 'ancient_t_window_smoke');
    assert.equal(out.utilities[1].id, 'ancient_both_heaven_flash');
    assert.equal(out.smokes[0].id, 'ancient_t_window_smoke');
  });

  it('keeps landing coords and suffixes duplicate names', () => {
    const out = sanitizeCoachSmokes('MIR', {
      smokes: [
        { name: 'Window', side: 't', type: 'smokegrenade', detonate: { x: 10, y: 20 } },
        { name: 'Window', side: 't', type: 'smokegrenade', detonate: { x: 30, y: 40 } }
      ]
    });
    assert.equal(out.utilities[0].id, 'mirage_t_window_smoke');
    assert.equal(out.utilities[1].id, 'mirage_t_window_smoke_2');
    assert.equal(out.utilities[1].detonate.x, 30);
  });

  it('accepts grenades alias and strips throws', () => {
    const out = sanitizeCoachSmokes('INF', {
      grenades: [
        {
          id: 'old',
          type: 'smokegrenade',
          name: 'Banana',
          side: 't',
          detonate: { x: 1, y: 2 },
          throws: [{ id: 'Th01', setpos: 'setpos 0 0 0' }]
        }
      ]
    });
    assert.equal(out.utilities.length, 1);
    assert.equal(out.utilities[0].id, 'inferno_t_banana_smoke');
    assert.equal(out.utilities[0].throws, undefined);
  });

  it('empty archive', () => {
    const empty = emptyCoachSmokes('DD2');
    assert.deepEqual(empty.utilities, []);
    assert.equal(empty.map, 'DD2');
  });
});
