// ---------------------------------------------------------------------------
// src/cs3d/hud.js
// The explorer's overlay: a status strip (map, mode, position, speed, fps), a
// load bar while the pack streams, the help/enter panel shown whenever the
// pointer is not locked, and the map picker. Plain DOM; no framework.
// ---------------------------------------------------------------------------

import { CS3D_MAPS } from '../../shared/cs3d/maps.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Hud {
  constructor(root, { map, onSensitivity, sens }) {
    this.root = root;
    this.map = map;
    root.innerHTML = `
      <div class="c3-top">
        <div class="c3-title">${esc(map.name)}</div>
        <div class="c3-stat" data-k="mode">fly</div>
        <div class="c3-stat" data-k="pos">0 0 0</div>
        <div class="c3-stat" data-k="speed">0 u/s</div>
        <div class="c3-stat" data-k="fps"></div>
        <div class="c3-stat" data-k="view"></div>
        <div class="c3-stat" data-k="backend"></div>
        <div class="c3-stat" data-k="demo" hidden></div>
      </div>
      <div class="c3-roster" data-k="roster" hidden></div>
      <div class="c3-inspect" data-k="inspect" hidden></div>
      <div class="c3-grade" data-k="grade" hidden></div>
      <div class="c3-load" data-k="load"><div class="c3-load-bar"><span></span></div><div class="c3-load-text"></div></div>
      <div class="c3-boot" data-k="boot">
        <div class="c3-boot-name">${esc(map.name)}</div>
        <div class="c3-boot-bar"><span></span></div>
        <div class="c3-boot-text">Loading</div>
      </div>
      <div class="c3-center" data-k="enter">
        <div class="c3-panel">
          <div class="c3-panel-title">${esc(map.name)}</div>
          <div class="c3-keys">
            <div><b>Click</b> to enter</div>
            <div><b>W A S D</b> move</div>
            <div><b>F</b> fly / walk</div>
            <div><b>Space</b> up / jump</div>
            <div><b>C</b> down, <b>Ctrl</b> slow / crouch</div>
            <div><b>Shift</b> fast / walk</div>
            <div><b>1</b> T spawn, <b>2</b> CT spawn, <b>R</b> respawn</div>
            <div><b>Esc</b> release, <b>H</b> this panel</div>
            <div><b>I</b> inspect what you are looking at</div>
            <div><b>G</b> colour grade sliders</div>
            <div><b>V</b> flat view — no textures, max fps</div>
            <div class="c3-keys-demo"><b>Drop</b> an .aim4replay on the page to watch it here</div>
            <div class="c3-keys-demo"><b>1-0</b> player POV, <b>X</b> free camera</div>
            <div class="c3-keys-demo"><b>P</b> play / pause, <b>, .</b> step (Shift: half-second)</div>
            <div class="c3-keys-demo"><b>[ ]</b> previous / next round, <b>M</b> speed</div>
          </div>
          <!-- The trainer's sensitivity, on the trainer's scale and step:
               editing it here changes it for the gamemodes too. -->
          <label class="c3-sens">Sensitivity <input type="number" step="0.001" min="0.001" value="${sens}"></label>
          <div class="c3-maps"></div>
        </div>
      </div>
      <div class="c3-err" data-k="err" hidden></div>
    `;
    this.el = {};
    root.querySelectorAll('[data-k]').forEach((n) => (this.el[n.dataset.k] = n));
    this.loadBar = root.querySelector('.c3-load-bar span');
    this.loadText = root.querySelector('.c3-load-text');
    this.bootBar = root.querySelector('.c3-boot-bar span');
    this.bootText = root.querySelector('.c3-boot-text');
    /** True once the map has been revealed; the boot screen never comes back. */
    this.booted = false;
    const picker = root.querySelector('.c3-maps');
    picker.innerHTML = CS3D_MAPS.map((m) => {
      const href = m.bareRoute === false ? `/de_${m.slug}` : `/${m.slug}`;
      const cls = m.slug === map.slug ? ' class="is-active"' : '';
      return `<a href="${href}"${cls}>${esc(m.name)}</a>`;
    }).join('');
    const sensInput = root.querySelector('.c3-sens input');
    sensInput.addEventListener('change', () => onSensitivity?.(sensInput.value));
    sensInput.addEventListener('keydown', (e) => e.stopPropagation());
    this._fpsN = 0;
    this._fpsT = performance.now();
  }

  setLocked(locked) {
    this.el.enter.hidden = locked;
    this.root.classList.toggle('is-locked', locked);
  }

  toggleHelp() {
    this.el.enter.hidden = !this.el.enter.hidden;
  }

  setMode(mode) {
    this.el.mode.textContent = mode;
  }

  setBackend(name) {
    this.el.backend.textContent = name;
  }

  /** The flat view is a mode you can forget you are in; say so in the strip. */
  setFpsView(on) {
    this.el.view.textContent = on ? 'flat' : '';
  }

  /**
   * The demo roster: one row per player, digit → POV. Rebuilt on demo/round/
   * POV changes only — the per-frame part is setDemoStatus.
   * @param {Array<{slot:number,name:string,team:1|2,pov:boolean}>|null} rows
   */
  setRoster(rows) {
    const el = this.el.roster;
    if (!rows || !rows.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = rows
      .map(
        (p) =>
          `<div class="c3-r-row${p.pov ? ' is-pov' : ''} c3-r-t${esc(p.side)}">` +
          `<b>${(p.slot + 1) % 10}</b><span>${esc(p.name)}</span></div>`
      )
      .join('');
  }

  hideError() {
    this.el.err.hidden = true;
  }

  /**
   * The per-frame demo strip: round, clock, play state, speed, POV. Throttled
   * here so callers can just call it every frame.
   */
  setDemoStatus(s) {
    const el = this.el.demo;
    if (!s) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    const now = performance.now();
    if (!el.hidden && now - (this._demoAt || 0) < 100) return;
    this._demoAt = now;
    el.hidden = false;
    const sign = s.clock < 0 ? '-' : '';
    const t = Math.abs(s.clock);
    const clock = `${sign}${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    el.textContent =
      `round ${s.round}/${s.rounds}  ${clock}  ${s.atEnd ? 'end' : s.playing ? '▶' : '⏸'}` +
      (s.speed !== 1 ? ` ×${s.speed}` : '') +
      (s.pov ? `  POV ${s.pov}` : '');
  }

  /** @param {number[]} src source-space position, @param {number} speed u/s */
  setStatus(src, speed) {
    this.el.pos.textContent = `${src[0].toFixed(0)} ${src[1].toFixed(0)} ${src[2].toFixed(0)}`;
    this.el.speed.textContent = `${speed.toFixed(0)} u/s`;
  }

  tickFps() {
    this._fpsN++;
    const now = performance.now();
    if (now - this._fpsT >= 500) {
      this.el.fps.textContent = `${Math.round((this._fpsN * 1000) / (now - this._fpsT))} fps`;
      this._fpsN = 0;
      this._fpsT = now;
    }
  }

  setProgress(p) {
    // Geometry and the texture bundle stream side by side; the bar is bytes.
    const total = (p.bytesTotal || 0) + (p.texBytesTotal || 0);
    const loaded = (p.bytesLoaded || 0) + (p.texBytesLoaded || 0);
    // Both counts have to be able to finish on a degenerate pack, or the boot
    // screen never lifts: no texture bundle at all is done, and so is a pack
    // with no geometry groups — but only once the geometry phase is reached,
    // since 0 of 0 is trivially true while the manifest is still landing.
    const streaming = p.phase !== 'manifest' && p.phase !== 'phys';
    const geoDone = streaming && p.groupsLoaded >= p.groupsTotal;
    const texDone = !p.texTotal || p.texLoaded >= p.texTotal;
    if (geoDone && texDone) {
      this.el.load.classList.add('is-done');
      this.finishBoot();
      return;
    }
    const frac = total ? loaded / total : p.groupsTotal ? p.groupsLoaded / p.groupsTotal : 0;
    const pct = Math.round(frac * 100);
    this.loadBar.style.width = `${pct}%`;
    const mb = (loaded / 1e6).toFixed(0);
    const mbT = (total / 1e6).toFixed(0);
    const label =
      p.phase === 'manifest' || p.phase === 'phys'
        ? 'collision'
        : p.groupsLoaded < p.groupsTotal
          ? `${mb} / ${mbT} MB`
          : `textures ${p.texLoaded} / ${p.texTotal}`;
    this.loadText.textContent = label;
    if (!this.booted) {
      this.bootBar.style.width = `${pct}%`;
      this.bootText.textContent = `${pct}% · ${label}`;
    }
  }

  /**
   * Take the boot screen down and hand over the map.
   *
   * Half a map is worse than no map: streaming tiles in over an empty grey
   * void reads as a broken render, so nothing is shown until every tile and
   * texture is in. Also called on a load error, so the message is not stranded
   * behind an opaque panel.
   */
  finishBoot() {
    if (this.booted) return;
    this.booted = true;
    this.bootBar.style.width = '100%';
    this.el.boot.classList.add('is-done');
  }

  /**
   * The inspector panel. `rows` is a flat list of [label, value] pairs; a row
   * with no label is a section heading, and a null value is skipped, so the
   * caller can build the list without worrying about what a material happens
   * to carry.
   * @param {Array<[string, any]>|null} rows  null hides the panel
   */
  setInspect(rows) {
    const el = this.el.inspect;
    if (!rows) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = rows
      .map(([k, v]) => {
        if (v === null || v === undefined) return '';
        if (!k) return `<div class="c3-i-head">${esc(v)}</div>`;
        const sw = /^#[0-9a-f]{6}$/i.test(String(v)) ? `<i style="background:${esc(v)}"></i>` : '';
        return `<div class="c3-i-row"><span>${esc(k)}</span><b>${sw}${esc(v)}</b></div>`;
      })
      .join('');
  }

  /**
   * The grade panel: live sliders over the tone-mapping uniforms.
   *
   * Every knob is a uniform, so dragging one costs nothing but a uniform write
   * — no shader rebuild, no re-pack. The values are echoed as a query string so
   * a setting that looks right can be pasted back or shared as a URL, and kept
   * in localStorage so it survives a reload.
   *
   * @param {Array<{key:string,label:string,min:number,max:number,step:number,value:number}>} defs
   * @param {(key:string,value:number)=>void} onChange
   */
  buildGrade(defs, onChange) {
    const el = this.el.grade;
    this._gradeDefs = defs;
    this._gradeOn = onChange;
    el.innerHTML =
      `<div class="c3-g-title">Colour grade <span>G to hide</span></div>` +
      defs
        .map(
          (d) => `<label class="c3-g-row" data-key="${esc(d.key)}">
            <span>${esc(d.label)}</span>
            <input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${d.value}">
            <b>${d.value.toFixed(3)}</b>
          </label>`
        )
        .join('') +
      `<div class="c3-g-foot"><button type="button" data-act="reset">reset</button><code data-k="gradeq"></code></div>`;
    const echo = el.querySelector('[data-k="gradeq"]');
    const refresh = () => {
      echo.textContent = defs
        .map((d) => `${d.key}=${Number(el.querySelector(`[data-key="${d.key}"] input`).value)}`)
        .join('&');
    };
    el.querySelectorAll('.c3-g-row').forEach((row) => {
      const input = row.querySelector('input');
      const out = row.querySelector('b');
      const fire = () => {
        const v = Number(input.value);
        out.textContent = v.toFixed(3);
        onChange(row.dataset.key, v);
        refresh();
      };
      input.addEventListener('input', fire);
      // Arrow keys inside a slider must not also fly the camera.
      input.addEventListener('keydown', (e) => e.stopPropagation());
    });
    el.querySelector('[data-act="reset"]').addEventListener('click', () => {
      defs.forEach((d) => {
        const row = el.querySelector(`[data-key="${d.key}"]`);
        row.querySelector('input').value = d.reset;
        row.querySelector('b').textContent = Number(d.reset).toFixed(3);
        onChange(d.key, Number(d.reset));
      });
      refresh();
    });
    refresh();
  }

  toggleGrade() {
    const el = this.el.grade;
    if (!el.innerHTML) return;
    el.hidden = !el.hidden;
  }

  showError(msg) {
    this.el.err.hidden = false;
    this.el.err.textContent = msg;
    this.el.load.classList.add('is-done');
    // Whatever went wrong, the user has to be able to read it.
    this.finishBoot();
  }
}
