/* ============================================================================
   HEALTH — score rings, and the answer to "why?"
   ----------------------------------------------------------------------------
   The design prompt asks for score rings and then adds the part that decides
   whether they are worth anything: a person has to be able to open "Why this
   score?" and see the checks. A ring with no explanation is decoration, and a
   room full of decorative numbers teaches people to ignore all of them.

   So every ring here is drawn from engine/spec/health.mjs, which derives its
   scores from validateSpec and permissionReport — the same two calls the Build
   screen, the CLI and CI already make. Nothing is calculated twice, which means
   the number on this screen cannot drift from the one in the build report, and
   each ring expands into the exact list of checks, each with the reason it
   passed, warned or failed.

   A category with nothing to measure shows a dash and says so. It does not show
   a reassuring 100 for a thing nobody configured.
   ========================================================================= */

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

/** A score as a ring. The arc length is the score; nothing else is implied. */
function scoreRing(score, band) {
  const frac = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const dash = RING_C * frac;
  return el('span', { class: `ring band-${band}`, role: 'img', 'aria-label': score === null ? 'Nothing to measure' : `Score ${score} of 100` },
    el('span', {
      html: `<svg viewBox="0 0 64 64" aria-hidden="true">
        <circle class="ring-track" cx="32" cy="32" r="${RING_R}"/>
        <circle class="ring-arc" cx="32" cy="32" r="${RING_R}"
          stroke-dasharray="${dash.toFixed(2)} ${(RING_C - dash).toFixed(2)}"/>
      </svg>`,
    }),
    el('span', { class: 'ring-num' }, score === null ? '—' : String(score)),
  );
}

/** The list behind "Why this score?" — one row per check, with its reason. */
function whyList(category) {
  if (!category.checks.length) {
    return el('p', { class: 'why-none' },
      'Nothing to measure. This category scores no number at all rather than a score invented to fill the grid.');
  }
  return el('ul', { class: 'why' },
    ...category.checks.map((c) => el('li', { class: `why-row s-${c.status}` },
      el('span', { class: 'why-mark', 'aria-hidden': 'true' }),
      el('span', { class: 'why-main' },
        el('span', { class: 'why-name' }, c.name),
        el('span', { class: 'why-detail' }, c.detail),
      ),
      el('span', { class: 'why-tag' }, c.status),
    )));
}

function ringCard(category) {
  const counts = [];
  if (category.failing) counts.push(`${category.failing} failing`);
  if (category.warning) counts.push(`${category.warning} warning${category.warning === 1 ? '' : 's'}`);
  if (!counts.length && category.checks.length) counts.push(`${category.checks.length} checks passed`);
  if (!category.checks.length) counts.push('not configured');

  return el('article', { class: `card ringcard band-${category.band}` },
    el('div', { class: 'ringhead' },
      scoreRing(category.score, category.band),
      el('div', { class: 'ringmeta' },
        el('h3', { class: 'ringname' }, category.label),
        el('p', { class: 'ringsub' }, counts.join(' · ')),
      ),
    ),
    el('details', { class: 'why-box' },
      el('summary', {}, 'Why this score?'),
      whyList(category),
    ),
  );
}

/** The Health section. */
function viewHealth() {
  const spec = S.active ? S.active.spec : {};
  const validation = check();
  const report = permissionReport(spec);
  const health = projectHealth(spec, validation, report);

  const weakest = health.categories.find((c) => c.key === health.weakest);

  const overallText = health.overall === null
    ? 'Nothing is measurable yet, so there is no overall number to show.'
    : `The weakest of the ${health.measured} measured categor${health.measured === 1 ? 'y' : 'ies'}` +
      (weakest ? `, which is ${weakest.label}` : '') +
      '. Not an average — an average hides the one thing that will stop the build.';

  const out = [
    section('Project health', {
      icon: I.gauge,
      open: true,
      summary: `${health.measured} measured · ${health.unmeasured} not measured`,
      children: [
        el('div', { class: 'rings' }, ...health.categories.map(ringCard)),
      ],
    }),

    // The overall number is the weakest measured category, not an average of
    // them. An average let a specification that cannot build report a
    // comfortable score because four other categories were content with it.
    section('The overall number', {
      icon: I.spark,
      open: true,
      summary: overallText,
      children: [
        el('div', { class: 'overall' },
          scoreRing(health.overall, bandOf(health.overall)),
          el('div', { class: 'ringmeta' },
            el('h3', { class: 'ringname' }, health.overall === null ? 'No score' : `${health.overall} / 100`),
            el('p', { class: 'ringsub' },
              health.overall === null
                ? 'Configure something measurable first.'
                : `${health.measured} measured · ${health.unmeasured} not measured` +
                  (weakest ? ` · weakest: ${weakest.label} at ${weakest.score}` : '')),
          ),
        ),
      ],
    }),
  ];

  if (health.unmeasured) {
    const names = health.categories.filter((c) => c.score === null).map((c) => c.label);
    out.push(el('div', { class: 'banner info' }, el('div', {}, [
      el('strong', {}, `${health.unmeasured} categor${health.unmeasured === 1 ? 'y' : 'ies'} not measured: ${names.join(', ')}. `),
      'Left blank on purpose. A score with nothing behind it is worse than no score, because it gets read and believed.',
    ])));
  }

  return out;
}
