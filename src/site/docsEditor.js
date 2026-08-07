// ---------------------------------------------------------------------------
// site/docsEditor.js
// The team document editor: a contenteditable surface with the formatting a
// strat doc actually needs.
//
// Text size and line gap, bold / italic / underline, horizontal rules, links,
// Tab / Shift+Tab block indent (multiple levels), bullet lists from "* ",
// dashed lists from "- ", numbered lists from "1. ", and paste that keeps or
// drops formatting. Everything is stored as HTML and sanitized on the way in
// and out, because the same document is rendered for every member of the team.
// ---------------------------------------------------------------------------

const SIZES = [
  { key: '13', label: 'Small' },
  { key: '15', label: 'Normal' },
  { key: '19', label: 'Heading' },
  { key: '25', label: 'Title' }
];

const GAPS = [
  { key: '1.35', label: 'Tight' },
  { key: '1.7', label: 'Normal' },
  { key: '2.1', label: 'Wide' }
];

/** Pixels per Tab indent step on a paragraph. */
const INDENT_STEP_PX = 36;
/** Cap so a runaway Tab mash cannot push content off-screen. */
const INDENT_MAX_LEVEL = 12;

/** Tags a stored document may contain. Anything else is unwrapped. */
const ALLOWED = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'A', 'P', 'DIV', 'BR', 'HR', 'UL', 'OL', 'LI',
  'SPAN', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'CODE', 'PRE', 'IMG'
]);

/** Inline styles worth keeping. Everything else is dropped on save. */
const SAFE_STYLE = /^(font-size|line-height|font-weight|font-style|text-decoration|text-align|margin-left|padding-left)$/;

/**
 * Strip a document down to the tags and styles above. Runs on load and on
 * save: pasted HTML from anywhere gets the same treatment as stored HTML.
 */
export function sanitizeHtml(html) {
  const host = document.createElement('div');
  host.innerHTML = String(html || '');

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }
      const el = /** @type {HTMLElement} */ (child);
      if (!ALLOWED.has(el.tagName)) {
        // Keep the words, drop the wrapper.
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        el.remove();
        continue;
      }
      // Images carry only an embedded data URI (antistrat heatmaps). A remote
      // src would leak reader IPs to whoever controls the host, so it is not
      // an allowed shape at all.
      if (el.tagName === 'IMG') {
        const src = String(el.getAttribute('src') || '');
        if (!/^data:image\/(png|jpeg|webp);base64,/i.test(src)) {
          el.remove();
          continue;
        }
        const alt = el.getAttribute('alt') || '';
        for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
        el.setAttribute('src', src);
        if (alt) el.setAttribute('alt', alt);
        continue;
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name === 'href' && el.tagName === 'A') {
          const href = attr.value.trim();
          // http(s), mailto, in-document anchors and same-origin paths
          // (antistrat round links). No javascript: links.
          if (!/^(https?:|mailto:|#|\/[^/])/i.test(href)) el.removeAttribute('href');
          else if (!href.startsWith('#') && !href.startsWith('/')) {
            el.setAttribute('rel', 'noopener noreferrer');
            el.setAttribute('target', '_blank');
          }
          continue;
        }
        if (name === 'style') {
          const kept = [];
          for (const rule of attr.value.split(';')) {
            const [prop, value] = rule.split(':').map((s) => (s || '').trim());
            if (prop && value && SAFE_STYLE.test(prop.toLowerCase())) {
              kept.push(`${prop}: ${value}`);
            }
          }
          if (kept.length) el.setAttribute('style', kept.join('; '));
          else el.removeAttribute('style');
          continue;
        }
        if (name === 'id') {
          // Chrome's insertHorizontalRule leaves id="null" behind. Keep only
          // ids that could actually be an in-document link target.
          if (!/^[A-Za-z][\w-]*$/.test(attr.value) || attr.value === 'null') {
            el.removeAttribute('id');
          }
          continue;
        }
        if (name === 'rel' || name === 'target') continue;
        el.removeAttribute(attr.name);
      }
      walk(el);
    }
  };

  walk(host);
  hoistLists(host);
  return host.innerHTML;
}

/**
 * A list inside a paragraph is invalid HTML: the browser closes the <p> when
 * re-parsing, which reorders the document. execCommand produces this shape on
 * some engines, so it is repaired rather than trusted.
 */
function hoistLists(host) {
  for (let guard = 0; guard < 20; guard++) {
    const nested = host.querySelector('p > ul, p > ol, li > p');
    if (!nested) return;
    if (nested.tagName === 'P') {
      // <li><p>text</p></li> -> <li>text</li>
      const li = nested.parentNode;
      while (nested.firstChild) li.insertBefore(nested.firstChild, nested);
      nested.remove();
      continue;
    }
    const para = nested.parentNode;
    para.parentNode.insertBefore(nested, para.nextSibling);
    if (!para.textContent.trim() && !para.querySelector('br, hr')) para.remove();
  }
}

const exec = (cmd, value = null) => document.execCommand(cmd, false, value);

/**
 * @param {{
 *   escapeHtml: (s: string) => string,
 *   onSave: (html: string) => Promise<void> | void,
 *   onDirty?: () => void
 * }} deps
 */
export function createDocsEditor({ escapeHtml, onSave, onDirty }) {
  const el = document.createElement('div');
  el.className = 'doc-editor';
  el.innerHTML = `
    <div class="doc-toolbar" id="doc-toolbar">
      <div class="doc-tool-group">
        <select class="site-select doc-size" data-size aria-label="Text size">
          ${SIZES.map((s) => `<option value="${s.key}"${s.key === '15' ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
        </select>
        <select class="site-select doc-gap" data-gap aria-label="Line gap">
          ${GAPS.map((g) => `<option value="${g.key}"${g.key === '1.7' ? ' selected' : ''}>${escapeHtml(g.label)}</option>`).join('')}
        </select>
      </div>
      <div class="doc-tool-group">
        <button type="button" class="doc-tool" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button type="button" class="doc-tool" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button type="button" class="doc-tool" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
      </div>
      <div class="doc-tool-group">
        <button type="button" class="doc-tool" data-cmd="insertUnorderedList" title="Bullet list">&bull;</button>
        <button type="button" class="doc-tool" data-cmd="insertOrderedList" title="Numbered list">1.</button>
        <button type="button" class="doc-tool" data-rule title="Horizontal line">&mdash;</button>
        <button type="button" class="doc-tool" data-link title="Link (Ctrl+K)">&#128279;</button>
        <button type="button" class="doc-tool" data-unlink title="Remove link">&#9003;</button>
      </div>
      <div class="doc-tool-group">
        <button type="button" class="doc-tool" data-paste-plain title="Paste without formatting (Ctrl+Shift+V)">T</button>
        <button type="button" class="doc-tool" data-clear title="Clear formatting">A</button>
      </div>
      <span class="doc-saved" id="doc-saved"></span>
    </div>
    <div class="doc-page">
      <div class="doc-surface" id="doc-surface" contenteditable="true" spellcheck="true"></div>
    </div>`;

  const surface = el.querySelector('#doc-surface');
  const savedEl = el.querySelector('#doc-saved');
  let dirty = false;
  let saveTimer = 0;

  // Without a block wrapper the caret sits in a bare text node, where Enter is
  // a no-op in Chromium and "start of line" cannot be identified at all. Every
  // document therefore keeps at least one paragraph.
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {
    /* older engines: the default separator is already a block */
  }

  /**
   * Keep every character inside a block element.
   *
   * Runs on each input, so it must never rebuild the surface from a string:
   * replacing nodes would drop the caret mid-word. Stray text nodes are MOVED
   * into a paragraph instead, which carries the selection with them.
   */
  function ensureBlocks() {
    if (!surface.childNodes.length) {
      surface.innerHTML = '<p><br></p>';
      return;
    }
    for (const node of [...surface.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      if (!node.textContent) {
        node.remove();
        continue;
      }
      const p = document.createElement('p');
      surface.insertBefore(p, node);
      p.appendChild(node);
    }
  }

  function markDirty() {
    dirty = true;
    savedEl.textContent = 'Unsaved';
    savedEl.classList.add('dirty');
    onDirty?.();
    window.clearTimeout(saveTimer);
    // Autosave the way a docs app does: shortly after typing stops.
    saveTimer = window.setTimeout(() => save(), 1200);
  }

  /** The gap is a document property, so it is stored with the document. */
  function wrapForSave(html) {
    const gap = surface.style.lineHeight || '1.7';
    return gap === '1.7' ? html : `<div style="line-height: ${gap}">${html}</div>`;
  }

  /** Undo wrapForSave, returning the body and the gap it was saved with. */
  function unwrapOnLoad(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    const only = host.children.length === 1 ? host.firstElementChild : null;
    const gap = only?.tagName === 'DIV' ? only.style.lineHeight : '';
    if (gap) return { html: only.innerHTML, gap };
    return { html, gap: '1.7' };
  }

  async function save() {
    if (!dirty) return;
    const html = wrapForSave(sanitizeHtml(surface.innerHTML));
    dirty = false;
    savedEl.textContent = 'Saving…';
    try {
      await onSave(html);
      savedEl.textContent = 'Saved';
      savedEl.classList.remove('dirty');
    } catch (err) {
      dirty = true;
      savedEl.textContent = err?.message || 'Could not save';
      savedEl.classList.add('dirty');
    }
  }

  // ---- toolbar ------------------------------------------------------------

  el.querySelector('#doc-toolbar').addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]');
    if (cmd) {
      surface.focus();
      exec(cmd.dataset.cmd);
      markDirty();
      syncToolbar();
      return;
    }
    if (e.target.closest('[data-rule]')) {
      surface.focus();
      exec('insertHorizontalRule');
      markDirty();
      return;
    }
    if (e.target.closest('[data-link]')) {
      promptLink();
      return;
    }
    if (e.target.closest('[data-unlink]')) {
      surface.focus();
      exec('unlink');
      markDirty();
      return;
    }
    if (e.target.closest('[data-clear]')) {
      surface.focus();
      exec('removeFormat');
      markDirty();
      return;
    }
    if (e.target.closest('[data-paste-plain]')) {
      pastePlain();
    }
  });

  el.querySelector('[data-size]').addEventListener('change', (e) => {
    surface.focus();
    applyToBlockOrSelection((node) => {
      node.style.fontSize = `${e.target.value}px`;
    });
    markDirty();
  });

  el.querySelector('[data-gap]').addEventListener('change', (e) => {
    surface.focus();
    // Line gap is a block property: apply it to the whole document body so the
    // spacing stays consistent rather than per paragraph.
    surface.style.lineHeight = e.target.value;
    markDirty();
  });

  /**
   * Wrap the selection in a span (or style the block when nothing is selected),
   * which is how size survives a round trip through the sanitizer.
   */
  function applyToBlockOrSelection(styler) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      const block = blockAt(range.startContainer);
      if (block && block !== surface) styler(block);
      return;
    }
    const span = document.createElement('span');
    styler(span);
    try {
      range.surroundContents(span);
    } catch {
      // Selection crosses element boundaries: fall back to the block.
      const block = blockAt(range.startContainer);
      if (block && block !== surface) styler(block);
    }
  }

  function blockAt(node) {
    let n = node;
    while (n && n !== surface) {
      if (n.nodeType === Node.ELEMENT_NODE && /^(P|DIV|LI|H1|H2|H3)$/.test(n.tagName)) return n;
      n = n.parentNode;
    }
    return surface.firstElementChild || surface;
  }

  function isEmptyBlock(block) {
    if (!block || block === surface) return true;
    const text = (block.textContent || '').replace(/\u200B/g, '').trim();
    return !text;
  }

  /** Indent level from margin-left / padding-left on the block. */
  function indentLevelOf(block) {
    if (!block || block.nodeType !== Node.ELEMENT_NODE) return 0;
    const style = block.style;
    const px =
      parseFloat(style.marginLeft || '') ||
      parseFloat(style.paddingLeft || '') ||
      0;
    if (!(px > 0)) return 0;
    return Math.max(0, Math.round(px / INDENT_STEP_PX));
  }

  function setIndentLevel(block, level) {
    if (!block || block === surface || block.nodeType !== Node.ELEMENT_NODE) return;
    const n = Math.max(0, Math.min(INDENT_MAX_LEVEL, level));
    if (n <= 0) {
      block.style.marginLeft = '';
      // Clear leftover padding from older span-based indents on the block itself.
      if (block.style.paddingLeft) block.style.paddingLeft = '';
      return;
    }
    block.style.marginLeft = `${n * INDENT_STEP_PX}px`;
  }

  /** Blocks covered by the current selection (one or many paragraphs). */
  function selectedBlocks() {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const start = blockAt(range.startContainer);
    const end = blockAt(range.endContainer);
    if (!start || start === surface) return [];
    if (start === end || range.collapsed) return [start];
    const out = [];
    let on = false;
    for (const el of surface.querySelectorAll('p, div, h1, h2, h3')) {
      if (el === start) on = true;
      if (on) out.push(el);
      if (el === end) break;
    }
    return out.length ? out : [start];
  }

  function changeIndent(delta) {
    const blocks = selectedBlocks();
    if (!blocks.length) return;
    for (const block of blocks) {
      setIndentLevel(block, indentLevelOf(block) + delta);
    }
  }

  async function pastePlain() {
    surface.focus();
    try {
      const text = await navigator.clipboard.readText();
      exec('insertText', text);
      markDirty();
    } catch {
      savedEl.textContent = 'Clipboard access was blocked';
    }
  }

  function promptLink() {
    const sel = window.getSelection();
    const selected = sel ? String(sel) : '';
    const url = window.prompt('Link to', 'https://');
    if (!url) return;
    surface.focus();
    if (selected) exec('createLink', url);
    else {
      exec('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    }
    markDirty();
  }

  // ---- keyboard -----------------------------------------------------------

  surface.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;

    if (mod && !e.shiftKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      // Browsers already map these, but not in every engine and not when the
      // surface is inside a list, so drive them explicitly.
      e.preventDefault();
      exec({ b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()]);
      markDirty();
      syncToolbar();
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      promptLink();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      pastePlain();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      // Inside a list Tab nests / outdents. Everywhere else: block indent levels.
      if (inList()) exec(e.shiftKey ? 'outdent' : 'indent');
      else changeIndent(e.shiftKey ? -1 : 1);
      markDirty();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod && !inList()) {
      // Empty indented line + Enter → drop back to the default level.
      // Non-empty + Enter keeps the indent on the new line (browser copies
      // margin-left; we re-apply after the split in case an engine drops it).
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const block = blockAt(sel.getRangeAt(0).startContainer);
        const level = indentLevelOf(block);
        if (level > 0 && isEmptyBlock(block)) {
          e.preventDefault();
          setIndentLevel(block, 0);
          markDirty();
          return;
        }
        if (level > 0) {
          // After the browser inserts the new paragraph, mirror the indent.
          const prev = block;
          requestAnimationFrame(() => {
            const nextSel = window.getSelection();
            if (!nextSel?.rangeCount) return;
            const next = blockAt(nextSel.getRangeAt(0).startContainer);
            if (next && next !== prev && next !== surface) {
              setIndentLevel(next, level);
            }
          });
        }
      }
    }
    if (e.key === ' ') {
      // "* ", "- " and "1. " at the start of a line become lists.
      const converted = maybeAutoList();
      if (converted) {
        e.preventDefault();
        markDirty();
      }
    }
  });

  function inList() {
    const sel = window.getSelection();
    let n = sel?.anchorNode;
    while (n && n !== surface) {
      if (n.nodeType === Node.ELEMENT_NODE && (n.tagName === 'LI' || n.tagName === 'UL' || n.tagName === 'OL')) {
        return true;
      }
      n = n.parentNode;
    }
    return false;
  }

  /**
   * Markdown-style list starters. Returns true when the line was converted, in
   * which case the space that triggered it is swallowed.
   *
   * The marker is read from the start of the block rather than of the text
   * node: "* " after a bold run, or after any inline split, is still the start
   * of the line as far as the writer is concerned.
   */
  function maybeAutoList() {
    if (inList()) return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;

    const block = blockAt(range.startContainer);
    if (!block || block === surface) return false;

    const upto = document.createRange();
    upto.setStart(block, 0);
    upto.setEnd(range.startContainer, range.startOffset);
    // The trailing space is optional: on keydown it has not been inserted yet,
    // on an input event it already has.
    const typed = upto.toString();
    const bullet = /^\s*([*-])\s?$/.test(typed);
    const numbered = /^\s*(\d+)\.\s?$/.test(typed);
    if (!bullet && !numbered) return false;

    // Drop the marker characters, then put the caret back inside the now-empty
    // line. Without this the selection collapses to wherever deleteContents
    // left it and the list command converts the PREVIOUS paragraph instead.
    upto.deleteContents();
    const caret = document.createRange();
    caret.setStart(block, 0);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);

    exec(bullet ? 'insertUnorderedList' : 'insertOrderedList');
    hoistLists(surface);
    return true;
  }

  // ---- paste --------------------------------------------------------------

  surface.addEventListener('paste', (e) => {
    const html = e.clipboardData?.getData('text/html');
    if (!html) {
      // Plain text paste is fine as-is; the browser inserts it unstyled.
      markDirty();
      return;
    }
    e.preventDefault();
    exec('insertHTML', sanitizeHtml(html));
    markDirty();
  });

  surface.addEventListener('input', (e) => {
    ensureBlocks();
    // Second entry point for the list markers: text inserted without a
    // per-character keydown (IME composition, autocomplete, automation) never
    // reaches the handler above.
    if (e.inputType === 'insertText' && e.data === ' ') maybeAutoList();
    markDirty();
  });
  surface.addEventListener('blur', () => save());
  surface.addEventListener('keyup', syncToolbar);
  surface.addEventListener('mouseup', syncToolbar);

  function syncToolbar() {
    for (const btn of el.querySelectorAll('[data-cmd]')) {
      let on = false;
      try {
        on = document.queryCommandState(btn.dataset.cmd);
      } catch {
        on = false;
      }
      btn.classList.toggle('active', on);
    }
  }

  return {
    el,
    /** @param {{html?: string, lineHeight?: string}} doc */
    load(doc = {}) {
      window.clearTimeout(saveTimer);
      dirty = false;
      const body = unwrapOnLoad(sanitizeHtml(doc.html || ''));
      surface.innerHTML = body.html || '<p><br></p>';
      ensureBlocks();
      surface.style.lineHeight = doc.lineHeight || body.gap;
      const gapSelect = el.querySelector('[data-gap]');
      if (gapSelect) gapSelect.value = surface.style.lineHeight;
      savedEl.textContent = 'Saved';
      savedEl.classList.remove('dirty');
      syncToolbar();
    },
    focus() {
      surface.focus();
    },
    html() {
      return wrapForSave(sanitizeHtml(surface.innerHTML));
    },
    flush() {
      window.clearTimeout(saveTimer);
      return save();
    },
    destroy() {
      window.clearTimeout(saveTimer);
      el.remove();
    }
  };
}
