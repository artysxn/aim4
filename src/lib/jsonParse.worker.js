// Parse large JSON off the UI thread. The main thread still pays the structured
// clone when the result arrives, but the atomic JSON.parse spike moves here.

self.onmessage = (e) => {
  const { id, buffer } = e.data || {};
  try {
    const text = new TextDecoder().decode(buffer);
    const value = JSON.parse(text);
    self.postMessage({ id, ok: true, value });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: String(err?.message || err || 'JSON parse failed')
    });
  }
};
