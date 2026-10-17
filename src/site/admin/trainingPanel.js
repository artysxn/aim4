// ---------------------------------------------------------------------------
// src/site/admin/trainingPanel.js
// /admin/training_1 … training_5: teaching the rule-based bot.
//
//   1  a random round, played back with the bot's description beside it;
//      yes or no, was it described right
//   2  the same, and after a yes the admin writes the round in their own words
//   3  a random team's antistrat, point by point, each with the rounds it was
//      written from; yes or no
//   4  the same, and after a no the admin says what is different or why it
//      matters
//   5  the bot's own opinions, two facts of the sheet put together into what
//      to do about them; yes or no, with an optional note
//
// Every answer is one line in a JSON Lines file per stage on the server
// (server/admin/trainingStore.js), exported from here as one .jsonl.
//
// Built with dom.js only: round, team and player names are library data.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, el } from './dom.js';
import { spinnerNode } from '../../lib/spinner.js';

export const STAGES = [
  { n: 1, title: 'Round descriptions', help: 'The bot plays a random round and describes it. Was the description right?' },
  { n: 2, title: 'Round descriptions + yours', help: 'Same, and after a yes you describe the round in your own words.' },
  { n: 3, title: 'Antistrat points', help: 'The bot writes an antistrat for a random team and goes through it point by point, with the rounds each point came from.' },
  { n: 4, title: 'Antistrat points + comments', help: 'Same, and after a no you say what is different or how it is relevant.' },
  { n: 5, title: 'Opinions', help: 'The bot puts two facts of the antistrat together and says what follows. Do you agree?' }
];

/** Rounds a point or an opinion opens in the viewer: enough to check it, few enough to load. */
const VIEWER_ROUNDS = 20;

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The antistrat a stage is working through survives a switch between stages
 * 3, 4 and 5: scanning a team takes long enough not to repeat for nothing.
 * @type {null | { choice: object, report: object, points: object[], opinions: object[] }}
 */
let sharedTeam = null;

/**
 * @param {{ stage: number, onStage: (n: number) => void }} opts
 * @returns {HTMLElement & { _stopPolling?: () => void }}
 */
export function trainingPanel({ stage, onStage }) {
  const root = el('div', 'tr-root');
  const head = el('div', 'tr-head');
  const work = el('div', 'tr-work');
  root.append(head, work);

  let stats = null;
  /** Records saved from this page, newest last: what "Undo" takes back. */
  const saved = [];
  let viewer = null;
  let destroyed = false;
  const info = STAGES.find((s) => s.n === stage) || STAGES[0];

  function dropViewer() {
    viewer?.destroy();
    viewer = null;
  }
  root._stopPolling = () => {
    destroyed = true;
    dropViewer();
  };

  // ---- header: stages, counts, export, undo -----------------------------------

  function renderHead() {
    const nav = el('div', 'tr-stages');
    for (const s of STAGES) {
      const b = button(`${s.n}. ${s.title}`, () => s.n !== stage && onStage(s.n), `tr-stage${s.n === stage ? ' is-on' : ''}`);
      nav.appendChild(b);
    }
    const c = stats?.counts?.[stage];
    const counts = el(
      'span',
      'admin-muted',
      c ? `${c.total} answered here (${c.yes} yes, ${c.no} no)` : 'Loading counts…'
    );
    const all = stats ? Object.values(stats.counts).reduce((n, x) => n + x.total, 0) : 0;
    const actions = el('div', 'tr-actions');
    actions.append(
      counts,
      button('Export this stage', () => download([stage]), 'btn btn-sm'),
      button(`Export all (${all})`, () => download([]), 'btn btn-sm')
    );
    if (saved.length) actions.appendChild(button('Undo last answer', undo, 'btn btn-sm'));
    head.replaceChildren(nav, el('p', 'tr-help', info.help), actions);
  }

  async function refreshStats(next = null) {
    try {
      stats = next || (await adminApi.labelStats());
    } catch {
      stats = null;
    }
    if (!destroyed) renderHead();
  }

  async function download(stages) {
    try {
      const { blob, name } = await adminApi.exportLabels(stages);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
      flash(`Export failed: ${err.message}`, true);
    }
  }

  async function undo() {
    const last = saved.pop();
    if (!last) return;
    try {
      const res = await adminApi.undoLabel(last.stage, last.id);
      await refreshStats(res);
      flash('Last answer removed.');
    } catch (err) {
      flash(`Undo failed: ${err.message}`, true);
    }
  }

  function flash(message, error = false) {
    const node = el('div', `tr-flash${error ? ' is-error' : ''}`, message);
    root.prepend(node);
    setTimeout(() => node.remove(), 4000);
  }

  async function save(body) {
    const res = await adminApi.saveLabel(stage, body);
    saved.push({ stage, id: res.record.id });
    await refreshStats(res);
  }

  // ---- the viewer, embedded ---------------------------------------------------

  /**
   * Play a list of rounds (full metas) inside the page.
   * @param {HTMLElement} host
   * @param {object[]} rounds
   * @param {(at: { index: number, tick: number }) => void} [onTick]
   */
  async function mountViewer(host, rounds, onTick) {
    dropViewer();
    host.replaceChildren(spinnerNode('Loading the viewer…'));
    const [{ createTimelineViewer }, { TickStore }] = await Promise.all([
      import('../../replays/viewer/timelineViewer.js'),
      import('../../replays/tickStore.js')
    ]);
    if (destroyed) return;
    const store = new TickStore();
    const v = createTimelineViewer({ store, rounds, escapeHtml, syncUrl: false, onTick, onBack: null });
    const frame = el('div', 'rv-overlay tr-viewer');
    frame.appendChild(v.el);
    host.replaceChildren(frame);
    viewer = {
      seekTo: (index, tick) => v.seekTo(index, tick),
      destroy() {
        v.destroy();
        store.cancelled = true;
      }
    };
  }

  /** Full metas for the first rounds of a list, in its order. */
  async function metasFor(files) {
    const { fetchRoundMeta } = await import('../../replays/api.js');
    const list = files.slice(0, VIEWER_ROUNDS);
    const metas = await Promise.all(list.map((f) => fetchRoundMeta(f).then((m) => (m ? { ...m, file: f } : null)).catch(() => null)));
    return metas.filter(Boolean);
  }

  // ---- verdict controls ---------------------------------------------------------

  /**
   * Yes / No (and Skip), with the text box a stage asks for.
   *   need: 'answer-on-yes' (stage 2), 'comment-on-no' (stage 4),
   *         'comment-optional' (stage 5), '' (stages 1 and 3)
   */
  function verdictBox({ need, onAnswer, onSkip, skipLabel = 'Skip' }) {
    const box = el('div', 'tr-verdict');
    const buttons = el('div', 'tr-verdict-buttons');
    const extra = el('div', 'tr-verdict-extra');
    const status = el('span', 'admin-muted');
    let busy = false;

    const submit = async (verdict, textValue = '') => {
      if (busy) return;
      busy = true;
      status.textContent = 'Saving…';
      try {
        await onAnswer(verdict, textValue.trim());
      } catch (err) {
        status.textContent = err.message;
        busy = false;
      }
    };
    const ask = (verdict, label, required) => {
      const area = document.createElement('textarea');
      area.className = 'tr-text';
      area.rows = 4;
      area.placeholder = label;
      const go = button(required ? 'Save' : 'Save answer', () => {
        if (required && !area.value.trim()) {
          status.textContent = 'Write something first.';
          area.focus();
          return;
        }
        submit(verdict, area.value);
      }, 'btn primary');
      const back = button('Back', () => {
        extra.replaceChildren();
        buttons.hidden = false;
      }, 'btn');
      buttons.hidden = true;
      extra.replaceChildren(el('p', 'tr-ask', `${verdict === 'yes' ? 'Yes' : 'No'}. ${label}`), area, el('div', 'tr-verdict-buttons', null));
      extra.lastChild.append(go, back);
      area.focus();
    };

    const yes = button('Yes, that is right', () => {
      if (need === 'answer-on-yes') ask('yes', 'Now describe the round in your own words.', true);
      else if (need === 'comment-optional') ask('yes', 'Anything to add? (optional)', false);
      else submit('yes');
    }, 'btn primary');
    const no = button('No', () => {
      if (need === 'comment-on-no') ask('no', 'What is different, or how is it relevant?', true);
      else if (need === 'comment-optional') ask('no', 'Why not? (optional)', false);
      else submit('no');
    }, 'btn');
    const skip = button(skipLabel, onSkip, 'btn btn-sm');
    buttons.append(yes, no, skip, status);
    box.append(buttons, extra);
    return box;
  }

  // ---- stages 1 and 2: a round, described ------------------------------------------

  async function nextRound() {
    dropViewer();
    work.replaceChildren(spinnerNode('Picking a round and describing it…'));
    let item;
    try {
      const { randomRoundStory } = await import('../../replays/training/trainingSources.js');
      item = await randomRoundStory();
    } catch (err) {
      work.replaceChildren(el('p', 'admin-error', `Could not load a round: ${err.message}`), button('Try again', nextRound));
      return;
    }
    if (destroyed) return;
    const { meta, story, file, demoId } = item;
    const viewerHost = el('div', 'tr-viewer-host');
    const side = el('div', 'tr-side');
    const title = el(
      'h3',
      'tr-title',
      `${meta.mapName || meta.map} · round ${meta.round} · ${meta.team1?.name || 'Team 1'} vs ${meta.team2?.name || 'Team 2'}`
    );
    const beats = el('ol', 'tr-beats');
    const rows = story.beats.map((b) => {
      const li = el('li', `tr-beat tr-beat-${b.kind}`);
      li.append(el('span', 'tr-clock', b.clock), el('span', 'tr-beat-text', b.text));
      li.title = 'Jump here';
      li.addEventListener('click', () => viewer?.seekTo(0, b.tick));
      beats.appendChild(li);
      return { li, tick: b.tick };
    });
    // The beat the playhead has passed most recently is the one lit.
    let lit = null;
    const onTick = ({ tick }) => {
      let cur = null;
      for (const r of rows) if (r.tick <= tick) cur = r;
      if (cur === lit) return;
      lit?.li.classList.remove('is-now');
      cur?.li.classList.add('is-now');
      lit = cur;
    };
    side.append(
      title,
      el('p', 'admin-muted', 'Play the round (Space) and read along. Click a line to jump to it.'),
      beats,
      verdictBox({
        need: stage === 2 ? 'answer-on-yes' : '',
        onSkip: nextRound,
        skipLabel: 'Skip round',
        onAnswer: async (verdict, text) => {
          await save({
            engine: 'rules-1',
            subject: {
              round: file,
              demoId,
              map: meta.map,
              roundNumber: meta.round,
              team1: meta.team1?.name || '',
              team2: meta.team2?.name || ''
            },
            bot: { text: story.text, beats: story.beats, facts: story.facts },
            verdict,
            answer: text
          });
          nextRound();
        }
      })
    );
    work.replaceChildren(el('div', 'tr-split', null));
    work.firstChild.append(viewerHost, side);
    await mountViewer(viewerHost, [meta], onTick);
  }

  // ---- stages 3, 4 and 5: a team's antistrat ---------------------------------------

  let index = 0;

  async function loadTeam(choice = null) {
    dropViewer();
    work.replaceChildren(spinnerNode('Picking a team…'));
    const sources = await import('../../replays/training/trainingSources.js');
    const { opinionsFrom } = await import('../../replays/training/opinions.js');
    let choices;
    try {
      choices = await sources.teamMapChoices();
    } catch (err) {
      work.replaceChildren(el('p', 'admin-error', `Could not list teams: ${err.message}`));
      return;
    }
    if (!choices.length) {
      work.replaceChildren(el('p', 'admin-empty', `No team has ${sources.TEAM_MIN_DEMOS} demos on one map yet.`));
      return;
    }
    const pickTeam = choice || choices[Math.floor(Math.random() * choices.length)];
    const progress = el('p', 'admin-muted', '');
    work.replaceChildren(
      el('h3', 'tr-title', `${pickTeam.teamName} on ${pickTeam.mapCode} (${pickTeam.demoIds.length} demos)`),
      spinnerNode('Running the antistrat…'),
      progress
    );
    try {
      const summary = await sources.teamSummary(pickTeam, (label) => {
        progress.textContent = label;
      });
      sharedTeam = { choice: pickTeam, choices, report: summary.report, points: summary.points, opinions: opinionsFrom(summary.report) };
    } catch (err) {
      work.replaceChildren(el('p', 'admin-error', `The antistrat failed: ${err.message}`), button('Another team', () => loadTeam()));
      return;
    }
    if (destroyed) return;
    index = 0;
    showItem();
  }

  /** The team bar: which team, how far through it, and a way to another one. */
  function teamBar(total) {
    const bar = el('div', 'tr-teambar');
    const { choice, choices } = sharedTeam;
    const pickEl = document.createElement('select');
    pickEl.className = 'tr-team-select';
    choices.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${c.teamName} · ${c.mapCode} · ${c.demoIds.length} demos`;
      if (c === choice || (c.teamKey === choice.teamKey && c.mapCode === choice.mapCode)) o.selected = true;
      pickEl.appendChild(o);
    });
    pickEl.addEventListener('change', () => loadTeam(choices[Number(pickEl.value)]));
    bar.append(
      pickEl,
      button('Random team', () => loadTeam(), 'btn btn-sm'),
      el('span', 'admin-muted', total ? `${Math.min(index + 1, total)} of ${total}` : '')
    );
    return bar;
  }

  async function showItem() {
    if (!sharedTeam) return loadTeam();
    const list = stage === 5 ? sharedTeam.opinions : sharedTeam.points;
    dropViewer();
    if (index >= list.length) {
      work.replaceChildren(
        teamBar(list.length),
        el('p', 'admin-empty', list.length ? 'That was the last one for this team.' : stage === 5 ? 'The bot has no opinion on this team yet.' : 'This antistrat has no points with rounds.'),
        button('Next team', () => loadTeam(), 'btn primary')
      );
      return;
    }
    const item = list[index];
    const { choice } = sharedTeam;
    const viewerHost = el('div', 'tr-viewer-host');
    const side = el('div', 'tr-side');
    const advance = () => {
      index++;
      showItem();
    };

    if (stage === 5) {
      side.append(
        el('p', 'tr-kicker', `Opinion · ${item.rule}`),
        el('p', 'tr-claim', item.text),
        el('p', 'admin-field-label', 'Built from:'),
        (() => {
          const ul = el('ul', 'tr-because');
          for (const b of item.because) ul.appendChild(el('li', null, b));
          return ul;
        })()
      );
    } else {
      // Section headings already start with the side ("CT Positions"); a player's
      // heading does not.
      const where = item.side && !item.section.startsWith(`${item.side} `) ? `${item.side} · ${item.section}` : item.section;
      side.append(el('p', 'tr-kicker', where), el('p', 'tr-claim', item.text));
    }
    const shown = Math.min(item.files.length, VIEWER_ROUNDS);
    side.appendChild(
      el('p', 'admin-muted', `Based on ${item.files.length} round${item.files.length === 1 ? '' : 's'}${shown < item.files.length ? `; the first ${shown} are in the viewer` : ''}.`)
    );
    side.appendChild(
      verdictBox({
        need: stage === 4 ? 'comment-on-no' : stage === 5 ? 'comment-optional' : '',
        onSkip: advance,
        onAnswer: async (verdict, text) => {
          const subject = {
            team: choice.teamName,
            teamKey: choice.teamKey,
            map: choice.mapCode,
            demoIds: choice.demoIds,
            files: item.files
          };
          const bot =
            stage === 5
              ? { text: item.text, rule: item.rule, key: item.key, because: item.because }
              : { text: item.text, side: item.side, section: item.section };
          await save({ engine: 'rules-1', subject, bot, verdict, comment: text });
          advance();
        }
      })
    );
    work.replaceChildren(teamBar(list.length), el('div', 'tr-split', null));
    work.lastChild.append(viewerHost, side);
    const metas = await metasFor(item.files);
    if (destroyed || (stage === 5 ? sharedTeam.opinions : sharedTeam.points)[index] !== item) return;
    if (metas.length) await mountViewer(viewerHost, metas);
    else viewerHost.replaceChildren(el('p', 'admin-empty', 'None of these rounds could be loaded.'));
  }

  renderHead();
  refreshStats();
  if (stage <= 2) nextRound();
  else showItem();
  return root;
}
