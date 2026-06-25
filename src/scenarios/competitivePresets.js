// Fixed Competitive rules — merged in scenario ctors when config.variant === 'competitive'.

export const COMPETITIVE_PRESETS = {
  gridshot: {
    floatEnabled: false,
    targetSize: 0.35,
    targetCount: 5,
    boundsScaleY: 0.8,
    boundsScaleX: 1.2,
    mode: 'clicking'
  },
  pasu: {
    targetSize: 0.15,
    angleOffset: 180,
    targetCount: 4,
    travelSpeedMax: 3.5
  },
  arena: {
    crossDuration: 375,
    peekHold: 400,
    columns: 5,
    columnRadius: 0.75,
    ringRadius: 13.5,
    infiniteAmmo: true,
    competitiveMissPenalty: true
  },
  duels: {
    ttk: 0.3
  },
  range: {
    enemyCount: 8,
    radius: 15,
    coverEnabled: true,
    coverCount: 5,
    coverDistance: 4,
    coverThickness: 1.5,
    coverHeight: 3
  }
};

export function competitivePresetFor(scenarioName) {
  return COMPETITIVE_PRESETS[scenarioName] ?? null;
}
