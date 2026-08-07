import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignMapRoles } from './mapRoleAssign.js';
import { CT_POSITIONS, T_POSITIONS } from './regionKeys.js';

function setRole(out, id, key, side) {
  const def = side === 'T' ? T_POSITIONS[key] : CT_POSITIONS[key];
  assert.ok(def, `missing role def ${side}.${key}`);
  out[id] = { position: key, label: def.label, tactical: def.tactical };
}

function player(id, hitsT = {}, hitsCT = {}, awp = {}) {
  return {
    id,
    zoneHitsT: hitsT,
    zoneHitsCT: hitsCT,
    tAwpRounds: awp.t || 0,
    tAwpKills: 0,
    tAwpShots: 0,
    ctAwpRounds: awp.ct || 0,
    ctAwpKills: 0,
    ctAwpShots: 0
  };
}

describe('assignMapRoles Inferno', () => {
  it('assigns T Banana / A Lurk / 2nd Mid / Ramp', () => {
    const list = [
      player('awp', {}, {}, { t: 10 }),
      player('ban', { banana: 20, tAps: 0, secondMid: 0 }),
      player('al', { pitA: 12, tAps: 10, secondMid: 8 }),
      player('sm', { secondMid: 15, tAps: 9, ramp: 1 }),
      player('rm', { ramp: 14, bBanana: 8, secondMid: 2, tAps: 1 })
    ];
    const out = assignMapRoles('INF', list, 'T', setRole);
    assert.equal(out.awp.position, 'awper');
    assert.equal(out.ban.label, 'Banana');
    assert.equal(out.al.position, 'aLurk');
    assert.equal(out.sm.label, '2nd Mid');
    assert.equal(out.rm.label, 'Ramp');
  });

  it('assigns CT A Anchor / A Rotation / B Anchor / B Rotation', () => {
    const list = [
      player('awp', {}, {}, { ct: 8 }),
      player('aa', {}, { pitA: 30 }),
      player('ar', {}, { pitA: 10, midA: 12, ctLong: 8 }),
      player('ba', {}, { bSite: 20, bBanana: 10 }),
      player('br', {}, { bBanana: 6, bSite: 4 })
    ];
    const out = assignMapRoles('INF', list, 'CT', setRole);
    assert.equal(out.aa.position, 'aAnchor');
    assert.equal(out.ar.position, 'aRotation');
    assert.equal(out.ba.position, 'bAnchor');
    assert.equal(out.br.position, 'bRotation');
  });
});

describe('assignMapRoles Dust2', () => {
  it('renames T roles', () => {
    const list = [
      player('awp', {}, {}, { t: 5 }),
      player('bu', { bTunnels: 40, tMid: 0 }),
      player('al', { aLong: 20, tLong: 10 }),
      player('tm', { tMid: 18, tSpawn: 4, tLong: 6 }),
      player('bl', { bTunnels: 8, tMid: 6, ctMid: 5, aShort: 4 })
    ];
    const out = assignMapRoles('DD2', list, 'T', setRole);
    assert.equal(out.bu.label, 'B Upper');
    assert.equal(out.al.label, 'A Long');
    assert.equal(out.tm.label, 'T Mid');
    assert.equal(out.bl.label, 'B Lower');
  });
});

describe('assignMapRoles Anubis / Cache', () => {
  it('splits Anubis pack into Mid and Water', () => {
    const list = [
      player('a', { aWater: 20, aSite: 10 }),
      player('b', { tSpawnBMain: 18, bSite: 12 }),
      player('m', { tMid: 20, aMid: 10 }),
      player('w', { tCon: 15, aWater: 3 }),
      player('x', { tMid: 1 })
    ];
    const out = assignMapRoles('ANU', list, 'T', setRole);
    assert.equal(out.a.position, 'aLurk');
    assert.equal(out.b.position, 'bLurk');
    assert.equal(out.m.label, 'Mid');
    assert.equal(out.w.label, 'Water');
  });

  it('renames Cache CT A Rotation to Mid', () => {
    const list = [
      player('aa', {}, { aSite: 20, tA: 5 }),
      player('mid', {}, { ctMid: 25, aSite: 4 }),
      player('ba', {}, { bSite: 18, bCheckers: 10, ctMid: 1 }),
      player('br', {}, { bSite: 12, bCheckers: 8, ctMid: 9 }),
      player('z', {}, { ctMid: 2 })
    ];
    const out = assignMapRoles('CCH', list, 'CT', setRole);
    assert.equal(out.aa.position, 'aAnchor');
    assert.equal(out.mid.label, 'Mid');
    assert.equal(out.ba.position, 'bAnchor');
    assert.equal(out.br.position, 'bRotation');
  });
});

describe('assignMapRoles Nuke', () => {
  it('assigns T Lobby, 1st Yard, 2nd Yard, Rotation', () => {
    const list = [
      player('awp', {}, {}, { t: 5 }),
      player('lob', { lobby: 24 }),
      player('s2', { silo: 20, tYard: 8, yard: 6, secret: 4 }),
      player('s1', { tYard: 18, yard: 12, ctYard: 5, secret: 3 }),
      player('rot', { lobby: 2, secret: 2 })
    ];
    const out = assignMapRoles('NUK', list, 'T', setRole);
    assert.equal(out.lob.label, 'Lobby');
    assert.equal(out.s2.label, '2nd Yard');
    assert.equal(out.s1.label, '1st Yard');
    assert.equal(out.rot.label, 'Rotation');
  });

  it('assigns CT A Site, A Door, Ramp, Yard', () => {
    const list = [
      player('awp', {}, {}, { ct: 4 }),
      player('as', {}, { aAnchor: 22, aDoor: 6 }),
      player('ad', {}, { aDoor: 18, lobby: 4, ctYard: 3 }),
      player('rp', {}, { ramp: 20, ctHeaven: 4 }),
      player('yd', {}, { ctYard: 16, yard: 10, aDoor: 3 })
    ];
    const out = assignMapRoles('NUK', list, 'CT', setRole);
    assert.equal(out.as.label, 'A Site');
    assert.equal(out.ad.label, 'A Door');
    assert.equal(out.rp.label, 'Ramp');
    assert.equal(out.yd.label, 'Yard');
  });
});

describe('assignMapRoles Mirage', () => {
  it('assigns T A Lurk, B / UG, Mid, Rotation', () => {
    const list = [
      player('awp', {}, {}, { t: 7 }),
      player('al', { tA: 22, tSpawn: 4, aSite: 3 }),
      player('ug', { underground: 20, tSpawn: 6, bAps: 5, mid: 4 }),
      player('mid', { tMid: 24, mid: 6, bShort: 2 }),
      player('rot', { tSpawn: 5, aJungle: 3, bShort: 3 })
    ];
    const out = assignMapRoles('MIR', list, 'T', setRole);
    assert.equal(out.al.position, 'aLurk');
    assert.equal(out.ug.label, 'B / UG');
    assert.equal(out.mid.label, 'Mid');
    assert.equal(out.rot.label, 'Rotation');
  });

  it('assigns CT A Con and B Short', () => {
    const list = [
      player('awp', {}, {}, { ct: 4 }),
      player('ba', {}, { bSite: 18, bAps: 12, bShort: 3 }),
      player('aa', {}, { aSite: 16, ctSpawn: 10, aJungle: 4 }),
      player('bs', {}, { bShort: 20, aJungle: 5, mid: 4, bSite: 3 }),
      player('ac', {}, { aJungle: 14, aSite: 5, mid: 4, bShort: 2, ctSpawn: 3 })
    ];
    const out = assignMapRoles('MIR', list, 'CT', setRole);
    assert.equal(out.ba.position, 'bAnchor');
    assert.equal(out.aa.position, 'aAnchor');
    assert.equal(out.bs.label, 'B Short');
    assert.equal(out.ac.label, 'A Con');
  });
});

describe('assignMapRoles Ancient', () => {
  it('splits T pack into Mid and Street', () => {
    const list = [
      player('awp', {}, {}, { t: 6 }),
      player('bl', { bRamp: 22, bStreet: 8, tSpawn: 5 }),
      player('al', { aMain: 20, tMid: 6 }),
      player('mid', { tMid: 18, ctMid: 10, aMain: 4 }),
      player('st', { bStreet: 16, bRamp: 6, bCave: 5 })
    ];
    const out = assignMapRoles('ANC', list, 'T', setRole);
    assert.equal(out.bl.position, 'bLurk');
    assert.equal(out.al.position, 'aLurk');
    assert.equal(out.mid.label, 'Mid');
    assert.equal(out.st.label, 'Street');
  });

  it('renames CT roles to Mid / A, Mid, B Site, B Cave', () => {
    const list = [
      player('awp', {}, {}, { ct: 5 }),
      player('bs', {}, { bSite: 20, bRamp: 4 }),
      player('bc', {}, { bCave: 18, bSite: 6, bStreet: 3 }),
      player('ma', {}, { ctMid: 10, ctDonut: 8, aSite: 12, ctSpawn: 9 }),
      player('md', {}, { ctMid: 11, ctDonut: 9, aSite: 6, ctSpawn: 2 })
    ];
    const out = assignMapRoles('ANC', list, 'CT', setRole);
    assert.equal(out.bs.label, 'B Site');
    assert.equal(out.bc.label, 'B Cave');
    assert.equal(out.ma.label, 'Mid / A');
    assert.equal(out.md.label, 'Mid');
  });
});
