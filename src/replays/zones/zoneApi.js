// ---------------------------------------------------------------------------
// replays/zones/zoneApi.js
// Zone networks use the same backend + VITE_API_URL path as round notes
// (/api/replays/* on the Coolify volume). No Supabase — shared JSON on disk.
// ---------------------------------------------------------------------------

import { fetchZoneMaps, fetchZones, saveZones } from '../api.js';

export { fetchZoneMaps, fetchZones, saveZones };
