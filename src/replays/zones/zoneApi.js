// ---------------------------------------------------------------------------
// replays/zones/zoneApi.js
// Position/zone networks use the same backend + VITE_API_URL path as round notes
// (/api/replays/* on the Coolify volume). No Supabase — shared JSON on disk.
// ---------------------------------------------------------------------------

import { fetchZoneMaps, fetchZones, saveZones } from '../api.js';
import { isZoneNetworkReady } from './zoneModel.js';

export { fetchZoneMaps, fetchZones, saveZones, isZoneNetworkReady };
