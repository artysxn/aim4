// ---------------------------------------------------------------------------
// AuthManager.js — Supabase auth (Google), profile, settings cloud sync
//
// Sign-up and sign-in by email and password are gone. Google is the only way to
// create an account, which removes the password reset flow, the confirmation
// email, and the class of support ticket that comes with both.
//
// Existing password accounts are NOT locked out. The Email provider stays
// enabled in Supabase until the migration window closes, signIn/signUp are
// simply no longer reachable from the UI, and password holders are prompted to
// link Google on their next visit. Disabling the provider is a dashboard action
// taken after that window, not something this file does.
// ---------------------------------------------------------------------------

import {
  getSupabase,
  supabaseConfigured,
  authRedirectUrl,
  validateUsername
} from '../lib/supabase.js';
import * as Storage from '../utils/Storage.js';
import { clampElo, DEFAULT_ELO } from '../multiplayer/elo.js';

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

  /** Username for UI / leaderboards; falls back to auth metadata if profile row is missing. */
  get displayName() {
    if (this.profile?.username) return this.profile.username;
    const meta = this.user?.user_metadata?.username;
    if (meta) return String(meta).trim().toLowerCase();
    return null;
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
      .select('id, username, elo, country_code, created_at, username_chosen')
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
      .select('id, username, elo, country_code, created_at, username_chosen')
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
   * Sign in or sign up with Google (OAuth). Redirects away from the page; on
   * return the session is restored via detectSessionInUrl in the Supabase client.
   */
  async signInWithGoogle() {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    const sb = getSupabase();
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: authRedirectUrl() }
    });
    if (error) throw new Error(error.message || 'Google sign-in failed.');
  }

  /** Link Google to the current account (redirects away like sign-in). */
  async linkGoogle() {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    if (!this.user) throw new Error('Sign in first.');
    if (this.hasGoogleLinked) return;
    const sb = getSupabase();
    const { error } = await sb.auth.linkIdentity({
      provider: 'google',
      options: { redirectTo: authRedirectUrl() }
    });
    if (error) {
      if (/manual linking is disabled/i.test(error.message)) {
        throw new Error(
          'Manual linking is off in Supabase. Enable it under Authentication → Settings → “Enable manual linking”, then try again.'
        );
      }
      throw new Error(error.message || 'Could not link Google.');
    }
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
      .select('id, username, elo, country_code, created_at, username_chosen')
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
