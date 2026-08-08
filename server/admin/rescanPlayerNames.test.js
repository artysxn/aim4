import assert from 'node:assert/strict';
import {
  buildSteamNameIndex,
  canonicalBySteam,
  pickCanonicalName
} from './rescanPlayerNames.js';

{
  const counts = new Map([
    ['Aquwo', 2],
    ['aRTYSAN', 5],
    ['arty', 1]
  ]);
  assert.equal(pickCanonicalName(counts), 'aRTYSAN');
}

{
  // Tie → alphabetical.
  const counts = new Map([
    ['forzaN', 3],
    ['ang3l', 3]
  ]);
  assert.equal(pickCanonicalName(counts), 'ang3l');
}

{
  const records = [
    {
      status: 'ready',
      players: [
        { steamId: '76561198000000001', id: 'aaa', name: 'Aquwo' },
        { steamId: '76561198000000002', id: 'bbb', name: 'T3MN1Y_PR1NC' }
      ]
    },
    {
      status: 'ready',
      players: [
        { steamId: '76561198000000001', id: 'aaa', name: 'aRTYSAN' },
        { steamId: '76561198000000002', id: 'bbb', name: 'forzaN' }
      ]
    },
    {
      status: 'ready',
      players: [
        { steamId: '76561198000000001', id: 'aaa', name: 'aRTYSAN' },
        { steamId: '76561198000000002', id: 'bbb', name: 'forzaN' }
      ]
    },
    {
      status: 'ready',
      players: [
        { steamId: '76561198000000002', id: 'bbb', name: 'ang3l' },
        { steamId: '0', id: 'zzz', name: 'bot' }
      ]
    }
  ];
  const bySteam = buildSteamNameIndex(records);
  assert.equal(bySteam.size, 2);
  const canon = canonicalBySteam(bySteam);
  assert.equal(canon.get('76561198000000001').name, 'aRTYSAN');
  assert.equal(canon.get('76561198000000002').name, 'forzaN');
}

console.log('rescanPlayerNames.test.js: ok');
