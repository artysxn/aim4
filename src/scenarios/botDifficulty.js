// Training-only bot difficulty presets for duels and deathmatch.

export const BOT_DIFFICULTIES = Object.freeze(['hard', 'medium', 'easy']);

/** Multipliers applied on top of per-mode settings (hard = 1× / unchanged). */
export function botDifficultyMultipliers(difficulty) {
  switch (difficulty) {
    case 'medium':
      return { reaction: 1.5, hit: 1 / 1.5 };
    case 'easy':
      return { reaction: 2, hit: 1 / 1.5 };
    default:
      return { reaction: 1, hit: 1 };
  }
}
