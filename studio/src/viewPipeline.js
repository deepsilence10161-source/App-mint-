/* ============================================================================
   PIPELINE — the stepper, drawn from the run that is actually happening
   ----------------------------------------------------------------------------
   engine/spec/pipeline.mjs turns the steps GitHub Actions reported into stages.
   This file draws them, and adds the two things a stepper most often gets wrong:

     · it never advances on a timer. A stage moves because a step moved.
     · it never claims "Done" while the run is still going, and it says
       "cancelled" when that is what happened, which is neither a pass nor a
       failure and should not be dressed up as one.

   Steps that belong to no stage are listed underneath rather than dropped, and
   stages this workflow never had are named as absent. A stepper that only shows
   what it expects will look green all the way through a build that is failing
   somewhere it never learned to look.
   ========================================================================= */

/** Status marker for one stage. */
function stageMark(status) {
  const glyph = { done: 'check', running: 'spin', failed: 'cross', cancelled: 'minus', waiting: 'dot' }[status] || 'dot';
  return el('span', { class: `pmark s-${status}`, 'aria-hidden': 'true', html: svg(PIPE_ICONS[glyph]) });
}

function stageNode(stage, index) {
  const label = stage.key === 'done' ? 'Done' : `${index + 1}. ${stage.label}`;
  return el('li', { class: `pstep s-${stage.status}`, 'data-stage': stage.key },
    stageMark(stage.status),
    el('div', { class: 'pstep-main' },
      el('span', { class: 'pstep-name' }, label),
      stage.detail ? el('span', { class: 'pstep-detail' }, stage.detail) : null,
      stage.steps && stage.steps.length
        ? el('ul', { class: 'pstep-steps' },
            ...stage.steps.map((s) => el('li', { class: `s-${buildStepStatus(s)}` },
              el('span', { class: 'pdot', 'aria-hidden': 'true' }),
              el('span', { class: 'pname' }, s.name),
              el('span', { class: 'pstate' }, buildStepStatus(s)),
            )))
        : null,
    ),
  );
}

/**
 * The Build pipeline section. Returns [] when there is nothing to report, so the
 * Build screen does not grow an empty box around a build nobody started.
 */
function viewPipeline() {
  const P = S.pipeline;
  if (!P || (!P.run && !P.polling)) return [];

  const run = P.run;
  const stages = pipelineStages(P.steps || [], stagesFor(run ? run.name : ''), run);

  const head = el('div', { class: 'phead' },
    el('span', { class: 'pill ' + (run && run.conclusion === 'success' ? 'pass' : (run && run.conclusion && run.conclusion !== 'success' ? 'fail' : 'warn')) },
      run ? `${(run.conclusion || run.status || 'starting').toUpperCase()}` : 'STARTING'),
    run && run.run_number ? el('span', { class: 'val' }, `Run #${run.run_number}`) : null,
    run && run.html_url
      ? el('a', { class: 'btn ghost small', href: run.html_url, target: '_blank', rel: 'noopener' }, 'Open the run')
      : null,
  );

  const body = [
    el('ol', { class: 'pipeline' }, ...stages.stages.map(stageNode)),
  ];

  if (stages.other.length) {
    body.push(el('details', { class: 'pother' },
      el('summary', {}, `${stages.other.length} step${stages.other.length === 1 ? '' : 's'} outside these stages`),
      el('ul', { class: 'pstep-steps' },
        ...stages.other.map((s) => el('li', { class: `s-${buildStepStatus(s)}` },
          el('span', { class: 'pdot', 'aria-hidden': 'true' }),
          el('span', { class: 'pname' }, s.name),
          el('span', { class: 'pstate' }, buildStepStatus(s)),
        ))),
    ));
  }

  if (stages.absent.length) {
    body.push(el('p', { class: 'hint' },
      `Not part of this pipeline: ${stages.absent.join(', ')}. These stages exist in other workflows, not this one.`));
  }

  if (P.polling && (!run || run.status !== 'completed')) {
    body.push(el('div', { class: 'skel skel-line', 'aria-hidden': 'true' }));
    body.push(el('p', { class: 'hint' }, P.error
      ? `Still waiting, but the last check failed: ${P.error}`
      : 'Watching the run. Each stage moves when its real steps move.'));
  }

  const outcome = outcomeNode(P);

  return [card('Build pipeline', [head, ...body, outcome],
    'The stages are the steps this workflow reported, grouped. Nothing here advances on a timer.')];
}

/* ── the outcome ────────────────────────────────────────────────────────────
   The design prompt asks for an elegant success state rather than confetti:
   an animated checkmark, then the file with its size and checksum. The size
   and checksum come from the artifact GitHub actually stored, so they are the
   properties of the file a person is about to download and not a description
   of what the file was meant to be.
   ─────────────────────────────────────────────────────────────────────────── */
function sayBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function outcomeNode(P) {
  const run = P.run;
  if (!run || run.status !== 'completed') return null;

  // The checkmark is drawn, not swapped in: the stroke is animated from nothing
  // so the mark appears to be drawn as you look at it. One shape, one property.
  const glyph = run.conclusion === 'success'
    ? el('span', { class: 'outcome-mark ok', html: '<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="om-ring" cx="26" cy="26" r="23"/><path class="om-tick" d="M15 27l8 8 15-16"/></svg>' })
    : el('span', { class: 'outcome-mark ' + (run.conclusion === 'cancelled' ? 'warn' : 'bad'), html: svg(run.conclusion === 'cancelled' ? PIPE_ICONS.minus : PIPE_ICONS.cross) });

  const arts = P.artifacts || [];
  const apks = arts.filter((a) => /apk|aab/i.test(a.name));

  const kids = [
    glyph,
    el('div', { class: 'outcome-text' },
      el('h3', {}, run.conclusion === 'success' ? 'The build succeeded'
        : run.conclusion === 'cancelled' ? 'The build was cancelled'
        : 'The build failed'),
      el('p', { class: 'hint' }, run.conclusion === 'success'
        ? 'Everything below was verified against the finished file, not against the specification that described it.'
        : run.conclusion === 'cancelled'
        ? 'It was stopped before it finished, so nothing here was verified. That is not the same as a build that failed.'
        : 'The stages above name the step that failed.'),
    ),
  ];

  if (run.conclusion === 'success' && apks.length) {
    kids.push(el('ul', { class: 'outcome-files' },
      ...apks.map((a) => el('li', {},
        el('span', { class: 'fname' }, a.name),
        sayBytes(a.size_in_bytes) ? el('span', { class: 'fsize' }, sayBytes(a.size_in_bytes)) : null,
        a.sha256 ? el('code', { class: 'fsha', title: a.sha256 }, `sha256 ${a.sha256.slice(0, 16)}…`) : null,
        a.id ? el('a', { class: 'btn ghost small', href: `https://api.github.com/repos/${(store.repo() || 'deepsilence10161-source/App-mint-')}/actions/artifacts/${a.id}/zip`, target: '_blank', rel: 'noopener' }, 'Download') : null,
      ))));
  } else if (run.conclusion === 'success') {
    kids.push(el('p', { class: 'hint' }, 'The run reported no APK artifact, so there is nothing to download from here.'));
  }

  return el('div', { class: `outcome s-${run.conclusion || 'unknown'}` }, kids);
}
