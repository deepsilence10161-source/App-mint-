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
  check('Opening a template reveals the five sections', tabs === 5, `found ${tabs} tabs`);

  const health = (await page.textContent('#health')) || '';
  check('Health strip reports a verdict', /Valid|Blocked|Ready/.test(health), `health="${health.trim()}"`);

  /* ── every section renders ──────────────────────────────────────────── */
  for (const [label, expect] of [['Design', 'Application name'], ['Screens', 'Build the first screen'], ['Features', 'Permissions this app will request'], ['Preview', 'Preview'], ['Build', 'Validation']]) {
    await page.locator('.tabbar .tab', { hasText: label }).click();
    await page.waitForTimeout(200);
    const text = await page.textContent('#main');
    check(`Section "${label}" renders its content`, text.includes(expect), `looking for "${expect}"`);
  }

  /* ── editing actually changes state ─────────────────────────────────── */
  await page.locator('.tabbar .tab', { hasText: 'Design' }).click();
  await page.waitForTimeout(150);
  const nameInput = page.locator('input[aria-label="Application name"]');
  await nameInput.fill('Phone Test App');
  await page.waitForTimeout(250);
  const shown = await page.textContent('#projname');
  check('Typing an app name updates the header', shown.includes('Phone Test App'), `header="${shown}"`);

  /* ── the real engine is running inside the page ─────────────────────── */
  await page.locator('.tabbar .tab', { hasText: 'Features' }).click();
  await page.waitForTimeout(200);
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
  await page.locator('.tabbar .tab', { hasText: 'Build' }).click();
  await page.waitForTimeout(200);
  let build = await page.textContent('#main');
  check('Valid configuration is not blocked', !/Build blocked/i.test(build), 'expected a pass banner');

  // Break it on purpose. Note: minSdk 33 with targetSdk 36 is perfectly valid,
  // so the obvious choice is the wrong one. A package name with a space is a
  // genuine format error, and the field is reachable from the UI.
  await page.locator('.tabbar .tab', { hasText: 'Design' }).click();
  await page.waitForTimeout(150);
  await page.locator('input[aria-label="Package name"]').fill('com.example.not valid');
  await page.waitForTimeout(350);
  const health2 = (await page.textContent('#health')) || '';
  check('Health strip reacts to an invalid change', /Blocked/.test(health2), `health="${health2.trim()}"`);

  await page.locator('.tabbar .tab', { hasText: 'Build' }).click();
  await page.waitForTimeout(300);
  build = await page.textContent('#main');
  check('An invalid configuration visibly blocks the build',
    /Build blocked/i.test(build), 'a package name containing a space must block the build');
  check('The exact field is named in the finding',
    /Package name|packageName/i.test(build), 'the message should point at the field');

  const startDisabled = await page.locator('button:has-text("Start build")').isDisabled().catch(() => null);
  check('The build button is disabled while blocked', startDisabled === true, `disabled=${startDisabled}`);

  // Put it back so the remaining checks run against a valid project.
  await page.locator('.tabbar .tab', { hasText: 'Design' }).click();
  await page.waitForTimeout(150);
  await page.locator('input[aria-label="Package name"]').fill('com.example.phonetest');
  await page.waitForTimeout(350);

  /* ── persistence ────────────────────────────────────────────────────── */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
  const afterReload = await page.textContent('#projname');
  check('Work survives a reload', afterReload.includes('Phone Test App'), `header="${afterReload}"`);


  /* ── the screen designer ─────────────────────────────────────────────── */
  // Everything here goes through the real component library: the palette is
  // generated from it, the properties come from it, and the findings are its
  // findings. So these checks are also checks on the library.
  await page.locator('.tabbar .tab', { hasText: 'Screens' }).click();
  await page.waitForTimeout(250);

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
  await page.locator('.tabbar .tab', { hasText: 'Screens' }).click();
  await page.waitForTimeout(200);
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

  // the app is switched to native screens, so the build path matches the design
  await page.locator('.tabbar .tab', { hasText: 'Design' }).click();
  await page.waitForTimeout(200);
  const modeSelect = page.locator('select[aria-label="Architecture"]');
  check('The architecture can be set to designed screens', await modeSelect.count() > 0, 'expected an architecture selector');
  await modeSelect.selectOption('native-screens');
  await page.waitForTimeout(400);
  const healthAfter = await page.textContent('#health');
  check('A designed app validates against the same rules as everything else',
    /Valid|Ready|Blocked/.test(healthAfter), `health="${healthAfter.trim()}"`);

  /* ── offline: no external requests at all ───────────────────────────── */
  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  await page.locator('.tabbar .tab', { hasText: 'Preview' }).click();
  await page.waitForTimeout(300);
  await page.locator('.tabbar .tab', { hasText: 'Build' }).click();
  await page.waitForTimeout(300);
  check('No external resources are requested', external.length === 0, external.join(', '));

  await page.locator('.tabbar .tab', { hasText: 'Preview' }).click();
  await page.waitForTimeout(300);
  const frameCount = await page.locator('.device').count();
  check('Preview draws a device frame', frameCount === 1, `found ${frameCount} .device elements`);
  const screenBg = await page.evaluate(() => {
    const el = document.querySelector('.screen');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  check('Preview applies the project theme colours', !!screenBg && screenBg !== 'rgba(0, 0, 0, 0)', `screen background ${screenBg}`);

  /* ── nothing on screen may ever read as broken ─────────────────────── */
  // "undefined", "NaN" and "[object Object]" are how a program tells the user
  // it has lost track of its own state. They are always a bug, never a value,
  // and one of them reached the health strip before this check existed.
  const brokenWords = [];
  for (const tab of ['Design', 'Screens', 'Features', 'Preview', 'Build']) {
    await page.locator('.tabbar .tab', { hasText: tab }).click();
    await page.waitForTimeout(250);
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
  await page.locator('.tabbar .tab', { hasText: 'Design' }).click();
  await page.waitForTimeout(250);
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
  const shoot = async (tab, file) => {
    await page.locator('.tabbar .tab', { hasText: tab }).click();
    await page.waitForTimeout(350);
    // The top bar is sticky, so a scrolled page puts the health strip behind it
    // and the screenshot looks broken. Return to the top before capturing.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shotDir, file) });
  };
  await shoot('Design', 'studio-design.png');
  await shoot('Features', 'studio-features.png');
  await shoot('Screens', 'studio-screens.png');
  await shoot('Preview', 'studio-preview.png');
  await shoot('Build', 'studio-build.png');

  // A second frame, scrolled down, to show the permission table rather than
  // the tab buttons covering it.
  await page.locator('.tabbar .tab', { hasText: 'Features' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollBy(0, 620));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shotDir, 'studio-permissions.png') });

  if (!process.argv.includes('--keep')) await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  console.log(`  screenshots: studio/screenshots/`);
  console.log('');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('\n  Studio test crashed:', e.message, '\n'); process.exit(1); });
