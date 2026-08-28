// ---------------------------------------------------------------------------
// Stratbook note markup.
// Adjacent tags share one label: <Smoke top car><!iDiD><URL=https://…>
// <!id> copies that throw's setpos. URL= opens in a new tab. Both run on click.
// ---------------------------------------------------------------------------

const TAG = /<([^<>]+)>/g;

export function classifyTag(inner) {
  const s = String(inner || '').trim();
  const url = s.match(/^URL=(.+)$/i);
  if (url) return { kind: 'url', value: url[1].trim() };
  const util = s.match(/^!([A-Za-z0-9]{4})$/);
  if (util) return { kind: 'util', value: util[1] };
  return { kind: 'label', value: s };
}

export function safeHref(raw) {
  const u = String(raw || '').trim();
  if (!u) return '';
  if (u.startsWith('/') && !u.startsWith('//')) return u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {
    /* ignore */
  }
  return '';
}

export function utilArchiveHref(id, map = '') {
  const q = new URLSearchParams();
  if (map) q.set('map', String(map).toUpperCase());
  q.set('u', id);
  return `/team/utility-archive?${q}`;
}

/**
 * Consume one run of adjacent tags starting at `ti`.
 * A link is a label plus a throw id and/or a URL, in any order.
 */
export function takeLinkCluster(tags, ti, text) {
  const first = tags[ti];
  const parts = { label: '', util: '', url: '' };
  const assign = (t) => {
    if (t.kind === 'label') {
      if (parts.label) return false;
      parts.label = t.value;
      return true;
    }
    if (t.kind === 'util') {
      if (parts.util) return false;
      parts.util = t.value;
      return true;
    }
    if (t.kind === 'url') {
      if (parts.url) return false;
      parts.url = t.value;
      return true;
    }
    return false;
  };
  assign(first);
  let i = ti + 1;
  let end = first.end;
  while (i < tags.length) {
    const between = text.slice(tags[i - 1].end, tags[i].start);
    if (between.trim() !== '') break;
    if (!assign(tags[i])) break;
    end = tags[i].end;
    i += 1;
  }
  const linked = Boolean(parts.util || parts.url);
  if (!linked) {
    return { linked: false, consumed: 1, start: first.start, end: first.end, parts };
  }
  return { linked: true, consumed: i - ti, start: first.start, end, parts };
}

/**
 * Walk a note, handing every link cluster to `clusterHtml` and escaping the
 * rest. The two renderers below differ only in what a cluster becomes.
 *
 * @param {string} raw
 * @param {{ escapeHtml: (s: string) => string }} opts
 * @param {(parts: {label: string, util: string, url: string}) => string} clusterHtml
 */
function walkStratNote(raw, { escapeHtml }, clusterHtml) {
  const text = String(raw || '');
  const tags = [];
  TAG.lastIndex = 0;
  let m;
  while ((m = TAG.exec(text))) {
    tags.push({
      start: m.index,
      end: m.index + m[0].length,
      ...classifyTag(m[1])
    });
  }

  let out = '';
  let i = 0;
  let ti = 0;
  while (i < text.length) {
    const tag = tags[ti];
    if (!tag || tag.start > i) {
      const next = tag ? tag.start : text.length;
      out += escapeHtml(text.slice(i, next));
      i = next;
      continue;
    }
    const cluster = takeLinkCluster(tags, ti, text);
    if (cluster.linked) {
      out += clusterHtml(cluster.parts);
    } else {
      out += escapeHtml(text.slice(cluster.start, cluster.end));
    }
    i = cluster.end;
    ti += cluster.consumed;
  }
  return out;
}

/**
 * @param {string} raw
 * @param {{ escapeHtml: (s: string) => string }} opts
 */
export function renderStratNoteLinks(raw, opts) {
  const { escapeHtml } = opts;
  return walkStratNote(raw, opts, (parts) => {
    const href = parts.url ? safeHref(parts.url) : '';
    const label = parts.label || parts.util || href || parts.url || '';
    const copy = parts.util || '';
    const copyAttr = copy ? ` data-ua-copy="${escapeHtml(copy)}"` : '';
    if (href) {
      return `<a class="ua-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${copyAttr}>${escapeHtml(
        label
      )}</a>`;
    }
    if (copy) {
      return `<button type="button" class="ua-link"${copyAttr}>${escapeHtml(label)}</button>`;
    }
    return escapeHtml(label);
  });
}

/**
 * The same note inside a team document.
 *
 * A document has no stratbook around it, so a `<!id>` cannot copy a setpos on
 * click. It becomes a link into the utility archive entry instead, which is
 * where a reader goes to get the lineup. Anything the documents sanitizer
 * would strip is not emitted: plain anchors and text, nothing else.
 *
 * @param {string} raw
 * @param {{ escapeHtml: (s: string) => string, mapCode?: string }} opts
 */
export function stratNoteToDocHtml(raw, { escapeHtml, mapCode = '' }) {
  return walkStratNote(raw, { escapeHtml }, (parts) => {
    const href = parts.util
      ? utilArchiveHref(parts.util, mapCode)
      : parts.url
        ? safeHref(parts.url)
        : '';
    const label = parts.label || parts.util || parts.url || '';
    if (!href) return escapeHtml(label);
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
}
