// ---------------------------------------------------------------------------
// src/site/admin/pitchPanel.js
// Edit the pitch deck's wording without a deploy.
//
// The fields are generated from the deck itself: every string in
// pitchContent.js becomes one box, addressed by slide id and path. Nothing here
// knows what a slide contains, which is the point — adding a slide or a bullet
// to the deck makes it editable here with no change to this file.
//
// An edit is only kept while it differs from the wording in the source. Typing
// a sentence back to its original removes the override rather than saving a
// copy of it, so the file stays the default and the store only ever holds the
// deltas.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, el, notice, render } from './dom.js';
import { PITCH_SLIDES, textLeaves } from '../pitchContent.js';
import { TALK_SLIDES } from '../pitchTalk.js';

/** Both decks, edited from one panel. Slide ids are unique across the pair. */
const DECKS = [
  { id: 'full', label: 'Full deck', slides: PITCH_SLIDES, view: '/tools/pitchdeck', share: '/public-pitch' },
  { id: 'talk', label: 'Talking deck', slides: TALK_SLIDES, view: '/tools/pitchtalk', share: '/public-talk' }
];

const ORDINAL = (n) => String(Number(n) + 1);

/** Human label for a path like "columns.1.points.3". */
function pathLabel(path) {
  const parts = String(path).split('.');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    const next = parts[i + 1];
    const isIndex = /^\d+$/.test(next || '');
    switch (key) {
      case 'kicker':
        out.push('Kicker');
        break;
      case 'title':
        out.push('Title');
        break;
      case 'lead':
        out.push('Lead');
        break;
      case 'note':
        out.push('Note');
        break;
      case 'tableNote':
        out.push('Table note');
        break;
      case 'quote':
        out.push('Quote');
        break;
      case 'quoteBy':
        out.push('Quote credit');
        break;
      case 'big':
        out.push('Watermark');
        break;
      case 'value':
        out.push('Value');
        break;
      case 'label':
        out.push('Label');
        break;
      case 'tag':
        out.push('Tag');
        break;
      case 'points':
        if (isIndex) {
          out.push(`Bullet ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Bullets');
        break;
      case 'columns':
        if (isIndex) {
          out.push(`Column ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Columns');
        break;
      case 'stats':
        if (isIndex) {
          out.push(`Stat ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Stats');
        break;
      case 'head':
        if (isIndex) {
          out.push(`Header ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Header');
        break;
      case 'rows':
        if (isIndex) {
          out.push(`Row ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Rows');
        break;
      case 'script':
        if (isIndex) {
          out.push(`Script ¶${ORDINAL(next)}`);
          i += 1;
        } else out.push('Script');
        break;
      case 'lists':
        if (isIndex) {
          // A bare entry is a leaf ("lists.2"); a group has something after it.
          out.push(parts[i + 2] ? `List ${ORDINAL(next)}` : `Item ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Lists');
        break;
      case 'items':
        if (isIndex) {
          out.push(`Item ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Items');
        break;
      case 'flow':
        if (isIndex) {
          out.push(`Step ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Flow');
        break;
      case 'bars':
        if (isIndex) {
          out.push(`Bar ${ORDINAL(next)}`);
          i += 1;
        } else out.push('Bars');
        break;
      case 'foot':
        out.push('Total');
        break;
      case 'table':
        break;
      default:
        out.push(/^\d+$/.test(key) ? `Cell ${ORDINAL(key)}` : key);
    }
  }
  return out.join(' · ') || path;
}

/** Long sentences get a taller box; a kicker does not need four lines. */
function boxRows(text) {
  const len = String(text || '').length;
  // Spoken paragraphs on the talking deck run several hundred characters, and
  // editing a script through a three-line window is miserable.
  if (len > 520) return 9;
  if (len > 260) return 6;
  if (len > 140) return 4;
  if (len > 60) return 3;
  return 2;
}

export function pitchPanel() {
  const root = el('div', 'admin-panel admin-pitch');

  /** Saved overrides, as they exist on the server. */
  let saved = {};
  /** Working copy: {slideId: {path: text}}, deltas only. */
  let draft = {};
  let dirty = false;
  let statusNode = null;
  /** Which deck's slide cards are listed. */
  let deckId = DECKS[0].id;

  const editedCount = () =>
    Object.values(draft).reduce((n, patch) => n + Object.keys(patch).length, 0);

  function setStatus(text, kind = '') {
    if (!statusNode) return;
    statusNode.textContent = text;
    statusNode.className = `admin-hint${kind ? ` admin-notice-${kind}` : ''}`;
  }

  function markDirty() {
    dirty = true;
    setStatus(`${editedCount()} edited line${editedCount() === 1 ? '' : 's'}, not saved yet.`);
  }

  /** Record or clear one override. Equal to the source means no override. */
  function setValue(slideId, path, original, value) {
    if (value === original) {
      if (draft[slideId]) {
        delete draft[slideId][path];
        if (!Object.keys(draft[slideId]).length) delete draft[slideId];
      }
    } else {
      draft[slideId] = draft[slideId] || {};
      draft[slideId][path] = value;
    }
    markDirty();
  }

  function slideCard(slide, i) {
    const leaves = textLeaves(slide);
    const card = el('details', 'admin-pitch-slide');
    const summary = el('summary');
    summary.appendChild(el('span', 'admin-pitch-num', `${i + 1}`));
    summary.appendChild(el('span', 'admin-pitch-name', slide.title));
    const edits = Object.keys(draft[slide.id] || {}).length;
    if (edits) summary.appendChild(el('span', 'admin-pitch-badge', `${edits} edited`));
    summary.appendChild(el('span', 'admin-pitch-id', slide.id));
    card.appendChild(summary);

    const body = el('div', 'admin-pitch-fields');
    for (const leaf of leaves) {
      const wrap = el('label', 'admin-pitch-field');
      const head = el('div', 'admin-pitch-field-head');
      head.appendChild(el('span', 'admin-pitch-label', pathLabel(leaf.path)));

      const revert = button(
        'revert',
        () => {
          area.value = leaf.value;
          setValue(slide.id, leaf.path, leaf.value, leaf.value);
          area.classList.remove('is-edited');
          revert.hidden = true;
        },
        'admin-pitch-revert'
      );
      head.appendChild(revert);
      wrap.appendChild(head);

      const area = document.createElement('textarea');
      area.rows = boxRows(leaf.value);
      area.spellcheck = true;
      area.value = draft[slide.id]?.[leaf.path] ?? leaf.value;
      const changed = area.value !== leaf.value;
      area.classList.toggle('is-edited', changed);
      revert.hidden = !changed;
      area.addEventListener('input', () => {
        // A newline would be rendered as a space anyway (and is stripped by the
        // store), so fold it here rather than letting the box lie about it.
        if (area.value.includes('\n')) area.value = area.value.replace(/\s*\n\s*/g, ' ');
        setValue(slide.id, leaf.path, leaf.value, area.value);
        const now = area.value !== leaf.value;
        area.classList.toggle('is-edited', now);
        revert.hidden = !now;
      });
      wrap.appendChild(area);
      body.appendChild(wrap);
    }
    card.appendChild(body);
    return card;
  }

  async function save(btn) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      const record = await adminApi.savePitch(draft);
      saved = record.text || {};
      draft = JSON.parse(JSON.stringify(saved));
      dirty = false;
      // Redraw first: draw() replaces the panel's children, so a notice added
      // before it would be wiped out by the very repaint that confirms it.
      draw();
      notice(root, 'Saved. The deck shows it the next time it is opened or reloaded.', 'ok');
    } catch (err) {
      notice(root, err.message || 'Could not save.', 'error');
      setStatus('Not saved.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function revertAll(btn) {
    if (!window.confirm('Discard every saved edit and go back to the wording in the code?')) return;
    draft = {};
    await save(btn);
  }

  /** Which deck's cards are on screen. Edits to both are held in one draft. */
  function deckEdits(deck) {
    return deck.slides.reduce((n, s) => n + Object.keys(draft[s.id] || {}).length, 0);
  }

  function draw() {
    const deck = DECKS.find((d) => d.id === deckId) || DECKS[0];
    const wrap = el('div');

    const head = el('div', 'admin-pitch-head');
    head.appendChild(
      el(
        'p',
        'admin-hint',
        'Every sentence in both decks, editable. Saved text is served to the in-site decks and to the public share links. The talking deck also carries the spoken script shown in its transcript panel.'
      )
    );

    // Deck switch. One draft covers both, so switching never loses typing.
    const decks = el('div', 'admin-row admin-pitch-decks');
    for (const d of DECKS) {
      const n = deckEdits(d);
      const btn = button(
        `${d.label} · ${d.slides.length}${n ? ` · ${n} edited` : ''}`,
        () => {
          deckId = d.id;
          draw();
        },
        `admin-tab${d.id === deck.id ? ' active' : ''}`
      );
      decks.appendChild(btn);
    }
    head.appendChild(decks);

    const bar = el('div', 'admin-row admin-pitch-bar');
    bar.appendChild(button('Save changes', (e) => save(e.currentTarget), 'btn primary'));
    bar.appendChild(button('Revert everything', (e) => revertAll(e.currentTarget), 'btn'));

    const openDeck = el('a', 'btn', `Open ${deck.label.toLowerCase()}`);
    openDeck.href = deck.view;
    openDeck.target = '_blank';
    openDeck.rel = 'noopener';
    bar.appendChild(openDeck);

    const openPublic = el('a', 'btn', 'Open the public link');
    openPublic.href = deck.share;
    openPublic.target = '_blank';
    openPublic.rel = 'noopener';
    bar.appendChild(openPublic);

    statusNode = el('span', 'admin-hint');
    bar.appendChild(statusNode);
    head.appendChild(bar);
    wrap.appendChild(head);

    const list = el('div', 'admin-pitch-list');
    deck.slides.forEach((slide, i) => list.appendChild(slideCard(slide, i)));
    wrap.appendChild(list);

    render(root, wrap);
    const n = editedCount();
    setStatus(
      dirty
        ? `${n} edited line${n === 1 ? '' : 's'}, not saved yet.`
        : n
          ? `${n} edited line${n === 1 ? '' : 's'}, live.`
          : 'No edits. The deck is showing the wording from the code.'
    );
  }

  // Warn before losing typing, but only while there is typing to lose.
  const beforeUnload = (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  root._stopPolling = () => window.removeEventListener('beforeunload', beforeUnload);

  render(root, el('p', 'admin-hint', 'Loading the deck…'));
  adminApi
    .pitch()
    .then((record) => {
      saved = record?.text || {};
      draft = JSON.parse(JSON.stringify(saved));
      draw();
    })
    .catch((err) => {
      render(root, el('p', 'admin-error', err.message || 'Could not load the deck text.'));
    });

  return root;
}
