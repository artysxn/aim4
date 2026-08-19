// ---------------------------------------------------------------------------
// src/cs3d/practiceSpawn.js
// N cycles the current side's spawn list in order. Chat prints the 1-based
// index so you know which one you landed on.
// ---------------------------------------------------------------------------

export function cycleSpawnIndex(prev, length) {
  const n = Math.max(0, Number(length) || 0);
  if (n === 0) return 0;
  return (Math.max(-1, Number(prev) || 0) + 1) % n;
}

export function formatSpawnChat(side, index, length) {
  return `${side} spawn ${index + 1}/${length}`;
}
