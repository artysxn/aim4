// ---------------------------------------------------------------------------
// regionLabels.js — human-readable Fly.io / server region codes for the HUD.
// ---------------------------------------------------------------------------

export const REGION_LABELS = {
  fra: 'Frankfurt',
  ams: 'Amsterdam',
  arn: 'Stockholm',
  cdg: 'Paris',
  lhr: 'London',
  iad: 'Virginia, US',
  ord: 'Chicago, US',
  lax: 'Los Angeles, US',
  sjc: 'San Jose, US',
  sin: 'Singapore',
  syd: 'Sydney',
  nrt: 'Tokyo',
  hkg: 'Hong Kong'
};

export function formatServerRegion(code) {
  if (!code) return null;
  const key = String(code).toLowerCase();
  const label = REGION_LABELS[key];
  return label ? `${label} (${key})` : key.toUpperCase();
}
