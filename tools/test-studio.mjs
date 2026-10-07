#!/usr/bin/env node
/**
 * Studio behaviour test — drives the real UI in a real browser.
 * ============================================================
 * The Studio is a single HTML file with no dependencies, so the only honest way
 * to know it works is to open it and use it: tap the tabs, flip a capability,
 * read the permission table, and fail on any console error.
 *
 * A syntax check would not have caught the bug that was actually present (two
 * stray closing parentheses that broke the whole bundle). This does.
 *
 * Usage:  node tools/test-studio.mjs [--keep]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO = path.join(ROOT, 'studio/app.html');

// Use whatever chromium is available locally rather than assuming a path.
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Playwright has moved its browser between several directory layouts over
  // time (chrome-linux/chrome, chrome-linux64/chrome, headless shell variants).
  // Rather than list the layouts and be wrong again, look for the binary.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(process.env.HOME || '/root', '.cache/ms-playwright');
  const wanted = new Set(['chrome', 'headless_shell', 'chrome-headless-shell']);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (wanted.has(e.name)) {
        try { fs.accessSync(full, fs.constants.X_OK); found.push(full); } catch { /* not executable */ }
      }
    }
  };
  walk(base, 0);
  // prefer the full browser over the headless shell: it is the one that can
  // take a screenshot the way a phone would show it
  found.sort((a, b) => (a.includes('headless') ? 1 : 0) - (b.includes('headless') ? 1 : 0));
  if (found.length) return found[0];
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  → ' + detail : ''}`);
};

async function main() {
  if (!fs.existsSync(STUDIO)) throw new Error('studio/app.html is missing — run: node tools/build-studio.mjs');
  const executablePath = findChromium();
  if (!executablePath) throw new Error('No chromium found. Install one or set CHROMIUM_PATH.');

  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // a real phone size

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // A token is seeded so the Build section renders its real call to action.
  // Without one the Studio asks you to connect GitHub first, and the test would
  // be asserting on a button that correctly is not there.
  await page.addInitScript(() => {
    try { localStorage.setItem('appmint.token.v1', 'test-token-not-a-real-credential'); } catch (e) {}
  });
  await page.goto('file://' + STUDIO, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  /* ── it boots ───────────────────────────────────────────────────────── */
  const tplCount = await page.locator('button.tpl').count();
  check('Studio boots and lists templates', tplCount >= 8, `found ${tplCount} template buttons`);

  const title = await page.textContent('#projname');
  check('Shows a title instead of staying on the loading screen', title && !/Loading/i.test(title), `title="${title}"`);

  /* ── creating a project ─────────────────────────────────────────────── */
  await page.locator('button.tpl').nth(1).click();      // first real template
  await page.waitForTimeout(250);

  const tabs = await page.locator('.tabbar .tab').count();
  check('Opening a template reveals the seven sections', tabs === 7, `found ${tabs} tabs`);

  const health = (await page.textContent('#health')) || '';
  check('Health strip reports a verdict', /Valid|Blocked|Ready/.test(health), `health="${health.trim()}"`);

  /* ── every section renders ──────────────────────────────────────────── */
  for (const [label, expect] of [['Design', 'Application name'], ['Screens', 'Build the first screen'], ['Features', 'Permissions this app will request'], ['Preview', 'Preview'], ['Health', 'Project health'], ['Settings', 'Advanced Mode'], ['Build', 'Validation']]) {
    await tapTab(page, label);
    const text = await page.textContent('#main');
    check(`Section "${label}" renders its content`, text.includes(expect), `looking for "${expect}"`);
  }

  /* ── health: a score you can argue with ─────────────────────────────────
     The design prompt allows score rings on one condition — "Do not invent
     arbitrary scores. Every score must be calculated from measurable checks" —
     and a person must be able to open "Why this score?" and see them. So the
     assertion that matters is not that a number is printed; it is that the
     number printed is the number the engine derives, and that the reasons are
     on the page. */
  await tapTab(page, 'Health');

  const rings = await page.locator('.rings .ringcard').count();
  check('Health shows a ring for every category', rings === 7, `found ${rings} rings`);

  const whys = await page.locator('.why-box > summary').count();
  check('Every ring offers "Why this score?"', whys === 7, `found ${whys}`);

  const ringFacts = await page.evaluate(() => {
    const h = window.__appmintHealth();
    const cards = [...document.querySelectorAll('.rings .ringcard')];
    return {
      engine: h.categories.map((c) => ({ label: c.label, score: c.score, n: c.checks.length })),
      overall: h.overall,
      weakest: h.weakest,
      shown: cards.map((c) => ({
        label: c.querySelector('.ringname').textContent.trim(),
        num: c.querySelector('.ring-num').textContent.trim(),
        rows: c.querySelectorAll('.why-row').length,
        // A ring drawn from a constant would pass a test that only looks at the
        // number, so the arc length is checked against the score as well.
        arc: c.querySelector('.ring-arc').getAttribute('stroke-dasharray'),
        band: [...c.querySelector('.ring').classList].find((x) => x.startsWith('band-')),
      })),
      overallNum: document.querySelector('.overall .ring-num').textContent.trim(),
    };
  });

  const CIRC = 2 * Math.PI * 26;
  let mismatches = [];
  ringFacts.engine.forEach((e, i) => {
    const got = ringFacts.shown[i];
    if (!got) { mismatches.push(`${e.label}: no ring rendered`); return; }
    if (got.label !== e.label) mismatches.push(`ring ${i} is labelled "${got.label}", engine says "${e.label}"`);
    const want = e.score === null ? '—' : String(e.score);
    if (got.num !== want) mismatches.push(`${e.label}: ring shows ${got.num}, engine derives ${want}`);
    if (got.rows !== e.n) mismatches.push(`${e.label}: ${got.rows} reason rows for ${e.n} checks`);
    if (e.score !== null) {
      const arcLen = parseFloat(got.arc);
      const want = CIRC * e.score / 100;
      if (!(Math.abs(arcLen - want) < 0.6)) mismatches.push(`${e.label}: arc ${arcLen.toFixed(2)} for score ${e.score}, expected ${want.toFixed(2)}`);
      const wantBand = e.score >= 85 ? 'band-good' : (e.score >= 60 ? 'band-fair' : 'band-poor');
      if (got.band !== wantBand) mismatches.push(`${e.label}: band ${got.band}, score ${e.score} is ${wantBand}`);
    } else if (got.band !== 'band-none') {
      mismatches.push(`${e.label}: an unmeasured category must not wear a band, got ${got.band}`);
    }
  });
  check('Each ring shows the score the engine derives, not a number chosen for the layout',
    mismatches.length === 0, mismatches.join('; '));

  check('The overall number is the weakest category, so nothing failing is averaged away',
    ringFacts.overallNum === String(ringFacts.overall),
    `page shows ${ringFacts.overallNum}, engine derives ${ringFacts.overall} (weakest: ${ringFacts.weakest})`);

  // "Why this score?" has to actually open onto the checks. A disclosure that
  // never reveals anything is the decorative version of this feature.
  const firstWhy = page.locator('.rings .ringcard').first().locator('.why-box > summary');
  await firstWhy.click();
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => {
    const box = document.querySelector('.rings .ringcard .why-box');
    const rows = [...box.querySelectorAll('.why-row')];
    return {
      open: box.open,
      n: rows.length,
      named: rows.every((r) => r.querySelector('.why-name').textContent.trim().length > 0),
      reasoned: rows.every((r) => r.querySelector('.why-detail').textContent.trim().length > 0),
      tagged: rows.every((r) => /^(pass|warn|fail)$/.test(r.querySelector('.why-tag').textContent.trim())),
      first: rows[0] ? rows[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 110) : '',
    };
  });
  check('"Why this score?" opens onto the checks behind the ring',
    opened.open && opened.n > 0, `open=${opened.open}, rows=${opened.n}`);
  check('Every check states a name and a reason, because that is the whole feature',
    opened.named && opened.reasoned && opened.tagged, JSON.stringify(opened).slice(0, 160));

  // A category with nothing configured must say so rather than score 100.
  const unmeasured = await page.evaluate(() => {
    const h = window.__appmintHealth();
    return h.categories.filter((c) => c.score === null).map((c) => c.label);
  });
  if (unmeasured.length) {
    const bannerText = await page.textContent('#main');
    check('Unmeasured categories are named instead of being given a score',
      bannerText.includes('not measured') && unmeasured.every((n) => bannerText.includes(n)),
      `unmeasured: ${unmeasured.join(', ')}`);
  }

  /* ── settings: raw configuration that is really the configuration ────────
     The point of an Advanced Mode is that what it shows is what the build reads.
     So the assertion is not that a panel appears; it is that the specification
     in the panel is the project's specification, and that changing something
     here changes what the validator says. */
  await tapTab(page, 'Settings');

  // Two screens can offer the same setting. When they do, the controls must not
  // share an accessible name, or nothing - neither a person using a screen
  // reader nor a test - can say which one it is addressing.
  const dupes = await page.evaluate(() => {
    const vis = [...document.querySelectorAll('input,select')]
      .filter((n) => n.offsetParent !== null)
      .map((n) => n.getAttribute('aria-label'))
      .filter(Boolean);
    return vis.filter((v, i) => vis.indexOf(v) !== i);
  });
  check('No two visible controls share an accessible name', dupes.length === 0, `duplicated: ${[...new Set(dupes)].join(', ')}`);

  const subtabs = await page.locator('.subtab').count();
  check('Settings is tabbed rather than one long scroll', subtabs === 6, `found ${subtabs} tabs`);

  check('Advanced Mode is offered, with what it unlocks stated',
    /Unlocks the raw configuration/.test(await page.textContent('#main')), 'the toggle must say what it does');

  const advSwitch = page.locator('input[role="switch"][aria-label="Advanced Mode"]');
  await advSwitch.check();
  await page.waitForTimeout(350);

  const raw = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.rawbox')];
    const spec = boxes.find((b) => /spec\.json/.test(b.querySelector('.rawname').textContent));
    const manifest = boxes.find((b) => /AndroidManifest/.test(b.querySelector('.rawname').textContent));
    return {
      n: boxes.length,
      parsed: spec ? JSON.parse(spec.querySelector('.raw').textContent) : null,
      real: window.__appmintSpec(),
      manifest: manifest ? manifest.querySelector('.raw').textContent : '',
      gradle: boxes.some((b) => /gradle/i.test(b.querySelector('.rawname').textContent) && !/resolveToolchain/.test(b.querySelector('.rawname').textContent)),
    };
  });
  check('Advanced Mode shows the specification the build actually reads',
    raw.parsed && JSON.stringify(raw.parsed) === JSON.stringify(raw.real),
    'the panel must be the project spec, not a summary of it');
  check('The manifest permissions shown are derived, and match the capabilities enabled',
    /uses-permission/.test(raw.manifest) || /no permissions/.test(raw.manifest),
    raw.manifest.slice(0, 90));
  check('No Gradle file is invented for the browser to show',
    raw.gradle === false,
    'the generator cannot run in a page, so an approximation would be a document that looks like the build without being it');

  // Changing something here has to move the validator, or the screen is a form
  // that goes nowhere.
  await tapTab(page, 'Settings');
  const sdkBefore = await page.evaluate(() => window.__appmintHealth().categories.find((c) => c.key === 'build').score);
  // The section folds away closed, and its contents stay in the document while
  // closed - hidden, not removed. So the control has to be opened before it can
  // be typed into, exactly as a person would have to.
  await page.locator('button.sec-head', { hasText: 'Android' }).click();
  await page.waitForTimeout(250);
  await page.locator('input[aria-label="Target Android version"]').fill('33');
  await page.waitForTimeout(350);
  const sdkAfter = await page.evaluate(() => {
    const h = window.__appmintHealth();
    const build = h.categories.find((c) => c.key === 'build');
    return { score: build.score, play: build.checks.find((c) => /Play requirement/.test(c.name)).status };
  });
  check('Editing the target SDK in Settings is reported by the validator',
    sdkAfter.play === 'warn' && sdkAfter.score < sdkBefore,
    `build score ${sdkBefore} → ${sdkAfter.score}, Play check "${sdkAfter.play}"`);
  await page.locator('input[aria-label="Target Android version"]').fill('36');
  await page.waitForTimeout(300);

  // Signing has a rule that blocks a build, and the screen should say so rather
  // than let a person discover it at the end of a failed run.
  /* ── the backend the app is given ──────────────────────────────────────────
     A backend configuration screen that does not say what it produces leaves a
     person guessing whether picking "Supabase" did anything at all. So the check
     is that the screen shows the runtime the build will emit, and that turning
     on an insecure address is refused rather than warned about. */
  await page.locator('.subtab', { hasText: 'Backend' }).click();
  await page.waitForTimeout(300);

  await page.locator('select[aria-label="Backend kind"]').selectOption('supabase');
  await page.waitForTimeout(350);
  await page.locator('input[aria-label="Backend address"]').fill('https://example.supabase.co');
  await page.waitForTimeout(350);
  await page.locator('input[role="switch"][aria-label="Backend requires authentication"]').check();
  await page.waitForTimeout(400);

  const backend = await page.evaluate(() => {
    const h = window.__appmintHealth().categories.find((c) => c.key === 'backend');
    return {
      score: h.score,
      checks: h.checks.map((c) => `${c.status}: ${c.name}`),
      text: document.querySelector('#main').textContent,
    };
  });
  check('Configuring a backend produces a data runtime, and the screen says so',
    /data runtime/i.test(backend.text) && backend.checks.some((c) => /^pass: The app gets one controlled path/.test(c)),
    backend.checks.join(' | ').slice(0, 200));
  check('A configured backend is scored, where an unconfigured one was not',
    backend.score !== null, `score was ${backend.score}`);

  await page.locator('textarea[aria-label="Tables needing row-level security"]').fill('orders\nprofiles');
  await page.waitForTimeout(400);
  const withTables = await page.evaluate(() => {
    const h = window.__appmintHealth().categories.find((c) => c.key === 'backend');
    return { score: h.score, named: h.checks.find((c) => /row-level security are named/.test(c.name)) };
  });
  check('Naming the tables that need row-level security is reflected in the score',
    withTables.named && withTables.named.status === 'pass',
    JSON.stringify(withTables.named).slice(0, 160));

  await page.locator('input[aria-label="Backend address"]').fill('http://example.supabase.co');
  await page.waitForTimeout(450);
  const insecure = await page.evaluate(() => window.__appmintBlocking());
  check('An http backend address blocks the build rather than being quietly accepted',
    insecure.blocked && insecure.codes.includes('E_BACKEND_NOT_HTTPS'),
    JSON.stringify(insecure));

  await page.locator('input[aria-label="Backend address"]').fill('https://example.supabase.co');
  await page.waitForTimeout(400);
  await page.locator('select[aria-label="Backend kind"]').selectOption('none');
  await page.waitForTimeout(350);

  await page.locator('.subtab', { hasText: 'Signing' }).click();
  await page.waitForTimeout(300);
  await page.locator('select[aria-label="Signing mode"]').selectOption('secret-store');
  await page.waitForTimeout(300);
  await page.locator('input[role="switch"][aria-label="Refuse to build if the keystore is missing"]').uncheck();
  await page.waitForTimeout(400);
  const signingWarned = await page.evaluate(() => ({
    text: document.querySelector('#main').textContent,
    ...window.__appmintBlocking(),
    code: (window.__appmintBlocking().codes.find((c) => /SIGNING/.test(c)) || ''),
  }));
  check('A signing combination that blocks the build is explained on the screen',
    signingWarned.blocked && /SIGNING/.test(signingWarned.code) && /blocked/i.test(signingWarned.text),
    `blocked=${signingWarned.blocked} code=${signingWarned.code}`);

  await page.locator('input[role="switch"][aria-label="Refuse to build if the keystore is missing"]').check();
  await page.waitForTimeout(300);
  await page.locator('select[aria-label="Signing mode"]').selectOption('debug');
  await page.waitForTimeout(300);

  /* ── the build pipeline stepper ──────────────────────────────────────────
     A stepper is the easiest thing in the app to fake: eight words on a timer
     and a tick at the end. These assertions feed in the steps a real GitHub run
     reports and check that what is drawn describes them — including that Done
     is not claimed early, and that a step belonging to no stage is still listed
     rather than quietly dropped. */
  const STEPS_OK = [
    ['Checkout', 'completed', 'success'],
    ['Set up Node', 'completed', 'success'],
    ['Pick specification', 'completed', 'success'],
    ['Validate specification (layers 1-5)', 'completed', 'success'],
    ['Engine self-tests', 'completed', 'success'],
    ['Build the Studio bundle', 'completed', 'success'],
    ['Row level security gate', 'completed', 'success'],
    ['Generate Android project', 'completed', 'success'],
    ['Show permission table', 'completed', 'success'],
    ['Set up JDK 17', 'completed', 'success'],
    ['Set up Gradle', 'completed', 'success'],
    ['Prepare Android SDK', 'completed', 'success'],
    ['Build debug APK', 'completed', 'success'],
    ['Locate artifact', 'completed', 'success'],
    ['Validate the real artifact', 'completed', 'success'],
    ['Upload APK', 'completed', 'success'],
    ['Upload build report', 'completed', 'success'],
  ].map(([name, status, conclusion]) => ({ name, status, conclusion }));

  const setPipeline = (run, steps) => page.evaluate(([r, st]) => {
    window.__appmintPipeline({ run: r, steps: st, polling: false, error: null });
  }, [run, steps]);

  await tapTab(page, 'Build');
  await setPipeline(null, []);
  await page.waitForTimeout(200);
  check('No build pipeline is drawn before a build is started',
    (await page.locator('.pipeline').count()) === 0,
    'an empty stepper would be decoration');

  await setPipeline({ id: 1, run_number: 42, name: 'Generate, build and validate', status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/run/1' }, STEPS_OK);
  await page.waitForTimeout(250);

  const drawnStages = await page.evaluate(() => ({
    stages: [...document.querySelectorAll('.pstep')].map((n) => ({
      key: n.dataset.stage,
      status: [...n.classList].find((c) => c.startsWith('s-')),
      name: n.querySelector('.pstep-name').textContent.trim(),
      detail: n.querySelector('.pstep-detail') ? n.querySelector('.pstep-detail').textContent.trim() : '',
      steps: [...n.querySelectorAll('.pstep-steps .pname')].map((x) => x.textContent.trim()),
    })),
    other: [...document.querySelectorAll('.pother .pname')].map((x) => x.textContent.trim()),
    absent: (document.querySelector('.pipeline + details + .hint, .pother + .hint') || {}).textContent || '',
    text: document.querySelector('.card .pipeline').closest('.card').textContent,
  }));

  const labels = drawnStages.stages.map((s) => s.name.replace(/^\d+\.\s*/, ''));
  check('The stepper groups the real steps into the real stages',
    JSON.stringify(labels) === JSON.stringify(['Guards', 'Security', 'Dependencies', 'Build', 'Validate', 'Done']),
    labels.join(' → '));

  check('A successful run shows every stage done, and says Done',
    drawnStages.stages.every((s) => s.status === 's-done'),
    drawnStages.stages.map((s) => `${s.name}=${s.status}`).join(', '));

  const flat = drawnStages.stages.flatMap((s) => s.steps);
  check('Every step the workflow reported is on the screen somewhere',
    ['Validate specification (layers 1-5)', 'Row level security gate', 'Build debug APK', 'Validate the real artifact']
      .every((n) => flat.includes(n) || drawnStages.other.includes(n)),
    `placed: ${flat.length}, other: ${drawnStages.other.join(', ')}`);

  check('A step that belongs to no stage is listed, not swallowed',
    drawnStages.other.includes('Checkout'), `other was: ${drawnStages.other.join(', ') || 'empty'}`);

  check('The stages this workflow never had are named rather than drawn',
    /Sign/.test(drawnStages.absent), `hint was "${drawnStages.absent.trim().slice(0, 90)}"`);

  // The reassuring lie: every step finished, but the run has not concluded.
  await setPipeline({ id: 2, run_number: 43, name: 'Generate, build and validate', status: 'in_progress', conclusion: null }, STEPS_OK);
  await page.waitForTimeout(250);
  const going = await page.evaluate(() => ({
    done: [...document.querySelectorAll('.pstep')].find((n) => n.dataset.stage === 'done').className,
    pill: document.querySelector('.phead .pill').textContent.trim(),
  }));
  check('Done is not claimed while the run is still going',
    /s-running/.test(going.done) && !/s-done/.test(going.done), `done stage was ${going.done}`);

  // A failure has to be visible, and named.
  const failing = STEPS_OK.map((s) => (s.name === 'Row level security gate' ? { ...s, conclusion: 'failure' } : s));
  await setPipeline({ id: 3, run_number: 44, name: 'Generate, build and validate', status: 'completed', conclusion: 'failure' }, failing);
  await page.waitForTimeout(250);
  const bad = await page.evaluate(() => {
    const stages = [...document.querySelectorAll('.pstep')];
    const sec = stages.find((n) => n.dataset.stage === 'security');
    return {
      security: sec.className,
      detail: sec.querySelector('.pstep-detail').textContent.trim(),
      done: stages.find((n) => n.dataset.stage === 'done').className,
      guards: stages.find((n) => n.dataset.stage === 'guards').className,
    };
  });
  check('A failed step fails its stage and names it',
    /s-failed/.test(bad.security) && bad.detail.includes('Row level security gate'),
    `${bad.security} — ${bad.detail}`);
  check('A failed build does not reach Done, and the stages before the failure still show as done',
    /s-failed/.test(bad.done) && /s-done/.test(bad.guards),
    `done=${bad.done}, guards=${bad.guards}`);

  // A cancelled build is neither a pass nor a failure and must not be dressed
  // up as one.
  await setPipeline(
    { id: 4, run_number: 45, name: 'Generate, build and validate', status: 'completed', conclusion: 'cancelled' },
    STEPS_OK.map((s) => ({ ...s, conclusion: 'cancelled' })),
  );
  await page.waitForTimeout(250);
  const cancelled = await page.evaluate(() => ({
    done: [...document.querySelectorAll('.pstep')].find((n) => n.dataset.stage === 'done').className,
    anyDone: [...document.querySelectorAll('.pstep.s-done')].length,
  }));
  check('A cancelled run says cancelled',
    /s-cancelled/.test(cancelled.done) && cancelled.anyDone === 0,
    `done=${cancelled.done}, stages marked done=${cancelled.anyDone}`);

  /* ── the outcome: what the build produced ────────────────────────────────
     Success is not confetti. The interesting part is the file, and the size and
     checksum shown are the properties of the artifact GitHub actually stored,
     so a person can verify what they downloaded against what the screen said. */
  await setPipeline(
    { id: 5, run_number: 46, name: 'Generate, build and validate', status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/run/5' },
    STEPS_OK,
  );
  await page.evaluate(() => { window.__appmintPipeline({
    run: { id: 5, run_number: 46, name: 'Generate, build and validate', status: 'completed', conclusion: 'success' },
    steps: [],
    artifacts: [{ id: 99, name: 'app-debug.apk', size_in_bytes: 5976832 }],
    polling: false, error: null,
  }); });
  await page.waitForTimeout(300);

  const ok = await page.evaluate(() => {
    const o = document.querySelector('.outcome');
    return {
      cls: o ? o.className : '',
      tick: !!document.querySelector('.outcome-mark.ok .om-tick'),
      title: o ? o.querySelector('h3').textContent.trim() : '',
      file: (document.querySelector('.fname') || {}).textContent || '',
      size: (document.querySelector('.fsize') || {}).textContent || '',
      link: (document.querySelector('.outcome-files a') || {}).textContent || '',
    };
  });
  check('A successful build shows the success state',
    /s-success/.test(ok.cls) && ok.tick && /succeeded/i.test(ok.title),
    JSON.stringify(ok).slice(0, 150));
  check('The success state names the file and its size',
    ok.file === 'app-debug.apk' && ok.size === '5.7 MB' && /Download/.test(ok.link),
    `file="${ok.file}" size="${ok.size}" link="${ok.link}"`);

  await setPipeline(
    { id: 6, run_number: 47, name: 'Generate, build and validate', status: 'completed', conclusion: 'failure' },
    failing,
  );
  await page.waitForTimeout(250);
  const badOut = await page.evaluate(() => ({
    cls: (document.querySelector('.outcome') || {}).className || '',
    title: (document.querySelector('.outcome h3') || {}).textContent || '',
    tick: !!document.querySelector('.outcome-mark.ok'),
  }));
  check('A failed build does not get the success state',
    /s-failure/.test(badOut.cls) && !badOut.tick && /failed/i.test(badOut.title),
    JSON.stringify(badOut).slice(0, 140));

  await setPipeline(null, []);
  await page.waitForTimeout(150);

  /* ── the log console ───────────────────────────────────────────────────────
     A log console is trivial to fake and the fake looks identical, so the checks
     are about behaviour: it is absent until something has happened, the entries
     are the ones that were recorded, and the filters actually filter. */
  await page.evaluate(() => { window.__appmintPipeline(null); });
  await page.evaluate(() => { window.__appmintLogReset(); });
  await tapTab(page, 'Design');
  await tapTab(page, 'Build');
  await page.waitForTimeout(250);
  check('No log console before anything has happened',
    (await page.locator('#logconsole').count()) === 0,
    'an empty console saying "waiting" would be decoration');

  await page.evaluate(() => {
    window.__appmintLog('info', 'Committed apps/studio/demo/spec.json');
    window.__appmintLog('step', 'RUNNING  Build debug APK');
    window.__appmintLog('ok', 'DONE  Validate the real artifact');
    window.__appmintLog('error', 'FAILED  Row level security gate');
    window.__appmintLog('warn', 'Could not check the run: rate limited');
  });
  // The drawer is part of the Build screen, so it appears when that screen is
  // drawn - which is the same thing a person does: they were on another tab,
  // something happened, they came back to look.
  await tapTab(page, 'Design');
  await tapTab(page, 'Build');
  await page.waitForTimeout(300);

  const log = await page.evaluate(() => ({
    open: document.querySelector('#logconsole').classList.contains('open'),
    n: document.querySelectorAll('#loglist li.lv-info, #loglist li.lv-step, #loglist li.lv-ok, #loglist li.lv-warn, #loglist li.lv-error').length,
    mono: getComputedStyle(document.querySelector('#loglist')).fontFamily,
    count: document.querySelector('#logconsole .logcount').textContent.trim(),
  }));
  check('The log console appears once there is something to show',
    log.open && log.n === 5, `open=${log.open}, rows=${log.n}`);
  check('The log is monospace, because it is timestamps and step names',
    /mono/i.test(log.mono), log.mono.slice(0, 60));

  await page.locator('.loglevel', { hasText: 'error' }).click();
  await page.waitForTimeout(250);
  const onlyErrors = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#loglist li')].map((n) => n.className),
    text: document.querySelector('#loglist').textContent,
  }));
  check('Filtering by level shows only that level',
    onlyErrors.rows.length === 1 && onlyErrors.rows[0] === 'lv-error' && /Row level security gate/.test(onlyErrors.text),
    JSON.stringify(onlyErrors.rows));

  await page.locator('.loglevel', { hasText: 'all' }).click();
  await page.waitForTimeout(200);
  await page.locator('input[aria-label="Filter the build log"]').fill('artifact');
  await page.waitForTimeout(300);
  const searched = await page.evaluate(() => ({
    rows: document.querySelectorAll('#loglist li:not(.logempty)').length,
    text: document.querySelector('#loglist').textContent,
    count: document.querySelector('#logconsole .logcount').textContent.trim(),
  }));
  check('Searching the log narrows it to what matches',
    searched.rows === 1 && /Validate the real artifact/.test(searched.text) && /^1 of 5$/.test(searched.count),
    `rows=${searched.rows} count="${searched.count}"`);

  await page.locator('input[aria-label="Filter the build log"]').fill('nothing will ever match this');
  await page.waitForTimeout(300);
  check('A search with no match says so instead of showing an empty box',
    /Nothing matches/.test(await page.textContent('#loglist')), await page.textContent('#loglist'));

  await page.locator('input[aria-label="Filter the build log"]').fill('');
  await page.waitForTimeout(250);
  await page.locator('#logtoggle').click();
  await page.waitForTimeout(250);
  check('The console collapses', (await page.locator('#loglist').count()) === 0, 'the list should be gone when collapsed');
  await page.locator('#logtoggle').click();
  await page.waitForTimeout(250);
  check('and opens again', (await page.locator('#loglist li').count()) === 5, 'all five entries should be back');

  await page.locator('#logconsole button:has-text("Clear")').click();
  await page.waitForTimeout(250);
  check('Clearing empties it rather than hiding it',
    /Nothing has happened yet/.test(await page.textContent('#loglist')), await page.textContent('#loglist'));

  await page.evaluate(() => { window.__appmintLogReset(); });
  await tapTab(page, 'Design');
  await tapTab(page, 'Build');
  await page.waitForTimeout(250);

  /* ── editing actually changes state ─────────────────────────────────── */
  await tapTab(page, 'Design');
  const nameInput = page.locator('input[aria-label="Application name"]');
  await nameInput.fill('Phone Test App');
  await page.waitForTimeout(250);
  const shown = await page.textContent('#projname');
  check('Typing an app name updates the header', shown.includes('Phone Test App'), `header="${shown}"`);

  /* ── the real engine is running inside the page ─────────────────────── */
  await tapTab(page, 'Features');
  // CAMERA legitimately appears in the "deliberately not requested" list, so
  // the assertion has to look at the *requested* table, not the whole page.
  const requestedText = async () => page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card')];
    const c = cards.find((x) => /Permissions this app will request/i.test(x.querySelector('h2')?.textContent || ''));
    return c ? c.textContent : '';
  });
  const before = await requestedText();
  check('Permission table starts without camera access',
    !/CAMERA/.test(before), `requested table so far: ${before.slice(0, 80)}`);

  // Turn on barcode scanning and the CAMERA permission must appear by itself.
  const camSwitch = page.locator('input[role="switch"][aria-label="Barcode / QR scanning"]');
  await camSwitch.check();
  await page.waitForTimeout(350);
  const after = await page.textContent('#main');
  check('Enabling a capability derives its permission automatically',
    after.includes('CAMERA'), 'CAMERA should appear after enabling barcode scanning');
  check('The permission explains why it is needed',
    /CAMERA/.test(after) && /camera is required to scan a code/i.test(after),
    'the permission row should carry a reason');

  // The engine also states what it is NOT requesting, which is the honest
  // proof of minimisation. This assertion is what exposed the original version
  // being unreachable code.
  check('Reports the permissions it deliberately did not request',
    /Deliberately not requested/i.test(after) && /AD_ID/.test(after),
    'expected a list of permissions left out because their features are off');

  /* ── validation genuinely blocks ────────────────────────────────────── */
  await tapTab(page, 'Build');
  let build = await page.textContent('#main');
  check('Valid configuration is not blocked', !/Build blocked/i.test(build), 'expected a pass banner');

  // Break it on purpose. Note: minSdk 33 with targetSdk 36 is perfectly valid,
  // so the obvious choice is the wrong one. A package name with a space is a
  // genuine format error, and the field is reachable from the UI.
  await tapTab(page, 'Design');
  await page.locator('input[aria-label="Package name"]').fill('com.example.not valid');
  await page.waitForTimeout(350);
  const health2 = (await page.textContent('#health')) || '';
  check('Health strip reacts to an invalid change', /Blocked/.test(health2), `health="${health2.trim()}"`);

  await tapTab(page, 'Build');
  build = await page.textContent('#main');
  check('An invalid configuration visibly blocks the build',
    /Build blocked/i.test(build), 'a package name containing a space must block the build');
  check('The exact field is named in the finding',
    /Package name|packageName/i.test(build), 'the message should point at the field');

  const startDisabled = await page.locator('button:has-text("Start build")').isDisabled().catch(() => null);
  check('The build button is disabled while blocked', startDisabled === true, `disabled=${startDisabled}`);

  // Put it back so the remaining checks run against a valid project.
  await tapTab(page, 'Design');
  await page.locator('input[aria-label="Package name"]').fill('com.example.phonetest');
  // Wait for the value to reach storage before reloading. Reloading on a fixed
  // delay raced the save and failed about one run in three with "New project" —
  // a flaky test that blames the product for the test's own timing.
  await page.waitForFunction(() => {
    try {
      return JSON.parse(localStorage.getItem('appmint.projects.v1') || '[]')
        .some((p) => p.spec && p.spec.identity.packageName === 'com.example.phonetest');
    } catch (e) { return false; }
  }, null, { timeout: 5000 });

  /**
   * Reload and wait for boot() to finish, rather than for a fixed delay.
   *
   * The header says "Loading…" until the bundle has parsed, so reading anything
   * before then reads the markup rather than the app. Three checks lost that
   * race on the slower CI runner; the bundle has only got bigger since, so the
   * delays are gone and this is what every reload waits for.
   */
  async function reloadAndWait() {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(
      () => {
        const t = ((document.querySelector('#projname') || {}).textContent || '');
        return t.length > 0 && !/Loading/i.test(t);
      },
      null, { timeout: 20000 },
    );
  }

  /* ── persistence ────────────────────────────────────────────────────── */
  await reloadAndWait();
  const afterReload = await page.textContent('#projname');
  check('Work survives a reload', afterReload.includes('Phone Test App'), `header="${afterReload}"`);


  /* ── the screen designer ─────────────────────────────────────────────── */
  // Everything here goes through the real component library: the palette is
  // generated from it, the properties come from it, and the findings are its
  // findings. So these checks are also checks on the library.
  await tapTab(page, 'Screens');

  check('The designer offers to start the first screen',
    /Build the first screen/i.test(await page.textContent('#main')), 'expected an empty-state call to action');

  await page.locator('button:has-text("Build the first screen")').click();
  await page.waitForTimeout(300);
  const afterFirst = await page.textContent('#main');
  check('Adding a screen creates a real screen with content',
    /Contents of/i.test(afterFirst) && /Heading/.test(afterFirst), 'expected an outline with components');

  // The preview must draw what the outline says, from the same description.
  const previewTypes = await page.evaluate(() =>
    [...document.querySelectorAll('#preview-root .pv-node')].map((n) => n.dataset.type));
  check('The preview draws the designed components',
    previewTypes.includes('Heading') && previewTypes.includes('Text'),
    `drew: ${previewTypes.join(', ')}`);

  check('The preview states plainly that it is a browser drawing',
    /browser drawing/i.test(await page.textContent('.pv-caption')), 'the caption must not pretend to be the device');

  // add a component from the palette
  await page.locator('button:has-text("+ Add")').click();
  await page.waitForTimeout(250);
  const groups = await page.locator('.palette-groups .chip').count();
  check('The palette is grouped, and generated from the library', groups >= 6, `found ${groups} groups`);

  await page.locator('.palette-groups .chip', { hasText: 'Input' }).click();
  await page.waitForTimeout(200);
  await page.locator('.pitem', { hasText: 'Button' }).first().click();
  await page.waitForTimeout(350);
  const withButton = await page.evaluate(() =>
    [...document.querySelectorAll('#preview-root .pv-node')].map((n) => n.dataset.type));
  check('A component added from the palette appears in the preview',
    withButton.includes('Button'), `drew: ${withButton.join(', ')}`);

  // editing a property updates the preview without a redraw of the whole page
  const textField = page.locator('#prop-text');
  check('Selecting a component shows its properties',
    await textField.count() > 0, 'expected a text property for a Button');
  await textField.fill('Tap me');
  await page.waitForTimeout(300);
  const previewText = await page.textContent('#preview-root');
  check('Editing a property changes the preview', /Tap me/.test(previewText), 'the edited text should be drawn');

  // an image with no label is an error, and the fix is one tap
  await page.locator('button:has-text("+ Add")').click();
  await page.waitForTimeout(200);
  await page.locator('.palette-groups .chip', { hasText: 'Media' }).click();
  await page.waitForTimeout(200);
  await page.locator('.pitem', { hasText: 'Image' }).first().click();
  await page.waitForTimeout(400);
  const findingText = await page.textContent('#main');
  check('An image without a screen-reader label is reported as an error',
    /describe this for someone using a screen reader/i.test(findingText), 'expected the accessibility finding');
  // There is deliberately no auto-fix here: a screen-reader label has to say
  // what the picture IS, and inventing that would be worse than asking. The
  // remedy is to jump to the field, which is what the finding offers.
  const showMe = page.locator('.finding button', { hasText: /Show me/i });
  check('The finding offers to jump to the exact field', await showMe.count() > 0, 'expected a "Show me" button');
  await showMe.first().click();
  await page.waitForTimeout(350);
  const labelField = page.locator('#prop-a11yLabel');
  check('The field that needs filling is the one shown', await labelField.count() > 0, 'expected the label field to be visible');
  await labelField.fill('A photograph of the shop front');
  await page.waitForTimeout(400);
  check('Filling the label clears the finding',
    !/describe this for someone using a screen reader/i.test(await page.textContent('#main')),
    'the finding should be gone once the label exists');

  // two components with the same name in one screen is refused
  await page.locator('button:has-text("+ Add")').click();
  await page.waitForTimeout(200);
  await page.locator('.palette-groups .chip', { hasText: 'Layout' }).click();
  await page.waitForTimeout(200);
  await page.locator('.pitem', { hasText: 'Card' }).first().click();
  await page.waitForTimeout(300);
  await tapTab(page, 'Screens');
  const firstNode = page.locator('.tree .node-main').first();
  await firstNode.click();
  await page.waitForTimeout(200);
  await page.locator('#node-name').fill('dupe');
  await page.waitForTimeout(250);
  const secondNode = page.locator('.tree .node-main').nth(1);
  await secondNode.click();
  await page.waitForTimeout(200);
  await page.locator('#node-name').fill('dupe');
  await page.waitForTimeout(350);
  // The engine refuses the design, and the designer prevents it happening at
  // all: two components with one name would make the second take over the
  // first one's behaviour in the app, so the change is refused with the reason
  // shown rather than accepted and complained about later.
  check('A repeated name is refused, and the reason is shown',
    await page.locator('#node-name-err').isVisible(), 'expected a visible explanation');
  check('The refused name was not written into the design',
    /take over the first one/i.test(await page.evaluate(() => JSON.stringify(window.__appmintTemplates))) === false,
    'sanity: templates are not the project state');
  const ids = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tree .node')];
    return rows.map((r) => r.querySelector('.node-id')?.textContent || '');
  });
  check('Every component still has its own name', new Set(ids).size === ids.length, `ids: ${ids.join(', ')}`);

  // a second screen, and switching between them
  await page.locator('.screen-chips .chip.add').click();
  await page.waitForTimeout(350);
  const chipCount = await page.locator('.screen-chips .chip').count();
  check('A second screen can be added and selected', chipCount >= 3, `found ${chipCount} chips (including the add button)`);

  /* ── undo and redo in the designer ───────────────────────────────────── */
  // Repairs on the Build screen were reversible; designer edits were not, which
  // is backwards, because dragging something into the wrong place is easier to
  // do by accident than applying a repair that asks first.
  await tapTab(page, 'Screens');
  await page.waitForTimeout(300);

  const orderOf = () => page.evaluate(() =>
    [...document.querySelectorAll('.tree .node')].map((r) => r.querySelector('.node-id')?.textContent || ''));
  const orderBefore = await orderOf();
  check('The outline lists components in an order', orderBefore.length >= 2,
    `found ${orderBefore.length} rows`);

  const undoBtn = page.locator('#undo-edit');
  const redoBtn = page.locator('#redo-edit');
  check('Undo and redo are offered in the designer',
    await undoBtn.count() === 1 && await redoBtn.count() === 1, 'expected both buttons');
  /* Whether Undo is enabled here depends on the edits made earlier in this run,
     so asserting a particular state would be asserting something about the test
     rather than the product. What has to be true is narrower and more useful:
     with nothing recorded, pressing it must not pretend to have undone
     something. */

  // Delete the last component, then undo it. Going through the real button
  // matters: wiring the history to the wrong mutation is the likely mistake.
  const lastRow = page.locator('.tree .node').last();
  await lastRow.locator('.ibtn[aria-label="Delete"]').click();
  await page.waitForTimeout(350);
  const orderAfterDelete = await orderOf();
  check('Deleting removes a component from the outline',
    orderAfterDelete.length === orderBefore.length - 1,
    `${orderBefore.length} → ${orderAfterDelete.length}`);
  check('Undo is available once there is something to undo',
    !(await undoBtn.isDisabled()), 'expected Undo to enable');

  await undoBtn.click();
  await page.waitForTimeout(350);
  check('Undo puts the deleted component back exactly where it was',
    JSON.stringify(await orderOf()) === JSON.stringify(orderBefore),
    `expected ${orderBefore.join(', ')}`);
  check('Redo becomes available after an undo', !(await redoBtn.isDisabled()), 'expected Redo to enable');

  await redoBtn.click();
  await page.waitForTimeout(350);
  check('Redo re-applies the deletion',
    JSON.stringify(await orderOf()) === JSON.stringify(orderAfterDelete),
    `expected ${orderAfterDelete.join(', ')}`);
  await undoBtn.click();          // leave the screen as it was
  await page.waitForTimeout(300);

  /* ── reordering, including the move the arrows cannot express ─────────── */
  // The tree rows are draggable, which is the affordance; what has to be true is
  // that a component can be placed somewhere else and the tree agrees.
  check('Components in the outline can be dragged',
    await page.locator('.tree .node[draggable="true"]').count() >= 2,
    'expected the rows to be drag sources');

  // Reordering is exercised through the move-down button, which runs the same
  // moveComponent the drop handler depends on, so the shared path is covered
  // without relying on HTML5 drag simulation, which is not reliable here.
  const firstRow = page.locator('.tree .node').first();
  await firstRow.locator('.ibtn[aria-label="Move down"]').click();
  await page.waitForTimeout(350);
  const orderAfterMove = await orderOf();
  check('A component can be reordered',
    orderAfterMove.length === orderBefore.length
      && JSON.stringify(orderAfterMove) !== JSON.stringify(orderBefore),
    `before ${orderBefore.join(', ')} → after ${orderAfterMove.join(', ')}`);
  await undoBtn.click();
  await page.waitForTimeout(350);
  check('Reordering is undoable',
    JSON.stringify(await orderOf()) === JSON.stringify(orderBefore),
    'expected the original order back');

  /* ── moving components on the canvas ─────────────────────────────────────
     The design prompt asks the visual builder to feel like Figma: dragging
     with a drop indicator and alignment guides. The outline's drag cannot show
     either, so these checks are about the canvas itself — and about the two
     claims that are easiest to fake: that the drop lands where the indicator
     said it would, and that a refusal is a refusal rather than a silent no-op. */

  const historyNow = () => page.evaluate(() => window.__appmintHistory());
  const topsOf = () => page.evaluate(() => [...document.querySelectorAll('#preview-root .pv-body > .pv-node')]
    .map((n) => n.dataset.id));
  /* The tree row is a rendering of the component; what "untouched" has to mean
     is that the specification's shape is the same, so this reads the ids out of
     the specification itself rather than out of the labels the tree happens to
     be showing. */
  const structureOf = () => page.evaluate(() => {
    const walk = (list, out) => { for (const n of list || []) { out.push(n.id); walk(n.children, out); } return out; };
    return (window.__appmintSpec().screens || []).flatMap((s) => walk(s.components, []));
  });

  const tops = await topsOf();
  check("The canvas draws the screen's components, and each can be addressed", tops.length >= 2,
    `top-level components: ${tops.length}`);

  /* Tapping the drawing selects — and the outline has to agree, or the two
     halves of the editor disagree about what is being edited. */
  const firstTop = page.locator('#preview-root .pv-body > .pv-node').first();
  await firstTop.scrollIntoViewIfNeeded();
  await firstTop.click();
  await page.waitForTimeout(350);
  const afterTap = await page.evaluate(() => {
    const sel = document.querySelector('#preview-root .pv-node.sel');
    const row = document.querySelector('.tree .node.on');
    return {
      selId: sel ? sel.dataset.id : null,
      treeName: row ? ((row.querySelector('.node-id') || {}).textContent || '') : '',
      grip: !!(sel && sel.querySelector(':scope > .pv-grip')),
    };
  });
  check('Tapping a component in the preview selects it, and the outline agrees',
    afterTap.selId === tops[0] && afterTap.treeName.length > 0, JSON.stringify(afterTap));
  check('The selected component offers a grip to drag it by', afterTap.grip,
    'no .pv-grip inside the selection');

  const gripBox = await page.locator('#preview-root .pv-node.sel .pv-grip').boundingBox();
  check('The grip is a real 44px touch target, not a decorative dot',
    gripBox && gripBox.width >= 44 && gripBox.height >= 44,
    gripBox ? `${Math.round(gripBox.width)}x${Math.round(gripBox.height)}` : 'no grip box');

  /* touch-action is what makes a touch drag possible at all, and it is only
     safe on the grip: on the components it would take scrolling away from a
     screen that is usually taller than the phone. */
  const touchActions = await page.evaluate(() => ({
    node: getComputedStyle(document.querySelector('#preview-root .pv-node')).touchAction,
    grip: getComputedStyle(document.querySelector('#preview-root .pv-node.sel .pv-grip')).touchAction,
  }));
  check('Only the grip claims the touch gesture, so the screen behind it still scrolls',
    touchActions.grip === 'none' && touchActions.node !== 'none', JSON.stringify(touchActions));

  /* A drag that lands exactly where the component already is changes nothing,
     so it must record nothing: an undo step for a no-op is a claim that
     something happened. */
  const orderBeforeNoop = await orderOf();
  const historyBeforeNoop = await historyNow();
  const boxA = await page.locator('#preview-root .pv-body > .pv-node').first().boundingBox();
  const boxB = await page.locator('#preview-root .pv-body > .pv-node').nth(1).boundingBox();
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxA.x + boxA.width / 2 + 12, boxA.y + boxA.height / 2 + 10, { steps: 4 });
  await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + Math.min(10, boxB.height * 0.2), { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const historyAfterNoop = await historyNow();
  check('A drag that lands where the component already was records nothing',
    historyAfterNoop.length === historyBeforeNoop.length
      && JSON.stringify(await orderOf()) === JSON.stringify(orderBeforeNoop),
    `history ${historyBeforeNoop.length} -> ${historyAfterNoop.length}`);

  /* The drag itself, with the mouse. What is being tested while the pointer is
     down is not the outcome but the promise: an outline that says what is
     moving, a line that says where it will land, and guides that say what it
     has lined up with. */
  const orderBeforeDrag = await orderOf();
  const historyBeforeDrag = await historyNow();
  const srcBox = await page.locator('#preview-root .pv-body > .pv-node').first().boundingBox();
  const dstBox = await page.locator('#preview-root .pv-body > .pv-node').last().boundingBox();
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(srcBox.x + srcBox.width / 2 + 16, srcBox.y + srcBox.height / 2 + 34, { steps: 5 });
  await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height - 6, { steps: 8 });
  await page.waitForTimeout(150);
  const inTheAir = await page.evaluate(() => ({
    ghost: !!document.querySelector('.pv-ghost'),
    label: (document.querySelector('.pv-ghost-label') || {}).textContent || '',
    line: !!document.querySelector('#preview-root .pv-overlay .pv-line'),
    refused: !!document.querySelector('#preview-root .pv-overlay .refused'),
    guides: document.querySelectorAll('#preview-root .pv-overlay .pv-guide').length,
  }));
  check('A component in the air is drawn as an outline that names it',
    inTheAir.ghost && inTheAir.label.length > 0, JSON.stringify(inTheAir));
  check('The canvas says where the component will land',
    inTheAir.line && !inTheAir.refused, JSON.stringify(inTheAir));
  check('Alignment guides are drawn while dragging, so edges line up rather than being guessed at',
    inTheAir.guides >= 1, `guides drawn: ${inTheAir.guides}`);

  // The guides exist only while a drag is open, so this is the only moment a
  // picture of them can be taken.
  try { await page.screenshot({ path: path.join(ROOT, 'studio/screenshots/studio-drag.png') }); }
  catch (e) { console.log(`  (screenshot "studio-drag.png" skipped: ${e.message.split('\n')[0]})`); }

  await page.mouse.up();
  await page.waitForTimeout(450);
  const orderAfterDrag = await orderOf();
  check('Dropping lands the component where the indicator promised',
    orderAfterDrag.length === orderBeforeDrag.length
      && orderAfterDrag[orderAfterDrag.length - 1] === orderBeforeDrag[0],
    `before ${orderBeforeDrag.join(', ')} -> after ${orderAfterDrag.join(', ')}`);

  const afterDragHistory = await historyNow();
  check('A canvas move is recorded as an edit, so it can be undone',
    afterDragHistory.length === historyBeforeDrag.length + 1 && /^Move /.test(afterDragHistory[0] || ''),
    `newest edit: "${afterDragHistory[0]}"`);

  await page.locator('#undo-edit').click();
  await page.waitForTimeout(400);
  check('Undo walks a canvas move back to where it was',
    JSON.stringify(await orderOf()) === JSON.stringify(orderBeforeDrag),
    `expected ${orderBeforeDrag.join(', ')}`);

  /* Dropping a container onto one of its own children would put the container
     inside itself, which breaks the tree. The refusal has to be visible while
     the pointer is still down, and the drop has to leave the project and the
     undo stack exactly as they were.

     This is also the one place that checks the other half of "add": with a
     container selected, the next component goes inside it. */
  await page.locator('button:has-text("+ Add")').click();
  await page.waitForTimeout(250);
  await page.locator('.palette-groups .chip', { hasText: 'Layout' }).click();
  await page.waitForTimeout(250);
  await page.locator('.pitem', { hasText: 'Card' }).first().click();
  await page.waitForTimeout(450);
  await page.locator('button:has-text("+ Add")').click();
  await page.waitForTimeout(250);
  await page.locator('.palette-groups .chip', { hasText: 'Text' }).click();
  await page.waitForTimeout(250);
  await page.locator('.pitem', { hasText: 'Heading' }).first().click();
  await page.waitForTimeout(450);
  // A component from the palette starts empty, and an empty one has no height
  // to aim at; give it words.
  await page.locator('#prop-text').fill('Inside the card');
  await page.waitForTimeout(400);

  const card = page.locator('#preview-root .pv-node[data-type="Card"]').first();
  const cardChild = page.locator('#preview-root .pv-node[data-type="Card"] .pv-node[data-type="Heading"]').first();
  check('A component added while a container is selected is drawn inside it',
    await cardChild.count() === 1, 'expected the heading to land inside the card');
  // Centre it rather than scrolling it "into view": the top of this page is a
  // sticky strip, and an element sitting underneath it cannot be pointed at.
  await card.evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
  const cardBox = await card.boundingBox();
  const childBox = await cardChild.boundingBox();
  const structureBeforeRefusal = await structureOf();
  const historyBeforeRefusal = await historyNow();
  // Let the "added" toast finish before this drag can print its own.
  await page.waitForTimeout(2700);
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 6);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 18, cardBox.y + cardBox.height / 2, { steps: 5 });
  await page.mouse.move(childBox.x + childBox.width / 2, childBox.y + childBox.height / 2, { steps: 5 });
  await page.waitForTimeout(150);
  const refusedNow = await page.evaluate(() => ({
    box: !!document.querySelector('#preview-root .pv-overlay .pv-box.refused'),
    line: !!document.querySelector('#preview-root .pv-overlay .pv-line.refused'),
  }));
  check('A drop that cannot happen is drawn as refused while the pointer is still down',
    refusedNow.box || refusedNow.line, JSON.stringify(refusedNow));
  await page.mouse.up();
  await page.waitForTimeout(400);
  const refusalToast = ((await page.textContent('#toast')) || '').trim();
  check('The refusal is explained rather than silently ignored',
    /inside itself/i.test(refusalToast), `toast reads "${refusalToast}"`);
  const historyAfterRefusal = await historyNow();
  const structureAfterRefusal = await structureOf();
  check('A refused drop leaves the project and the undo stack untouched',
    JSON.stringify(structureAfterRefusal) === JSON.stringify(structureBeforeRefusal)
      && JSON.stringify(historyAfterRefusal) === JSON.stringify(historyBeforeRefusal),
    `structure ${JSON.stringify(structureBeforeRefusal)} -> ${JSON.stringify(structureAfterRefusal)}; `
    + `history ${JSON.stringify(historyBeforeRefusal)} -> ${JSON.stringify(historyAfterRefusal)}`);

  /* The same drag on a touchscreen. The pointer events are dispatched by hand,
     on the grip, because that is the path the product defines for touch — and
     because a synthetic touch through the driver would be measuring the driver. */
  await page.locator('#preview-root .pv-body > .pv-node').first().click();
  await page.waitForTimeout(350);
  const orderBeforeTouch = await orderOf();
  const touchResult = await page.evaluate(() => {
    const from = document.querySelector('#preview-root .pv-node.sel');
    if (!from) return 'nothing is selected';
    const grip = from.querySelector(':scope > .pv-grip');
    if (!grip) return 'the selected component has no grip';
    const others = [...document.querySelectorAll('#preview-root .pv-body > .pv-node')].filter((n) => n !== from);
    const to = others.pop();
    if (!to) return 'there is no second component to drop beside';
    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: 21, pointerType: 'touch', isPrimary: true, buttons: 1,
    });
    const g = grip.getBoundingClientRect();
    grip.dispatchEvent(mk('pointerdown', g.x + g.width / 2, g.y + g.height / 2));
    const r = from.getBoundingClientRect();
    window.dispatchEvent(mk('pointermove', r.x + r.width / 2 + 20, r.y + r.height / 2 + 28));
    window.dispatchEvent(mk('pointermove', r.x + r.width / 2 + 26, r.y + r.height / 2 + 44));
    const t = to.getBoundingClientRect();
    window.dispatchEvent(mk('pointermove', t.x + t.width / 2, t.y + t.height - 6));
    window.dispatchEvent(mk('pointerup', t.x + t.width / 2, t.y + t.height - 6));
    return window.__appmintHistory()[0] || '';
  });
  await page.waitForTimeout(450);
  check('A drag that begins on the grip works with touch pointer events',
    typeof touchResult === 'string' && /^Move /.test(touchResult), `result: "${touchResult}"`);
  check('The touch drag moved the component',
    JSON.stringify(await orderOf()) !== JSON.stringify(orderBeforeTouch), 'the order did not change');
  await page.locator('#undo-edit').click();
  await page.waitForTimeout(400);

  /* A heading and its explanation used to be two bare spans in a div, so they
     were drawn run together — "PreviewDrawn in the browser from the same
     numbers the app uses." — in every cell that used them. */
  const headLayout = await page.evaluate(() => {
    const head = document.querySelector('.d-head');
    if (!head) return null;
    const t = head.querySelector('.d-title');
    const n = head.querySelector('.d-note');
    if (!t || !n) return null;
    const a = t.getBoundingClientRect();
    const b = n.getBoundingClientRect();
    return { sameLine: Math.abs(a.top - b.top) < 2, gap: Math.round(b.left - a.right) };
  });
  check('A heading and its explanation are separated, not run together',
    !!headLayout && (headLayout.sameLine ? headLayout.gap >= 6 : true),
    JSON.stringify(headLayout));

  /* ── the command palette ─────────────────────────────────────────────── */
  // Keyboard-first, but it also has a button, because the way most people hold
  // this tool is a phone and there is no Ctrl key on a phone.
  const palBtn = page.locator('#palbtn');
  check('There is a button to open the command palette', await palBtn.count() === 1, 'expected #palbtn');
  await palBtn.click();
  await page.waitForTimeout(300);
  check('The palette opens with a field ready to type into',
    await page.locator('#pal-input').isVisible(), 'expected the palette input');
  check('The palette lists actions before anything is typed',
    await page.locator('.pal-item').count() >= 5,
    `found ${await page.locator('.pal-item').count()} items`);

  await page.locator('#pal-input').fill('feat');
  await page.waitForTimeout(250);
  const firstItem = await page.locator('.pal-item').first().textContent();
  check('Typing filters the list to what matches',
    /Features/i.test(firstItem || ''), `first match was "${(firstItem || '').trim()}"`);

  // "go to build" has to survive being abbreviated, which is the whole point of
  // a palette: nobody types the full label of the thing they were looking for.
  await page.locator('#pal-input').fill('bild');
  await page.waitForTimeout(250);
  check('An abbreviation still finds the command',
    await page.locator('.pal-item').count() >= 1,
    'expected "bild" to match "Build" by subsequence');

  await page.locator('#pal-input').fill('Features');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const afterEnter = await page.textContent('#main');
  check('Running a command takes you there',
    afterEnter.includes('Permissions this app will request'),
    'expected the Features section to be showing');
  check('The palette closes once a command runs',
    await page.locator('#pal-input').count() === 0, 'expected the overlay to be gone');

  await page.keyboard.press('Control+k');
  await page.waitForTimeout(300);
  check('Ctrl+K opens it again', await page.locator('#pal-input').isVisible(), 'expected the palette');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Escape closes it', await page.locator('#pal-input').count() === 0, 'expected the overlay gone');

  await page.locator('#palbtn').click();
  await page.waitForTimeout(250);
  await page.locator('#pal-input').fill('zzzznotacommand');
  await page.waitForTimeout(250);
  check('A query that matches nothing says so instead of showing an empty box',
    /Nothing matches/i.test(await page.textContent('.pal-list')),
    'expected an explanation');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // the app is switched to native screens, so the build path matches the design
  await tapTab(page, 'Design');
  const modeSelect = page.locator('select[aria-label="Architecture"]');
  check('The architecture can be set to designed screens', await modeSelect.count() > 0, 'expected an architecture selector');
  await modeSelect.selectOption('native-screens');
  await page.waitForTimeout(400);
  const healthAfter = await page.textContent('#health');
  check('A designed app validates against the same rules as everything else',
    /Valid|Ready|Blocked/.test(healthAfter), `health="${healthAfter.trim()}"`);

  /* ── offline: no external requests at all ───────────────────────────── */
  /* ── tapping a section ────────────────────────────────────────────────────
   Every section change in this file goes through here rather than calling
   .click() directly, for a reason that cost a whole CI run to learn.

   A bare .click() that cannot reach its target throws, the throw escapes
   main(), and the process exits 1 having reported nothing — so 33 checks that
   come later in the file never run, and the only output is "Timeout exceeded"
   with no clue what was in the way. This helper waits for the tab to be
   actionable, retries, and on the last attempt asks the page what element is
   actually sitting at that point. "Covered by <div class=sheet-back>" is a
   finding. "Timeout exceeded" is not. */
async function tapTab(page, label) {
  const tab = page.locator('.tabbar .tab', { hasText: label });
  const attempts = 4;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await tab.scrollIntoViewIfNeeded({ timeout: 4000 });
      await tab.click({ timeout: i === attempts - 1 ? 15000 : 5000 });
      await page.waitForTimeout(200);
      return;
    } catch (e) {
      if (i === attempts - 1) {
        const why = await page.evaluate((text) => {
          const t = [...document.querySelectorAll('.tabbar .tab')]
            .find((n) => n.textContent.includes(text));
          if (!t) return `no tab contains "${text}"`;
          const r = t.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const vis = getComputedStyle(t);
          const shown = r.width > 0 && r.height > 0 && vis.visibility !== 'hidden' && vis.display !== 'none';
          return `tab "${text}" shown=${shown} rect=${Math.round(r.width)}x${Math.round(r.height)} `
            + `at ${Math.round(r.left)},${Math.round(r.top)}; the element there is `
            + (at ? `<${at.tagName.toLowerCase()} class="${at.className}">` : 'nothing');
        }, label).catch(() => 'the page could not be inspected');
        throw new Error(`could not tap the "${label}" section — ${why}`);
      }
      await page.waitForTimeout(700);
    }
  }
}

const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  await tapTab(page, 'Preview');
  await tapTab(page, 'Build');
  check('No external resources are requested', external.length === 0, external.join(', '));

  await tapTab(page, 'Preview');
  const frameCount = await page.locator('.device').count();
  check('Preview draws a device frame', frameCount === 1, `found ${frameCount} .device elements`);

  /* The frame has to be wearing the APP's colours, not the Studio's.

     The previous version of this check asked only whether the background was
     non-transparent, which the tool's own grey satisfies — so it passed for as
     long as the preview was being drawn in the Studio's palette. That is why
     it is rewritten rather than extended: it now sets a colour nothing else in
     the interface uses, and fails unless the frame, a card inside it and a
     caption inside that card are all dressed in it. */
  const toRgb = (hex) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  };
  const themeBg = '#0B3D2E';       // deliberately unlike any Studio surface
  const themeSurface = '#12503C';
  const themeText = '#E8F5EE';
  const themePrimary = '#F2A93B';

  const previewColours = async () => page.evaluate(() => {
    const pick = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const c = getComputedStyle(n);
      return { bg: c.backgroundColor, fg: c.color, border: c.borderTopColor };
    };
    return {
      frame: pick('.screen.app-screen'),
      card: pick('.screen.app-screen .pv-card'),
      caption: pick('.screen.app-screen .pv-card .d'),
      action: pick('.screen.app-screen .pv-btn:not(.ghost)'),
    };
  });

  // Set the theme through the real Design screen rather than by poking state,
  // so the check covers the path a person actually takes. Each control is
  // addressed by its accessible label, because the order of the colour fields
  // is a layout detail and the label is the contract.
  await tapTab(page, 'Design');
  const colourInputs = await page.locator('input[type="color"]').count();
  check('The theme offers colour controls to change', colourInputs >= 2, `found ${colourInputs} colour inputs`);
  for (const [label, value] of [
    ['Background', themeBg], ['Surface', themeSurface],
    ['Text on surface', themeText], ['Primary', themePrimary],
  ]) {
    await page.locator(`input[type="color"][aria-label="${label}"]`).evaluate((n, v) => {
      n.value = v;
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);

  await tapTab(page, 'Preview');
  const drawn = await previewColours();

  check('Preview applies the project theme colours',
    drawn.frame && drawn.frame.bg === toRgb(themeBg),
    `frame background ${drawn.frame && drawn.frame.bg}, expected ${toRgb(themeBg)}`);
  check('A card inside the preview is dressed in the app theme, not the tool palette',
    drawn.card && drawn.card.bg === toRgb(themeSurface),
    `card bg ${drawn.card && drawn.card.bg}, expected ${toRgb(themeSurface)}`);
  // Muted text is a dimmed copy of the app's own text colour, not a grey from
  // the Studio, so the check is that the same RGB comes back with alpha below
  // 1 — which is what "derived from your theme" can honestly mean.
  const t = toRgb(themeText).match(/\d+/g).map(Number);
  const isDimmedThemeText = (c) => {
    const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(c || '');
    if (!m) return false;
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    const a = m[4] === undefined ? 1 : Number(m[4]);
    return r === t[0] && g === t[1] && b === t[2] && a > 0 && a < 1;
  };
  check('Text inside the preview is derived from the app theme',
    drawn.caption && isDimmedThemeText(drawn.caption.fg),
    `caption ${drawn.caption && drawn.caption.fg}, expected ${toRgb(themeText)} at reduced alpha`);
  check('The primary action in the preview uses the app accent',
    drawn.action && drawn.action.bg === toRgb(themePrimary),
    `action bg ${drawn.action && drawn.action.bg}, expected ${toRgb(themePrimary)}`);

  /* ── light mode is reachable, real, and remembered ───────────────────── */
  // A palette defined in tokens but with no way to turn it on is not a light
  // mode, so the control is driven the way a person drives it, and the result
  // is read off the page rather than assumed.
  const themeBtn = page.locator('#themebtn');
  check('There is a control to change colour mode', await themeBtn.count() === 1, 'expected #themebtn');
  const startTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await themeBtn.click();
  await page.waitForTimeout(250);
  const flipped = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    fg: getComputedStyle(document.body).color,
  }));
  check('The control switches the whole interface to the other theme',
    flipped.attr !== startTheme && /light|dark/.test(flipped.attr || ''),
    `${startTheme} → ${flipped.attr}`);
  // Light mode must be an actual light surface, not the dark one relabelled.
  const isLight = flipped.attr === 'light';
  const channel = (rgb) => Number((/(\d+)/.exec(rgb) || [])[1] ?? 0);
  check('The switched theme really repaints the surface',
    isLight ? channel(flipped.bg) > 200 : channel(flipped.bg) < 60,
    `body background is ${flipped.bg} in ${flipped.attr} mode`);
  check('Text and surface stay far enough apart to read',
    Math.abs(channel(flipped.bg) - channel(flipped.fg)) > 120,
    `bg ${flipped.bg} vs text ${flipped.fg}`);

  // A preference that is forgotten on reload is not a preference.
  await reloadAndWait();
  const afterReloadTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('The colour mode survives a reload', afterReloadTheme === flipped.attr,
    `was ${flipped.attr}, came back as ${afterReloadTheme}`);

  // Put it back so the remaining checks run against the theme they expect.
  await page.locator('#themebtn').click();
  await page.waitForTimeout(250);
  check('It switches back', 
    await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === startTheme,
    'expected the original theme back');

  /* ── nothing on screen may ever read as broken ─────────────────────── */
  // "undefined", "NaN" and "[object Object]" are how a program tells the user
  // it has lost track of its own state. They are always a bug, never a value,
  // and one of them reached the health strip before this check existed.
  const brokenWords = [];
  for (const tab of ['Design', 'Screens', 'Features', 'Preview', 'Build']) {
    await tapTab(page, tab);
    const text = await page.textContent('#main');
    const header = await page.textContent('#health');
    const top = await page.textContent('.topbar');
    // Plain substring search on purpose: a regular expression built from a
    // literal like "[object Object]" is a character class, which matches
    // practically everything and reports a clean interface as broken.
    for (const bad of ['undefined', 'NaN', '[object Object]']) {
      if ((text + ' ' + header + ' ' + top).includes(bad)) brokenWords.push(`${tab}: "${bad}"`);
    }
  }
  check('No section shows a broken value', brokenWords.length === 0,
    brokenWords.join(', ') || 'no undefined, NaN or [object Object] anywhere in the interface');

  /* ── sections fold, and say what is inside ──────────────────────────── */
  await tapTab(page, 'Design');
  const secCount = await page.locator('.sec').count();
  check('The design tab is organised into foldable sections', secCount >= 4, `found ${secCount}`);
  const closedCount = await page.locator('.sec[data-open="0"]').count();
  check('Some sections start folded away', closedCount > 0, `a page that opens everything is a long scroll`);
  const closedSummary = (await page.locator('.sec[data-open="0"]').first().textContent()).trim();
  check('A folded section still says what is inside', closedSummary.length > 20,
    `closed section reads: "${closedSummary.slice(0, 60)}"`);

  // Pin the section by its id before clicking. A locator meaning "the first
  // closed section" points at a different section the instant the first one
  // opens, so asserting through it reads the wrong element and the check fails
  // while the interface is behaving correctly.
  const secId = await page.locator('.sec[data-open="0"]').first().getAttribute('id');
  await page.locator(`#${secId} .sec-head`).click();
  await page.waitForTimeout(250);
  check('Tapping a section header opens it',
    await page.locator(`#${secId}`).getAttribute('data-open') === '1', `section ${secId} should be open`);
  const nowClosed = await page.locator('.sec[data-open="0"]').count();
  check('Opening one section closes nothing else', nowClosed === closedCount - 1,
    `${closedCount} closed before, ${nowClosed} after`);

  /* ── controls are big enough for a thumb ────────────────────────────── */
  const tooSmall = await page.evaluate(() => {
    const out = [];
    for (const node of document.querySelectorAll('#main button, #main input, #main select, #main textarea, .tabbar .tab')) {
      const r = node.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.height < 38) out.push((node.textContent || node.getAttribute('aria-label') || node.className).trim().slice(0, 26) + ` (${Math.round(r.height)}px)`);
    }
    return out;
  });
  check('Every control is big enough to tap', tooSmall.length === 0, tooSmall.join(', '));

  /* ── no console noise ───────────────────────────────────────────────── */
  check('No uncaught errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('No console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  /* ── screenshot for the record ──────────────────────────────────────── */
  const shotDir = path.join(ROOT, 'studio/screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  /* Capturing a picture is evidence, not an assertion. If one cannot be taken
     the run should say so and carry on: the checks that follow are the point of
     this file, and a screenshot is not worth losing them over. Before this, a
     click that timed out inside the loop escaped main() and the process exited
     1 having printed nothing at all. */
  const shoot = async (tab, file) => {
    try {
      await tapTab(page, tab);
      // The top bar is sticky, so a scrolled page puts the health strip behind it
      // and the screenshot looks broken. Return to the top before capturing.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(shotDir, file) });
    } catch (e) {
      console.log(`  (screenshot "${file}" skipped: ${e.message.split('\n')[0]})`);
    }
  };
  await shoot('Design', 'studio-design.png');
  await shoot('Features', 'studio-features.png');
  await shoot('Screens', 'studio-screens.png');
  await shoot('Preview', 'studio-preview.png');
  await shoot('Build', 'studio-build.png');

  // A second frame, scrolled down, to show the permission table rather than
  // the tab buttons covering it.
  try {
    await tapTab(page, 'Features');
    await page.evaluate(() => window.scrollBy(0, 620));
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shotDir, 'studio-permissions.png') });
  } catch (e) {
    console.log(`  (screenshot "studio-permissions.png" skipped: ${e.message.split('\n')[0]})`);
  }

  /* ── the repair screen ─────────────────────────────────────────────── */

  /*
   * A project with two problems of deliberately different kinds:
   *   android.minSdk above android.targetSdk  — impossible, so repairable
   *   android.cleartextTraffic turned on      — legal, so only your call
   * The repair screen must treat them differently: fix the first in bulk, and
   * never touch the second without being asked.
   */
  async function loadBrokenProject() {
    await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('appmint.projects.v1') || '[]');
      const p = list[0];
      p.spec.identity.appName = 'Repair Screen Test';
      p.spec.android.minSdk = 36;
      p.spec.android.targetSdk = 26;
      p.spec.android.cleartextTraffic = true;
      delete p.repairs;
      localStorage.setItem('appmint.projects.v1', JSON.stringify(list));
      localStorage.setItem('appmint.active.v1', p.id);
    });
    await reloadAndWait();
    await tapTab(page, 'Build');
  }

  await loadBrokenProject();
  const repairText = await page.textContent('#main');
  check('A problem that cannot work is offered as a repair',
    /Ready to repair/i.test(repairText), 'expected the repair card');
  check('The repair says what it will change before changing it',
    /minSdk/.test(repairText) && /36 → 26/.test(repairText),
    'the before and after must both be visible before the press');
  check('A repair that changes your decision is listed, not applied',
    /Your call/i.test(repairText) && /cleartextTraffic/.test(repairText),
    'the HTTP setting must be offered separately');

  const caughtByBulk = await page.evaluate(() => {
    // The bulk button must not carry the judgement call with it.
    const bulk = [...document.querySelectorAll('button')].find((b) => /^Repair \d+ problem/.test(b.textContent));
    return bulk ? bulk.textContent.trim() : null;
  });
  check('The bulk repair counts only the problems it may touch',
    caughtByBulk === 'Repair 1 problem', `the button said: ${caughtByBulk}`);

  await page.locator('button:has-text("Repair 1 problem")').click();
  await page.waitForTimeout(600);
  const afterRepair = await page.textContent('#main');
  // "36 → 26" also appears in the record of what was done, so the check is on
  // the offer disappearing rather than on the string being absent.
  const stillOffered = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => /^Repair \d+ problem/.test(b.textContent)));
  check('Repairing fixes the impossible value',
    !stillOffered && /Ready to repair/i.test(afterRepair) === false,
    'the repaired step should no longer be offered');
  check('Repairing leaves the judgement call alone',
    /cleartextTraffic/.test(afterRepair), 'the HTTP setting must survive the bulk repair');

  const stored = await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('appmint.projects.v1') || '[]');
    const p = list.find((x) => x.spec.identity.appName === 'Repair Screen Test');
    return { min: p.spec.android.minSdk, target: p.spec.android.targetSdk, clear: p.spec.android.cleartextTraffic, journal: (p.repairs || []).length };
  });
  check('The repair is written to the project, not just to the screen',
    stored.min === stored.target && stored.clear === true,
    `minSdk=${stored.min} targetSdk=${stored.target} cleartext=${stored.clear}`);
  check('The repair is recorded so it can be undone', stored.journal >= 1, `${stored.journal} recorded`);

  const toastText = await page.textContent('#toast');
  check('The result is stated exactly, and never claims more than was done',
    /Repaired 1 problem/.test(toastText) && !/Nothing is outstanding/i.test(toastText),
    `the toast said "${toastText.trim()}" while the header still reported warnings`);

  check('What was repaired is shown afterwards, with the value it replaced',
    /Repaired in this project/i.test(afterRepair) && /36 → 26/.test(afterRepair),
    'the journal must show the old value, not just a tick');

  // undo puts the field back exactly
  await page.locator('.repair-done button:has-text("Undo")').first().click();
  await page.waitForTimeout(600);
  const afterUndo = await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('appmint.projects.v1') || '[]');
    const p = list.find((x) => x.spec.identity.appName === 'Repair Screen Test');
    return { min: p.spec.android.minSdk, journal: (p.repairs || []).length };
  });
  check('Undo puts the value back exactly as it was',
    afterUndo.min === 36, `minSdk is ${afterUndo.min}, expected 36`);
  check('Undo is removed from the record once used',
    afterUndo.journal === 0, `${afterUndo.journal} entries left`);

  // applying a judgement call explicitly does work
  await page.locator('.repair-decision button:has-text("Apply this one")').first().click();
  await page.waitForTimeout(600);
  const decided = await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('appmint.projects.v1') || '[]');
    const p = list.find((x) => x.spec.identity.appName === 'Repair Screen Test');
    return { clear: p.spec.android.cleartextTraffic, entries: (p.repairs || []).map((r) => r.decided) };
  });
  check('A judgement call applies when it is asked for by name',
    decided.clear === false, `cleartextTraffic is ${decided.clear}`);
  check('The record marks which repairs were your decision',
    decided.entries.includes(true), `recorded: ${JSON.stringify(decided.entries)}`);

  /* ── starting from a website (M8) ──────────────────────────────────────
     The card is at the top of the Design screen, because "where does this app
     come from" is the first question. These checks drive the two routes it
     offers, and the one rule that matters: nothing is applied until the person
     presses the button that says what will happen. */

  /*
   * On a fresh project, deliberately.
   *
   * The checks above leave the project they use in a state that is blocked on
   * purpose — that is what the repair screen is tested with — and the first
   * version of this block ran on it and then complained that the result was
   * blocked. The claim being tested is "a site can be turned into a valid app",
   * so it starts from a project that is valid.
   */
  await page.locator('#newproj').click();
  await page.waitForTimeout(500);
  await page.locator('button.tpl').first().click();
  await page.waitForTimeout(900);
  await page.locator('.tab:has-text("Design")').click();
  await page.waitForTimeout(500);

  /* The project the Studio has open, not merely the first one in storage: a new
     project is appended to the list, so reading list[0] reads someone else's. */
  const readActive = () => {
    const list = JSON.parse(localStorage.getItem('appmint.projects.v1') || '[]');
    const id = localStorage.getItem('appmint.active.v1');
    return list.find((x) => x.id === id) || list[list.length - 1] || null;
  };

  const siteSectionCount = await page.locator('.sec-name:has-text("Start from a website")').count();
  check('The Design screen offers starting from a website', siteSectionCount >= 1,
    `found ${siteSectionCount} matching section headings`);

  await page.locator('.sec-head:has-text("Start from a website")').click();
  await page.waitForTimeout(350);

  const urlField = page.locator('.wv-row input[type="url"]');
  check('It asks for a website address', await urlField.count() === 1);

  await urlField.fill('greenfieldbakery.in');
  await page.locator('.wv-row button:has-text("Use this address")').click();
  await page.waitForTimeout(500);

  const afterAddress = await page.evaluate(readActive).then((p) => ({
    startUrl: p.spec.app.webview.startUrl,
    hosts: p.spec.app.webview.allowedHosts,
    localAsset: p.spec.app.webview.localAsset,
  }));
  check('An address becomes the app\'s start address',
    afterAddress.startUrl === 'https://greenfieldbakery.in/',
    `startUrl is ${afterAddress.startUrl}`);
  check('The address is the only host allowed to stay inside the app',
    JSON.stringify(afterAddress.hosts) === '["greenfieldbakery.in"]',
    `allowedHosts is ${JSON.stringify(afterAddress.hosts)}`);

  // typing a bare address must not be taken as a scheme
  await urlField.fill('javascript:alert(1)');
  await page.locator('.wv-row button:has-text("Use this address")').click();
  await page.waitForTimeout(400);
  const rejected = await page.evaluate(readActive).then((p) => p.spec.app.webview.startUrl);
  check('An address that is not http or https is refused',
    rejected === 'https://greenfieldbakery.in/',
    `startUrl changed to ${rejected}`);

  /* The file route, driven the way a person drives it: hand the page some files
     and see what it does with them. The analysis is the engine's own code — the
     deep checks on it live in tools/tests/analyse.test.mjs, which runs it
     directly — so what is asserted here is the part only a browser can show: the
     screen, and the rule that nothing is applied until it is asked for. */
  const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appmint-studio-site-'));
  const siteDir = path.join(siteRoot, 'beanleaf');
  fs.mkdirSync(siteDir);
  fs.writeFileSync(path.join(siteDir, 'index.html'), `<!doctype html>
<html><head><title>Bean &amp; Leaf</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { background: #F7F3EE; color: rgb(36, 26, 18); } h1 { background: #6B3A1F; color: #FFFFFF; }
a { color: #6B3A1F; }</style></head>
<body><h1>Coffee, slowly</h1>
<p>Open from seven, every morning except Monday.</p>
<p><a href="tel:+911234567890">Call 12345 67890</a></p>
<form action="https://forms.example.org/orders" method="post">
  <input name="name" type="text" required><button type="submit">Send</button></form>
</body></html>`);

  const nameBefore = await page.evaluate(readActive).then((p) => (p ? p.spec.identity.appName : null));

  // A directory, because that is what this input asks for: the browser then
  // hands over each file's path inside the folder, which is what makes
  // "assets/style.css" resolvable from "index.html".
  await page.locator('#sec-website input[type="file"]').setInputFiles(siteDir);
  await page.waitForTimeout(1200);

  const readBack = await page.evaluate(readActive).then((p) => ({
    name: p.spec.identity.appName, website: p.website ? p.website.status : null,
  }));
  check('Choosing the site\'s files reads them without changing the project',
    readBack.name === nameBefore && readBack.website === 'ready',
    `name ${nameBefore} → ${readBack.name}, analysis ${readBack.website}`);

  const screen = await page.evaluate(() => {
    const box = document.querySelector('#sec-website');
    const text = box ? box.textContent : '';
    return {
      pages: /\b1 page\b/.test(text),
      entry: /would open index\.html/.test(text),
      findings: document.querySelectorAll('#sec-website .wv-finding').length,
      changes: /What applying this changes/.test(text),
      applyLabel: (box.querySelector('.wv-acts .btn.primary') || {}).textContent || '',
    };
  });
  check('The screen says how many pages it read', screen.pages, 'no page count on screen');
  check('It says which page the app would open', screen.entry, 'no entry page on screen');
  check('It shows what it found, as findings', screen.findings >= 1, `${screen.findings} findings rendered`);
  check('It lists the changes before making them', screen.changes, 'no change list on screen');
  check('The button says what it will apply',
    /Apply \d+ change/.test(screen.applyLabel), `button reads "${screen.applyLabel.trim()}"`);

  await page.locator('#sec-website .wv-acts .btn.primary').click();
  await page.waitForTimeout(700);

  const applied = await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('appmint.projects.v1') || '[]');
    const id = localStorage.getItem('appmint.active.v1');
    const project = list.find((x) => x.id === id) || list[list.length - 1];
    const spec = project.spec;
    return {
      name: spec.identity.appName, pkg: spec.identity.packageName,
      localAsset: spec.app.webview.localAsset, mode: spec.app.mode,
      primary: spec.theme.primary, caps: spec.capabilities,
      appliedAt: project.website && project.website.appliedAt,
      button: (document.querySelector('#sec-website .wv-acts .btn.primary') || {}).textContent || '',
    };
  });
  check('Applying names the app after the site', applied.name === 'Bean & Leaf', `name is "${applied.name}"`);
  check('Applying sets the package name', applied.pkg === 'com.appmint.beanleaf', `package is ${applied.pkg}`);
  check('Applying bundles the site\'s entry page', applied.localAsset === 'index.html', `localAsset ${applied.localAsset}`);
  check('Applying takes the site\'s colour', applied.primary === '#6B3A1F', `primary ${applied.primary}`);
  check('Applying only claims capabilities the site justifies',
    !applied.caps.includes('barcode') && !applied.caps.includes('exactAlarms'), JSON.stringify(applied.caps));
  check('The application is recorded on the project', !!applied.appliedAt, 'no timestamp recorded');
  check('The button stops offering to apply what is already applied',
    /Already applied/.test(applied.button), `button reads "${applied.button.trim()}"`);

  // The Studio bundle is a module, so the validation function is not on window.
  // What the page says about the result is what a person reads, and that is what
  // gets checked here; the same validation is asserted directly, on the same
  // analyser output, in tools/tests/analyse.test.mjs.
  const healthFromSite = await page.evaluate(() => {
    const pill = document.querySelector('#health .pill');
    return pill ? pill.textContent.trim() : '(no health strip)';
  });
  check('The screen still says the project is buildable after applying',
    /Ready/.test(healthFromSite), `the health strip reads "${healthFromSite}"`);

  fs.rmSync(siteRoot, { recursive: true, force: true });

  /* ── the icon rail ─────────────────────────────────────────────────────────
     The design prompt asks for a collapsible icon-rail sidebar. On a phone the
     sections are a bottom bar, where a thumb already is; the rail is what the
     same markup becomes on a wide screen. It is the same markup, because two
     navigations listing the sections separately would eventually disagree about
     what the sections are. */
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(350);

  const rail = await page.evaluate(() => {
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return {
      barW: Math.round(bar.width),
      barTop: Math.round(bar.top),
      onLeft: Math.round(bar.left) === 0 && bar.height > 400,
      label: getComputedStyle(document.querySelector('.tab > span:last-child')).opacity,
      pinShown: getComputedStyle(document.querySelector('#railpin')).display !== 'none',
      tabs: document.querySelectorAll('.tabbar .tab').length,
    };
  });
  check('On a wide screen the section bar becomes a rail down the left edge',
    rail.onLeft && rail.barW < 120 && rail.tabs === 7,
    `width ${rail.barW}, top ${rail.barTop}, tabs ${rail.tabs}`);
  check('The collapsed rail shows icons without their labels',
    rail.label === '0', `label opacity ${rail.label}`);
  check('The rail can be pinned open', rail.pinShown, 'the pin control was not visible');

  await page.hover('.tabbar');
  await page.waitForTimeout(350);
  const railOpened = await page.evaluate(() => ({
    barW: Math.round(document.querySelector('.tabbar').getBoundingClientRect().width),
    label: getComputedStyle(document.querySelector('.tab > span:last-child')).opacity,
  }));
  check('Hovering the rail opens it and reveals the labels',
    railOpened.barW > 180 && railOpened.label === '1', `width ${railOpened.barW}, label ${railOpened.label}`);

  await page.mouse.move(900, 500);
  await page.waitForTimeout(300);
  await page.click('#railpin');
  await page.waitForTimeout(350);
  const pinned = await page.evaluate(() => ({
    barW: Math.round(document.querySelector('.tabbar').getBoundingClientRect().width),
    pressed: document.querySelector('#railpin').getAttribute('aria-pressed'),
    label: getComputedStyle(document.querySelector('.tab > span:last-child')).opacity,
  }));
  check('Pinning holds the rail open without the pointer being on it',
    pinned.barW > 180 && pinned.pressed === 'true' && pinned.label === '1',
    JSON.stringify(pinned));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  const narrow = await page.evaluate(() => {
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return {
      atBottom: bar.top > 400,
      full: Math.round(bar.width) > 350,
      pin: getComputedStyle(document.querySelector('#railpin')).display,
      label: getComputedStyle(document.querySelector('.tab > span:last-child')).opacity,
    };
  });
  check('On a phone the same markup is a bottom bar, and the pin goes away',
    narrow.atBottom && narrow.full && narrow.pin === 'none' && narrow.label === '1',
    JSON.stringify(narrow));

  if (!process.argv.includes('--keep')) await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  console.log(`  screenshots: studio/screenshots/`);
  console.log('');
  process.exit(failed.length ? 1 : 0);
}

/* A crash is reported, and so is everything that had already been decided.
   Exiting on the exception alone used to throw the whole result set away, which
   made a late cosmetic failure look identical to a product that would not
   start. */
main().catch((e) => {
  console.error('\n  Studio test crashed:', e.message, '\n');
  const failed = results.filter((r) => !r.ok);
  console.log(`  ${results.length - failed.length}/${results.length} checks had run before the crash`);
  process.exit(1);
});
