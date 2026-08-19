// Packed CS2 viewmodel clip names for a magazine reload, in preference order.
// Empty mag wants `reload_empty` (slide lock / charge) when the weapon ships it;
// a partial mag wants `reload`. AK and most rifles only author `reload`.

export function reloadClipAliases(empty) {
  return empty ? ['reload_empty', 'reload'] : ['reload', 'reload_empty'];
}

/** First alias present in a Set of packed clip names, or null. */
export function pickReloadClip(available, empty) {
  for (const name of reloadClipAliases(empty)) {
    if (available.has(name)) return name;
  }
  return null;
}
