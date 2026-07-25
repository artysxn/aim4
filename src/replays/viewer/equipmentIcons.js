// ---------------------------------------------------------------------------
// replays/viewer/equipmentIcons.js
// CS2 equipment silhouettes from public/icons/equipment (Juknum/counter-strike-icons).
// ---------------------------------------------------------------------------

import { FLAG_HAS_BOMB, FLAG_HAS_HELMET } from '../shared/tickFormat.js';

export const ICON_BASE = '/icons/equipment';

/** Known SVG stems in public/icons/equipment (without .svg). */
const ICON_FILES = new Set([
  'ak47',
  'armor',
  'armor_helmet',
  'assaultsuit',
  'assaultsuit_helmet_only',
  'aug',
  'awp',
  'bayonet',
  'bizon',
  'c4',
  'cz75a',
  'deagle',
  'decoy',
  'defuser',
  'elite',
  'famas',
  'fiveseven',
  'flashbang',
  'g3sg1',
  'galilar',
  'glock',
  'hegrenade',
  'helmet',
  'heavy_armor',
  'hkp2000',
  'incgrenade',
  'kevlar',
  'knife',
  'knife_bowie',
  'knife_butterfly',
  'knife_canis',
  'knife_cord',
  'knife_css',
  'knife_falchion',
  'knife_flip',
  'knife_gut',
  'knife_gypsy_jackknife',
  'knife_karambit',
  'knife_kukri',
  'knife_m9_bayonet',
  'knife_outdoor',
  'knife_push',
  'knife_skeleton',
  'knife_stiletto',
  'knife_survival_bowie',
  'knife_t',
  'knife_tactical',
  'knife_twinblade',
  'knife_ursus',
  'knife_widowmaker',
  'm249',
  'm4a1',
  'm4a1_silencer',
  'm4a1_silencer_off',
  'mac10',
  'mag7',
  'molotov',
  'mp5sd',
  'mp7',
  'mp9',
  'negev',
  'nova',
  'p2000',
  'p250',
  'p90',
  'planted_c4',
  'revolver',
  'sawedoff',
  'scar20',
  'sg556',
  'smokegrenade',
  'ssg08',
  'taser',
  'tec9',
  'ump45',
  'usp_silencer',
  'usp_silencer_off',
  'xm1014'
]);

const ALIASES = {
  weapon_hkp2000: 'hkp2000',
  hkp2000: 'hkp2000',
  p2000: 'hkp2000',
  weapon_p2000: 'hkp2000',
  weapon_usp_silencer: 'usp_silencer',
  usp_silencer: 'usp_silencer',
  usp_s: 'usp_silencer',
  usps: 'usp_silencer',
  usp: 'usp_silencer',
  weapon_glock: 'glock',
  glock_18: 'glock',
  glock18: 'glock',
  // Rifles: demoparser / inventory strings vary (AK-47, ak_47, weapon_ak47…).
  // Unrecognized names fall through inventoryAt to the sidearm — the glock/usp bug.
  weapon_ak47: 'ak47',
  ak_47: 'ak47',
  ak47: 'ak47',
  weapon_m4a1: 'm4a1',
  m4a4: 'm4a1', // CS item index name for the unsilenced M4
  m4_a4: 'm4a1',
  weapon_m4a1_silencer: 'm4a1_silencer',
  m4a1_s: 'm4a1_silencer',
  m4a1s: 'm4a1_silencer',
  m4a1silencer: 'm4a1_silencer',
  weapon_aug: 'aug',
  weapon_sg556: 'sg556',
  sg553: 'sg556',
  sg_553: 'sg556',
  weapon_galilar: 'galilar',
  galil: 'galilar',
  galil_ar: 'galilar',
  weapon_famas: 'famas',
  weapon_awp: 'awp',
  weapon_ssg08: 'ssg08',
  ssg_08: 'ssg08',
  weapon_scar20: 'scar20',
  weapon_g3sg1: 'g3sg1',
  weapon_mac10: 'mac10',
  mac_10: 'mac10',
  weapon_mp9: 'mp9',
  weapon_mp7: 'mp7',
  weapon_mp5sd: 'mp5sd',
  mp5_sd: 'mp5sd',
  weapon_ump45: 'ump45',
  ump_45: 'ump45',
  weapon_p90: 'p90',
  weapon_bizon: 'bizon',
  weapon_nova: 'nova',
  weapon_xm1014: 'xm1014',
  weapon_mag7: 'mag7',
  weapon_sawedoff: 'sawedoff',
  weapon_m249: 'm249',
  weapon_negev: 'negev',
  weapon_deagle: 'deagle',
  weapon_revolver: 'revolver',
  r8revolver: 'revolver',
  weapon_cz75a: 'cz75a',
  cz75: 'cz75a',
  weapon_fiveseven: 'fiveseven',
  five_seven: 'fiveseven',
  weapon_tec9: 'tec9',
  tec_9: 'tec9',
  weapon_elite: 'elite',
  weapon_p250: 'p250',
  weapon_taser: 'taser',
  zeus: 'taser',
  item_defuser: 'defuser',
  defuser: 'defuser',
  item_cutters: 'defuser',
  item_kevlar: 'kevlar',
  item_assaultsuit: 'assaultsuit',
  item_heavyassaultsuit: 'heavy_armor',
  weapon_c4: 'c4',
  c4: 'c4',
  weapon_knife: 'knife',
  weapon_knife_t: 'knife_t',
  weapon_bayonet: 'bayonet',
  inferno: 'molotov',
  firebomb: 'molotov'
};

const GRENADES = ['flashbang', 'smokegrenade', 'hegrenade', 'molotov', 'incgrenade', 'decoy'];

/**
 * demoparser2 spellings vary ("Smoke Grenade", "weapon_smokegrenade", …).
 * Collapse them to the dictionary keys we draw / icon against.
 */
export function normalizeGrenadeType(name) {
  const raw = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '')
    .replace(/[\s_-]+/g, '');
  if (!raw) return '';
  if (raw.includes('smoke')) return 'smokegrenade';
  if (raw.includes('flash')) return 'flashbang';
  if (raw.includes('molotov') || raw.includes('firebomb')) return 'molotov';
  if (raw.includes('incen')) return 'incgrenade';
  if (raw.includes('decoy')) return 'decoy';
  if (raw === 'he' || raw.includes('hegrenade') || raw.includes('frag')) return 'hegrenade';
  if (GRENADES.includes(raw)) return raw;
  return raw;
}

const GUN_PRIORITY = [
  'awp',
  'scar20',
  'g3sg1',
  'ssg08',
  'ak47',
  'm4a1_silencer',
  'm4a1',
  'aug',
  'sg556',
  'galilar',
  'famas',
  'm249',
  'negev',
  'p90',
  'bizon',
  'ump45',
  'mp9',
  'mp7',
  'mp5sd',
  'mac10',
  'xm1014',
  'mag7',
  'sawedoff',
  'nova',
  'deagle',
  'revolver',
  'fiveseven',
  'tec9',
  'cz75a',
  'elite',
  'p250',
  'usp_silencer',
  'hkp2000',
  'glock',
  'taser'
];

const imageCache = new Map();

export function bareWeapon(name) {
  let s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '')
    .replace(/^item_/, '')
    // "AK-47" / "M4A1-S" → ak47 / m4a1s (hyphens are not part of icon stems).
    .replace(/-/g, '')
    .replace(/\s+/g, '_');
  if (ALIASES[s]) s = ALIASES[s];
  if (ALIASES[`weapon_${s}`]) s = ALIASES[`weapon_${s}`];
  // Underscored digits from older spellings: ak_47 → ak47 (keep m4a1_silencer).
  s = s.replace(/([a-z])_+(\d)/g, '$1$2');
  if (ALIASES[s]) s = ALIASES[s];
  // demoparser display names: "Glock-18", "USP-S", "P2000"
  if (s.startsWith('glock')) s = 'glock';
  if (s === 'usp_s' || s === 'usps' || s === 'usp') s = 'usp_silencer';
  if (s === 'p2000' || s === 'hk_p2000') s = 'hkp2000';
  if (s === 'm4a4') s = 'm4a1';
  if (s === 'm4a1s' || s === 'm4a1_s') s = 'm4a1_silencer';
  return s;
}

/** Resolve to an on-disk SVG stem, or '' if we have no art. */
export function iconKey(name) {
  const bare = bareWeapon(name);
  if (!bare || bare === 'none') return '';
  if (ICON_FILES.has(bare)) return bare;
  if (bare.startsWith('knife')) return ICON_FILES.has(bare) ? bare : 'knife';
  // Last-chance pistol / common renames.
  if (bare.includes('usp')) return 'usp_silencer';
  if (bare.includes('glock')) return 'glock';
  if (bare.includes('p2000') || bare.includes('hkp2000')) return 'hkp2000';
  return '';
}

export function iconSrc(name) {
  const key = iconKey(name);
  return key ? `${ICON_BASE}/${key}.svg` : '';
}

export function isGrenade(name) {
  const n = normalizeGrenadeType(name) || bareWeapon(name);
  return GRENADES.includes(n);
}

export function isKnife(name) {
  const b = bareWeapon(name);
  return b === 'knife' || b.startsWith('knife') || b === 'bayonet' || b === 'melee';
}

export function isGun(name) {
  const b = bareWeapon(name);
  if (!b || b === 'none' || b === 'c4' || isGrenade(b) || isKnife(b)) return false;
  if (b === 'defuser' || b === 'kevlar' || b === 'armor' || b === 'helmet') return false;
  return GUN_PRIORITY.includes(b) || ICON_FILES.has(b);
}

export function isDefuser(name) {
  const b = bareWeapon(name);
  return b === 'defuser' || b === 'cutters';
}

/**
 * Loadout strings from the parser → bare item ids (keeps duplicates for nades).
 * @param {string[]} loadout
 */
export function normalizeLoadout(loadout) {
  return (loadout || []).map(bareWeapon).filter((b) => b && b !== 'none');
}

/**
 * Inventory at a tick: freezetime loadout minus grenades already thrown.
 * Armor / helmet / bomb come from live tick flags when provided.
 *
 * @param {object} opts
 * @param {string[]} opts.loadout
 * @param {Array} [opts.grenades]
 * @param {string} opts.playerId
 * @param {number} opts.tick
 * @param {object} [opts.state]  live tick record (armor, flags)
 * @param {string} [opts.activeWeapon]  bare or weapon_* name from dictionary
 */
export function inventoryAt({ loadout, grenades, playerId, tick, state, activeWeapon }) {
  const items = normalizeLoadout(loadout);
  for (const g of grenades || []) {
    if (g.player !== playerId) continue;
    if ((g.throwTick ?? g.tick ?? 0) > tick) continue;
    removeOne(items, normalizeGrenadeType(g.type) || bareWeapon(g.type));
  }

  const active = bareWeapon(activeWeapon || '');

  const guns = items.filter(isGun);
  let primary = '';
  if (active && isGun(active)) primary = active;
  else if (guns.length) {
    guns.sort((a, b) => gunRank(a) - gunRank(b));
    primary = guns[0];
  } else if (active && isKnife(active)) primary = active;
  else {
    const knife = items.find(isKnife);
    if (knife) primary = knife;
  }

  const util = [];
  if (items.some(isDefuser)) util.push('defuser');
  for (const g of GRENADES) {
    for (const it of items) {
      if (it === g) util.push(g);
    }
  }
  if ((state?.flags & FLAG_HAS_BOMB) !== 0 || items.includes('c4') || active === 'c4') {
    util.push('c4');
  }

  const armor = (state?.armor ?? 0) > 0;
  const helmet = Boolean(state?.flags != null && (state.flags & FLAG_HAS_HELMET) !== 0);

  return {
    primary,
    active: active || primary,
    util,
    armor,
    helmet,
    items
  };
}

function gunRank(name) {
  const i = GUN_PRIORITY.indexOf(bareWeapon(name));
  return i === -1 ? 999 : i;
}

function removeOne(list, name) {
  const b = bareWeapon(name);
  const i = list.indexOf(b);
  if (i >= 0) list.splice(i, 1);
}

/**
 * Cached Image for canvas drawing. Calls onLoad when a new icon finishes.
 * @returns {HTMLImageElement|null}
 */
export function loadEquipmentIcon(name, onLoad) {
  const src = iconSrc(name);
  if (!src || typeof Image === 'undefined') return null;
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = src;
    imageCache.set(src, img);
    if (!img.complete) {
      img.addEventListener(
        'load',
        () => {
          onLoad?.(src);
        },
        { once: true }
      );
    }
  }
  return img.complete && img.naturalWidth > 0 ? img : img;
}

/** Build an <img> HTML snippet for the sidebar. */
export function iconImgHtml(name, className = '') {
  const src = iconSrc(name);
  if (!src) return '';
  const bare = bareWeapon(name);
  return `<img class="${className}" src="${src}" alt="" data-item="${bare}" draggable="false" />`;
}
