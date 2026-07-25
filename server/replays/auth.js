// ---------------------------------------------------------------------------
// replays/auth.js
// The demo library is shared: every caller reads and writes the same store.
// Sign-in is not required for uploads, playlists, notes, or viewing.
// ---------------------------------------------------------------------------

import { userKey } from './demoStore.js';

/**
 * Fixed library id. Override with AIM4_REPLAY_LIBRARY if an existing on-disk
 * folder (e.g. a former per-account UUID) should stay the public library.
 */
export const SHARED_LIBRARY = userKey(process.env.AIM4_REPLAY_LIBRARY || 'local');

/**
 * Resolve the library for a request. Always succeeds — replays are public.
 *
 * @returns {Promise<{ok: true, user: string}>}
 */
export async function identify(_req) {
  return { ok: true, user: SHARED_LIBRARY };
}

export function authStatus() {
  return {
    configured: false,
    mode: 'shared',
    required: false,
    library: SHARED_LIBRARY
  };
}
