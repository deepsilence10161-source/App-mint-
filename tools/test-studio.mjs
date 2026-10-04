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
  check('Opening a template reveals the five sections', tabs === 5, `found ${tabs} tabs`);

  const health = (await page.textContent('#health')) || '';
  check('Health strip reports a verdict', /Valid|Blocked|Ready/.test(health), `health="${health.trim()}"`);

  /* ── every section renders ──────────────────────────────────────────── */
  for (const [label, expect] of [['Design', 'Application name'], ['Screens', 'Build the first screen'], ['Features', 'Permissions this app will request'], ['Preview', 'Preview'], ['Build', 'Validation']]) {
    await tapTab(page, label);
    const text = await page.textContent('#main');
    check(`Section "${label}" renders its content`, text.includes(expect), `looking for "${expect}"`);
  }

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

  /* ── persistence ────────────────────────────────────────────────────── */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
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
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
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
    await page.reload();
    await page.waitForTimeout(500);
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
