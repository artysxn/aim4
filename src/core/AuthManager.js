// ---------------------------------------------------------------------------
// AuthManager.js — Supabase auth (email confirm on), profile, settings cloud sync
// ---------------------------------------------------------------------------

import {
  getSupabase,
  supabaseConfigured,
  normalizeEmail,
  validateUsername,
  validateEmail,
  validatePassword
} from '../lib/supabase.js';
import * as Storage from '../utils/Storage.js';

export class AuthManager {
  constructor(settings) {
    this.settings = settings;
    this.user = null;
    this.profile = null;
    this.ready = false;
    this._listeners = [];
    this._settingsSaveTimer = null;
    this._settingsSyncPaused = false;
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
      .select('id, username, created_at')
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
      .select('id, username, created_at')
      .eq('id', user.id)
      .maybeSingle();
    if (reloadErr) throw new Error(reloadErr.message);
    this.profile = refreshed;
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

  async signOut() {
    if (!this.isConfigured) return;
    this._unhookSettingsSync();
    await getSupabase().auth.signOut();
    this.user = null;
    this.profile = null;
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
