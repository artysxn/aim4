// ---------------------------------------------------------------------------
// PaceBar.js — KovaaK's-style personal-best pacing strip at the top of the HUD.
// ---------------------------------------------------------------------------

import {
  getPracticeBest,
  isAheadOfPace,
  paceMetric
} from '../lib/practiceBest.js';

export class PaceBar {
  constructor(root) {
    this.el = root.querySelector('#pace-bar');
    this.fill = root.querySelector('#pace-bar-fill');
    this._pb = null;
    this._totalTime = 0;
    this._scenario = null;
    this._locked = false;
    this._lockedFill = 0;
    this._lockedAhead = null;
  }

  reset() {
    this._pb = null;
    this._totalTime = 0;
    this._scenario = null;
    this._locked = false;
    this._lockedFill = 0;
    this._lockedAhead = null;
    this.hide();
  }

  begin(scenario, configKey, totalTime) {
    this._scenario = scenario;
    this._totalTime = totalTime;
    this._pb = getPracticeBest(scenario, configKey);
    this._locked = false;
    this._lockedFill = 0;
    this._lockedAhead = null;
    this.hide();
  }

  lock(currentTime, currentMetric) {
    if (this._locked || !this._scenario || !this._totalTime) return;
    this._locked = true;
    this._lockedFill = Math.max(0, Math.min(1, currentTime / this._totalTime));
    this._lockedAhead = isAheadOfPace(
      this._scenario,
      currentMetric,
      this._pb?.score ?? 0,
      currentTime,
      this._totalTime
    );
    this._apply(this._lockedFill, this._lockedAhead);
    this.el?.classList.add('active');
  }

  hide() {
    this.el?.classList.remove('active');
    if (this.fill) {
      this.fill.style.width = '0%';
      this.fill.classList.remove('ahead', 'behind', 'neutral');
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
      this._apply(this._lockedFill, this._lockedAhead);
      this.el.classList.add('active');
      return;
    }

    const t = Math.max(0, Math.min(elapsed, totalTime));
    const fill = t / totalTime;
    const metric = paceMetric(scenario, scoreSource);
    const pb = this._pb?.score ?? 0;
    const ahead = isAheadOfPace(scenario, metric, pb, t, totalTime);
    this._apply(fill, ahead);
    this.el.classList.add('active');
  }

  _apply(fill, ahead) {
    if (!this.fill) return;
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
}
