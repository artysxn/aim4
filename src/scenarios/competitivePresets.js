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
    targetCount: 200,
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
    crossDuration: 550,
    peekHold: 475,
    columns: 5,
    columnRadius: 0.75,
    ringRadius: 13.5,
    infiniteAmmo: true,
    competitiveMissPenalty: true
  },
  duels: {
    runDuration: 60,
    ttk: 0.3
  },
  range: {
    runDuration: 30,
    enemyCount: 8,
    radius: 15,
    coverEnabled: true,
    coverCount: 5,
    coverDistance: 4,
    coverThickness: 1.5,
    coverHeight: 3
  },
  tracking: {
    runDuration: 30,
    botWidth: 1.0,
    botSpeed: 1.0
  },
  deathmatch: {
    runDuration: 60,
    botCount: 6,
    botSpeed: 1.0,
    ttk: 0.6
  },
  spidershot: {
    runDuration: 30,
    timeToKill: 450,
    targetSize: 0.35,
    maxDistance: 7,
    minDistance: 1,
    heightSpread: 1,
    angleSpread: 25,
    streakChance: 0.1,
    streakLengthMin: 1,
    streakLengthMax: 2,
    doubleSpawnChance: 0.07,
    randomSize: true,
    randomSizeMin: 0.2,
    randomSizeMax: 0.35,
    infiniteAmmo: true,
    viewmodelRecoil: false
  }
};

export function competitivePresetFor(scenarioName) {
  return COMPETITIVE_PRESETS[scenarioName] ?? null;
}
