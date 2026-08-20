// ---------------------------------------------------------------------------
// site/docOutline.js
// Chapters and subchapters for the documents outline. Titles (h1, 25px) are
// chapters. Headings (h2, 19px) are subchapters. h3 nests one step further.
// ---------------------------------------------------------------------------

/** Docs editor Title size. */
export const TITLE_PX = 25;
/** Docs editor Heading size. */
export const HEADING_PX = 19;

/**
 * Outline depth for a block. 0 means it is not a chapter or subchapter.
 * Tag wins over font-size so an h3 that happens to be 19px stays nested.
 *
 * @param {{ tag?: string, fontSize?: number }} block
 */
export function outlineLevel({ tag = '', fontSize = 0 }) {
  const t = String(tag || '').toUpperCase();
  if (t === 'H1') return 1;
  if (t === 'H2') return 2;
  if (t === 'H3') return 3;
  const n = Number(fontSize) || 0;
  if (n >= TITLE_PX - 1) return 1;
  if (n >= HEADING_PX - 1) return 2;
  return 0;
}

/** Inline font-size on the block, or on a wrapper span the size dropdown left. */
export function readFontSize(el) {
  if (!el || el.nodeType !== 1) return 0;
  const own = parseFloat(el.style?.fontSize || '');
  if (own > 0) return own;
  for (const node of el.children || []) {
    const n = parseFloat(node.style?.fontSize || '');
    if (n > 0) return n;
  }
  return 0;
}

/**
 * Headings in document order. Does not descend into a heading or an embed.
 *
 * @param {ParentNode} root
 * @returns {Array<{ el: Element, text: string, level: number }>}
 */
export function collectOutline(root) {
  const out = [];
  if (!root) return out;

  const walk = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute?.('data-embed')) return;
    if (node.classList?.contains('doc-embed')) return;
    const level = outlineLevel({ tag: node.tagName, fontSize: readFontSize(node) });
    if (level) {
      const text = String(node.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) out.push({ el: node, text, level });
      return;
    }
    for (const child of node.children || []) walk(child);
  };

  for (const child of root.children || []) walk(child);
  return out;
}
