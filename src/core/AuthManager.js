// ---------------------------------------------------------------------------
// AuthManager.js — Supabase auth (Google or password), profile, settings sync
//
// Two ways in, and they land on the same session:
//
//   · Google (OAuth). Still the only way to CREATE an account from the site.
//   · Username (or email) and password, for accounts that predate the switch
//     to Google and for accounts an admin seeded.
//
// The password path does not call signInWithPassword here. Supabase
// authenticates on email, the site's identity is a username, and turning one
// into the other in the browser would mean a public username -> email lookup,
// which is an email harvester. So the credentials go to our own backend
// (POST /api/account/login), which resolves the address privately and hands
// back the tokens; setSession() then installs them and everything downstream —
// profile, entitlements, cloud settings — is identical either way.
// ---------------------------------------------------------------------------

import {
  getSupabase,
  supabaseConfigured,
  authRedirectUrl,
  validateUsername
} from '../lib/supabase.js';
import * as Storage from '../utils/Storage.js';
import { clampElo, DEFAULT_ELO } from '../multiplayer/elo.js';

/** Same resolution the rest of the client uses; empty means same origin. */
const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

/**
 * Display names for the providers, for error copy. The keys are Supabase's
 * own provider ids: 'x' is the OAuth 2.0 provider this site uses, 'twitter'
 * only ever names the legacy OAuth 1.0a one and is kept for identities that
 * might still carry it.
 */
export const PROVIDER_LABELS = {
  google: 'Google',
  x: 'X',
  twitter: 'X',
  discord: 'Discord',
  steam: 'Steam'
};

export class AuthManager {
  constructor(settings) {
    this.settings = settings;
    this.user = null;
    this.profile = null;
    this.ready = false;
    this._listeners = [];
    this._settingsSaveTimer = null;
    this._settingsSyncPaused = false;
    this._linkedProviders = [];
  }

  get isConfigured() {
    return supabaseConfigured();
  }

  get isLoggedIn() {
    return Boolean(this.user);
  }

  /** Ensure a profiles row exists before score submission or leaderboard display. */
  async ensureProfileReady() {
    if (!this.user) return false;
    await this._ensureProfile(this.user);
    return Boolean(this.displayName);
  }

  get username() {
    return this.displayName;
  }

  /**
   * The @ tag, for UI and leaderboards. Falls back to auth metadata if the
   * profile row is missing.
   *
   * Named displayName for history: call sites render it as `@${displayName}`,
   * so it is the TAG, not the free-form name. Use profileName for that.
   */
  get displayName() {
    if (this.profile?.username) return this.profile.username;
    const meta = this.user?.user_metadata?.username;
    if (meta) return String(meta).trim().toLowerCase();
    return null;
  }

  /**
   * What this person calls themselves, falling back to the tag. Never
   * prefixed with @ by callers: it may contain spaces.
   */
  get profileName() {
    return this.profile?.display_name || this.displayName;
  }

  get elo() {
    return clampElo(this.profile?.elo ?? DEFAULT_ELO);
  }

  get countryCode() {
    return this.profile?.country_code || null;
  }

  /** Linked auth providers (e.g. ['email', 'google']). */
  get linkedProviders() {
    return this._linkedProviders || [];
  }

  get hasGoogleLinked() {
    return this.linkedProviders.includes('google');
  }

  /** True when this account signed in with email/password and can link Google. */
  get canLinkGoogle() {
    return this.isLoggedIn && !this.hasGoogleLinked && this.linkedProviders.includes('email');
  }

  onChange(fn) {
    this._listeners.push(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  /** Call once at startup; restores session + cloud settings if logged in. */
  async init() {
    if (!this.isConfigured) {
      this.ready = true;
      this._emit();
      return;
    }

    const sb = getSupabase();
    sb.auth.onAuthStateChange((event, session) => {
      const next = session?.user ?? null;
      // Token rotation keeps the same user. Re-running profile/settings sync and
      // emitting onChange would remount live editors (team docs) on every autosave
      // that touches a near-expiry JWT via getSession().
      if (
        event === 'TOKEN_REFRESHED' &&
        this.user?.id &&
        next?.id === this.user.id
      ) {
        return;
      }
      this._applySession(next).catch((e) => {
        console.warn('[auth] session sync failed', e);
      });
    });

    const { data: { session } } = await sb.auth.getSession();
    await this._applySession(session?.user ?? null);
    this.ready = true;
    this._emit();
  }

  async _applySession(user) {
    this.user = user;
    if (!user) {
      this.profile = null;
      this._unhookSettingsSync();
      this._emit();
      return;
    }
    await this._ensureProfile(user);
    await this._refreshLinkedProviders();
    await this._pullSettings();
    this._hookSettingsSync();
    if (this.displayName) {
      Storage.write('mpName', this.displayName);
    }
    this._emit();
  }

  async _ensureProfile(user) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('profiles')
      .select('id, username, display_name, elo, country_code, created_at, username_chosen')
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.username) {
      this.profile = data;
      return;
    }

    let username = user.user_metadata?.username;
    if (username) username = String(username).trim().toLowerCase();
    if (!username) {
      username = `player_${user.id.replace(/-/g, '').slice(0, 8)}`;
    }

    if (!data) {
      let { error: insErr } = await sb.from('profiles').insert({ id: user.id, username });
      if (insErr?.code === '23505') {
        username = `${username}_${user.id.slice(0, 4)}`;
        ({ error: insErr } = await sb.from('profiles').insert({ id: user.id, username }));
      }
      if (insErr) console.warn('[auth] profile create failed', insErr.message);
    }

    const { data: refreshed, error: reloadErr } = await sb
      .from('profiles')
      .select('id, username, display_name, elo, country_code, created_at, username_chosen')
      .eq('id', user.id)
      .maybeSingle();
    if (reloadErr) throw new Error(reloadErr.message);
    this.profile = refreshed;
  }

  /** Persist Elo after a ranked match (server-calculated rating). */
  async applyMatchElo(newElo) {
    if (!this.user) return;
    const rating = clampElo(newElo);
    const sb = getSupabase();
    const { error } = await sb.from('profiles').update({ elo: rating }).eq('id', this.user.id);
    if (error) {
      console.warn('[auth] elo update failed', error.message);
      return;
    }
    if (this.profile) this.profile.elo = rating;
    this._emit();
  }

  async refreshElo() {
    if (!this.user) return DEFAULT_ELO;
    const sb = getSupabase();
    const { data, error } = await sb
      .from('profiles')
      .select('elo')
      .eq('id', this.user.id)
      .maybeSingle();
    if (error || data?.elo == null) return this.elo;
    if (this.profile) this.profile.elo = clampElo(data.elo);
    this._emit();
    return this.elo;
  }

  /**
   * True when this account arrived without choosing a username, so the app must
   * block on the picker.
   *
   * Without this, Google-only means a leaderboard full of player_a1b2c3d4.
   */
  get needsUsername() {
    return Boolean(this.user) && this.profile?.username_chosen === false;
  }

  /**
   * Claim a username, atomically.
   *
   * Done in one database call rather than "check, then update": between a
   * check and an update someone else can take the name, and what the user then
   * sees is a raw unique-constraint error.
   */
  async claimUsername(username) {
    if (!this.user) throw new Error('Sign in first.');
    const err = validateUsername(username);
    if (err) throw new Error(err);

    const sb = getSupabase();
    const { data, error } = await sb.rpc('claim_username', {
      p_username: username.trim().toLowerCase()
    });
    if (error) throw new Error(error.message);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) {
      if (row?.error === 'taken') throw new Error('That username is taken.');
      if (row?.error === 'invalid') {
        throw new Error('Usernames are 3 to 20 letters, numbers or underscores.');
      }
      throw new Error('Could not set that username.');
    }

    if (this.profile) {
      this.profile.username = row.username;
      this.profile.username_chosen = true;
    }
    Storage.write('mpName', row.username);
    this._emit();
    return row.username;
  }

  /**
   * A password-only account that has not linked Google yet.
   *
   * Drives the one-time "link Google to keep access" prompt. Not a hard block:
   * locking these accounts out before the window closes is exactly what the
   * migration is designed to avoid.
   */
  get needsGoogleLink() {
    if (!this.user || !this._linkedProviders.length) return false;
    return !this._linkedProviders.includes('google');
  }

  /**
   * Sign in with a username (or email) and a password.
   *
   * The account must already exist: this signs in, it never registers. Google
   * is still the only way to create one from the site.
   *
   * @param {{ identifier: string, password: string }} credentials
   * @returns {Promise<object>} the profile row
   */
  async signIn({ identifier, password }) {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    const id = String(identifier || '').trim();
    if (!id) throw new Error('Enter your username or email.');
    if (!password) throw new Error('Enter your password.');

    let res;
    try {
      res = await fetch(`${API_BASE}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: id, password })
      });
    } catch {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Sign-in failed.');
    if (!body.access_token || !body.refresh_token) throw new Error('Sign-in failed.');

    const sb = getSupabase();
    const { data, error } = await sb.auth.setSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token
    });
    if (error) throw new Error(error.message || 'Sign-in failed.');

    const user = data?.user || data?.session?.user || null;
    if (!user) throw new Error('Sign-in failed.');

    // setSession fires onAuthStateChange, which runs this too. Awaiting it here
    // as well is what lets the caller close the modal knowing the profile is
    // loaded, rather than on a race with the listener.
    await this._applySession(user);
    return this.profile;
  }

  /**
   * Create a username account and sign it in, one call.
   *
   * The server owns the whole recipe (internal login email, throttle, the
   * link-before-upload rule); this installs the session it returns exactly
   * the way signIn does. A registration that ends signed out would drop the
   * brand-new user straight back onto a login form.
   */
  async register({ username, password }) {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    const name = String(username || '').trim();
    if (!name) throw new Error('Pick a username.');
    if (!password) throw new Error('Pick a password.');

    let res;
    try {
      res = await fetch(`${API_BASE}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password })
      });
    } catch {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not create the account.');
    if (!body.access_token || !body.refresh_token) {
      // Created but not signed in (a hiccup on the grant): the account is
      // real, so send them through the door that exists.
      throw new Error('Account created. Sign in with your new username.');
    }

    const sb = getSupabase();
    const { data, error } = await sb.auth.setSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token
    });
    if (error) throw new Error(error.message || 'Account created. Sign in with your new username.');
    const user = data?.user || data?.session?.user || null;
    if (!user) throw new Error('Account created. Sign in with your new username.');

    await this._applySession(user);
    return this.profile;
  }

  /**
   * Sign in or sign up with an OAuth provider Supabase brokers for us.
   *
   * Google, X and Discord all take this path: Supabase runs the OAuth dance
   * and the callback lands on Supabase's own /auth/v1/callback, so there is
   * nothing on our backend to route. Steam is the exception — it speaks
   * OpenID 2.0, which Supabase does not broker, so it has its own flow in
   * signInWithSteam() and server/account/steamAuth.js.
   *
   * Redirects away from the page; on return the session is restored via
   * detectSessionInUrl in the Supabase client.
   *
   * @param {'google' | 'x' | 'discord'} provider
   */
  async signInWithProvider(provider) {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    const sb = getSupabase();
    const { error } = await sb.auth.signInWithOAuth({
      provider,
      options: { redirectTo: authRedirectUrl() }
    });
    if (error) throw new Error(error.message || `${PROVIDER_LABELS[provider] || provider} sign-in failed.`);
  }

  /** @deprecated call signInWithProvider('google'); kept for existing callers. */
  async signInWithGoogle() {
    return this.signInWithProvider('google');
  }

  /**
   * Attach another identity to the account already signed in.
   *
   * @param {'google' | 'x' | 'discord'} provider
   */
  async linkProvider(provider) {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    if (!this.user) throw new Error('Sign in first.');
    if (this.hasProviderLinked(provider)) return;
    const label = PROVIDER_LABELS[provider] || provider;
    const sb = getSupabase();
    const { error } = await sb.auth.linkIdentity({
      provider,
      options: { redirectTo: authRedirectUrl() }
    });
    if (error) {
      if (/manual linking is disabled/i.test(error.message)) {
        throw new Error(
          'Manual linking is off in Supabase. Enable it under Authentication → Settings → “Enable manual linking”, then try again.'
        );
      }
      throw new Error(error.message || `Could not link ${label}.`);
    }
  }

  /**
   * Detach an identity. Supabase refuses to remove the last one, which is the
   * behaviour we want: an account with no identity left cannot be signed into.
   *
   * @param {'google' | 'x' | 'discord'} provider
   */
  async unlinkProvider(provider) {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    if (!this.user) throw new Error('Sign in first.');
    const label = PROVIDER_LABELS[provider] || provider;
    const sb = getSupabase();
    const { data, error: readError } = await sb.auth.getUserIdentities();
    if (readError) throw new Error(readError.message || `Could not unlink ${label}.`);
    const identity = (data?.identities || []).find((i) => i.provider === provider);
    if (!identity) return;
    const { error } = await sb.auth.unlinkIdentity(identity);
    if (error) throw new Error(error.message || `Could not unlink ${label}.`);
    await this._refreshLinkedProviders();
  }

  /** @param {string} provider */
  hasProviderLinked(provider) {
    return (this._linkedProviders || []).includes(provider);
  }

  /**
   * Sign in or sign up with Steam. Leaves the page, like Google.
   *
   * A navigation rather than a fetch: Steam's OpenID flow redirects the
   * top-level browser and will not run in an iframe or an XHR. The backend
   * answers /api/auth/steam with a 302 into Steam, so pointing the location at
   * it is the whole call.
   *
   * @param {string} [next] path on the site to come back to
   */
  signInWithSteam(next = `${window.location.pathname}${window.location.search}`) {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    const url = `${API_BASE}/api/auth/steam?next=${encodeURIComponent(next || '/')}`;
    window.location.assign(url);
  }

  /**
   * Finish a Steam sign-in, from the ?steam_code= the callback redirected with.
   *
   * The code is exchanged for the session over POST rather than the session
   * riding in the URL; see server/account/steamAuth.js for why. Single use, so
   * this runs once and strips the parameter whatever happens — a reload that
   * retried a spent code would show a failure for a sign-in that worked.
   *
   * @returns {Promise<{ signedIn: boolean, persona?: string, error?: string }>}
   */
  async completeSteamSignIn(search = window.location.search) {
    const params = new URLSearchParams(search);
    const code = params.get('steam_code');
    const failed = params.get('steam_error');
    if (!code && !failed) return { signedIn: false };

    const strip = () => {
      const clean = new URLSearchParams(window.location.search);
      clean.delete('steam_code');
      clean.delete('steam_error');
      const qs = clean.toString();
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
      );
    };

    if (failed) {
      strip();
      return { signedIn: false, error: failed };
    }

    strip();
    let res;
    try {
      res = await fetch(`${API_BASE}/api/auth/steam/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
    } catch {
      return { signedIn: false, error: 'unreachable' };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token || !body.refresh_token) {
      return { signedIn: false, error: body.error || 'unavailable' };
    }

    const sb = getSupabase();
    const { data, error } = await sb.auth.setSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token
    });
    if (error) return { signedIn: false, error: error.message };
    const user = data?.user || data?.session?.user || null;
    if (!user) return { signedIn: false, error: 'unavailable' };

    await this._applySession(user);
    return { signedIn: true, persona: body.persona || '' };
  }

  /** @deprecated call linkProvider('google'); kept for existing callers. */
  async linkGoogle() {
    return this.linkProvider('google');
  }

  async _refreshLinkedProviders() {
    if (!this.user) {
      this._linkedProviders = [];
      return;
    }
    const sb = getSupabase();
    const { data, error } = await sb.auth.getUser();
    if (error) {
      console.warn('[auth] getUser failed', error.message);
      this._linkedProviders = [];
      return;
    }
    this._linkedProviders = (data.user?.identities || []).map((i) => i.provider);
  }

  /** Change the public username shown on leaderboards. */
  async updateUsername(username) {
    if (!this.user) throw new Error('Sign in first.');
    const err = validateUsername(username);
    if (err) throw new Error(err);
    const normalized = username.trim().toLowerCase();
    if (normalized === this.profile?.username) return this.profile;

    const sb = getSupabase();
    const { data: taken } = await sb
      .from('profiles')
      .select('id')
      .eq('username', normalized)
      .maybeSingle();
    if (taken && taken.id !== this.user.id) {
      throw new Error('Username is already taken.');
    }

    const { error } = await sb
      .from('profiles')
      .update({ username: normalized })
      .eq('id', this.user.id);
    if (error) throw new Error(error.message);

    if (this.profile) this.profile.username = normalized;
    Storage.write('mpName', normalized);
    this._emit();
    return this.profile;
  }

  /** Set or clear the account country flag (ISO 3166-1 alpha-2, or null). */
  async updateCountryCode(code) {
    if (!this.user) throw new Error('Sign in first.');
    const normalized = code ? String(code).trim().toUpperCase() : null;
    if (normalized && !/^[A-Z]{2}$/.test(normalized)) {
      throw new Error('Pick a valid country.');
    }

    const sb = getSupabase();
    const { error } = await sb
      .from('profiles')
      .update({ country_code: normalized })
      .eq('id', this.user.id);
    if (error) throw new Error(error.message);

    if (this.profile) this.profile.country_code = normalized;
    this._emit();
    return this.profile;
  }

  async refreshProfile() {
    if (!this.user) return null;
    const sb = getSupabase();
    const { data, error } = await sb
      .from('profiles')
      .select('id, username, display_name, elo, country_code, created_at, username_chosen')
      .eq('id', this.user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    this.profile = data;
    await this._refreshLinkedProviders();
    this._emit();
    return this.profile;
  }

  async signOut() {
    if (!this.isConfigured) return;
    this._unhookSettingsSync();
    await getSupabase().auth.signOut();
    this.user = null;
    this.profile = null;
    this._linkedProviders = [];
    this._emit();
  }

  _hookSettingsSync() {
    this._unhookSettingsSync();
    this.settings.setCloudSaveHandler(() => this._scheduleSettingsPush());
  }

  _unhookSettingsSync() {
    this.settings.setCloudSaveHandler(null);
    if (this._settingsSaveTimer) {
      clearTimeout(this._settingsSaveTimer);
      this._settingsSaveTimer = null;
    }
  }

  _scheduleSettingsPush() {
    if (!this.isLoggedIn || this._settingsSyncPaused) return;
    if (this._settingsSaveTimer) clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = setTimeout(() => {
      this._settingsSaveTimer = null;
      this._pushSettings().catch((e) => console.warn('[auth] settings push failed', e));
    }, 800);
  }

  async _pullSettings() {
    if (!this.user) return;
    const sb = getSupabase();
    const { data, error } = await sb
      .from('user_settings')
      .select('settings, updated_at')
      .eq('user_id', this.user.id)
      .maybeSingle();
    if (error) {
      console.warn('[auth] settings pull failed', error.message);
      return;
    }
    if (data?.settings && typeof data.settings === 'object') {
      this._settingsSyncPaused = true;
      this.settings.applyPayload(data.settings);
      this._settingsSyncPaused = false;
    } else {
      await this._pushSettings();
    }
  }

  async _pushSettings() {
    if (!this.user) return;
    const sb = getSupabase();
    const { error } = await sb.from('user_settings').upsert(
      {
        user_id: this.user.id,
        settings: this.settings.getExportPayload(),
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
    if (error) console.warn('[auth] settings upsert failed', error.message);
  }
}
