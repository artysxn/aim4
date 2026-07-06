// Shared shoot / input bind codes: `Mouse0` (left), `Mouse1` (middle), `Mouse2`
// (right), or a KeyboardEvent.code string (`KeyE`, `Space`, …).

export const DEFAULT_SHOOT_BIND = 'Mouse0';

export function getShootBind(settings) {
  return settings?.data?.weapon?.shootBind || DEFAULT_SHOOT_BIND;
}

export function bindLabel(code) {
  if (!code) return '—';
  if (code === 'Mouse0') return 'Left click';
  if (code === 'Mouse1') return 'Middle click';
  if (code === 'Mouse2') return 'Right click';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

export function mouseButtonFromBind(bind) {
  if (bind?.startsWith('Mouse')) {
    const n = parseInt(bind.slice(5), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function isKeyboardBind(bind) {
  return !!bind && !bind.startsWith('Mouse');
}

export function bindFromMouseButton(button) {
  return `Mouse${button}`;
}

export function matchesMouseBind(bind, button) {
  return mouseButtonFromBind(bind) === button;
}
