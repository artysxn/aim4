// ---------------------------------------------------------------------------
// replays/viewer/playback.js
// The transport: a wall-clock driven position, and the mapping between one
// continuous timeline and the rounds it is stitched from.
//
// Playing a whole game is the default, so position is kept as seconds across
// the entire selection rather than per round. Round tabs are then just seeks
// to a known offset, and playback rolls into the next round on its own.
// ---------------------------------------------------------------------------

import { timingFor, totalSeconds } from './roundClock.js';

export class RoundSequence {
  /** @param {Array} rounds  round records, in play order */
  constructor(rounds) {
    this.rounds = rounds.map((r) => {
      const timing = timingFor(r);
      return { round: r, timing, seconds: totalSeconds(timing) };
    });
    this.offsets = [];
    let acc = 0;
    for (const item of this.rounds) {
      this.offsets.push(acc);
      acc += item.seconds;
    }
    this.duration = acc;
  }

  get length() {
    return this.rounds.length;
  }

  at(index) {
    return this.rounds[index] || null;
  }

  offsetOf(index) {
    return this.offsets[index] ?? 0;
  }

  /** Global seconds -> which round, and how far into it. */
  locate(seconds) {
    const t = Math.max(0, Math.min(this.duration, seconds));
    let index = 0;
    while (index + 1 < this.rounds.length && this.offsets[index + 1] <= t) index++;
    const item = this.rounds[index];
    const local = t - this.offsets[index];
    return {
      index,
      local,
      item,
      tick: item.timing.startTick + local * item.timing.tickRate
    };
  }

  /** Demo tick for a point inside one round. */
  tickAt(index, localSeconds) {
    const item = this.rounds[index];
    if (!item) return 0;
    return item.timing.startTick + localSeconds * item.timing.tickRate;
  }
}

export class Playback {
  /**
   * @param {(pos: number, dt: number) => void} onFrame  called with global seconds
   */
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.position = 0;
    this.duration = 0;
    this.speed = 1;
    this.playing = false;
    this.loop = false;
    this._raf = 0;
    this._last = 0;
    this._tick = this._tick.bind(this);
  }

  setDuration(seconds) {
    this.duration = Math.max(0, seconds);
    if (this.position > this.duration) this.position = this.duration;
  }

  play() {
    if (this.playing || this.duration <= 0) return;
    this.playing = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed) {
    this.speed = Math.max(0.1, Math.min(8, speed));
  }

  seek(seconds, { emit = true } = {}) {
    this.position = Math.max(0, Math.min(this.duration, seconds));
    if (emit) this.onFrame(this.position, 0);
  }

  nudge(seconds) {
    this.seek(this.position + seconds);
  }

  _tick(now) {
    if (!this.playing) return;
    // A tab that was backgrounded should not fast-forward on return.
    const dt = Math.min(0.25, (now - this._last) / 1000);
    this._last = now;
    let next = this.position + dt * this.speed;
    if (next >= this.duration) {
      if (this.loop) {
        next = 0;
      } else {
        next = this.duration;
        this.position = next;
        this.onFrame(next, dt);
        this.pause();
        return;
      }
    }
    this.position = next;
    this.onFrame(next, dt);
    this._raf = requestAnimationFrame(this._tick);
  }

  destroy() {
    this.pause();
    this.onFrame = () => {};
  }
}
