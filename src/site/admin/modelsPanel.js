// ---------------------------------------------------------------------------
// src/site/admin/modelsPanel.js
// Training controls and diagnostics for the two fitted models.
//
// One card per model. Each carries the same four things, in the order they get
// looked at: what is happening right now, what the reigning model scores, every
// attempt that has been made at beating it, and the full parameter listing.
//
// The parameter listing is the part worth having. A fitted model is a vector of
// numbers and a vector of numbers explains nothing; what makes it inspectable
// is seeing each weight beside the range it was allowed to move in, the group
// the optimizer puts it in, the scenarios it is answerable for, and two flags
// that mean "do not trust this one": pinned against a bound somebody chose, or
// never moved from its starting guess because the corpus had nothing to teach
// it.
//
// Nodes only, no innerHTML, same as every other admin panel.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, el, field, input, row, table } from './dom.js';

const POLL_MS = 2000;

const MODELS = [
  {
    kind: 'round',
    title: 'Round win model',
    unit: 'rounds',
    blurb: 'Predicts which side wins the round, from bodies, economy, map control, the bomb and the open gunfights.'
  },
  {
    kind: 'duel',
    title: 'Gunfight model',
    unit: 'duels',
    blurb: 'Predicts who wins a fight, from crosshair placement, weapons, range, movement and who else is looking.'
  }
];

const f4 = (n) => (Number.isFinite(n) ? n.toFixed(4) : '—');
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const int = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—');
const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};
/** A coin flip scores ln 2; everything is measured against that. */
const COIN_FLIP = Math.log(2);

export function initModelsPanel() {
  const root = el('div', 'admin-panel');
  const timers = [];

  for (const model of MODELS) {
    root.appendChild(buildCard(model, timers));
  }

  root._stopPolling = () => {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  };
  return root;
}

function buildCard(model, timers) {
  const card = el('div', 'admin-tool-card');
  card.appendChild(el('h3', 'admin-tool-title', model.title));
  card.appendChild(el('p', 'admin-hint', model.blurb));

  // --- controls -------------------------------------------------------------
  const genInput = input('number', '30');
  genInput.min = '1';
  genInput.max = '500';
  const seedInput = input('text', '', 'random');
  const workersInput = input('number', '4');
  workersInput.min = '1';
  workersInput.max = '32';

  const status = el('p', 'admin-hint', 'Loading…');
  const bar = el('div', 'ingest-bar');
  const fill = el('div', 'ingest-bar-fill');
  bar.appendChild(fill);
  const progressWrap = el('div', 'ingest-progress');
  progressWrap.appendChild(bar);
  const progressMeta = el('div', 'ingest-progress-meta');
  progressWrap.appendChild(progressMeta);
  progressWrap.hidden = true;

  const startBtn = button('Start training', () => start());
  const stopBtn = button('Stop', () => stop(), 'btn btn-ghost');
  stopBtn.disabled = true;

  card.appendChild(
    row(
      field('Generations', genInput),
      field('Seed', seedInput),
      field('Threads', workersInput),
      startBtn,
      stopBtn
    )
  );
  card.appendChild(status);
  card.appendChild(progressWrap);

  const championBox = el('div', 'admin-subsection');
  card.appendChild(championBox);
  const historyBox = el('div', 'admin-subsection');
  card.appendChild(historyBox);
  const weightsBox = el('div', 'admin-subsection');
  card.appendChild(weightsBox);

  let polling = null;

  function setBusy(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    startBtn.textContent = running ? 'Running…' : 'Start training';
  }

  async function start() {
    setBusy(true);
    status.className = 'admin-hint';
    status.textContent = 'Starting…';
    try {
      const seedRaw = seedInput.value.trim();
      const job = await adminApi.trainingStart(model.kind, {
        generations: Number(genInput.value) || 30,
        // Blank means "surprise me", which is the point of pressing it again:
        // each press searches a different corner of the space.
        seed: seedRaw === '' ? undefined : Number(seedRaw),
        workers: Number(workersInput.value) || 4
      });
      render(job);
      startPoll();
    } catch (err) {
      setBusy(false);
      status.className = 'admin-error';
      status.textContent = err.message || 'Could not start training.';
    }
  }

  async function stop() {
    stopBtn.disabled = true;
    try {
      // The child is asked, not killed: it finishes the generation it is in and
      // still offers its best model, so a run that already found something is
      // not thrown away by pressing stop.
      render(await adminApi.trainingStop(model.kind));
    } catch (err) {
      status.className = 'admin-error';
      status.textContent = err.message || 'Could not stop training.';
    }
  }

  function startPoll() {
    stopPoll();
    polling = setInterval(pollOnce, POLL_MS);
    timers.push(polling);
  }

  function stopPoll() {
    if (polling) clearInterval(polling);
    polling = null;
  }

  async function pollOnce() {
    try {
      const job = await adminApi.trainingStatus(model.kind);
      render(job);
      if (!job.running) {
        stopPoll();
        await loadWeights();
      }
    } catch {
      stopPoll();
    }
  }

  function render(job) {
    if (!job) return;
    setBusy(Boolean(job.running));

    if (job.running) {
      // Extraction and fitting are separate progress bars wearing one widget.
      // Extraction is the long half on a large library and reports per demo;
      // showing a stalled zero for all of it is what makes a working run look
      // hung.
      const extracting = job.stage === 'extracting' || job.stage === 'starting';
      const pct = extracting
        ? job.demosTotal > 0
          ? Math.min(100, (job.demosDone / job.demosTotal) * 100)
          : 0
        : job.generations > 0
          ? Math.min(100, (job.generation / job.generations) * 100)
          : 0;
      progressWrap.hidden = false;
      fill.style.width = `${pct.toFixed(1)}%`;
      progressMeta.textContent = extracting
        ? job.demosTotal > 0
          ? `Extracting: ${job.demosDone} of ${job.demosTotal} demos (${pct.toFixed(0)}%)`
          : 'Reading the replay library'
        : job.stage === 'stopping'
          ? 'Stopping after this generation'
          : `Generation ${job.generation} of ${job.generations} (${pct.toFixed(0)}%)`;

      const bits = [`seed ${job.seed ?? '—'}`];
      if (Number.isFinite(job.trainLoss)) bits.push(`train ${f4(job.trainLoss)}`);
      if (Number.isFinite(job.validLoss)) bits.push(`held out ${f4(job.validLoss)}`);
      if (Number.isFinite(job.bestValidLoss)) {
        bits.push(`best ${f4(job.bestValidLoss)} at gen ${job.bestGeneration}`);
      }
      status.className = 'admin-hint';
      status.textContent = bits.join(' · ');
    } else {
      progressWrap.hidden = true;
      status.className = job.stage === 'failed' || job.crashed ? 'admin-error' : 'admin-hint';
      if (job.crashed) {
        status.textContent = 'The last run stopped without finishing.';
      } else if (job.stage === 'failed') {
        status.textContent = `Last run failed: ${job.error || 'unknown error'}`;
      } else if (job.finished) {
        const outcome =
          job.promoted === true
            ? `promoted (${job.promoteReason || 'improved'})`
            : job.promoted === false
              ? `kept the existing model (${job.promoteReason || 'no improvement'})`
              : 'finished';
        status.textContent = `Last run ${outcome}, ${when(job.finishedAt)}`;
      } else {
        status.textContent = 'Idle.';
      }
    }

    renderChampion(job.champion);
    renderHistory(job.champion);
  }

  function renderChampion(champion) {
    championBox.replaceChildren();
    championBox.appendChild(el('h4', 'admin-subtitle', 'Deployed model'));
    if (!champion) {
      championBox.appendChild(
        el('p', 'admin-hint', 'Nothing trained yet. The site is using the weights that shipped.')
      );
      return;
    }
    const improvement = champion.totalImprovement;
    championBox.appendChild(
      table(
        ['Held-out loss', 'vs coin flip', 'Total improvement', model.unit, 'Promotions', 'Updated'],
        [
          [
            f4(champion.validLoss),
            // The only honest yardstick: ln 2 is what guessing scores.
            Number.isFinite(champion.validLoss)
              ? `${(((COIN_FLIP - champion.validLoss) / COIN_FLIP) * 100).toFixed(1)}% better`
              : '—',
            Number.isFinite(improvement) && improvement > 0
              ? `${f4(improvement)} since the first`
              : 'first champion',
            int(champion.trainedOn),
            int(champion.promotions),
            when(champion.updatedAt)
          ]
        ]
      )
    );

    const exams = champion.exams;
    if (exams && (exams.examEarly || exams.examMid || exams.examFinal)) {
      championBox.appendChild(el('h4', 'admin-subtitle', 'Exams, held out'));
      championBox.appendChild(
        table(
          ['Exam', 'Log loss', 'Points per round', 'Predicted', 'Actual'],
          [
            ['Early to mid', exams.examEarly],
            ['Mid to late', exams.examMid],
            ['10s before end', exams.examFinal]
          ]
            .filter(([, e]) => e)
            .map(([label, e]) => [
              label,
              f4(e.logLoss),
              Number.isFinite(e.exam) ? `${e.exam > 0 ? '+' : ''}${f2(e.exam)}` : '—',
              Number.isFinite(e.predicted) ? `${(e.predicted * 100).toFixed(1)}%` : '—',
              Number.isFinite(e.actual) ? `${(e.actual * 100).toFixed(1)}%` : '—'
            ])
        )
      );
    }
  }

  function renderHistory(champion) {
    historyBox.replaceChildren();
    const history = champion?.history || [];
    if (!history.length) return;
    historyBox.appendChild(el('h4', 'admin-subtitle', 'Attempts'));
    historyBox.appendChild(
      table(
        ['When', 'Seed', 'Best gen', 'Held-out loss', 'Outcome'],
        [...history]
          .reverse()
          .slice(0, 25)
          .map((h) => [
            when(h.at),
            h.seed == null ? '—' : String(h.seed),
            int(h.generation),
            f4(h.validLoss),
            h.promoted ? 'promoted' : h.reason || 'kept existing'
          ])
      )
    );
  }

  async function loadWeights() {
    try {
      const w = await adminApi.trainingWeights(model.kind);
      weightsBox.replaceChildren();
      weightsBox.appendChild(
        el('h4', 'admin-subtitle', `Weights and biases (${w.count}, ${w.source})`)
      );
      weightsBox.appendChild(
        el(
          'p',
          'admin-hint',
          `${w.atBound} pinned at a bound, ${w.neverMoved} never moved from their starting value. ` +
            'Both mean the fit is not being driven by the data at that parameter.'
        )
      );
      weightsBox.appendChild(
        table(
          ['Parameter', 'Value', 'Start', 'Range', 'Group', 'Scenarios', 'Flag'],
          w.params.map((p) => [
            p.name,
            f4(p.value),
            f4(p.init),
            `${f2(p.min)} to ${f2(p.max)}`,
            p.group,
            (p.buckets || []).join(', ') || '—',
            p.atBound ? 'at a bound' : p.neverMoved ? 'never moved' : ''
          ])
        )
      );
    } catch (err) {
      weightsBox.replaceChildren();
      weightsBox.appendChild(el('p', 'admin-error', err.message || 'Could not read the weights.'));
    }
  }

  // Attach to whatever is already happening, so a run started in another tab or
  // before a reload shows up immediately.
  pollOnce().then(() => {
    loadWeights();
    if (startBtn.disabled) startPoll();
  });

  return card;
}
