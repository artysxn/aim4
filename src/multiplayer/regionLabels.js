// ---------------------------------------------------------------------------
// regionLabels.js — human-readable server region codes for the HUD.
// Codes follow the IATA airport convention most hosts use; unknown codes fall
// back to the raw value, so a new host needs no change here.
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
