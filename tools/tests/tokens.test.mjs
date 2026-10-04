/**
 * THE DESIGN TOKEN GATE
 * =====================
 *
 * The Studio's entire visual identity is a set of CSS custom properties. These
 * checks exist because two of them were already broken and nothing noticed:
 *
 *   · `color: var(--fg-1)` — there was no `--fg-1`, so the declaration was
 *     invalid at computed-value time and the text silently inherited its
 *     parent's colour. No error, no warning, just a wrong colour.
 *   · `border-radius: var(--r2)` in two rules — there was no `--r2`, so those
 *     elements had no rounded corners at all while every neighbour did.
 *
 * A third fault was caught while writing the token system rather than after: a
 * motion duration declared as `--t-base` after the type scale's `--t-base`
 * (body text). The later declaration wins, so body text would have become the
 * string "180ms" and every rule using it would have fallen back to the
 * inherited font. That is the reason duplicate declarations inside one block are
 * an error here and not a style choice.
 *
 * Like the other suites, every rule has a test that makes it fire and a test
 * that shows it staying quiet on the near-miss. A token gate that flags a
 * stylesheet that is fine teaches people to ignore it, and then it is not
 * guarding anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseBlocks, declarationsOf, referencesOf, auditTokens, hardcodedColors,
  resolveColor, runtimeDeclarationsOf,
} from '../../engine/style/tokens.mjs';
import { contrastRatio, parseColor, over, meetsAA } from '../../engine/style/color.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS_PATH = path.join(ROOT, 'studio/src/studio.css');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');
const STUDIO_JS = path.join(ROOT, 'studio/src/studio.js');
const DESIGNER_JS = path.join(ROOT, 'studio/src/designer.js');

/**
 * The device preview is drawn in the colours of the app being designed, not in
 * the Studio's palette, so its white-alpha overlays are intentional: they have
 * to read on an arbitrary theme colour that the tool cannot know in advance.
 * Everything else is the tool's own chrome and must be tokenised.
 */
const isPreviewRegion = (selector) => /\.pv-|\.sbar|\.device-screen|\.skel/.test(selector);

/* ────────────────────────────────────────────────────────────────────────── */

test('the token map is complete: nothing is read that was never declared', () => {
  /* A token counts as declared if the stylesheet declares it or a script sets it
     with style.setProperty — the preview frame is dressed from the project's
     theme that way, so those names are real even though studio.css never
     mentions them. Both sources are gathered first, because a completeness
     check that lists legitimate runtime tokens as missing gets ignored, and
     then it is not guarding anything. */
  const jsSources = [STUDIO_JS, DESIGNER_JS].map((f) => fs.readFileSync(f, 'utf8'));
  const runtimeDeclared = new Set(jsSources.flatMap((src) => [...runtimeDeclarationsOf(src)]));

  const { undeclared } = auditTokens(CSS, [...runtimeDeclared]);
  assert.deepEqual(undeclared, [],
    `studio.css reads tokens that nothing declares: ${undeclared.join(', ')}`);

  for (const [file, src] of [[STUDIO_JS, jsSources[0]], [DESIGNER_JS, jsSources[1]]]) {
    const { undeclared: jsUndeclared } = auditTokens(src);
    const declared = auditTokens(CSS).declared;
    const missing = jsUndeclared.filter((n) => !declared.has(n) && !runtimeDeclared.has(n));
    assert.deepEqual(missing, [],
      `${path.basename(file)} reads tokens that nothing declares: ${missing.join(', ')}`);
  }
});

test('no token is declared twice inside the same block', () => {
  const { duplicates } = auditTokens(CSS);
  assert.deepEqual(duplicates, [],
    'a repeated declaration silently replaces the first: '
    + duplicates.map((d) => `${d.name} in "${d.selector}"`).join('; '));
});

test('the tool chrome does not name a colour directly', () => {
  const found = hardcodedColors(CSS, isPreviewRegion);
  assert.deepEqual(found.map((f) => `${f.selector} → ${f.value}`), [],
    'these rules hardcode a colour instead of using a token:\n  '
    + found.map((f) => `${f.selector} → ${f.value}  (${f.line})`).join('\n  '));
});

/* ── and the gate actually fires ──────────────────────────────────────────── */

test('an undeclared token is caught, and a declared one is not', () => {
  const broken = ':root { --fg: #10121A; }\n.a { color: var(--fg); }\n.b { color: var(--nope); }';
  assert.deepEqual(auditTokens(broken).undeclared, ['--nope']);

  const fine = ':root { --fg: #10121A; }\n.a { color: var(--fg); }';
  assert.deepEqual(auditTokens(fine).undeclared, []);
});

test('a colliding declaration is caught, and a re-declaration in another block is not', () => {
  // Same block, same name: the second silently wins. This is the fault that
  // would have turned body text into "180ms".
  const collide = ':root { --t-base: 600 22px/1.28 system-ui; --t-base: 180ms; }';
  assert.equal(auditTokens(collide).duplicates.length, 1);
  assert.equal(auditTokens(collide).duplicates[0].name, '--t-base');

  // Two blocks each declaring the same name is the whole point of a theme
  // override, and must not be reported.
  const themed = ':root { --bg: #0B0D12; }\n:root[data-theme="light"] { --bg: #FFFFFF; }';
  assert.deepEqual(auditTokens(themed).duplicates, []);
});

test('a hardcoded colour is caught outside the preview, and allowed inside it', () => {
  const dirty = '.btn { background: #6C5CE7; }';
  assert.equal(hardcodedColors(dirty, isPreviewRegion).length, 1);

  const clean = '.btn { background: var(--brand); }';
  assert.equal(hardcodedColors(clean, isPreviewRegion).length, 0);

  // The device preview is the documented exception.
  const preview = '.pv-btn.ghost { border-color: rgba(255, 255, 255, 0.35); }';
  assert.equal(hardcodedColors(preview, isPreviewRegion).length, 0);

  // A colour inside a token definition is where colours are supposed to live.
  const token = ':root { --brand: #6C5CE7; }';
  assert.equal(hardcodedColors(token, isPreviewRegion).length, 0);
});

/* ── the palette is readable ──────────────────────────────────────────────── */

function resolveBlocks(list, selectorForTheme) {
  const map = new Map();
  for (const b of list) {
    if (!selectorForTheme(b.selector)) continue;
    for (const line of b.body.split('\n')) {
      for (const part of line.split(';')) {
        const m = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*([^]*)$/.exec(part);
        if (m) map.set(m[1], m[2].trim());
      }
    }
  }
  return map;
}

const blocks = parseBlocks(CSS);
const darkTokens = resolveBlocks(blocks, (s) => s === ':root');
const lightTokens = resolveBlocks(
  blocks,
  (s) => s === ':root' || s === ':root[data-theme="light"]',
);


/**
 * Text colours against every surface they can land on. `*-ink` tokens are the
 * variants made for reading on a surface, which is why they are checked and the
 * saturated fills are not: a solid violet button carries white text, and that
 * pair is checked separately below.
 */
const READABLE_PAIRS = [
  ['--fg', '--bg'], ['--fg', '--surface'], ['--fg', '--surface-2'],
  ['--fg-2', '--bg'], ['--fg-2', '--surface'], ['--fg-2', '--surface-2'],
  ['--fg-3', '--surface'], ['--fg-3', '--surface-2'],
  ['--accent-ink', '--bg'], ['--accent-ink', '--surface'], ['--accent-ink', '--surface-2'],
  ['--ok-ink', '--bg'], ['--ok-ink', '--surface'],
  ['--warn-ink', '--bg'], ['--warn-ink', '--surface'],
  ['--bad-ink', '--bg'], ['--bad-ink', '--surface'],
  ['--info-ink', '--bg'], ['--info-ink', '--surface'],
];

for (const [themeName, tokens] of [['dark', darkTokens], ['light', lightTokens]]) {
  test(`${themeName} mode: every text token clears 4.5:1 on its surfaces`, () => {
    const failures = [];
    for (const [fgName, bgName] of READABLE_PAIRS) {
      const bg = resolveColor(tokens.get(bgName), tokens);
      const fg = resolveColor(tokens.get(fgName), tokens);
      if (!bg || !fg) {
        failures.push(`${fgName} on ${bgName}: could not resolve a colour`);
        continue;
      }
      const painted = fg.a < 1 ? over(fg, bg) : fg;
      const ratio = contrastRatio(painted, bg);
      if (ratio === null || ratio < 4.5) {
        failures.push(`${fgName} on ${bgName}: ${(ratio ?? 0).toFixed(2)}:1 (needs 4.5:1)`);
      }
    }
    assert.deepEqual(failures, [], `${themeName} theme fails WCAG AA:\n  ${failures.join('\n  ')}`);
  });

  test(`${themeName} mode: the primary button's text clears 4.5:1 on the brand fill`, () => {
    const brand = resolveColor(tokens.get('--brand'), tokens);
    const onBrand = resolveColor(tokens.get('--on-brand'), tokens);
    assert.ok(brand && onBrand, 'the brand fill and its text colour must both resolve');
    const ratio = contrastRatio(onBrand, brand);
    assert.ok(ratio >= 4.5,
      `white on the brand fill is ${(ratio ?? 0).toFixed(2)}:1 in ${themeName} mode (needs 4.5:1)`);
  });
}

test('a failing contrast pair is reported, and a passing one is not', () => {
  // The exact failure mode that matters: a mid-grey label on a mid-grey surface
  // looks fine on a calibrated monitor and is unreadable in daylight.
  assert.ok(contrastRatio('#8D97AC', '#15171F') >= 4.5, 'the shipped --fg-3 must pass');
  // A pair far below the threshold, so this assertion is not itself a claim
  // about a borderline number that could quietly stop being true.
  assert.ok(contrastRatio('#3A3A3A', '#404040') < 1.5,
    'a near-invisible pair must be reported as failing');
  assert.ok(contrastRatio('#777777', '#888888') < 4.5, 'a near-match pair must fail');
  assert.equal(contrastRatio('#000000', '#FFFFFF').toFixed(0), '21');
  assert.equal(contrastRatio('#123456', '#123456'), 1);
  // An unparseable value must return null rather than a reassuring number.
  assert.equal(contrastRatio('not-a-colour', '#000000'), null);
});

/* ── the colour parser is right at the edges that matter ─────────────────── */

test('colour parsing handles the notations the tokens actually use', () => {
  assert.deepEqual(parseColor('#6C5CE7'), { r: 108, g: 92, b: 231, a: 1 });
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('rgba(108, 92, 231, 0.5)'), { r: 108, g: 92, b: 231, a: 0.5 });
  assert.deepEqual(parseColor('rgb(108 92 231 / 0.5)'), { r: 108, g: 92, b: 231, a: 0.5 });
  assert.equal(parseColor('var(--brand)'), null);
  assert.equal(parseColor(''), null);
});

test('a translucent token is composited before it is judged', () => {
  // 50% white over the dark base is a mid-grey, and grading the un-composited
  // white against the base would have called it 21:1.
  const base = parseColor('#0B0D12');
  const tint = parseColor('rgba(255, 255, 255, 0.5)');
  const painted = over(tint, base);
  assert.ok(contrastRatio(painted, base) < 12, 'the composite must be far below white-on-base');
  assert.ok(contrastRatio(parseColor('#FFFFFF'), base) > 18, 'while plain white is near 21:1');
  assert.ok(meetsAA(painted, base), 'and it still clears AA for body text');
});

test('token resolution follows var() chains and refuses to guess', () => {
  const tokens = new Map([
    ['--brand', '#6C5CE7'],
    ['--brand-rgb', '108 92 231'],
    ['--accent', 'var(--brand)'],
    ['--accent-soft', 'rgb(var(--brand-rgb) / 0.16)'],
  ]);
  assert.deepEqual(resolveColor(tokens.get('--accent'), tokens), { r: 108, g: 92, b: 231, a: 1 });
  const soft = resolveColor(tokens.get('--accent-soft'), tokens);
  assert.equal(soft.a, 0.16, 'the alpha survives the space-separated rgb() form');

  // A chain that does not resolve must say so rather than invent a colour.
  assert.equal(resolveColor('var(--missing)', new Map()), null);
  // A self-referential token must terminate instead of hanging the suite.
  const loop = new Map([['--a', 'var(--a)']]);
  assert.equal(resolveColor(loop.get('--a'), loop), null);
});

test('a token set at runtime counts as declared', () => {
  const declared = runtimeDeclarationsOf("n.style.setProperty('--pv-bg', bg);");
  assert.ok(declared.has('--pv-bg'));
  assert.deepEqual(auditTokens('.a { background: var(--pv-bg); }', ['--pv-bg']).undeclared, []);
  // and one that is neither in the sheet nor set at runtime is still a fault
  assert.deepEqual(auditTokens('.a { background: var(--pv-bg); }').undeclared, ['--pv-bg']);
});

test('a tokenised rgb() is not reported as a hardcoded colour', () => {
  assert.equal(hardcodedColors('.topbar { background: rgb(var(--bg-rgb) / 0.94); }').length, 0);
  assert.equal(hardcodedColors('.topbar { background: rgb(11 13 18 / 0.94); }').length, 1);
});
