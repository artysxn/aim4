// Fixed Competitive rules — merged in scenario ctors when config.variant === 'competitive'.

export const COMPETITIVE_PRESETS = {
  gridshot: {
    runDuration: 30,
    floatEnabled: false,
    targetSize: 0.35,
    targetCount: 5,
    boundsScaleY: 0.8,
    boundsScaleX: 1.2,
    mode: 'clicking',
    viewmodelRecoil: false
  },
  stars: {
    runDuration: 30,
    targetSize: 0.1,
    targetCount: 120, // 40% fewer than practice default (200)
    boundsScaleX: 2,
    viewmodelRecoil: false
  },
  microflicks: {
    runDuration: 30,
    targetSize: 0.1,
    targetCount: 2,
    randomSpawnChance: 0.1,
    boundsScaleX: 2,
    viewmodelRecoil: false
  },
  bounce: {
    runDuration: 30,
    targetSize: 0.3,
    targetCount: 4,
    travelSpeed: 25,
    minDistance: 10,
    maxDistance: 16,
    bounceHeight: 7, // apex height (m) — replaces the old bounceStrength feel
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  pasu: {
    runDuration: 30,
    targetSize: 0.15,
    angleOffset: 180,
    targetCount: 4,
    travelSpeedMax: 3.5,
    viewmodelRecoil: false
  },
  arena: {
    runDuration: 30,
    botDistMin: 1.0,
    botDistMax: 1.0,
    columns: 5,
    columnRadius: 0.75,
    ringRadius: 13.5,
    infiniteAmmo: true,
    competitiveMissPenalty: true
  },
  snipercrossfire: {
    runDuration: 30,
    botDistMin: 1.0,
    botDistMax: 1.0,
    columns: 5,
    columnRadius: 0.75,
    ringRadius: 13.5,
    infiniteAmmo: true,
    competitiveMissPenalty: true
  },
  duels: {
    runDuration: 60,
    ttk: 0.3,
    botHeadHit: 0.08,
    botBodyHit: 0.40,
    botHitRamp: 0.01
  },
  range: {
    runDuration: 30,
    arc: 360,
    enemyCount: 8,
    radius: 15,
    coverEnabled: true,
    coverCount: 4,
    coverDistance: 4,
    coverThickness: 1.5,
    coverHeight: 3
  },
  tracking: {
    runDuration: 30,
    botWidth: 1.0,
    botSpeed: 1.0,
    botCrouchTap: true,
    strafeRate: 1.0
  },
  deathmatch: {
    runDuration: 60,
    botCount: 6,
    botSpeed: 1.0,
    botBodyHit: 0.3,
    botHeadHit: 0.1
  },
  spidershot: {
    runDuration: 30,
    timeToKill: 450,
    targetSize: 0.23,
    maxDistance: 5.6,
    minDistance: 1,
    heightSpread: 1,
    angleSpread: 25,
    streakChance: 0.1,
    streakLengthMin: 1,
    streakLengthMax: 2,
    doubleSpawnChance: 0.07,
    randomSize: true,
    randomSizeMin: 0.13,
    randomSizeMax: 0.23,
    infiniteAmmo: true,
    viewmodelRecoil: false,
    decoyEnabled: true,
    decoyRoundChance: 0.1,
    decoyMin: 1,
    decoyMax: 2
  },
  sequence: {
    runDuration: 30,
    targetSize: 0.2, // "dot size 20"
    dotTime: 1200,
    startDistance: 0.8,
    distanceStep: 0.35,
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  double: {
    runDuration: 30,
    targetSize: 0.25,
    canvasSize: 2.5,
    canvasDistance: 5,
    canvasCount: 2,
    layout: 'flat',
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  doubletracking: {
    runDuration: 30,
    targetSize: 0.2,
    holdTime: 0.3,
    floatSpeed: 1.0,
    canvasSize: 2.5,
    canvasDistance: 5,
    canvasCount: 2,
    layout: 'flat',
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  sequencespeed: {
    runDuration: 30,
    startSize: 0.12,
    maxSize: 0.55,
    growTime: 1200,
    startDistance: 0.8,
    distanceStep: 0.35,
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  sequencetracking: {
    runDuration: 30,
    targetSize: 0.16,
    holdTime: 0.3,
    floatSpeed: 1.0,
    dotTime: 1200,
    startDistance: 0.8,
    distanceStep: 0.35,
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  ball: {
    runDuration: 30,
    targetSize: 0.5,
    travelSpeed: 80,
    minDistance: 8,
    maxDistance: 16,
    bounceHeight: 8
  },
  bouncetracking: {
    runDuration: 30,
    targetSize: 0.225,
    targetCount: 3,
    travelSpeed: 28,
    minDistance: 10,
    maxDistance: 16,
    bounceHeight: 2.2,
    holdTime: 0.5,
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  pasutracking: {
    runDuration: 30,
    targetSize: 0.11,
    targetCount: 3,
    trackTime: 0.5,
    travelSpeedMax: 2.0,
    angleOffset: 360,
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  turn: {
    runDuration: 30,
    targetSize: 0.15, // "size here is 15"
    dotTime: 2000,
    infiniteAmmo: true,
    viewmodelRecoil: false
  },
  box: {
    runDuration: 30,
    targetSize: 0.3,
    sizeX: 7,
    sizeY: 4,
    travelSpeed: 187.5, // ± variance → the spec's random 100–200 u/s (+25% competitive base)
    speedVariance: 50,
    infiniteAmmo: true
  },
  circle: {
    runDuration: 30,
    targetSize: 0.3,
    sizeX: 7,
    sizeY: 4,
    travelSpeed: 187.5,
    speedVariance: 50,
    infiniteAmmo: true
  },
  threeshot: {
    runDuration: 30,
    targetSize: 0.075,
    targetCount: 3,
    boundsScaleX: 2,
    boundsScaleY: 2,
    floatEnabled: false,
    viewmodelRecoil: false
  },
  cover: {
    runDuration: 60,
    rowCount: 3,
    coverPerRow: 3,
    rowDistance: 16,
    rowSpacing: 10,
    botSpeed: 1.0,
    reactMin: 25,
    reactMax: 200,
    playerHp: 4,
    botHp: 2,
    spawnHint: true
  },
  drone: {
    runDuration: 30,
    targetSize: 0.5,
    travelSpeed: 80,
    minDistance: 8,
    maxDistance: 16,
    bounceHeight: 8
  },
  line: {
    runDuration: 30,
    targetSize: 0.35,
    travelSpeed: 180
  },
  sniperholds: {
    runDuration: 60,
    ttk: 0.3,
    botHp: 1,
    botHeadHit: 0.08,
    botBodyHit: 0.40,
    botHitRamp: 0.01
  },
  pitrifle: {
    runDuration: 60,
    rowCount: 3,
    coverPerRow: 8,
    rowDistance: 14,
    rowSpacing: 8,
    botSpeed: 1.0,
    reactMin: 25,
    reactMax: 200,
    playerHp: 4,
    botHp: 1,
    spawnHint: true
  },
  coverawp: {
    runDuration: 60,
    rowCount: 3,
    coverPerRow: 3,
    rowDistance: 16,
    rowSpacing: 10,
    botSpeed: 1.0,
    reactMin: 25,
    reactMax: 200,
    playerHp: 4,
    botHp: 1,
    spawnHint: true
  },
  sniperquickscopes: {
    runDuration: 60,
    rowCount: 3,
    coverPerRow: 8,
    rowDistance: 14,
    rowSpacing: 8,
    botSpeed: 1.0,
    reactMin: 25,
    reactMax: 200,
    playerHp: 4,
    botHp: 1,
    spawnHint: true
  },
  sniperflicks: {
    runDuration: 60,
    spawnScaleX: 1.0,
    spawnScaleY: 1.0,
    botScale: 1.0,
    minDistance: 35,
    maxDistance: 75,
    botsMove: false // competitive uses static bots
  },
  snipertracking: {
    runDuration: 60,
    botWidth: 1.0,
    botSpeed: 1.0,
    botCrouchTap: true,
    holdTime: 0,
    respawnDelay: 1.0,
    minDistance: 10,
    maxDistance: 16
  }
};

export function competitivePresetFor(scenarioName) {
  return COMPETITIVE_PRESETS[scenarioName] ?? null;
}
