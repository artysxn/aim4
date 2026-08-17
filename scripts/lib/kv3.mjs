// ---------------------------------------------------------------------------
// scripts/lib/kv3.mjs
// A reader for the KV3 text that Source2Viewer prints for a resource's DATA
// block. Enough of the format for the CS3D extractors and no more: objects,
// arrays, numbers, strings, booleans, null, and the tagged scalars KV3 uses
// for references (`resource_name:"…"`, `soundevent:"…"`, `resource:"…"`).
//
// Why a parser rather than another regex: `scripts/weapons.vdata_c` is 17k
// lines of nested prefabs where the value you want (a weapon's cycle time) is
// often inherited from a `_base` two levels up, and picking that out by
// pattern-matching lines is how you end up reading the shotgun's fire rate
// into the AWP.
//
// Not supported, because nothing here emits it: multi-line binary blobs
// (`#[ … ]`), flagged values (`resource+subclass:`), and comments inside a
// value. Blobs are skipped rather than mis-parsed.
// ---------------------------------------------------------------------------

/**
 * Parse a KV3 document (with or without the `<!-- kv3 … -->` header) into
 * plain JS values.
 */
export function parseKv3(text) {
  const src = String(text);
  let i = 0;

  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      // Line comments and the kv3 header both start with a delimiter we skip.
      if (src.startsWith('//', i)) {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i);
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i);
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      return;
    }
  };

  const fail = (msg) => {
    const line = src.slice(0, i).split('\n').length;
    throw new Error(`kv3: ${msg} at line ${line}`);
  };

  const readString = () => {
    // Triple-quoted heredoc, used for embedded keyvalue text.
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const s = src.slice(i + 3, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
      return s;
    }
    if (src[i] !== '"') fail('expected a string');
    i++;
    let out = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        i++;
        const c = src[i++];
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c;
      } else out += src[i++];
    }
    i++;
    return out;
  };

  const readValue = () => {
    ws();
    const c = src[i];
    if (c === '{') return readObject();
    if (c === '[') return readArray();
    if (c === '"') return readString();
    if (c === '#') {
      // Binary blob: skip it wholesale, it is never what a caller wants here.
      const end = src.indexOf(']', i);
      i = end < 0 ? src.length : end + 1;
      return null;
    }
    // A bare token: number, keyword, or a tagged scalar like resource_name:"…".
    const start = i;
    while (i < src.length && !/[\s,\]}]/.test(src[i])) {
      if (src[i] === ':' && src[i + 1] === '"') {
        // tag:"value" — keep the value, drop the tag.
        i++;
        return readString();
      }
      i++;
    }
    const tok = src.slice(start, i);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    const n = Number(tok);
    return Number.isNaN(n) ? tok : n;
  };

  const readArray = () => {
    i++; // [
    const out = [];
    for (;;) {
      ws();
      if (src[i] === ']') {
        i++;
        return out;
      }
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (i >= src.length) fail('unterminated array');
      out.push(readValue());
    }
  };

  const readObject = () => {
    i++; // {
    const out = {};
    for (;;) {
      ws();
      if (src[i] === '}') {
        i++;
        return out;
      }
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (i >= src.length) fail('unterminated object');
      const key = src[i] === '"' ? readString() : (() => {
        const start = i;
        while (i < src.length && !/[\s=]/.test(src[i])) i++;
        return src.slice(start, i);
      })();
      ws();
      if (src[i] !== '=') fail(`expected '=' after key "${key}"`);
      i++;
      out[key] = readValue();
    }
  };

  ws();
  // The dump may or may not wrap the document in braces.
  if (src[i] === '{') return readObject();
  const out = {};
  while (i < src.length) {
    ws();
    if (i >= src.length) break;
    const start = i;
    while (i < src.length && !/[\s=]/.test(src[i])) i++;
    const key = src.slice(start, i);
    if (!key) break;
    ws();
    if (src[i] !== '=') break;
    i++;
    out[key] = readValue();
  }
  return out;
}

/**
 * Flatten a `_base` prefab chain: fields on the entry win over fields on the
 * thing it derives from, all the way up. `table` is the whole document, keyed
 * the way `_base` names it.
 */
export function resolveBase(table, entry, seen = new Set()) {
  const base = entry?._base;
  if (!base || seen.has(base) || !table[base]) return { ...entry };
  seen.add(base);
  return { ...resolveBase(table, table[base], seen), ...entry };
}
