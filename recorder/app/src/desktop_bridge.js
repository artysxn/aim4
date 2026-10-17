// The aim4 desktop app's bridge into the page. Injected before the site's own
// scripts on every page load of the app's window, never into a browser.
//
//   window.aim4Desktop.info              latest state from the app
//   window.aim4Desktop.send({ type })    ask the app for something
//   window.aim4Desktop.on(fn)            hear back (also a window 'aim4-desktop' event)
//
// Messages to the app: get-info, eye-link {token}, eye-unlink, open-recorder,
// open-external {url}, check-update, apply-update.
(() => {
  if (window.aim4Desktop) return;
  const listeners = new Set();
  const api = {
    version: '__VERSION__',
    platform: '__PLATFORM__',
    info: null,
    send(msg) {
      window.ipc.postMessage(JSON.stringify(msg));
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
  Object.defineProperty(window, '__aim4DesktopPush', {
    value(msg) {
      if (msg && msg.type === 'info') api.info = msg;
      for (const fn of listeners) {
        try {
          fn(msg);
        } catch (err) {
          console.error(err);
        }
      }
      window.dispatchEvent(new CustomEvent('aim4-desktop', { detail: msg }));
    }
  });
  Object.defineProperty(window, 'aim4Desktop', { value: api });
  api.send({ type: 'get-info' });
})();
