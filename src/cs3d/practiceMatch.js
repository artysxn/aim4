// ---------------------------------------------------------------------------
// src/cs3d/practiceMatch.js
// Local match state for the map explorer HUD. The explorer is not a round,
// but the CS2 chrome needs numbers that move: money that buying spends, a
// magazine that firing empties, a clock that runs down, a side that spawn
// and the buy list agree on. Nothing here talks to a server.
// ---------------------------------------------------------------------------

import { MONEY_CAP } from '../../shared/sim/economy.js';
import { weaponInfo } from '../replays/shared/weaponTable.js';
import {
  bareWeapon,
  isGrenade,
  isKnife,
  isPrimaryGun,
  isSecondary,
  normalizeGrenadeType
} from '../replays/viewer/equipmentIcons.js';

export const START_MONEY = MONEY_CAP;
export const ROUND_SECONDS = 115;
export const TEAM_SIZE = 5;

const NADE_PRICE = {
  flashbang: 200,
  smokegrenade: 300,
  hegrenade: 300,
  molotov: 400,
  incgrenade: 600,
  decoy: 50
};

/** Guns and nades that only one side can buy. `give` ignores this. */
const SIDE_ONLY = {
  glock: 'T',
  usp_silencer: 'CT',
  hkp2000: 'CT',
  tec9: 'T',
  fiveseven: 'CT',
  mac10: 'T',
  mp9: 'CT',
  sawedoff: 'T',
  mag7: 'CT',
  galilar: 'T',
  famas: 'CT',
  ak47: 'T',
  m4a1_silencer: 'CT',
  sg556: 'T',
  m4a1: 'CT',
  aug: 'CT',
  g3sg1: 'T',
  scar20: 'CT',
  molotov: 'T',
  incgrenade: 'CT'
};

const RESERVE_OVERRIDE = {
  glock: 120,
  elite: 120,
  ssg08: 90,
  negev: 300,
  m249: 200,
  taser: 0
};

const RESERVE_BY_CAT = {
  pistol: 24,
  smg: 120,
  rifle: 90,
  sniper: 30,
  shotgun: 32,
  lmg: 200,
  other: 0,
  knife: 0
};

let killSeq = 1;

export function defaultPistol(side) {
  return side === 'CT' ? 'usp_silencer' : 'glock';
}

/** Practice spawn kit: rifle, side pistol, smoke, fire nade, flash, HE. */
export function practiceKit(side) {
  const ct = side === 'CT';
  return {
    primary: ct ? 'm4a1' : 'ak47',
    pistol: defaultPistol(ct ? 'CT' : 'T'),
    nades: ct
      ? ['smokegrenade', 'incgrenade', 'flashbang', 'hegrenade']
      : ['smokegrenade', 'molotov', 'flashbang', 'hegrenade']
  };
}

export function itemPrice(name) {
  const nade = nadeStem(name);
  if (nade) return NADE_PRICE[nade] ?? 0;
  const info = weaponInfo(name);
  if (isKnife(name) || info.category === 'knife') return 0;
  return info.price || 0;
}

export function nadeStem(name) {
  if (!isGrenade(name)) return '';
  return normalizeGrenadeType(name);
}

export function reserveFor(name) {
  const bare = bareWeapon(name);
  if (RESERVE_OVERRIDE[bare] != null) return RESERVE_OVERRIDE[bare];
  return RESERVE_BY_CAT[weaponInfo(bare).category] ?? 90;
}

function emptyAmmo() {
  return { clip: 0, reserve: 0 };
}

export function createPracticeMatch({ side = 'T' } = {}) {
  const m = {
    money: START_MONEY,
    hp: 100,
    maxHp: 100,
    god: false,
    dead: false,
    side: side === 'CT' ? 'CT' : 'T',
    name: 'You',
    roundKills: 0,
    scoreT: 0,
    scoreCt: 0,
    clock: ROUND_SECONDS,
    roundTime: ROUND_SECONDS,
    startMoney: START_MONEY,
    primary: '',
    pistol: defaultPistol(side === 'CT' ? 'CT' : 'T'),
    knife: 'knife',
    nades: [],
    held: defaultPistol(side === 'CT' ? 'CT' : 'T'),
    lastGun: defaultPistol(side === 'CT' ? 'CT' : 'T'),
    ammo: {},
    kills: [],
    showPos: false,
    _reload: 0,
    _gen: 0
  };

  fillAmmo(m, m.pistol);

  function touch() {
    m._gen++;
  }

  function fillAmmo(state, name) {
    const bare = bareWeapon(name);
    if (!bare || isKnife(bare) || nadeStem(bare)) return;
    const mag = weaponInfo(bare).magSize || 0;
    state.ammo[bare] = { clip: mag, reserve: reserveFor(bare) };
  }

  function ammoOf(name) {
    const bare = bareWeapon(name);
    return stateAmmo(m, bare);
  }

  function ownSlot(name) {
    const bare = bareWeapon(name);
    if (!bare) return '';
    if (nadeStem(bare)) return 'nade';
    if (isKnife(bare)) return 'knife';
    if (isPrimaryGun(bare)) return 'primary';
    if (isSecondary(bare) && bare !== 'taser') return 'pistol';
    if (bare === 'taser') return 'nade';
    return 'primary';
  }

  function owns(name) {
    const bare = bareWeapon(name);
    if (!bare) return false;
    if (bare === m.knife || isKnife(bare)) return true;
    if (bare === m.primary || bare === m.pistol) return true;
    const nade = nadeStem(bare);
    if (nade) return m.nades.includes(nade);
    return false;
  }

  function hold(name) {
    const bare = bareWeapon(name);
    if (!bare || !owns(bare)) return m.held;
    const next = nadeStem(bare) || bare;
    if (next === m.held) return m.held;
    if (isDroppableGun(m.held)) m.lastGun = m.held;
    m._reload = 0;
    m.held = next;
    touch();
    return m.held;
  }

  function isDroppableGun(name) {
    const slot = ownSlot(name);
    return slot === 'primary' || slot === 'pistol';
  }

  function snapshotItem(name) {
    const nade = nadeStem(name);
    const bare = nade || bareWeapon(name);
    if (!bare) return null;
    const slot = ownSlot(bare);
    if (slot === 'knife') return null;
    const ammo =
      slot === 'nade' ? null : { clip: ammoOf(bare).clip, reserve: ammoOf(bare).reserve };
    return { name: bare, slot, ammo };
  }

  function removeCarried(name) {
    const nade = nadeStem(name);
    const bare = nade || bareWeapon(name);
    if (!bare) return false;
    const slot = ownSlot(bare);
    if (slot === 'nade') {
      const i = m.nades.indexOf(bare);
      if (i < 0) return false;
      m.nades.splice(i, 1);
    } else if (slot === 'primary') {
      if (m.primary !== bare) return false;
      m.primary = '';
      delete m.ammo[bare];
    } else if (slot === 'pistol') {
      if (m.pistol !== bare) return false;
      m.pistol = '';
      delete m.ammo[bare];
    } else {
      return false;
    }
    if (m.lastGun === bare) m.lastGun = m.primary || m.pistol || '';
    touch();
    return true;
  }

  function nextAfterDrop(dropped) {
    if (m.lastGun && m.lastGun !== dropped && owns(m.lastGun)) return m.lastGun;
    if (m.primary) return m.primary;
    if (m.pistol) return m.pistol;
    if (m.nades.length) return m.nades[0];
    return m.knife;
  }

  function applyDroppedAmmo(bare, ammo) {
    if (!ammo || nadeStem(bare)) return;
    const a = stateAmmo(m, bare);
    a.clip = Math.max(0, ammo.clip | 0);
    a.reserve = Math.max(0, ammo.reserve | 0);
  }

  function applyPracticeKit() {
    const kit = practiceKit(m.side);
    m.primary = kit.primary;
    m.pistol = kit.pistol;
    m.knife = 'knife';
    m.nades = [...kit.nades];
    m.held = kit.primary;
    m.lastGun = kit.pistol;
    m._reload = 0;
    fillAmmo(m, kit.primary);
    fillAmmo(m, kit.pistol);
    touch();
  }

  function give(name, { spend = false } = {}) {
    const nade = nadeStem(name);
    const bare = nade || bareWeapon(name);
    if (!bare) return { ok: false, reason: 'unknown_weapon' };
    if (isKnife(bare)) {
      m.knife = 'knife';
      m._reload = 0;
      m.held = 'knife';
      touch();
      return { ok: true, name: 'knife', price: 0 };
    }
    const price = spend ? itemPrice(bare) : 0;
    if (spend && price > m.money) return { ok: false, reason: 'insufficient_funds', price };
    const slot = ownSlot(bare);
    if (slot === 'nade') {
      if (m.nades.length >= 4) return { ok: false, reason: 'grenade_limit', price };
      if (bare === 'flashbang' && m.nades.filter((g) => g === 'flashbang').length >= 2) {
        return { ok: false, reason: 'flash_limit', price };
      }
      if (bare !== 'flashbang' && m.nades.includes(bare)) {
        return { ok: false, reason: 'duplicate_grenade', price };
      }
      m.nades.push(bare);
    } else if (slot === 'primary') {
      m.primary = bare;
      fillAmmo(m, bare);
    } else if (slot === 'pistol') {
      m.pistol = bare;
      fillAmmo(m, bare);
    }
    if (spend) m.money = Math.max(0, m.money - price);
    m._reload = 0;
    m.held = bare;
    touch();
    return { ok: true, name: bare, price };
  }

  const api = {
    get state() {
      return m;
    },
    get gen() {
      return m._gen;
    },
    get held() {
      return m.held;
    },
    get side() {
      return m.side;
    },
    get dead() {
      return m.dead;
    },
    get god() {
      return m.god;
    },

    ammoOf,
    owns,
    hold,
    itemPrice,
    nadeStem,

    /** Weapons the body actually has, in slot order, for Q. */
    carried() {
      const out = [];
      if (m.primary) out.push(m.primary);
      if (m.pistol) out.push(m.pistol);
      if (m.knife) out.push(m.knife);
      out.push(...m.nades);
      return out;
    },

    /** Slot keys the way the game numbers them. 4 cycles owned nades. */
    slot(n) {
      if (n === 1) return m.primary || '';
      if (n === 2) return m.pistol || '';
      if (n === 3) return m.knife || '';
      if (n === 4) {
        if (!m.nades.length) return '';
        const cur = nadeStem(m.held);
        const i = cur ? m.nades.indexOf(cur) : -1;
        return m.nades[(i + 1) % m.nades.length];
      }
      return '';
    },

    cycleHeld() {
      const list = api.carried();
      if (!list.length) return m.held;
      const i = list.indexOf(m.held);
      return hold(list[(i + 1) % list.length]);
    },

    buy(name) {
      const nade = nadeStem(name);
      const bare = nade || bareWeapon(name);
      if (!bare) return { ok: false, reason: 'unknown_weapon' };
      const need = SIDE_ONLY[bare];
      if (need && need !== m.side) return { ok: false, reason: 'wrong_side' };
      return give(bare, { spend: true });
    },

    give(name) {
      return give(name, { spend: false });
    },

    /** Slot is empty (or nade pocket has room). Walk-over pickup uses this. */
    canPickup(name) {
      const nade = nadeStem(name);
      const bare = nade || bareWeapon(name);
      if (!bare || isKnife(bare)) return false;
      const slot = ownSlot(bare);
      if (slot === 'nade') {
        if (m.nades.length >= 4) return false;
        if (bare === 'flashbang') return m.nades.filter((g) => g === 'flashbang').length < 2;
        return !m.nades.includes(bare);
      }
      if (slot === 'primary') return !m.primary;
      if (slot === 'pistol') return !m.pistol;
      return false;
    },

    /**
     * G: drop the thing in hand. Knife stays. Next gun, then remaining nades,
     * knife last.
     */
    dropHeld() {
      if (m.dead) return { ok: false, reason: 'dead' };
      const item = snapshotItem(m.held);
      if (!item) return { ok: false, reason: 'cannot_drop' };
      if (!removeCarried(item.name)) return { ok: false, reason: 'cannot_drop' };
      const next = nextAfterDrop(item.name);
      m._reload = 0;
      m.held = next;
      touch();
      return { ok: true, item, next };
    },

    /**
     * Death: the active gun (held, else primary, else pistol) and every nade.
     * Knife stays. Caller spawns the returned items; respawn kits the body.
     */
    dropDeath() {
      const items = [];
      const heldSlot = ownSlot(m.held);
      const gunName = heldSlot === 'primary' || heldSlot === 'pistol' ? m.held : m.primary || m.pistol;
      if (gunName) {
        const item = snapshotItem(gunName);
        if (item && removeCarried(item.name)) items.push(item);
      }
      for (const n of m.nades.slice()) {
        const item = snapshotItem(n);
        if (item && removeCarried(item.name)) items.push(item);
      }
      m._reload = 0;
      m.held = m.knife;
      touch();
      return { items };
    },

    /**
     * Restore a floor pickup. `replace` is E: a gun in that slot is displaced
     * (returned so the caller can drop it). Walk-over passes replace false.
     */
    takePickup(name, ammo, { replace = false } = {}) {
      const nade = nadeStem(name);
      const bare = nade || bareWeapon(name);
      if (!bare || isKnife(bare)) return { ok: false, reason: 'invalid' };
      const slot = ownSlot(bare);
      let displaced = null;
      if (slot === 'primary' || slot === 'pistol') {
        const current = slot === 'primary' ? m.primary : m.pistol;
        if (current && current === bare) return { ok: false, reason: 'already_have' };
        if (current && current !== bare) {
          if (!replace) return { ok: false, reason: 'slot_full' };
          displaced = snapshotItem(current);
          removeCarried(current);
        }
      }
      const r = give(bare, { spend: false });
      if (!r.ok) return r;
      applyDroppedAmmo(bare, ammo);
      touch();
      return { ok: true, name: bare, displaced };
    },

    canFire(name = m.held) {
      if (m.dead || m._reload > 0) return false;
      const nade = nadeStem(name);
      if (nade || isKnife(name)) return true;
      const a = ammoOf(name);
      return a.clip > 0;
    },

    get reloading() {
      return m._reload > 0;
    },

    consumeAmmo(name = m.held) {
      const nade = nadeStem(name);
      if (nade || isKnife(name)) return ammoOf(name);
      const bare = bareWeapon(name);
      const a = stateAmmo(m, bare);
      if (a.clip <= 0) return a;
      a.clip--;
      touch();
      return a;
    },

    /**
     * Start a magazine swap. Mag fills when the timer elapses (`tick`).
     * Returns false when already reloading, full, empty reserve, or not a gun.
     */
    beginReload(name = m.held) {
      if (m._reload > 0 || m.dead) return false;
      const bare = bareWeapon(name);
      if (!bare || isKnife(bare) || nadeStem(bare)) return false;
      const a = stateAmmo(m, bare);
      const mag = weaponInfo(bare).magSize || 0;
      if (needReloadBlocked(a, mag)) return false;
      m._reload = weaponInfo(bare).reloadSeconds || 2.2;
      touch();
      return true;
    },

    consumeNade(name) {
      // Practice kit: nades never leave the pocket.
      return nadeStem(name) || m.held;
    },

    reload(name = m.held) {
      const bare = bareWeapon(name);
      if (!bare || isKnife(bare) || nadeStem(bare)) return ammoOf(bare);
      const a = stateAmmo(m, bare);
      const mag = weaponInfo(bare).magSize || 0;
      const need = mag - a.clip;
      if (need <= 0 || a.reserve <= 0) return a;
      const take = Math.min(need, a.reserve);
      a.clip += take;
      a.reserve -= take;
      m._reload = 0;
      touch();
      return a;
    },

    refillAmmo() {
      if (m.primary) fillAmmo(m, m.primary);
      if (m.pistol) fillAmmo(m, m.pistol);
      m._reload = 0;
      touch();
    },

    givePracticeKit() {
      applyPracticeKit();
    },

    setSide(side) {
      const next = side === 'CT' ? 'CT' : 'T';
      if (next === m.side) return;
      m.side = next;
      applyPracticeKit();
    },

    setMoney(n) {
      m.money = Math.max(0, Math.min(MONEY_CAP, Math.round(Number(n) || 0)));
      touch();
      return m.money;
    },

    setHp(n) {
      m.hp = Math.max(0, Math.min(m.maxHp, Math.round(Number(n) || 0)));
      m.dead = m.hp <= 0;
      touch();
      return m.hp;
    },

    hurt(dmg) {
      if (m.god || m.dead) return m.hp;
      return api.setHp(m.hp - Math.max(0, dmg));
    },

    setGod(on) {
      m.god = !!on;
      touch();
      return m.god;
    },

    suicide() {
      api.setHp(0);
      api.addKill({ killer: m.name, victim: m.name, weapon: 'world', killerSide: m.side, victimSide: m.side });
    },

    respawn() {
      m.hp = m.maxHp;
      m.dead = false;
      m._reload = 0;
      touch();
    },

    restart() {
      m.money = m.startMoney;
      m.hp = m.maxHp;
      m.dead = false;
      m.roundKills = 0;
      m.clock = m.roundTime;
      m.primary = '';
      m.nades = [];
      m.pistol = defaultPistol(m.side);
      m.knife = 'knife';
      m.held = m.pistol;
      m.lastGun = m.pistol;
      m.ammo = {};
      fillAmmo(m, m.pistol);
      m.kills = [];
      m._reload = 0;
      touch();
    },

    setClock(seconds) {
      m.roundTime = Math.max(0, Number(seconds) || 0);
      m.clock = m.roundTime;
      touch();
    },

    setScore(t, ct) {
      if (t != null) m.scoreT = Math.max(0, Math.round(Number(t) || 0));
      if (ct != null) m.scoreCt = Math.max(0, Math.round(Number(ct) || 0));
      touch();
    },

    addKill({ killer, victim, weapon, killerSide, victimSide }) {
      m.kills.push({
        id: killSeq++,
        killer: killer || m.name,
        victim: victim || 'BOT',
        weapon: weapon || m.held || 'ak47',
        killerSide: killerSide || m.side,
        victimSide: victimSide || (m.side === 'T' ? 'CT' : 'T'),
        at: performance.now ? performance.now() : Date.now()
      });
      if (m.kills.length > 8) m.kills.splice(0, m.kills.length - 8);
      if ((killer || m.name) === m.name) m.roundKills++;
      touch();
      return m.kills[m.kills.length - 1];
    },

    pruneKills(now = performance.now(), life = 8000) {
      const n = m.kills.length;
      m.kills = m.kills.filter((k) => now - k.at < life);
      if (m.kills.length !== n) touch();
    },

    tick(dt) {
      if (m.clock > 0) m.clock = Math.max(0, m.clock - dt);
      if (m._reload > 0) {
        m._reload -= dt;
        if (m._reload <= 0) {
          m._reload = 0;
          api.reload(m.held);
        }
      }
    },

    snapshot() {
      const a = ammoOf(m.held);
      return {
        money: m.money,
        hp: m.hp,
        dead: m.dead,
        god: m.god,
        side: m.side,
        name: m.name,
        roundKills: m.roundKills,
        scoreT: m.scoreT,
        scoreCt: m.scoreCt,
        clock: m.clock,
        primary: m.primary,
        pistol: m.pistol,
        knife: m.knife,
        nades: m.nades.slice(),
        held: m.held,
        clip: a.clip,
        reserve: a.reserve,
        kills: m.kills,
        showPos: m.showPos,
        gen: m._gen
      };
    }
  };

  return api;
}

function stateAmmo(m, bare) {
  if (!bare) return emptyAmmo();
  if (!m.ammo[bare]) m.ammo[bare] = emptyAmmo();
  return m.ammo[bare];
}

function needReloadBlocked(a, mag) {
  return mag <= 0 || a.clip >= mag || a.reserve <= 0;
}
