// ---------------------------------------------------------------------------
// replays/eye/eyeImages.js
// The small pure parts of aim4 eye's vision: how many pictures stay in the
// conversation, and the round clock text a screenshot is asked for.
// ---------------------------------------------------------------------------

/** Pictures kept in the conversation. Older ones are dropped (their text stays), so the context does not fill with images. */
export const MAX_IMAGES = 2;

/** Keep the newest MAX_IMAGES pictures in the history; replace older ones with a note. */
export function limitImages(messages, keep = MAX_IMAGES) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    const images = m.content.filter((part) => part.type === 'image_url').length;
    if (!images) continue;
    seen += images;
    if (seen <= keep) continue;
    const text = m.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    m.content = `${text}\n[The picture was removed to save space. Take it again if you need it.]`.trim();
  }
}

/** "1:20", "80", "1.20" -> seconds left on the round clock, or null. */
export function parseClock(text) {
  const t = String(text ?? '').trim().replace('.', ':');
  if (!t) return null;
  const m = /^(\d+):(\d{1,2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export const clockLabel = (secondsLeft) => {
  const s = Math.max(0, Math.round(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

