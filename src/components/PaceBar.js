// ---------------------------------------------------------------------------
// PaceBar.js — KovaaK's-style personal-best pacing strip on the HUD.
// Colored fill = elapsed time + ahead/behind PB pace; white marker = live score
// as a fraction of personal best (0 = left, 1 = PB at right).
// ---------------------------------------------------------------------------

import { DEFAULTS } from '../core/SettingsManager.js';
import {
  getPracticeBest,
  isAheadOfPace,
  paceMetric,
  scoreFraction
} from '../lib/practiceBest.js';

export class PaceBar {
  constructor(root) {
    this.el = root.querySelector('#pace-bar');
    this.fill = root.querySelector('#pace-bar-fill');
    this.marker = root.querySelector('#pace-bar-marker');
    this.expandedSlot = root.querySelector('#pace-bar-slot-expanded');
    this.compactSlot = root.querySelector('#pace-bar-slot-compact');
    this._pb = null;
    this._totalTime = 0;
    this._scenario = null;
    this._locked = false;
    this._lockedFill = 0;
    this._lockedAhead = null;
    this._lockedMetric = 0;
    this._style = 'expanded';
  }

  reset() {
    this._pb = null;
    this._totalTime = 0;
    this._scenario = null;
    this._locked = false;
    this._lockedFill = 0;
    this._lockedAhead = null;
    this._lockedMetric = 0;
    this.hide();
  }

  applySettings(settings) {
    const s = settings?.activeSettings?.() ?? settings ?? {};
    const defaults = DEFAULTS.paceBarColors;
    const colors = { ...defaults, ...(s.paceBarColors || {}) };
    const style = s.paceBarStyle === 'compact' ? 'compact' : 'expanded';
    this._style = style;

    if (this.el) {
      const slot = style === 'compact' ? this.compactSlot : this.expandedSlot;
      if (slot && this.el.parentElement !== slot) slot.appendChild(this.el);
      this.el.classList.toggle('pace-bar--expanded', style === 'expanded');
      this.el.classList.toggle('pace-bar--compact', style === 'compact');
      this.el.style.setProperty('--pace-bar-track', colors.track);
      this.el.style.setProperty('--pace-bar-ahead', colors.ahead);
      this.el.style.setProperty('--pace-bar-behind', colors.behind);
      this.el.style.setProperty('--pace-bar-neutral', colors.neutral);
      if (style === 'compact') {
        this.el.style.width = `${Math.round(s.paceBarCompactWidth ?? 200)}px`;
        this.el.style.height = `${Math.round(s.paceBarCompactHeight ?? 30)}px`;
      } else {
        this.el.style.width = '';
        this.el.style.height = '';
      }
    }
  }

  begin(scenario, configKey, totalTime) {
    this._scenario = scenario;
    this._totalTime = totalTime;
    this._pb = getPracticeBest(scenario, configKey);
    this._locked = false;
    this._lockedFill = 0;
    this._lockedAhead = null;
    this._lockedMetric = 0;
    this.hide();
  }

  lock(currentTime, currentMetric) {
    if (this._locked || !this._scenario || !this._totalTime) return;
    this._locked = true;
    this._lockedFill = Math.max(0, Math.min(1, currentTime / this._totalTime));
    this._lockedMetric = currentMetric;
    this._lockedAhead = isAheadOfPace(
      this._scenario,
      currentMetric,
      this._pb?.score ?? 0,
      currentTime,
      this._totalTime
    );
    this._apply(this._lockedFill, this._lockedAhead, currentMetric);
    this.el?.classList.add('active');
  }

  hide() {
    this.el?.classList.remove('active');
    if (this.fill) {
      this.fill.style.width = '0%';
      this.fill.classList.remove('ahead', 'behind', 'neutral');
    }
    if (this.marker) {
      this.marker.style.left = '0%';
      this.marker.style.opacity = '0';
    }
  }

  update({ enabled, scenario, elapsed, scoreSource, totalTime }) {
    if (!enabled || !this.el || !this.fill || !scenario) {
      this.hide();
      return;
    }
    if (!Number.isFinite(totalTime) || totalTime <= 0) {
      this.hide();
      return;
    }

    if (this._locked) {
      this._apply(this._lockedFill, this._lockedAhead, this._lockedMetric);
      this.el.classList.add('active');
      return;
    }

    const t = Math.max(0, Math.min(elapsed, totalTime));
    const fill = t / totalTime;
    const metric = paceMetric(scenario, scoreSource);
    const pb = this._pb?.score ?? 0;
    const ahead = isAheadOfPace(scenario, metric, pb, t, totalTime);
    this._apply(fill, ahead, metric);
    this.el.classList.add('active');
  }

  _apply(fill, ahead, metric) {
    if (this.fill) {
      this.fill.style.width = `${(fill * 100).toFixed(2)}%`;
      this.fill.classList.remove('ahead', 'behind', 'neutral');
      if (ahead === null || !(this._pb?.score > 0)) {
        this.fill.classList.add('neutral');
      } else if (ahead) {
        this.fill.classList.add('ahead');
      } else {
        this.fill.classList.add('behind');
      }
    }

    if (!this.marker) return;
    const frac = scoreFraction(this._scenario, metric, this._pb?.score ?? 0);
    if (frac == null) {
      this.marker.style.opacity = '0';
      return;
    }
    this.marker.style.left = `${(frac * 100).toFixed(2)}%`;
    this.marker.style.opacity = '1';
  }
}
