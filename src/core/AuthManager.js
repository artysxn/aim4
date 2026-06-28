// ---------------------------------------------------------------------------
// AuthManager.js — Supabase auth (email confirm on), profile, settings cloud sync
// ---------------------------------------------------------------------------

import {
  getSupabase,
  supabaseConfigured,
  authRedirectUrl,
  normalizeEmail,
  validateUsername,
  validateEmail,
  validatePassword
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
    sb.auth.onAuthStateChange((_event, session) => {
      this._applySession(session?.user ?? null).catch((e) => {
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
      .select('id, username, elo, country_code, created_at')
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
      .select('id, username, elo, country_code, created_at')
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
   * Register username + email + password. With confirm-email enabled, returns
   * { pendingConfirmation: true } until the user clicks the link in their inbox.
   * Profile row is created by the DB trigger on auth.users insert.
   */
  async signUp({ username, email, password }) {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    const userErr = validateUsername(username);
    if (userErr) throw new Error(userErr);
    const emailErr = validateEmail(email);
    if (emailErr) throw new Error(emailErr);
    const passErr = validatePassword(password);
    if (passErr) throw new Error(passErr);

    const normalized = username.trim().toLowerCase();
    const authEmail = normalizeEmail(email);
    const sb = getSupabase();

    const { data: taken } = await sb
      .from('profiles')
      .select('id')
      .eq('username', normalized)
      .maybeSingle();
    if (taken) throw new Error('Username is already taken.');

    const { data, error } = await sb.auth.signUp({
      email: authEmail,
      password,
      options: {
        data: { username: normalized },
        emailRedirectTo: window.location.origin
      }
    });
    if (error) {
      if (/username_taken/i.test(error.message)) throw new Error('Username is already taken.');
      throw new Error(error.message);
    }
    if (!data.user) throw new Error('Sign-up failed.');

    if (!data.session) {
      return { pendingConfirmation: true, email: authEmail };
    }

    await this._applySession(data.user);
    if (!this.displayName) {
      throw new Error('Account created but profile is missing. Contact support.');
    }
    await this._pushSettings();
    return { pendingConfirmation: false, profile: this.profile };
  }

  async signIn({ email, password }) {
    if (!this.isConfigured) throw new Error('Accounts are not configured on this deployment.');
    const emailErr = validateEmail(email);
    if (emailErr) throw new Error(emailErr);
    if (!password) throw new Error('Enter your password.');

    const sb = getSupabase();
    const { data, error } = await sb.auth.signInWithPassword({
      email: normalizeEmail(email),
      password
    });
    if (error) {
      const msg = error.message || '';
      if (/email not confirmed/i.test(msg)) {
        throw new Error('Confirm your email first — check your inbox for the verification link.');
      }
      throw new Error(msg || 'Sign-in failed.');
    }
    if (!data.user) throw new Error('Sign-in failed.');

    await this._applySession(data.user);
    if (!this.displayName) {
      throw new Error('Account profile not found. Contact support.');
    }
    return this.profile;
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
    if (error) throw new Error(error.message || 'Could not link Google.');
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
      .select('id, username, elo, country_code, created_at')
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
