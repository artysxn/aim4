// ---------------------------------------------------------------------------
// src/site/desktop.js
// What the site shows only inside the aim4 desktop app.
//
// The desktop app is this site in a window, plus a bridge
// (window.aim4Desktop, injected by recorder/app/src/desktop_bridge.js). In a
// browser there is no bridge and nothing here does anything. In the app:
//
//   * a "Comms recorder" entry in the sidebar, under Communication, that
//     opens the recorder window (the same .exe in its other mode)
//   * a notice when the app has found a newer build of itself, with the
//     button that installs it and restarts
// ---------------------------------------------------------------------------

export function mountDesktopExtras() {
  const app = typeof window !== 'undefined' ? window.aim4Desktop : null;
  if (!app) return;
  document.documentElement.classList.add('is-desktop-app');

  const comms = document.querySelector('.side-link[data-nav="team-comms"]');
  if (comms && !document.querySelector('[data-desktop-recorder]')) {
    const link = document.createElement('a');
    link.className = 'side-link';
    link.href = '#';
    link.dataset.desktopRecorder = '';
    link.innerHTML = '<span class="side-icon" data-icon="team-comms"></span><span class="side-label">Comms recorder</span>';
    // The same icon as Communication; the site's icon pass fills data-icon spans.
    const icon = comms.querySelector('.side-icon');
    if (icon) link.querySelector('.side-icon').innerHTML = icon.innerHTML;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      app.send({ type: 'open-recorder' });
    });
    comms.after(link);
  }

  let bar = null;
  const showUpdate = (info) => {
    const update = info?.update;
    if (!update || bar) return;
    bar = document.createElement('div');
    bar.className = 'desktop-update';
    const text = document.createElement('span');
    text.textContent = `aim4 desktop ${update.version} is available.`;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn primary btn-sm';
    go.textContent = 'Update and restart';
    go.addEventListener('click', () => {
      go.disabled = true;
      go.textContent = 'Updating…';
      app.send({ type: 'apply-update' });
    });
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'btn btn-sm';
    later.textContent = 'Later';
    later.addEventListener('click', () => bar.remove());
    bar.append(text, go, later);
    document.body.appendChild(bar);
  };
  showUpdate(app.info);
  app.on((msg) => {
    if (msg?.type === 'info') showUpdate(msg);
  });
}
