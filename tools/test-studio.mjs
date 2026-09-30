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
  const base = path.join(process.env.HOME || '/root', '.cache/ms-playwright');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const p = path.join(base, d, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
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
  check('Opening a template reveals the four sections', tabs === 4, `found ${tabs} tabs`);

  const health = (await page.textContent('#health')) || '';
  check('Health strip reports a verdict', /Valid|Blocked|Ready/.test(health), `health="${health.trim()}"`);

  /* ── every section renders ──────────────────────────────────────────── */
  for (const [label, expect] of [['Design', 'Application name'], ['Features', 'Permissions this app will request'], ['Preview', 'Preview'], ['Build', 'Validation']]) {
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
