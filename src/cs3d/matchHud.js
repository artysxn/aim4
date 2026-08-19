// ---------------------------------------------------------------------------
// src/cs3d/matchHud.js
// CS2-shaped chrome on the map explorer: radar, match bar, kill feed, money,
// vitals, loadout, and a local command line on Y. Display only plus the
// console. Numbers come from practiceMatch; the explorer owns the body.
// ---------------------------------------------------------------------------

import { worldToRadar, isLowerLevel, RADAR_SIZE } from '../replays/viewer/mapCalibration.js';
import { hudRadarRotation, hudRadarScale, worldToHudRadar } from './hudRadar.js';
import { radarImage } from '../replays/shared/roundId.js';
import {
  iconImgHtml,
  isGrenade,
  isKnife,
  bareWeapon
} from '../replays/viewer/equipmentIcons.js';
import { itemByName } from './buyMenu.js';
import { nadeStem } from './practiceMatch.js';
import { PERF_HELP } from './perfToggles.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CT_SVG =
  '<svg class="c3-mh-team-svg" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-width="3"/><path fill="currentColor" d="M32 12l16 6v16c0 11-8 18-16 22-8-4-16-11-16-22V18z"/><path fill="#0c0c0c" d="M32 22l8 3v9c0 6-4 10-8 12-4-2-8-6-8-12v-9z"/></svg>';

const T_SVG =
  '<svg class="c3-mh-team-svg" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-width="3"/><path fill="currentColor" d="M32 10l5 16h17l-14 10 5 16-13-10-13 10 5-16-14-10h17z"/></svg>';

const SKULL_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1C4.4 1 2 3.6 2 7c0 1.6.6 2.8 1.4 3.7L3 13h3l.4 2h3.2l.4-2H13l-.4-2.3C13.4 9.8 14 8.6 14 7c0-3.4-2.4-6-6-6zM6 7.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm4 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4z"/></svg>';

const HELP = [
  'give <weapon>     put a gun or nade in the loadout',
  'buy <weapon>      same, but spend money',
  'ammo              refill magazines',
  'money [n]         set or print cash',
  'hp [n]            set or print health',
  'god [0|1]         ignore damage',
  'kill              suicide',
  'respawn           full health at spawn',
  'team t|ct|spec    switch side or spectate',
  'noclip            fly / walk',
  'setpos x y z      teleport (Source coords)',
  'getpos            print setpos / setang',
  'setang pitch yaw',
  'mp_restartgame    reset the local round',
  'mp_roundtime sec  set the clock',
  'mp_startmoney n   cash after restart',
  'score [t ct]      print or set the score',
  'killfeed a v [w]  push a feed row',
  'cl_showpos [0|1]  debug strip',
  'debug_sun         colour grade sliders',
  'debug_viewmodel   viewmodel placement',
  'debug_inspect     inspect under the crosshair',
  'debug_tooltips    keys overlay',
  ...PERF_HELP,
  'clear             wipe this log',
  'help              this list'
];

function formatClock(sec) {
  const sign = sec < 0 ? '-' : '';
  const t = Math.abs(sec);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

function itemLabel(name) {
  const nade = nadeStem(name);
  const row = itemByName(nade || name);
  if (row) return row.label;
  const bare = bareWeapon(name);
  return bare || '';
}

function sideClass(side) {
  return side === 'CT' ? 'is-ct' : 'is-t';
}

/**
 * @param {object} o
 * @param {HTMLElement} o.root
 * @param {{code:string,name:string}} o.map
 * @param {ReturnType<import('./practiceMatch.js').createPracticeMatch>} o.match
 * @param {object} o.hooks
 */
export function createMatchHud({ root, map, match, hooks = {} }) {
  const el = document.createElement('div');
  el.className = 'c3-mh';
  el.innerHTML = `
    <div class="c3-mh-radar" data-k="radar">
      <canvas width="256" height="256"></canvas>
    </div>
    <div class="c3-mh-match">
      <div class="c3-mh-lives" data-k="lives-ct" data-side="CT"></div>
      <div class="c3-mh-clock-wrap">
        <div class="c3-mh-clock" data-k="clock">1:55</div>
        <div class="c3-mh-score"><span data-k="scoreCt">0</span><span data-k="scoreT">0</span></div>
      </div>
      <div class="c3-mh-lives" data-k="lives-t" data-side="T"></div>
    </div>
    <div class="c3-mh-feed" data-k="feed" aria-live="polite"></div>
    <div class="c3-mh-money" data-k="money">$16000</div>
    <div class="c3-mh-vitals">
      <div class="c3-mh-hp" data-k="hp">100</div>
      <div class="c3-mh-badge">
        <div class="c3-mh-kills" data-k="kills"></div>
        <div class="c3-mh-team" data-k="team">${T_SVG}</div>
      </div>
      <div class="c3-mh-ammo">
        <div class="c3-mh-wpn" data-k="wpn"></div>
        <div class="c3-mh-clip" data-k="clip"></div>
      </div>
    </div>
    <div class="c3-mh-loadout" data-k="loadout"></div>
    <div class="c3-mh-cam" data-k="cam">
      <div class="c3-mh-spec" data-k="spec" hidden></div>
      <div class="c3-mh-play" data-k="play" hidden>
        <button type="button" data-act="pause">Pause</button>
        <button type="button" data-act="restart">Restart</button>
        <button type="button" data-act="exit">Exit</button>
      </div>
      <div class="c3-mh-seg" role="group" aria-label="Side">
        <button type="button" class="c3-mh-seg-btn" data-cam="T">T</button>
        <button type="button" class="c3-mh-seg-btn" data-cam="CT">CT</button>
        <button type="button" class="c3-mh-seg-btn" data-cam="spectate">Spectate</button>
      </div>
    </div>
    <div class="c3-mh-chat" data-k="chat" hidden>
      <div class="c3-mh-log" data-k="log"></div>
      <form class="c3-mh-form" data-k="form" autocomplete="off">
        <span>Y</span>
        <input type="text" data-k="input" maxlength="240" spellcheck="false" aria-label="Command">
      </form>
    </div>
  `;
  root.appendChild(el);
  root.classList.add('is-match');

  const node = {};
  el.querySelectorAll('[data-k]').forEach((n) => (node[n.dataset.k] = n));
  const canvas = node.radar.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const input = node.input;
  const form = node.form;

  const radarImgs = { default: new Image(), lower: new Image() };
  const defaultSrc = radarImage(map.code, 'default');
  const lowerSrc = radarImage(map.code, 'lower');
  if (defaultSrc) radarImgs.default.src = defaultSrc;
  if (lowerSrc && lowerSrc !== defaultSrc) radarImgs.lower.src = lowerSrc;

  let chatOpen = false;
  let lastGen = -1;
  let lastClock = '';
  let lastOverlayKey = '';
  const _pt = {};
  let peekTimer = 0;
  let camMode = 'T';

  node.cam.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cam]');
    if (btn) {
      hooks.onCamMode?.(btn.dataset.cam);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) hooks.onPlayback?.(act);
  });

  function setCamMode(mode) {
    camMode = mode === 'CT' || mode === 'spectate' ? mode : 'T';
    node.cam.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('is-on', b.dataset.cam === camMode));
  }
  setCamMode('T');

  function setSpectateName(name) {
    const on = camMode === 'spectate';
    node.spec.hidden = !on;
    if (on) node.spec.textContent = `spectating (${name || 'Bot'})`;
  }

  function setPlayback(on, playing) {
    node.play.hidden = !on;
    const pause = node.play.querySelector('[data-act="pause"]');
    if (pause) pause.textContent = playing ? 'Pause' : 'Play';
  }

  function setChat(open) {
    clearTimeout(peekTimer);
    chatOpen = !!open;
    node.chat.hidden = !chatOpen;
    node.form.hidden = false;
    node.chat.classList.toggle('is-open', chatOpen);
    hooks.onChatToggle?.(chatOpen);
    if (chatOpen) {
      input.value = '';
      requestAnimationFrame(() => input.focus());
    } else {
      input.blur();
    }
  }

  function peekLog() {
    if (chatOpen) return;
    node.form.hidden = true;
    node.chat.hidden = false;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      if (chatOpen) return;
      node.chat.hidden = true;
      node.form.hidden = false;
    }, 2500);
  }

  function logLine(text, kind = 'out') {
    const row = document.createElement('div');
    row.className = `c3-mh-line is-${kind}`;
    row.textContent = text;
    node.log.appendChild(row);
    while (node.log.childNodes.length > 40) node.log.firstChild.remove();
    node.log.scrollTop = node.log.scrollHeight;
  }

  function squares(alive, self) {
    const bits = [];
    for (let i = 0; i < 5; i++) {
      const on = i < alive;
      const me = self && i === 0 && on;
      bits.push(`<i class="${on ? 'is-on' : ''}${me ? ' is-self' : ''}"></i>`);
    }
    return bits.join('');
  }

  function syncStatic(snap, extra) {
    node.money.textContent = `$${snap.money}`;
    node.hp.textContent = String(snap.hp);
    node.hp.classList.toggle('is-low', snap.hp > 0 && snap.hp <= 20);
    node.hp.classList.toggle('is-dead', snap.dead);
    node.team.innerHTML = snap.side === 'CT' ? CT_SVG : T_SVG;
    node.team.className = `c3-mh-team ${sideClass(snap.side)}`;
    node.kills.innerHTML = Array.from({ length: snap.roundKills }, () => SKULL_SVG).join('');
    node.scoreCt.textContent = String(extra.scoreCt ?? snap.scoreCt);
    node.scoreT.textContent = String(extra.scoreT ?? snap.scoreT);
    const ctAlive = extra.ctAlive ?? (snap.side === 'CT' && !snap.dead ? 1 : 0);
    const tAlive = extra.tAlive ?? (snap.side === 'T' && !snap.dead ? 1 : 0);
    node['lives-ct'].innerHTML = squares(ctAlive, snap.side === 'CT');
    node['lives-t'].innerHTML = squares(tAlive, snap.side === 'T');
    node['lives-ct'].dataset.count = String(ctAlive);
    node['lives-t'].dataset.count = String(tAlive);

    const gun = snap.held;
    const showAmmo = gun && !isKnife(gun) && !isGrenade(gun) && snap.clip !== '' && snap.clip != null;
    node.wpn.textContent = itemLabel(gun);
    node.clip.textContent = showAmmo ? `${snap.clip} | ${snap.reserve}` : '';

    const held = snap.held;
    const util = snap.nades.map(
      (n) =>
        `<span class="c3-mh-slot${held === n ? ' is-held' : ''}">${iconImgHtml(n, 'c3-mh-ico')}</span>`
    );
    node.loadout.innerHTML =
      (snap.primary
        ? `<span class="c3-mh-slot${held === snap.primary ? ' is-held' : ''}">${iconImgHtml(snap.primary, 'c3-mh-ico')}</span>`
        : '') +
      (snap.pistol
        ? `<span class="c3-mh-slot${held === snap.pistol ? ' is-held' : ''}">${iconImgHtml(snap.pistol, 'c3-mh-ico')}</span>`
        : '') +
      `<span class="c3-mh-slot${isKnife(held) ? ' is-held' : ''}">${iconImgHtml(snap.knife || 'knife', 'c3-mh-ico')}</span>` +
      (util.length ? `<span class="c3-mh-util">${util.join('')}</span>` : '');

    node.feed.innerHTML = snap.kills
      .slice(-6)
      .map(
        (k) =>
          `<div class="c3-mh-kill">` +
          `<b class="${sideClass(k.killerSide)}">${esc(k.killer)}</b>` +
          `<span class="c3-mh-kill-w">${iconImgHtml(k.weapon, 'c3-mh-ico') || esc(itemLabel(k.weapon) || k.weapon)}</span>` +
          `<b class="${sideClass(k.victimSide)}">${esc(k.victim)}</b>` +
          `</div>`
      )
      .join('');
  }

  function drawRadar(src, yawDeg, marks) {
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, cx - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(8,8,8,0.92)';
    ctx.fillRect(0, 0, size, size);
    const lower = src && isLowerLevel(map.code, src[2]);
    const img = lower && radarImgs.lower.naturalWidth ? radarImgs.lower : radarImgs.default;
    const origin = { x: 0, y: 0 };
    if (src) worldToRadar(map.code, src[0], src[1], origin);
    if (img.naturalWidth && src) {
      const scale = hudRadarScale(map.code, size);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(hudRadarRotation(yawDeg));
      ctx.drawImage(
        img,
        -origin.x * scale,
        -origin.y * scale,
        RADAR_SIZE * scale,
        RADAR_SIZE * scale
      );
      ctx.restore();
    } else if (img.naturalWidth) {
      ctx.drawImage(img, 0, 0, size, size);
    }
    ctx.fillStyle = 'rgba(220,220,220,0.1)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const half = (90 * Math.PI) / 360;
    ctx.arc(cx, cy, cx - 2, -Math.PI / 2 - half, -Math.PI / 2 + half);
    ctx.closePath();
    ctx.fill();
    const dots = marks && marks.length ? marks : [];
    for (const d of dots) {
      if (d.self) continue;
      worldToHudRadar(map.code, d.x, d.y, origin, yawDeg, size, _pt);
      ctx.beginPath();
      ctx.fillStyle = d.side === 'CT' ? '#6ea2f0' : '#e0b15a';
      ctx.arc(_pt.x, _pt.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (src) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(245,227,106,0.28)';
      ctx.moveTo(cx, cy - 11);
      ctx.lineTo(cx + 7, cy + 2);
      ctx.lineTo(cx - 7, cy + 2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = '#f5e36a';
      ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.moveTo(cx, cy - 9);
      ctx.lineTo(cx + 3.6, cy - 1.5);
      ctx.lineTo(cx - 3.6, cy - 1.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, cx - 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#c4a43a';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function runLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return;
    logLine(raw, 'in');
    const parts = raw.replace(/^\//, '').split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    const out = dispatch(cmd, args);
    if (out === false) return;
    if (Array.isArray(out)) out.forEach((l) => logLine(l));
    else if (out) logLine(out);
  }

  function resolveWeapon(raw) {
    if (!raw) return '';
    const nade = nadeStem(raw);
    if (nade) return nade;
    const bare = bareWeapon(raw);
    if (itemByName(bare) || isKnife(bare)) return isKnife(bare) ? 'knife' : bare;
    return '';
  }

  function dispatch(cmd, args) {
    const st = match.state;
    switch (cmd) {
      case 'help':
        return HELP.slice();
      case 'clear':
        node.log.innerHTML = '';
        return false;
      case 'give': {
        const w = resolveWeapon(args[0]);
        if (!w) return 'unknown weapon';
        const r = match.give(w);
        if (!r.ok) return r.reason.replace(/_/g, ' ');
        hooks.onEquip?.(r.name);
        return `gave ${itemLabel(r.name)}`;
      }
      case 'buy': {
        const w = resolveWeapon(args[0]);
        if (!w) return 'unknown weapon';
        const r = match.buy(w);
        if (!r.ok) return r.reason.replace(/_/g, ' ');
        hooks.onEquip?.(r.name);
        return `bought ${itemLabel(r.name)} for $${r.price}`;
      }
      case 'ammo':
      case 'giveammo':
        match.refillAmmo();
        return 'ammo refilled';
      case 'reload':
        if (!match.beginReload()) return `${match.ammoOf(match.held).clip} in mag`;
        hooks.onReload?.();
        return 'reloading';
      case 'money':
        if (args[0] == null) return `$${st.money}`;
        return `$${match.setMoney(args[0])}`;
      case 'hp':
      case 'health':
        if (args[0] == null) return `hp ${st.hp}`;
        return `hp ${match.setHp(args[0])}`;
      case 'god': {
        const next = args[0] == null ? !st.god : args[0] !== '0';
        return match.setGod(next) ? 'god on' : 'god off';
      }
      case 'kill':
        match.suicide();
        hooks.onDied?.();
        return 'slain';
      case 'respawn':
        match.respawn();
        hooks.onRespawn?.();
        return 'respawned';
      case 'team':
      case 'jointeam': {
        const s = String(args[0] || '').toLowerCase();
        const side =
          s === 'ct' || s === '2'
            ? 'CT'
            : s === 't' || s === '1'
              ? 'T'
              : s === 'spec' || s === 'spectate' || s === '3'
                ? 'spectate'
                : '';
        if (!side) return 'team t|ct|spec';
        if (side === 'spectate') hooks.onCamMode?.('spectate');
        else hooks.onSide?.(side);
        return `team ${side}`;
      }
      case 'noclip':
      case 'fly':
        hooks.onNoclip?.();
        return 'toggled noclip';
      case 'walk':
        hooks.onWalk?.();
        return 'walk';
      case 'setpos': {
        const x = Number(args[0]);
        const y = Number(args[1]);
        const z = Number(args[2]);
        if (![x, y, z].every(Number.isFinite)) return 'setpos x y z';
        hooks.onSetpos?.(x, y, z);
        return `setpos ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`;
      }
      case 'getpos':
        return hooks.onGetpos?.() || 'no position';
      case 'setang': {
        const pitch = Number(args[0]);
        const yaw = Number(args[1]);
        if (![pitch, yaw].every(Number.isFinite)) return 'setang pitch yaw';
        hooks.onSetang?.(pitch, yaw);
        return `setang ${pitch.toFixed(1)} ${yaw.toFixed(1)}`;
      }
      case 'mp_restartgame':
      case 'restart':
        match.restart();
        hooks.onRestart?.();
        return 'round reset';
      case 'mp_roundtime':
        if (args[0] == null) return `roundtime ${st.roundTime}`;
        match.setClock(Number(args[0]));
        return `roundtime ${match.state.roundTime}`;
      case 'mp_startmoney':
        if (args[0] == null) return `startmoney ${st.startMoney}`;
        st.startMoney = Math.max(0, Math.round(Number(args[0]) || 0));
        return `startmoney ${st.startMoney}`;
      case 'score':
        if (args.length >= 2) match.setScore(args[0], args[1]);
        return `${match.state.scoreCt} / ${match.state.scoreT}`;
      case 'killfeed': {
        const killer = args[0] || st.name;
        const victim = args[1] || 'BOT';
        const weapon = resolveWeapon(args[2]) || match.held || 'ak47';
        match.addKill({ killer, victim, weapon });
        return `${killer} + ${victim}`;
      }
      case 'cl_showpos': {
        const next = args[0] == null ? !st.showPos : args[0] !== '0';
        st.showPos = next;
        hooks.onShowPos?.(next);
        return `cl_showpos ${next ? 1 : 0}`;
      }
      case 'debug_sun':
        hooks.onDebugSun?.();
        return 'debug_sun';
      case 'debug_viewmodel':
        hooks.onDebugViewmodel?.();
        return 'debug_viewmodel';
      case 'debug_inspect':
        hooks.onDebugInspect?.();
        return 'debug_inspect';
      case 'debug_tooltips': {
        const on = hooks.onDebugTooltips?.();
        return `debug_tooltips ${on ? 1 : 0}`;
      }
      case 'sv_cheats':
        return 'cheats are on';
      default: {
        const extra = hooks.onCommand?.(cmd, args);
        if (extra !== undefined && extra !== null) return extra;
        return `unknown command: ${cmd}`;
      }
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const line = input.value;
    input.value = '';
    runLine(line);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Escape') {
      e.preventDefault();
      setChat(false);
    }
  });

  const api = {
    el,
    get chatOpen() {
      return chatOpen;
    },
    openChat() {
      setChat(true);
    },
    closeChat() {
      setChat(false);
    },
    toggleChat() {
      setChat(!chatOpen);
    },
    echo(text, kind) {
      logLine(text, kind);
      peekLog();
    },
    /**
     * @param {object} frame
     * @param {number[]} [frame.src]  Source x y z
     * @param {number} [frame.yaw]    Source yaw degrees
     * @param {Array} [frame.marks]   extra radar dots
     * @param {number} [frame.clock]  override seconds
     * @param {number} [frame.ctAlive]
     * @param {number} [frame.tAlive]
     * @param {number} [frame.scoreCt]
     * @param {number} [frame.scoreT]
     * @param {object} [frame.overlay]  spectate vitals; replaces local snap fields
     */
    update(frame = {}) {
      match.pruneKills();
      const base = match.snapshot();
      const snap = frame.overlay ? { ...base, ...frame.overlay, gen: base.gen } : base;
      const clockSrc = frame.clock != null ? frame.clock : snap.clock;
      const clock = formatClock(clockSrc);
      if (clock !== lastClock) {
        lastClock = clock;
        node.clock.textContent = clock;
      }
      const overlayKey = frame.overlay
        ? `${snap.hp}|${snap.held}|${snap.money}|${snap.dead}|${snap.side}|${(snap.nades || []).join(',')}`
        : '';
      if (snap.gen !== lastGen || overlayKey !== lastOverlayKey) {
        lastGen = snap.gen;
        lastOverlayKey = overlayKey;
        syncStatic(snap, frame);
      }
      drawRadar(frame.src, frame.yaw, frame.marks);
    },
    setCamMode,
    setSpectateName,
    setPlayback
  };

  api.update();
  return api;
}
