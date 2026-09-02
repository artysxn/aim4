// ---------------------------------------------------------------------------
// i18n/dom.js
// The layer that puts the translation on the screen.
//
// The site writes its copy inline, inside HTML template literals, in about a
// hundred files. There is no lookup call to wrap and no single place text goes
// through, so rather than rewrite every view this watches the DOM and rewrites
// English as it appears.
//
// The cost of that choice is paid in three places and nowhere else:
//
//   - Re-entrancy. Writing a translation is itself a mutation, so every write
//     is recorded and a node whose text is exactly what we last wrote is left
//     alone. Without this the observer feeds itself forever.
//   - User content. A team document, a stratbook note or a player's nickname
//     must never be touched. Two defences: the catalogue only ever contains
//     strings the *site* wrote, matched whole, so a nickname has nothing to
//     match; and any container marked data-i18n="off" is skipped outright.
//   - English. When the language is English the observer is never installed and
//     nothing below this line runs, so the common case costs nothing at all.
//
// Originals are kept so a language change can put the English back and start
// again, rather than trying to translate an already-translated page.
// ---------------------------------------------------------------------------

import { translate, translatePadded } from './translate.js';

/** Attributes that hold copy a person reads. `alt` and `title` included. */
const ATTRS = Object.freeze(['title', 'placeholder', 'aria-label', 'alt', 'label', 'value']);

/** `value` is only copy on a button; anywhere else it is data. */
const VALUE_TYPES = Object.freeze(new Set(['button', 'submit', 'reset']));

/** Subtrees that never contain site copy. */
const SKIP_TAGS = Object.freeze(
  new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'SVG', 'CANVAS'])
);

/** English we wrote, so we can put it back on a language change. */
const originalText = new WeakMap();
/** What we last wrote, so our own writes are not mistaken for the app's. */
const writtenText = new WeakMap();
/** element -> attribute -> English. */
const originalAttrs = new WeakMap();
const writtenAttrs = new WeakMap();

let observer = null;
let root = null;
let queued = null;
let queuedIsFrame = false;
let backstop = null;
const pending = new Set();

/** Dev only: English-looking strings the catalogue did not cover. */
const misses = new Map();
let collectMisses = false;

function skipped(node) {
  for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    const flag = el.getAttribute?.('data-i18n');
    if (flag === 'off') return true;
  }
  return false;
}

/** Worth trying: has letters, and is not a bare number or symbol run. */
function translatable(text) {
  if (!text) return false;
  if (text.length > 2000) return false;
  return /\p{L}\p{L}/u.test(text);
}

function noteMiss(text) {
  if (!collectMisses) return;
  const key = text.replace(/\s+/g, ' ').trim();
  if (!key || key.length < 3 || !/\p{Lu}?\p{Ll}+(\s|$)/u.test(key)) return;
  misses.set(key, (misses.get(key) || 0) + 1);
}

function applyText(node) {
  const current = node.nodeValue;
  // Exactly what we last wrote: our own output coming back round, leave it.
  if (writtenText.get(node) === current) return;
  // Anything else is the app's text, whether this node is new or was rewritten
  // under a translation we had already put there.
  const english = current;
  if (!translatable(english)) return;
  const next = translatePadded(english);
  if (next == null) {
    noteMiss(english);
    return;
  }
  if (next === current) return;
  originalText.set(node, english);
  writtenText.set(node, next);
  node.nodeValue = next;
}

function applyAttrs(el) {
  for (const attr of ATTRS) {
    if (!el.hasAttribute(attr)) continue;
    if (attr === 'value' && !VALUE_TYPES.has(el.type)) continue;
    const current = el.getAttribute(attr);
    if (writtenAttrs.get(el)?.get(attr) === current) continue;
    if (!translatable(current)) continue;
    const next = translate(current);
    if (next == null) {
      noteMiss(current);
      continue;
    }
    if (next === current) continue;
    if (!originalAttrs.has(el)) originalAttrs.set(el, new Map());
    if (!writtenAttrs.has(el)) writtenAttrs.set(el, new Map());
    originalAttrs.get(el).set(attr, current);
    writtenAttrs.get(el).set(attr, next);
    el.setAttribute(attr, next);
  }
}

function cancelPending() {
  if (queued != null) {
    if (queuedIsFrame) cancelAnimationFrame(queued);
    else clearTimeout(queued);
    queued = null;
  }
  if (backstop != null) {
    clearTimeout(backstop);
    backstop = null;
  }
}

function sweep(node) {
  if (!node || skipped(node)) return;
  if (node.nodeType === 3) {
    applyText(node);
    return;
  }
  if (node.nodeType !== 1) return;
  if (node.hasAttribute?.('data-i18n') && node.getAttribute('data-i18n') === 'off') return;
  applyAttrs(node);
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        if (SKIP_TAGS.has(n.tagName)) return NodeFilter.FILTER_REJECT;
        if (n.getAttribute('data-i18n') === 'off') return NodeFilter.FILTER_REJECT;
        if (n.isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
      return translatable(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) applyText(n);
    else applyAttrs(n);
  }
}

function flush() {
  cancelPending();
  const batch = [...pending];
  pending.clear();
  // Our own writes fire the observer again; ignoring them is what `written`
  // is for, so it is safe to stay connected while we work.
  for (const node of batch) {
    if (node.isConnected) sweep(node);
  }
}

/**
 * Batch to a frame, with a timer behind it.
 *
 * A frame is the right moment: it coalesces a burst of inserts into one pass
 * and lands before paint, so nothing is seen in English first. But a hidden tab
 * gets no frames at all, and a page that renders while backgrounded would sit
 * with its work queued until somebody looked at it. The timer is the floor
 * under that; whichever fires first cancels the other.
 */
function schedule(node) {
  pending.add(node);
  if (queued != null) return;
  queuedIsFrame = typeof requestAnimationFrame === 'function';
  queued = queuedIsFrame ? requestAnimationFrame(flush) : setTimeout(flush, 0);
  backstop = setTimeout(flush, 250);
}

/**
 * Put every English string back. Called before switching language so the next
 * pass reads English rather than the last language's output.
 */
function restore(node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n = node;
  do {
    if (n.nodeType === 3) {
      if (originalText.has(n) && writtenText.get(n) === n.nodeValue) {
        n.nodeValue = originalText.get(n);
        writtenText.delete(n);
        originalText.delete(n);
      }
    } else if (n.nodeType === 1 && originalAttrs.has(n)) {
      const orig = originalAttrs.get(n);
      const writ = writtenAttrs.get(n);
      for (const [attr, english] of orig) {
        if (n.getAttribute(attr) === writ?.get(attr)) n.setAttribute(attr, english);
      }
      originalAttrs.delete(n);
      writtenAttrs.delete(n);
    }
  } while ((n = walker.nextNode()));
}

/**
 * Start translating. Idempotent: calling it again while running only re-sweeps,
 * which is what a language change needs.
 *
 * @param {HTMLElement} [host] defaults to <body>
 */
export function startDomTranslation(host) {
  root = host || document.body;
  if (!root) return;
  if (!observer) {
    observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'characterData') schedule(rec.target);
        else if (rec.type === 'attributes') schedule(rec.target);
        else for (const added of rec.addedNodes) schedule(added);
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRS]
    });
  }
  sweep(root);
}

/** Stop, and put the English back. */
export function stopDomTranslation() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  cancelPending();
  pending.clear();
  if (root) restore(root);
}

/** Re-read the page after the catalogue changed under us. */
export function resweep() {
  if (!root) return;
  restore(root);
  sweep(root);
}

/** Dev only. Turns on collection of strings nothing covered. */
export function collectMissing(on = true) {
  collectMisses = on;
  if (!on) misses.clear();
}

/** Dev only. What the sweep could not translate, commonest first. */
export function missingStrings() {
  return [...misses].sort((a, b) => b[1] - a[1]).map(([text, count]) => ({ text, count }));
}
