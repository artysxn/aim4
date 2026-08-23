// ---------------------------------------------------------------------------
// site/pitchDeckView.js
// The pitch, as slides. Two decks, two audiences, four routes:
//
//   /tools/pitchdeck   full deck, admin only, reachable from the site
//   /tools/pitchtalk   talking deck, admin only
//   /public-pitch      full deck, open to anyone with the link
//   /public-talk       talking deck, open to anyone with the link
//
// The full deck reads on its own; the talking deck is labels and matrices for
// presenting over, with the spoken script in a transcript panel that slides in
// from the right edge. One view renders both, because they are the same slide
// contract — only the wording density differs.
//
// Deliberately chromeless: onShow puts `deck-mode` on <body>, which hides the
// sidebar and page head. F or the button goes fullscreen; arrows, space, click
// and the dots navigate; T pins the transcript. The slide number rides in the
// URL hash, so a shared link opens on a slide and survives a reload.
//
// Wording is data: PITCH_SLIDES / TALK_SLIDES, with edits saved from the admin
// panel laid over them by GET /api/pitch. That fetch never blocks the deck — if
// it fails, the compiled-in wording is shown.
// ---------------------------------------------------------------------------

import { PITCH_SLIDES, applyPitchText } from './pitchContent.js';
import { TALK_SLIDES } from './pitchTalk.js';
import { getEntitlements } from '../lib/entitlements.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

/**
 * The four addresses this view answers on. `other` is the same audience's other
 * deck (the switch button), `share` is the public address of the deck currently
 * open (the copy-link button).
 */
const VARIANTS = {
  '/tools/pitchdeck': { deck: 'full', gated: true, other: 'pitchtalk', otherLabel: 'Talk', share: '/public-pitch' },
  '/tools/pitchtalk': { deck: 'talk', gated: true, other: 'pitchdeck', otherLabel: 'Full', share: '/public-talk' },
  '/public-pitch': { deck: 'full', gated: false, other: 'public-talk', otherLabel: 'Talk', share: '/public-pitch' },
  '/public-talk': { deck: 'talk', gated: false, other: 'public-pitch', otherLabel: 'Full', share: '/public-talk' }
};

const DEFAULT_VARIANT = VARIANTS['/public-pitch'];

/** Route name → path, for the deck switch when the router is not reachable. */
const ROUTE_PATHS = {
  pitchdeck: '/tools/pitchdeck',
  pitchtalk: '/tools/pitchtalk',
  'public-pitch': '/public-pitch',
  'public-talk': '/public-talk'
};

function currentVariant() {
  return VARIANTS[window.location.pathname.replace(/\/+$/, '')] || DEFAULT_VARIANT;
}

/** How close to the right edge the pointer has to get to pull the transcript in. */
const TRANSCRIPT_EDGE_PX = 64;

/**
 * @param {{escapeHtml: (s: string) => string, openRoute?: (name: string) => void}} deps
 */
export function initPitchDeckView({ escapeHtml, openRoute }) {
  const host = document.querySelector('.view[data-view="pitchdeck"]');
  if (!host) return {};

  let index = 0;
  let mounted = false;
  let variant = DEFAULT_VARIANT;
  /** The deck as rendered: base wording plus whatever the panel has saved. */
  let slides = PITCH_SLIDES;
  /** Saved overrides, kept so switching decks does not need a second fetch. */
  let overrides = null;
  let textLoaded = false;
  /** Transcript: open follows the pointer, pinned survives it leaving. */
  let transcriptOpen = false;
  let transcriptPinned = false;

  const baseSlides = () => (variant.deck === 'talk' ? TALK_SLIDES : PITCH_SLIDES);

  /**
   * Pull the live wording. Failure is not an error state: an unreachable or
   * broken endpoint just means the deck shows what is in the bundle, which is
   * always a complete pitch.
   */
  async function loadText() {
    if (textLoaded) return;
    try {
      const res = await fetch(`${API_BASE}/api/pitch`, { headers: { Accept: 'application/json' } });
      if (res.ok) overrides = (await res.json())?.text || null;
    } catch {
      overrides = null;
    }
    textLoaded = true;
  }

  function applyDeck() {
    slides = applyPitchText(baseSlides(), overrides);
    if (index > slides.length - 1) index = slides.length - 1;
  }

  // ---- rendering ----------------------------------------------------------

  const esc = (s) => escapeHtml(s);
  const pointsHtml = (list, cls = 'pd-points') =>
    `<ul class="${cls}">${list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
  const listRowHtml = (items) =>
    `<ul class="pd-list">${items.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;

  /** Grouped bullet lists. An inventory, read as a list rather than as prose. */
  function listsHtml(groups) {
    // A bare array of strings is one list; an array of {title, items} is a grid.
    if (typeof groups[0] === 'string') return listRowHtml(groups);
    return `<div class="pd-lists">${groups
      .map(
        (g) =>
          `<div class="pd-list-group"><h3>${esc(g.title)}</h3>${listRowHtml(g.items || [])}</div>`
      )
      .join('')}</div>`;
  }

  /**
   * A sequence with arrows between the steps.
   *
   * Each arrow is bound to the step that follows it, not the one before, so a
   * flow that wraps carries "→ next step" onto the new line instead of leaving
   * an arrow pointing at the end of the previous one.
   */
  function flowHtml(steps) {
    return `<div class="pd-flow">${steps
      .map((s, i) =>
        i === 0
          ? `<span class="pd-flow-step">${esc(s)}</span>`
          : `<span class="pd-flow-link"><span class="pd-flow-arrow" aria-hidden="true">→</span><span class="pd-flow-step">${esc(
              s
            )}</span></span>`
      )
      .join('')}</div>`;
  }

  /**
   * Labelled magnitudes. Scaled against the largest bar anywhere on the slide,
   * not the largest in its own column, so two revenue models can be compared by
   * eye rather than by reading the numbers back.
   */
  function barsHtml(bars, max) {
    return `<div class="pd-bars">${bars
      .map((b) => {
        const pct = max > 0 ? Math.max(3, Math.round((Number(b.n) || 0) * 100 / max)) : 0;
        return `<div class="pd-bar">
          <div class="pd-bar-head"><span>${esc(b.label)}</span><span class="pd-bar-value">${esc(
            b.value
          )}</span></div>
          <div class="pd-bar-track"><span class="pd-bar-fill" style="width:${pct}%"></span></div>
        </div>`;
      })
      .join('')}</div>`;
  }

  /** The biggest bar on the slide, across every column. */
  function barMax(slide) {
    let max = 0;
    const scan = (bars) => {
      for (const b of bars || []) max = Math.max(max, Number(b.n) || 0);
    };
    scan(slide.bars);
    for (const c of slide.columns || []) scan(c.bars);
    return max;
  }

  function slideHtml(slide) {
    const max = barMax(slide);
    let body = '';
    if (slide.quote) {
      body += `<blockquote class="pd-quote">${esc(slide.quote)}</blockquote>`;
      if (slide.quoteBy) body += `<p class="pd-quote-by">${esc(slide.quoteBy)}</p>`;
    }
    if (slide.stats) {
      body += `<div class="pd-stats">${slide.stats
        .map(
          (st) =>
            `<div class="pd-stat"><span class="pd-stat-value">${esc(
              st.value
            )}</span><span class="pd-stat-label">${esc(st.label)}</span></div>`
        )
        .join('')}</div>`;
    }
    if (slide.points) body += pointsHtml(slide.points);
    if (slide.flow) body += flowHtml(slide.flow);
    if (slide.lists) body += listsHtml(slide.lists);
    if (slide.columns) {
      body += `<div class="pd-columns">${slide.columns
        .map(
          (c) =>
            `<div class="pd-col">${
              c.tag ? `<span class="pd-col-tag">${esc(c.tag)}</span>` : ''
            }<h3>${esc(c.title)}</h3>${
              c.lead ? `<p class="pd-col-lead">${esc(c.lead)}</p>` : ''
            }${c.points ? pointsHtml(c.points) : ''}${c.lists ? listsHtml(c.lists) : ''}${
              c.bars ? barsHtml(c.bars, max) : ''
            }${c.foot ? `<p class="pd-col-foot">${esc(c.foot)}</p>` : ''}</div>`
        )
        .join('')}</div>`;
    }
    if (slide.bars) body += barsHtml(slide.bars, max);
    if (slide.table) {
      body += `<div class="pd-table-wrap"><table class="pd-table${
        slide.table.wrap ? ' is-wrap' : ''
      }">
        <thead><tr>${slide.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${slide.table.rows
          .map(
            (r, i) =>
              `<tr${slide.table.highlight === i ? ' class="pd-us"' : ''}>${r
                .map((cell, j) => `<t${j === 0 ? 'h' : 'd'}>${esc(cell)}</t${j === 0 ? 'h' : 'd'}>`)
                .join('')}</tr>`
          )
          .join('')}</tbody>
      </table>${slide.tableNote ? `<p class="pd-note">${esc(slide.tableNote)}</p>` : ''}</div>`;
    }
    if (slide.note) body += `<p class="pd-note">${esc(slide.note)}</p>`;
    return `
      <section class="pd-slide${slide.tone ? ` pd-tone-${slide.tone}` : ''}${
        slide.center ? ' is-center' : ''
      }${slide.dense ? ' is-dense' : ''}">
        ${slide.kicker ? `<span class="pd-kicker">${esc(slide.kicker)}</span>` : ''}
        <h1 class="pd-title">${esc(slide.title)}</h1>
        ${slide.lead ? `<p class="pd-lead">${esc(slide.lead)}</p>` : ''}
        ${body}
        ${slide.big ? `<span class="pd-big" aria-hidden="true">${esc(slide.big)}</span>` : ''}
      </section>`;
  }

  /** The spoken script for this slide, in the panel that lives off the right edge. */
  function transcriptHtml(slide) {
    const script = slide.script || [];
    const body = script.length
      ? script.map((p) => `<p>${esc(p)}</p>`).join('')
      : '<p class="pd-script-empty">No script for this slide yet.</p>';
    return `
      <div class="pd-edge" aria-hidden="true"><span>Transcript</span></div>
      <aside class="pd-script" data-pd-script-panel>
        <div class="pd-script-head">
          <span class="pd-script-kicker">Transcript</span>
          <span class="pd-script-num">${index + 1} / ${slides.length}</span>
        </div>
        <h2 class="pd-script-title">${esc(slide.title)}</h2>
        ${body}
        <p class="pd-script-hint">${
          transcriptPinned ? 'Pinned · press T to unpin' : 'Press T to pin'
        }</p>
      </aside>`;
  }

  function render() {
    const slide = slides[index];
    const talk = variant.deck === 'talk';
    host.innerHTML = `
      <div class="pd-deck${talk ? ' is-talk' : ''}${
        talk && transcriptOpen ? ' is-transcript' : ''
      }" tabindex="0">
        ${slideHtml(slide)}
        ${talk ? transcriptHtml(slide) : ''}
        <div class="pd-chrome">
          <button type="button" class="pd-nav" data-pd-prev aria-label="Previous slide">‹</button>
          <div class="pd-dots">${slides
            .map(
              (_, i) =>
                `<button type="button" class="pd-dot${
                  i === index ? ' active' : ''
                }" data-pd-go="${i}" aria-label="Slide ${i + 1}"></button>`
            )
            .join('')}</div>
          <button type="button" class="pd-nav" data-pd-next aria-label="Next slide">›</button>
          <button type="button" class="pd-full" data-pd-full title="Fullscreen (F)">⛶</button>
          ${
            talk
              ? `<button type="button" class="pd-full${
                  transcriptPinned ? ' is-on' : ''
                }" data-pd-script title="Transcript (T)">☰</button>`
              : ''
          }
          <button type="button" class="pd-switch" data-pd-switch title="Switch deck">${esc(
            variant.otherLabel
          )}</button>
          ${
            variant.gated
              ? '<button type="button" class="pd-full" data-pd-share title="Copy the public link">🔗</button>'
              : ''
          }
        </div>
        <span class="pd-count">${index + 1} / ${slides.length}</span>
      </div>`;
    host.querySelector('.pd-deck')?.focus({ preventScroll: true });
  }

  // ---- navigation ---------------------------------------------------------

  function go(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    // The slide lives in the hash, not the path: the router owns the path, and
    // replaceState keeps Back meaning "leave the deck" rather than "go back
    // twenty slides".
    const hash = index === 0 ? '' : `#${index + 1}`;
    const target = window.location.pathname + window.location.search + hash;
    if (window.location.pathname + window.location.search + window.location.hash !== target) {
      window.history.replaceState(window.history.state, '', target);
    }
    render();
  }

  /** Slide number from the URL hash, 1-based in the bar, 0-based inside. */
  function indexFromHash() {
    const n = Number(String(window.location.hash || '').replace('#', ''));
    if (!Number.isFinite(n) || n < 1) return 0;
    return Math.min(slides.length - 1, Math.floor(n) - 1);
  }

  /** The other deck for this audience. Falls back to a plain load off-router. */
  function switchDeck() {
    if (typeof openRoute === 'function') openRoute(variant.other);
    else window.location.assign(ROUTE_PATHS[variant.other] || '/');
  }

  function setTranscript(open, pin = transcriptPinned) {
    if (variant.deck !== 'talk') return;
    if (open === transcriptOpen && pin === transcriptPinned) return;
    transcriptOpen = open;
    transcriptPinned = pin;
    const deck = host.querySelector('.pd-deck');
    if (!deck) return;
    deck.classList.toggle('is-transcript', transcriptOpen);
    host.querySelector('[data-pd-script]')?.classList.toggle('is-on', transcriptPinned);
    const hint = host.querySelector('.pd-script-hint');
    if (hint) hint.textContent = transcriptPinned ? 'Pinned · press T to unpin' : 'Press T to pin';
  }

  function onKey(e) {
    if (!mounted) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      go(index - 1);
    } else if (e.key === 'Home') {
      go(0);
    } else if (e.key === 'End') {
      go(slides.length - 1);
    } else if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    } else if (e.key === 't' || e.key === 'T') {
      setTranscript(!transcriptPinned, !transcriptPinned);
    }
  }

  /**
   * Pull the transcript in when the pointer reaches the right edge, and let it
   * go when the pointer leaves it. Done on mousemove rather than with a hover
   * strip on purpose: a strip would sit exactly where click-to-advance lives.
   */
  function onMove(e) {
    if (!mounted || variant.deck !== 'talk' || transcriptPinned) return;
    const deck = host.querySelector('.pd-deck');
    if (!deck) return;
    const r = deck.getBoundingClientRect();
    const panel = deck.querySelector('.pd-script');
    const width = panel ? panel.getBoundingClientRect().width : 380;
    if (e.clientX > r.right - TRANSCRIPT_EDGE_PX) setTranscript(true);
    else if (e.clientX < r.right - width - 24) setTranscript(false);
  }

  function toggleFullscreen() {
    const deck = host.querySelector('.pd-deck');
    if (!deck) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void deck.requestFullscreen?.();
  }

  /** Copy the shareable address of the deck on screen, at the slide on screen. */
  async function copyShareLink(btn) {
    const hash = index === 0 ? '' : `#${index + 1}`;
    const link = `${window.location.origin}${variant.share}${hash}`;
    try {
      await navigator.clipboard.writeText(link);
      btn.textContent = '✓';
    } catch {
      // Clipboard blocked (insecure origin, denied permission): show the link
      // so it can still be copied by hand rather than failing silently.
      btn.textContent = '✕';
      window.prompt('Copy this link', link);
    }
    setTimeout(() => {
      btn.textContent = '🔗';
    }, 1400);
  }

  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-pd-prev]')) return go(index - 1);
    if (e.target.closest('[data-pd-next]')) return go(index + 1);
    if (e.target.closest('[data-pd-full]')) return toggleFullscreen();
    if (e.target.closest('[data-pd-switch]')) return switchDeck();
    if (e.target.closest('[data-pd-script]')) {
      return setTranscript(!transcriptPinned, !transcriptPinned);
    }
    const share = e.target.closest('[data-pd-share]');
    if (share) return void copyShareLink(share);
    const dot = e.target.closest('[data-pd-go]');
    if (dot) return go(Number(dot.dataset.pdGo));
    // Reading the transcript must not advance the deck.
    if (e.target.closest('[data-pd-script-panel]')) return;
    // Click on the slide itself: right two thirds forward, left third back.
    const slide = e.target.closest('.pd-slide');
    if (slide) {
      const r = slide.getBoundingClientRect();
      go(e.clientX - r.left < r.width / 3 ? index - 1 : index + 1);
    }
  });

  /** Someone edited the hash, or used Back onto a deck link. */
  function onHashChange() {
    if (!mounted) return;
    const next = indexFromHash();
    if (next === index) return;
    index = next;
    render();
  }

  return {
    async onShow() {
      mounted = true;
      variant = currentVariant();
      transcriptOpen = false;
      transcriptPinned = false;
      document.body.classList.add('deck-mode');
      window.addEventListener('keydown', onKey);
      window.addEventListener('hashchange', onHashChange);
      window.addEventListener('mousemove', onMove);

      // The shareable routes are open by design: they exist to be sent to
      // someone who does not have an account. Only the in-site copies are gated.
      if (variant.gated) {
        const ents = getEntitlements();
        await ents?.ready?.().catch(() => null);
        if (!ents?.isAdmin) {
          // Same posture as /admin: the page exists only for admins, everyone
          // else gets a plain refusal rather than a redirect that hints at more.
          document.body.classList.remove('deck-mode');
          host.innerHTML = '<div class="view-pad"><p class="view-empty">Admins only.</p></div>';
          return;
        }
      }

      await loadText();
      if (!mounted) return;
      applyDeck();
      index = indexFromHash();
      render();
    },
    onHide() {
      mounted = false;
      document.body.classList.remove('deck-mode');
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('mousemove', onMove);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    }
  };
}
