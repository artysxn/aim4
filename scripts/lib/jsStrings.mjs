// ---------------------------------------------------------------------------
// scripts/lib/jsStrings.mjs
// A scanner that finds the string and template literals in a JS file, and
// nothing else.
//
// The i18n extractor cannot use a regex sweep over the raw source, because this
// codebase comments more than most: every module opens with a paragraph of
// English prose explaining why it exists, and half of those paragraphs contain
// quotation marks. A naive scan pulls "what happened since I was here" out of
// homeView's header comment and asks somebody to translate it.
//
// So this walks the file one character at a time, tracking whether it is in a
// line comment, a block comment, a quoted string, a template literal or a
// regular expression, and reports only the literals. There is no JS parser in
// this repo's dependencies and adding one for this would be a large tail to
// wag a small dog.
//
// The one genuinely ambiguous case is `/`: division or the start of a regex.
// The rule below is the usual one, and it only has to be right often enough
// that no string is missed or invented, which it is.
// ---------------------------------------------------------------------------

const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'
]);

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'do',
  'else', 'yield', 'await'
]);

function regexAllowed(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if (REGEX_PRECEDERS.has(c)) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return REGEX_KEYWORDS.has(src.slice(k + 1, j + 1));
  }
  return false;
}

/**
 * Every literal in a file.
 *
 * A quoted string comes back as `{kind:'string', value}` with escapes resolved.
 * A template comes back as `{kind:'template', parts, exprs}`, where `parts` are
 * the literal chunks and `exprs` the raw source of each `${…}` between them —
 * the extractor needs the expression text to decide what kind of slot it is.
 * `parts.length === exprs.length + 1` always.
 *
 * @param {string} src
 * @returns {Array<{kind: string, value?: string, parts?: string[], exprs?: string[], line: number}>}
 */
export function scanLiterals(src) {
  const out = [];
  const lineAt = (idx) => {
    let n = 1;
    for (let k = 0; k < idx; k++) if (src[k] === '\n') n++;
    return n;
  };
  // One pass building a line table beats counting newlines per literal.
  const lines = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lines.push(k + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  void lineAt;

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && regexAllowed(src, i)) {
      let j = i + 1;
      let cls = false;
      let ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) { ok = true; break; }
        j++;
      }
      if (ok) {
        i = j + 1;
        while (i < n && /[dgimsuvy]/.test(src[i])) i++;
        continue;
      }
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      const start = i;
      const quote = c;
      let value = '';
      i++;
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          value += unescape(src, i);
          i += escapeLength(src, i);
          continue;
        }
        if (d === quote) { i++; break; }
        if (d === '\n') break; // unterminated; bail rather than run away
        value += d;
        i++;
      }
      out.push({ kind: 'string', value, line: lineOf(start) });
      continue;
    }

    if (c === '`') {
      const start = i;
      i++;
      const parts = [];
      const exprs = [];
      let cur = '';
      let closed = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          cur += unescape(src, i);
          i += escapeLength(src, i);
          continue;
        }
        if (d === '`') { i++; closed = true; break; }
        if (d === '$' && src[i + 1] === '{') {
          parts.push(cur);
          cur = '';
          const from = i + 2;
          i = skipExpression(src, from);
          exprs.push(src.slice(from, i));
          i++; // the closing brace
          continue;
        }
        cur += d;
        i++;
      }
      parts.push(cur);
      if (closed) out.push({ kind: 'template', parts, exprs, line: lineOf(start) });
      continue;
    }

    i++;
  }
  return out;
}

/** Length in source characters of the escape sequence beginning at `i`. */
function escapeLength(src, i) {
  const c = src[i + 1];
  if (c === 'u') return src[i + 2] === '{' ? src.indexOf('}', i) - i + 1 : 6;
  if (c === 'x') return 4;
  return 2;
}

/** What an escape sequence beginning at `i` actually stands for. */
function unescape(src, i) {
  const c = src[i + 1];
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    case 'v': return '\v';
    case '0': return '\0';
    case '\n': return '';
    case 'u': {
      if (src[i + 2] === '{') {
        const end = src.indexOf('}', i);
        return String.fromCodePoint(parseInt(src.slice(i + 3, end), 16) || 0);
      }
      return String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16) || 0);
    }
    case 'x':
      return String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16) || 0);
    default:
      return c;
  }
}

/**
 * Walk to the `}` that closes a `${` opened just before `from`, honouring
 * nested braces, strings and templates inside the expression.
 */
function skipExpression(src, from) {
  let depth = 1;
  let i = from;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    } else if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (c === '`') {
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          i = skipExpression(src, i + 2) + 1;
          continue;
        }
        i++;
      }
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    }
    i++;
  }
  return n;
}
