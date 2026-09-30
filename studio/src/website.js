/**
 * START FROM A WEBSITE
 * ====================
 *
 * The screen that turns a website into an app, on a phone, with no network and
 * no AI — and the rules it follows, which are the same ones the repair screen
 * follows:
 *
 *   Nothing is applied without being shown first. The analysis produces a
 *   proposal, the proposal is listed as a set of changes, and the changes happen
 *   when the person presses the button that says so. A tool that quietly edits
 *   your project is one you cannot check.
 *
 *   It runs the same code the command line runs. The analysis lives in
 *   engine/analyse/site.mjs, which is pure — no filesystem, no network — and is
 *   compiled into this bundle. If the Studio had its own copy, a phone and a
 *   build pipeline would eventually disagree, and the person holding the phone
 *   would have no way to know which one to believe.
 *
 *   It says what it cannot do. Some of what a website needs cannot be solved by
 *   adding it to an app: a form still needs its server, a page whose words
 *   arrive from a request will be empty with the network off. Those come back as
 *   findings with a level, not as failures and not as silence.
 *
 * Two things it can do, because they are genuinely different:
 *
 *   Address   Point the app at a live website. Everything stays on the site and
 *             the app needs a connection. Nothing to upload, works immediately.
 *
 *   Files     Give it the site's files and it works offline: the pages and their
 *             assets travel inside the app. This is the one that needs the files
 *             to reach the build, so the screen says so plainly.
 */

import { siteFromFiles, describeSite, findingsFor, proposeApp, humanBytes } from '../../engine/analyse/site.mjs';

const LEVEL_LABEL = { blocking: 'Cannot work', warning: 'Needs a decision', info: 'Worth knowing' };

/** What the analysis found, if one has been run. Kept on the project, so it persists. */
function webState() {
  if (!S.active) return null;
  return S.active.website || null;
}

function setWebState(next) {
  S.active.website = next;
  touch();
}

/** The section's one-line summary when it is closed. */
function websiteSummary() {
  const w = webState();
  if (!w) return 'Read a site and let it fill this in';
  if (w.status === 'working') return 'Reading the files…';
  if (w.status === 'failed') return `Could not read them: ${w.error}`;
  const s = w.analysis.summary;
  const bits = [`${w.analysis.pages.length} page${w.analysis.pages.length === 1 ? '' : 's'}`];
  if (s.blocking) bits.push(`${s.blocking} cannot work`);
  if (s.warning) bits.push(`${s.warning} to decide`);
  return `${w.analysis.proposal.appName} · ${bits.join(' · ')}`;
}

/* ── reading files a person picked ────────────────────────────────────────── */

/**
 * Read the chosen files and analyse them.
 *
 * A phone cannot hand a page a directory path, so the files are read here
 * instead. Each file's name inside its folder comes from webkitRelativePath when
 * the browser provides it — that is what makes `assets/style.css` resolvable
 * from `index.html` — and falls back to the plain name when it does not.
 */
async function readChosenFiles(fileList) {
  const files = [];
  const tooBig = [];
  let rootName = null;
  for (const file of Array.from(fileList)) {
    // Guard the phone's memory: a site is text and images, not video libraries.
    if (file.size > 12 * 1024 * 1024) { tooBig.push(file.name); continue; }
    const parts = (file.webkitRelativePath || file.name).split('/');
    // The first segment is the folder the person picked, which is the only name
    // the browser gives us for their site.
    if (!rootName && parts.length > 1) rootName = parts[0];
    const rel = parts.slice(1).join('/') || file.name;
    const isText = /\.(html?|css|js|mjs|json|svg|txt|webmanifest)$/i.test(file.name);
    files.push({ rel, data: isText ? await file.text() : new Uint8Array(await file.arrayBuffer()) });
  }
  return { files, tooBig, rootName };
}

async function analyseChosen(target) {
  const list = target.files;
  if (!list || !list.length) return;
  setWebState({ status: 'working', at: new Date().toISOString() });
  hardUpdate();

  try {
    const { files, tooBig, rootName } = await readChosenFiles(list);
    if (!files.some((f) => /\.html?$/i.test(f.rel))) {
      setWebState({ status: 'failed', error: 'no .html file among them', tooBig });
      toast('None of those files is a web page.');
      hardUpdate();
      return;
    }
    const site = siteFromFiles(files, { rootName });
    const model = describeSite(site);
    const findings = findingsFor(site, model);
    const proposal = proposeApp(model, {});

    setWebState({
      status: 'ready',
      at: new Date().toISOString(),
      files: files.map((f) => ({ rel: f.rel, bytes: (typeof f.data === 'string' ? f.data.length : f.data.byteLength) })),
      tooBig,
      analysis: {
        pages: model.pages.map((p) => ({ rel: p.rel, bytes: p.bytes, title: p.title })),
        assets: model.assets ? site.assets.map((a) => ({ rel: a.rel, bytes: a.bytes })) : [],
        entry: site.entry,
        summary: {
          blocking: findings.filter((f) => f.level === 'blocking').length,
          warning: findings.filter((f) => f.level === 'warning').length,
          info: findings.filter((f) => f.level === 'info').length,
        },
        findings,
        proposal: {
          appName: proposal.spec.identity.appName,
          packageName: proposal.spec.identity.packageName,
          capabilities: proposal.spec.capabilities,
          theme: proposal.spec.theme,
          localAsset: proposal.spec.app.webview.localAsset,
          startUrl: proposal.spec.app.webview.startUrl,
        },
      },
    });
    toast(`Read ${model.pages.length} page${model.pages.length === 1 ? '' : 's'}: ${findings.length} thing${findings.length === 1 ? '' : 's'} to look at.`);
  } catch (err) {
    setWebState({ status: 'failed', error: (err && err.message) || String(err) });
    toast('Could not read those files.');
  }
  hardUpdate();
}

/* ── applying what was proposed ───────────────────────────────────────────── */

/**
 * What applying the proposal would change, in words.
 *
 * Built by comparing the project with the proposal, so a person sees exactly the
 * fields that move and nothing else. If this list is empty there is nothing to
 * apply and the button says so, rather than pretending to work.
 */
function proposalChanges() {
  const w = webState();
  if (!w || w.status !== 'ready') return [];
  const spec = S.active.spec;
  const p = w.analysis.proposal;
  const changes = [];
  const push = (label, from, to) => {
    if (to === undefined || to === null || to === '') return;
    if (String(from ?? '') === String(to)) return;
    changes.push({ label, from: from === undefined || from === null || from === '' ? '(not set)' : from, to });
  };

  push('Application name', spec.identity.appName, p.appName);
  push('Package name', spec.identity.packageName, p.packageName);
  push('Bundled page', spec.app?.webview?.localAsset, p.localAsset);
  push('Address', spec.app?.webview?.startUrl, p.startUrl);
  const before = (spec.capabilities || []).join(', ');
  if (before !== p.capabilities.join(', ')) {
    changes.push({ label: 'Features', from: before || '(none)', to: p.capabilities.join(', ') || '(none)' });
  }
  const t = spec.theme || {};
  const nt = p.theme || {};
  for (const [key, label] of [['primary', 'App colour'], ['background', 'Background'], ['surface', 'Panels'], ['accent', 'Accent']]) {
    push(label, t[key], nt[key]);
  }
  return changes;
}

function applyProposal() {
  const w = webState();
  if (!w || w.status !== 'ready') return;
  const spec = S.active.spec;
  const p = w.analysis.proposal;

  spec.identity.appName = p.appName;
  spec.identity.packageName = p.packageName;
  spec.app.mode = 'webview';
  spec.app.webview = spec.app.webview || {};
  spec.app.webview.localAsset = p.localAsset;
  spec.app.webview.startUrl = p.startUrl;
  spec.app.webview.allowedHosts = [];
  spec.capabilities = p.capabilities.slice();
  spec.theme = { ...spec.theme, ...p.theme };

  S.active.website = { ...w, appliedAt: new Date().toISOString() };
  touch();
  hardUpdate();
  toast('Applied. The specification below shows every change.');
}

function forgetAnalysis() {
  if (!S.active.website) return;
  delete S.active.website;
  touch();
  hardUpdate();
  toast('The analysis was removed from this project.');
}

/* ── the address route ────────────────────────────────────────────────────── */

function useAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) { toast('Paste a website address first.'); return; }
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { toast('That does not look like an address.'); return; }
  if (!/^https?:$/.test(url.protocol)) { toast('Only http and https addresses can be used.'); return; }

  const spec = S.active.spec;
  spec.app.mode = 'webview';
  spec.app.webview = spec.app.webview || {};
  spec.app.webview.startUrl = url.href;
  // The bundled page is cleared deliberately: this app opens the live site, and
  // leaving a stale localAsset behind would silently win over the address and
  // ship a copy of a different site.
  delete spec.app.webview.localAsset;
  spec.app.webview.allowedHosts = [url.hostname];
  if (spec.android) spec.android.cleartextTraffic = false;
  touch();
  hardUpdate();
  toast(`The app will open ${url.hostname}. Anyone using it needs a connection.`);
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function websiteFinding(f) {
  return el('div', { class: `wv-finding lvl-${f.level}` }, [
    el('div', { class: 'wv-finding-head' }, [
      el('span', { class: `chip ${f.level === 'blocking' ? 'bad' : (f.level === 'warning' ? 'warn' : 'info')}` }, LEVEL_LABEL[f.level] || f.level),
      el('span', { class: 'wv-finding-msg' }, f.title),
    ]),
    el('p', { class: 'why' }, f.detail),
    f.action && f.action !== 'Nothing to do.' ? el('p', { class: 'hint' }, f.action) : null,
    f.evidence && f.evidence.length
      ? el('details', { class: 'ev' }, [
        el('summary', {}, `${f.evidence.length} detail${f.evidence.length === 1 ? '' : 's'}`),
        el('ul', {}, ...f.evidence.slice(0, 12).map((e) => el('li', {}, String(e)))),
      ])
      : null,
  ]);
}

function websiteSection() {
  const w = webState();
  const body = [];

  body.push(el('p', { class: 'hint' },
    'If the app is a website, let the site fill in the details. It reads nothing until you pick files, and it changes nothing until you say so.'));

  // ---- the address route
  const addressInput = el('input', {
    type: 'url', inputmode: 'url', placeholder: 'greenfieldbakery.in',
    'aria-label': 'Website address',
  });
  body.push(el('div', { class: 'wv-row' }, [
    addressInput,
    el('button', { class: 'btn primary', onclick: () => useAddress(addressInput.value) }, 'Use this address'),
  ]));
  body.push(el('p', { class: 'hint' }, 'The app opens the live site. It needs a connection, and nothing is stored on the phone.'));

  // ---- the files route
  const picker = el('input', {
    type: 'file', multiple: true, webkitdirectory: 'true', directory: 'true',
    style: 'display:none', 'aria-hidden': 'true', tabindex: '-1',
    onchange: (e) => analyseChosen(e.target),
  });
  body.push(el('div', { class: 'wv-row' }, [
    el('button', { class: 'btn ghost', onclick: () => picker.click() }, 'Choose my site’s files'),
    el('span', { class: 'hint' }, 'Works offline — the pages travel inside the app.'),
  ]));
  body.push(picker);

  if (w && w.status === 'working') {
    body.push(el('p', { class: 'hint' }, 'Reading the files…'));
  }

  if (w && w.status === 'failed') {
    body.push(el('div', { class: 'banner fail' }, [
      el('strong', {}, 'That did not work.'),
      el('div', {}, w.error),
    ]));
  }

  if (w && w.status === 'ready') {
    const a = w.analysis;
    const counts = a.summary;
    body.push(el('div', { class: 'wv-summary' }, [
      el('span', { class: 'pill pass' }, `${a.pages.length} page${a.pages.length === 1 ? '' : 's'}`),
      el('span', { class: 'pill' }, `${a.assets.length} file${a.assets.length === 1 ? '' : 's'}`),
      el('span', { class: 'pill' }, humanBytes(a.pages.reduce((n, p) => n + p.bytes, 0) + a.assets.reduce((n, x) => n + x.bytes, 0))),
      counts.blocking ? el('span', { class: 'pill fail' }, `${counts.blocking} cannot work`) : null,
      counts.warning ? el('span', { class: 'pill warn' }, `${counts.warning} to decide`) : null,
    ].filter(Boolean)));

    body.push(el('p', { class: 'hint' }, `The app would open ${a.entry}.`));

    if (a.findings.length) {
      body.push(el('div', { class: 'wv-findings' }, ...a.findings.map(websiteFinding)));
    } else {
      body.push(el('p', { class: 'hint' }, 'Nothing to flag: everything it looked for is in order.'));
    }

    const changes = proposalChanges();
    body.push(el('h3', { class: 'wv-h' }, 'What applying this changes'));
    body.push(changes.length
      ? el('div', { class: 'rs-change' }, ...changes.map((c) => el('div', { class: 'wv-change' }, [
        el('span', { class: 'wv-what' }, c.label),
        el('span', { class: 'wv-from' }, String(c.from)),
        el('span', { class: 'wv-arrow' }, '→'),
        el('span', { class: 'wv-to' }, String(c.to)),
      ])))
      : el('p', { class: 'hint' }, 'Nothing — this project already matches what the site suggests.'));

    body.push(el('div', { class: 'wv-acts' }, [
      el('button', {
        class: 'btn primary block', disabled: changes.length === 0 ? 'true' : null,
        onclick: applyProposal,
      }, changes.length ? `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Already applied'),
      el('button', { class: 'btn ghost block', onclick: forgetAnalysis }, 'Remove this analysis'),
    ]));

    body.push(el('p', { class: 'hint' },
      'The site’s files themselves are added to the project when the app is built, so the pages travel inside the app instead of being downloaded.'));

    if (w.tooBig && w.tooBig.length) {
      body.push(el('p', { class: 'hint' }, `Left out for being larger than 12 MB: ${w.tooBig.join(', ')}.`));
    }
  }

  return section('Start from a website', {
    icon: I.eye,
    id: 'website',
    open: false,
    summary: websiteSummary,
    children: body,
  });
}
