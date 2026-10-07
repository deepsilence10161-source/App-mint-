/* ==================================================================== *
 * HOME  (the dashboard) and the TEMPLATE GALLERY
 * ====================================================================
 * What this is
 * ------------
 * The screen you land on when there is no project, and the screen the mark in
 * the top bar takes you back to. It answers one question — "how do I start?" —
 * with four explicit creation methods rather than a list that only says
 * "templates", and it shows the work you already have underneath them.
 *
 * Three things are deliberately true of everything below:
 *
 *   1. NOTHING IS INVENTED. The health badge on a project is the number the
 *      engine derives (engine/spec/health.mjs), the thumbnail is drawn from the
 *      project's own theme, and the counts are read out of the specification.
 *      A dashboard is exactly where a reassuring number would go unnoticed.
 *
 *   2. NO SECOND COPY OF ANYTHING. The template list, the component names and
 *      the permission rules all come from where they already live. The only
 *      thing declared here is the category a template belongs to, because that
 *      is a fact about the gallery and about nothing else.
 *
 *   3. NO EXTERNAL RESOURCES. The illustrations and the thumbnails are inline
 *      SVG drawn from the tokens; the Studio is one file that works offline.
 */

const LS_HOME = 'appmint.home.v1';   // the gallery's search and filter

const homeState = () => {
  if (!S.home) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_HOME) || '{}'); } catch { /* first run */ }
    S.home = { q: typeof saved.q === 'string' ? saved.q : '', cat: saved.cat || 'all' };
  }
  return S.home;
};

const saveHomeState = () => {
  try { localStorage.setItem(LS_HOME, JSON.stringify({ q: homeState().q, cat: homeState().cat })); }
  catch { /* a filter that cannot be remembered is not a failure */ }
};

/* Which shelf a template sits on. This is the one fact the gallery owns: it is
   about browsing, not about the app the template makes. */
const TEMPLATE_CATEGORY = {
  blank: 'Start',
  business: 'Business',
  portfolio: 'Portfolio',
  commerce: 'Shop',
  education: 'Learning',
  news: 'News',
  tournament: 'Community',
  utility: 'Tools',
  dashboard: 'Business',
};

/* ── illustrations ──────────────────────────────────────────────────────── */

/*
 * Geometric line drawings, in the tokens, with the brand gradient used once.
 * Called "illustration" rather than "icon" on purpose: at 120px these are the
 * empty-state drawings the design spec asks for, not scaled-up icons.
 */
function illustration(kind, size = 120) {
  const g = `<linearGradient id="ill-g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--brand)"/><stop offset="1" stop-color="var(--mint)"/>
    </linearGradient>`;
  const drawings = {
    // a stack of screens, none of them written yet
    'no-projects': `
      <rect x="26" y="14" width="68" height="92" rx="10" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
      <rect x="16" y="26" width="68" height="92" rx="10" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
      <rect x="36" y="38" width="68" height="92" rx="10" fill="none" stroke="url(#ill-g)" stroke-width="1.8"/>
      <path d="M46 56h48M46 70h34M46 84h42" stroke="url(#ill-g)" stroke-width="1.8" stroke-linecap="round" opacity="0.8"/>
      <circle cx="46" cy="112" r="3" fill="url(#ill-g)"/>`,
    // a magnifier over nothing
    'no-results': `
      <circle cx="58" cy="56" r="30" fill="none" stroke="url(#ill-g)" stroke-width="1.8"/>
      <path d="m80 78 20 20" stroke="url(#ill-g)" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M44 50h28M44 62h18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>`,
    // an empty phone, waiting
    'empty-screen': `
      <rect x="38" y="10" width="64" height="112" rx="12" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"/>
      <path d="M70 22h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
      <path d="M52 52h36M52 68h24" stroke="url(#ill-g)" stroke-width="1.8" stroke-linecap="round"/>
      <rect x="52" y="84" width="36" height="14" rx="7" fill="none" stroke="url(#ill-g)" stroke-width="1.8"/>`,
  };
  const body = drawings[kind] || drawings['no-projects'];
  return `<svg class="ill" viewBox="0 0 140 140" width="${size}" height="${size}" aria-hidden="true" role="presentation">
    <defs>${g}</defs>${body}
  </svg>`;
}

/** An empty state: drawing, a sentence, and the one action worth taking. */
function emptyState(kind, title, text, action) {
  return el('div', { class: 'empty-state' }, [
    el('span', { class: 'ill-wrap', html: illustration(kind) }),
    el('p', { class: 'empty-title' }, title),
    el('p', { class: 'sub' }, text),
    action || null,
  ]);
}

/* ── what a project looks like, small ───────────────────────────────────── */

/** Counts read out of the specification, so the card cannot flatter it. */
function projectStats(spec) {
  let components = 0;
  const walk = (list) => {
    for (const n of list || []) { components += 1; walk(n.children); }
  };
  for (const s of spec.screens || []) walk(s.components);
  const caps = Object.entries(spec.capabilities || {}).filter(([, v]) => v).length;
  return { screens: (spec.screens || []).length, components, caps };
}

/**
 * A drawing of the app, built from the project's own theme — the same thing
 * the Preview tab does, at card size. It is deliberately abstract: at 64px a
 * "realistic" preview would be a picture of four grey rectangles pretending to
 * be content, and pretending is the thing this project does not do.
 */
function projectThumb(spec) {
  const th = spec.theme || {};
  const bg = th.background || '#0B0D12';
  const surface = th.surface || '#15171F';
  const primary = th.primary || '#6C5CE7';
  const screens = (spec.screens || []).length;
  const rows = Math.max(2, Math.min(4, (spec.screens && spec.screens[0] && (spec.screens[0].components || []).length) || 3));
  let inner = `<rect x="0" y="0" width="96" height="120" rx="10" fill="${bg}"/>`;
  inner += `<rect x="0" y="0" width="96" height="22" rx="10" fill="${primary}"/>`;
  inner += `<rect x="0" y="14" width="96" height="8" fill="${primary}"/>`;
  for (let i = 0; i < rows; i += 1) {
    inner += `<rect x="12" y="${34 + i * 20}" width="${72 - i * 12}" height="10" rx="5" fill="${surface}"/>`;
  }
  if (screens > 1) inner += `<rect x="0" y="110" width="96" height="10" rx="5" fill="${surface}"/>`;
  return `<svg viewBox="0 0 96 120" width="64" height="80" aria-hidden="true" role="presentation"
    style="border-radius:12px;border:1px solid var(--line-2);background:${bg}">${inner}</svg>`;
}

/* ── the four creation methods ──────────────────────────────────────────── */

/**
 * The four ways in, declared once. Every card says what it does in one line and
 * does it — there is no card here that leads to a screen where the thing you
 * asked for has to be found again.
 */
function creationMethods() {
  return [
    {
      id: 'template',
      icon: I.grid,
      title: 'From a template',
      line: 'Nine starting points — a shop, a business, a learning app — each one editable to the last detail.',
      run: () => renderGallery(),
    },
    {
      id: 'website',
      icon: I.eye,
      title: 'Website to app',
      line: 'Give an address and the analyser says how the site will behave inside an app, before anything is built.',
      run: () => startWebsiteProject(),
    },
    {
      id: 'blank',
      icon: I.square,
      title: 'Blank project',
      line: 'A name, a package and one empty screen. For when you already know what you are making.',
      run: () => startBlankProject(),
    },
    {
      id: 'import',
      icon: I.code,
      title: 'Import a specification',
      line: 'Open a spec.json you already have. It is validated before anything is offered.',
      run: () => importSpec(),
    },
  ];
}

/** Start a project whose whole point is the website analyser on the Design tab. */
function startWebsiteProject() {
  if (S.active) { S.tab = 'design'; renderActive(); return; }
  const tpls = (S.templates && S.templates.templates) || [];
  const tpl = tpls.find((t) => t.id === 'blank');
  if (!tpl) { toast('No blank template is available to start from.'); return; }
  createProject(tpl);          // lands on the Design tab, where the address field is
}

function startBlankProject() {
  const tpls = (S.templates && S.templates.templates) || [];
  const tpl = tpls.find((t) => t.id === 'blank');
  if (!tpl) { toast('No blank template is available.'); return; }
  createProject(tpl);
}

/* ── the health badge ───────────────────────────────────────────────────── */

/**
 * The same three calls the Health tab makes, so the badge on this screen and
 * the rings on that one cannot disagree. Returns null when there is no project
 * to measure, rather than a comforting zero.
 */
function homeHealth(spec) {
  if (!spec || !spec.identity) return null;
  try {
    return projectHealth(spec, validateSpec(spec), permissionReport(spec));
  } catch { return null; }
}

/* ── the Home screen ────────────────────────────────────────────────────── */

function viewHome() {
  const methods = creationMethods();
  const recent = (S.projects || []).slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const hero = el('section', { class: 'hero' }, [
    el('h1', { class: 'hero-title' }, 'Build an Android app'),
    el('p', { class: 'hero-sub' }, 'Free, offline, and deterministic: no account, no credits, no AI, and nothing here counts how many apps you make. Choose a way in.'),
    el('div', { class: 'methods' }, ...methods.map((m) => el('button', {
      class: 'method', id: `method-${m.id}`, type: 'button', onclick: m.run,
    }, [
      el('span', { class: 'method-ico', html: svg(m.icon) }),
      el('span', { class: 'method-text' }, [
        el('span', { class: 'method-name' }, m.title),
        el('span', { class: 'method-line' }, m.line),
      ]),
      el('span', { class: 'method-go', 'aria-hidden': 'true', html: svg('<path d="m9 6 6 6-6 6"/>') }),
    ]))),
  ]);

  const nodes = [hero];

  if (recent.length) {
    nodes.push(el('section', { class: 'sec-open' }, [
      el('div', { class: 'home-head' }, [
        el('h2', { class: 'home-h2' }, 'Your projects'),
        el('span', { class: 'home-count' }, `${recent.length} project${recent.length === 1 ? '' : 's'} in this browser`),
      ]),
      el('div', { class: 'projects' }, ...recent.map((p) => {
        const st = projectStats(p.spec);
        const h = p.id === (S.active && S.active.id) ? homeHealth(p.spec) : null;
        const when = p.updatedAt ? new Date(p.updatedAt) : null;
        return el('article', { class: 'pcard', 'data-project': p.id }, [
          el('div', { class: 'pcard-top' }, [
            el('span', { class: 'pthumb', html: projectThumb(p.spec) }),
            el('div', { class: 'pmeta' }, [
              el('h3', { class: 'pname' }, p.spec.identity.appName || p.name || 'Untitled'),
              el('p', { class: 'ppkg' }, p.spec.identity.packageName || 'no package name yet'),
              el('div', { class: 'pchips' }, [
                el('span', { class: 'chip small' }, `${st.screens} screen${st.screens === 1 ? '' : 's'}`),
                el('span', { class: 'chip small' }, `${st.caps} feature${st.caps === 1 ? '' : 's'}`),
                h ? el('span', { class: `chip small band-${bandOf(h.overall)}` }, `health ${h.overall}`) : null,
                when && !Number.isNaN(when.getTime())
                  ? el('span', { class: 'chip small' }, when.toISOString().slice(0, 10)) : null,
              ]),
            ]),
          ]),
          el('div', { class: 'pcard-acts' }, [
            el('button', {
              class: 'btn primary small', type: 'button',
              onclick: () => { S.active = p; persist(); S.tab = 'design'; touch(); renderActive(); },
            }, 'Open'),
            h ? el('button', {
              class: 'btn small', type: 'button',
              onclick: () => { S.active = p; persist(); S.tab = 'health'; touch(); renderActive(); },
            }, 'Health') : null,
            el('button', {
              class: 'btn ghost small', type: 'button',
              onclick: () => removeProject(p),
            }, 'Remove'),
          ]),
        ]);
      })),
    ]));
  } else {
    nodes.push(card('Your projects', emptyState(
      'no-projects',
      'Nothing here yet',
      'Projects live in this browser, not on a server. The first thing you make will appear here, with its health score — no account, nothing to sign into.',
      el('button', { class: 'btn primary', type: 'button', onclick: () => renderGallery() }, 'Start from a template'),
    )));
  }

  // The ring for whatever is open, with the one link that explains it.
  const h = homeHealth(S.active && S.active.spec);
  if (h) {
    nodes.push(el('section', { class: 'home-health' }, [
      el('div', { class: 'hh-ring' }, scoreRing(h.overall, bandOf(h.overall))),
      el('div', { class: 'hh-meta' }, [
        el('h2', { class: 'home-h2' }, `Health of ${S.active.spec.identity.appName}`),
        el('p', { class: 'sub' }, `The overall score is the weakest category — ${h.weakest} — so nothing failing is averaged away.`),
        el('button', {
          class: 'btn small', type: 'button',
          onclick: () => { S.tab = 'health'; touch(); renderActive(); },
        }, 'Why this score?'),
      ]),
    ]));
  }

  return nodes;
}

/** Removing a project closes it first if it is the open one. */
function removeProject(p) {
  const at = S.projects.findIndex((x) => x.id === p.id);
  if (at === -1) return;
  S.projects.splice(at, 1);
  if (S.active && S.active.id === p.id) S.active = S.projects[0] || null;
  clearHistory(p.id);
  persist();
  toast(`Removed ${p.spec.identity.appName || p.name}.`);
  renderPicker();
}

/* ── the template gallery ───────────────────────────────────────────────── */

/** Templates that match the current filter and query. */
function galleryMatches() {
  const st = homeState();
  const tpls = (S.templates && S.templates.templates) || [];
  const q = st.q.trim();
  return tpls.filter((t) => {
    const cat = TEMPLATE_CATEGORY[t.id] || 'Other';
    if (st.cat !== 'all' && cat !== st.cat) return false;
    if (!q) return true;
    // The same ranked subsequence search the command palette uses. A match is
    // anything that is not null: a prefix scores -100 and a plain substring
    // scores its position, so testing for a positive score would throw away
    // the best matches and keep the worst.
    return [t.name, t.tagline, cat].some((text) => fuzzyScore(q, text) !== null);
  });
}

function galleryCategories() {
  const tpls = (S.templates && S.templates.templates) || [];
  const used = [];
  for (const t of tpls) {
    const c = TEMPLATE_CATEGORY[t.id] || 'Other';
    if (!used.includes(c)) used.push(c);
  }
  return used.sort((a, b) => a.localeCompare(b));
}

/** The grid alone, so typing does not lose the caret in the search field. */
function redrawGalleryGrid() {
  const box = $('#tpl-grid');
  if (!box) return;
  const matches = galleryMatches();
  box.replaceChildren(...(matches.length
    ? matches.map(templateCard)
    : [emptyState('no-results', 'Nothing matches',
      'No template matches that search. Clearing it shows all of them again.', null)]));
  const count = document.querySelector('#tpl-count');
  if (count) count.textContent = `${matches.length} of ${((S.templates && S.templates.templates) || []).length} templates`;
}

function templateCard(t) {
  const st = projectStats(t.spec);
  const cat = TEMPLATE_CATEGORY[t.id] || 'Other';
  // Screens first when there are any; otherwise the theme, because every
  // template has one and "start blank" was the same words on nine cards.
  const shape = st.screens ? `${st.screens} screen${st.screens === 1 ? '' : 's'}` : 'empty start';
  const theme = (t.spec.theme || {}).primary;
  const facts = [shape, theme ? `theme ${theme}` : null].filter(Boolean);

  return el('article', { class: 'tcard', 'data-tpl': t.id }, [
    el('div', { class: 'tcard-top' }, [
      el('span', { class: 'tmark big', html: svg(I[t.mark] || I.square) }),
      el('div', { class: 'tcard-meta' }, [
        el('h3', { class: 'tname' }, t.name),
        el('p', { class: 'ttag' }, t.tagline),
      ]),
    ]),
    el('div', { class: 'tcard-foot' }, [
      el('span', { class: 'chip small' }, cat),
      ...facts.map((f) => el('span', { class: 'chip small' }, f)),
      el('button', {
        class: 'btn primary small', type: 'button', 'data-use': t.id,
        onclick: () => createProject(t),
      }, 'Use template'),
    ]),
  ]);
}

function viewGallery() {
  const st = homeState();
  const cats = galleryCategories();
  const search = el('input', {
    id: 'tpl-search', class: 'search', type: 'search', autocomplete: 'off',
    placeholder: 'Search templates by name, use or category', value: st.q,
    'aria-label': 'Search templates',
    oninput: (e) => { st.q = e.target.value; saveHomeState(); redrawGalleryGrid(); },
  });

  const total = ((S.templates && S.templates.templates) || []).length;
  const shown = galleryMatches().length;

  const pills = el('div', {
    class: 'tpl-cats', id: 'tpl-cats', role: 'tablist', 'aria-label': 'Template categories',
  }, ...[['all', 'All'], ...cats.map((c) => [c, c])].map(([id, label]) => el('button', {
    class: 'chip filter' + (st.cat === id ? ' on' : ''),
    role: 'tab', type: 'button', 'data-cat': id,
    'aria-selected': st.cat === id ? 'true' : 'false',
    onclick: () => {
      st.cat = id; saveHomeState();
      // The pills are marked from their own data rather than from their label:
      // two categories may not share a name, but a label is a rendering of the
      // thing and matching on it is how a filter ends up selecting the wrong
      // one after a rename.
      for (const b of document.querySelectorAll('#tpl-cats .chip')) {
        const on = b.dataset.cat === id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      redrawGalleryGrid();
    },
  }, label)));

  return [
    el('div', { class: 'gallery-head' }, [
      el('button', { class: 'btn ghost small', type: 'button', onclick: () => renderPicker() }, '← Home'),
      el('h1', { class: 'gallery-title' }, 'Templates'),
      el('span', { class: 'home-count', id: 'tpl-count' }, `${shown} of ${total} templates`),
    ]),
    el('p', { class: 'hint' }, 'Every template is an ordinary specification you can change completely — nothing about it is fixed, and nothing here is charged for.'),
    el('div', { class: 'gallery-search' }, search, pills),
    el('div', { class: 'tpl-grid', id: 'tpl-grid' }, ...galleryMatches().map(templateCard)),
    el('div', { class: 'gallery-note' }, el('p', { class: 'sub' },
      'Choosing a template copies it into a project in this browser. The template itself is never modified, so the gallery is the same next time.')),
  ];
}

/* The count under the title is filled by redrawGalleryGrid, which runs once
   after the first paint rather than being computed twice. */
