// Builds the client for the signed-in host (server/run-account.js) into
// dist-account/: VITE_LOCAL_MODE=0 and the site's Supabase settings from
// .env.account, so the page asks you to sign in instead of being the owner.
import { loadAccountEnv } from '../server/accountEnv.js';

loadAccountEnv();
await import('./build.mjs');
