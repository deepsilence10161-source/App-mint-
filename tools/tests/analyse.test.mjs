/**
 * THE WEBSITE ANALYSER
 * ====================
 *
 * Two kinds of test here, and they exist for different reasons.
 *
 * The first is ordinary: does the reader understand HTML and CSS correctly, and
 * does the proposal follow the rules it claims to follow.
 *
 * The second is the one that matters more. An analyser's output is a
 * specification, and a specification is acted on — so the tests that really
 * count are the ones that feed the analyser's own output to the validator and to
 * the generator and require both to accept it. An analyser that quietly produces
 * specifications which fail to build would be discovered at the worst possible
 * moment, by the person who trusted it.
 *
 * The fixture site is a real one: four pages, an external stylesheet, a form, a
 * telephone link and two third-party links.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { scanHtml, parsePage, parseCss, visibleText, classifyUrl, decodeEntities,
  normaliseColour, contrast, readableOn, ensureContrast, shade } from '../../engine/analyse/html.mjs';
import { readLocalSite, describeSite, findingsFor, proposeApp, packageFor, playSafeName,
  themeFor, planRewrites, analyse, humanBytes } from '../../engine/analyse/website.mjs';
import { validateSpec } from '../../engine/spec/spec.mjs';
import { generateAndroidProject } from '../../engine/gen/android.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'apps', 'site-demo', 'site');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appmint-analyse-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/* ── reading HTML ─────────────────────────────────────────────────────────── */

test('the reader finds what a page says, and ignores what it does not', () => {
  const html = `<!doctype html>
<!-- a comment with <a href="not-a-link">markup</a> inside it -->
<html lang="en">
<head>
  <title>Bean &amp; Leaf — coffee</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Coffee, slowly.">
  <link rel="stylesheet" href="/css/main.css">
</head>
<body>
  <h1>Hello</h1>
  <p>Text before an <a href="about.html">internal link</a>.</p>
  <img src="/img/bean.png" alt="A bean">
  <script>if (1 < 2) { document.write("<p>not real markup</p>"); }</script>
  <style>a > b { color: #abc; }</style>
</body></html>`;
  const page = parsePage(html);

  assert.equal(page.lang, 'en', 'lang survives');
  // The comment contained a link; it must not be counted, or the analyser
  // reports links the browser never sees.
  assert.deepEqual(page.links.map((l) => l.href), ['about.html']);
  assert.deepEqual(page.images.map((i) => i.src), ['/img/bean.png']);
  assert.equal(page.images[0].alt, 'A bean');
  assert.deepEqual(page.headings.map((h) => h.level), [1]);
  assert.equal(page.meta.viewport.includes('device-width'), true);
  assert.equal(page.meta.description, 'Coffee, slowly.');
  assert.deepEqual(page.stylesheets, ['/css/main.css']);
  // A `<` inside a script is not a tag: the script is raw text.
  assert.equal(page.bodyText.includes('not real markup'), false, 'script bodies are not page text');
  assert.equal(page.inlineScripts, 1);
  assert.equal(page.styleText.includes('#abc'), true, 'inline style is available to read for colours');
});

test('titles are decoded the way a person reads them', () => {
  const html = '<title>Fish &amp; Chips &#8212; the best in town</title>';
  assert.equal(visibleText(html), 'Fish & Chips — the best in town');
  assert.equal(decodeEntities('&amp;&lt;&#65;&#x42;'), '&<AB');
  // A malformed code point must not throw and must not take the page down.
  assert.equal(decodeEntities('&#99999999999;ok'), 'ok');
});

test('a quoted angle bracket does not end a tag early', () => {
  const page = parsePage('<a href="a.html" title="1 > 0">link</a><p>after</p>');
  assert.deepEqual(page.links.map((l) => l.href), ['a.html']);
  assert.equal(visibleText('<a href="a.html" title="1 > 0">link</a><p>after</p>'), 'link after');
});

test('URLs are classified by what a WebView has to do with them', () => {
  assert.equal(classifyUrl('https://example.org/x').kind, 'absolute');
  assert.equal(classifyUrl('/assets/x.css').kind, 'root-relative');
  assert.equal(classifyUrl('assets/x.css').kind, 'relative');
  assert.equal(classifyUrl('#top').kind, 'fragment');
  assert.equal(classifyUrl('tel:+911234567890').kind, 'scheme');
  assert.equal(classifyUrl('mailto:a@b.com').scheme, 'mailto');
  assert.equal(classifyUrl('').kind, 'empty');
});

/* ── reading CSS ──────────────────────────────────────────────────────────── */

test('colours are read in every form a stylesheet writes them', () => {
  assert.equal(normaliseColour('#abc'), '#AABBCC');
  assert.equal(normaliseColour('#A1B2C3'), '#A1B2C3');
  assert.equal(normaliseColour('#a1b2c3ff'), '#A1B2C3', 'the alpha channel is dropped, not mangled');
  assert.equal(normaliseColour('rgb(255, 0, 0)'), '#FF0000');
  assert.equal(normaliseColour('rgba(0, 0, 255, 0.5)'), '#0000FF');
  assert.equal(normaliseColour('white'), '#FFFFFF');
  assert.equal(normaliseColour('not-a-colour'), null);
  assert.equal(normaliseColour(''), null);
});

test('the CSS reader takes colours, fonts and layout facts from real CSS', () => {
  const css = `
    /* a comment containing #DEADBF which must not be counted */
    :root { --brand: #7C3F00; }
    body { background: #FFFAF3; color: rgb(36, 26, 18); font-family: Georgia, serif; }
    a { color: #7C3F00; }
    @import url("extra.css");
    .logo { background-image: url(logo.svg); }
    @media (min-width: 900px) { body { padding: 32px; } }
    .grid { display: grid; width: 50vw; }`;
  const out = parseCss(css);
  assert.ok(out.colours.has('#7C3F00'), 'the repeated brand colour is seen');
  assert.equal(out.colours.has('#DEADBF'), false, 'a colour inside a comment is not a colour the page uses');
  assert.deepEqual(out.background, ['#FFFAF3']);
  assert.deepEqual(out.foreground, ['#241A12', '#7C3F00']);
  assert.equal(out.fonts[0], 'Georgia');
  assert.equal(out.imports[0], 'extra.css');
  assert.equal(out.urlRefs.includes('logo.svg'), true);
  assert.equal(out.mediaQueries.length, 1);
  assert.equal(out.hasViewportUnit, true);
  assert.equal(out.hasFlexOrGrid, true);
});

test('contrast is measured, and a colour is nudged until it passes', () => {
  assert.ok(Math.abs(contrast('#000000', '#FFFFFF') - 21) < 0.01, 'black on white is 21:1');
  assert.ok(Math.abs(contrast('#FFFFFF', '#FFFFFF') - 1) < 0.01, 'identical colours are 1:1');
  assert.equal(contrast('nonsense', '#FFFFFF'), null, 'an unreadable colour has no contrast, not a made-up one');
  assert.equal(readableOn('#FFFFFF'), '#000000');
  assert.equal(readableOn('#101010'), '#FFFFFF');

  // A colour that cannot carry white text is darkened until it can, and the
  // change is reported rather than silent.
  const fixed = ensureContrast('#FFFF00', '#FFFFFF');
  assert.equal(fixed.changed, true);
  assert.ok(contrast(fixed.colour, '#FFFFFF') >= 4.5, `${fixed.colour} must carry white text`);
  assert.equal(ensureContrast('#101010', '#FFFFFF').changed, false, 'a colour that already passes is left alone');
  assert.equal(shade('#808080', 100, true), '#000000');
  assert.equal(shade('#808080', 100, false), '#FFFFFF');
});

/* ── reading the fixture site ─────────────────────────────────────────────── */

test('a directory of files is read as a site, in a stable order', () => {
  const site = readLocalSite(FIXTURE);
  assert.equal(site.kind, 'local');
  assert.equal(site.entry, 'index.html');
  assert.deepEqual(site.pages.map((p) => p.rel), ['about.html', 'index.html', 'menu.html', 'order.html']);
  assert.ok(site.assets.some((a) => a.rel === 'assets/style.css'));
  assert.equal(site.assets.some((a) => a.rel === 'assets/site.js'), true);
  // Same bytes, same answer, every time.
  const again = readLocalSite(FIXTURE);
  assert.deepEqual(again.pages.map((p) => p.rel), site.pages.map((p) => p.rel));
});

test('the description is right about the fixture', () => {
  const model = describeSite(readLocalSite(FIXTURE));
  assert.equal(model.title, 'Greenfield Bakery — fresh bread daily');
  assert.equal(model.forms.length, 1, 'one form');
  assert.equal(model.forms[0].method, 'post');
  assert.ok(model.forms[0].inputs.some((i) => i.type === 'tel'), 'the phone field is seen');
  assert.ok(model.links.some((l) => l.kind === 'scheme' && l.scheme === 'tel'), 'the telephone link is seen');
  assert.ok(model.external.some((e) => e.host === 'instagram.com'), 'a third-party link is seen');
  assert.ok(model.css.colours.size > 3, 'the stylesheet colours were read');
  assert.ok(model.css.mediaQueries.length >= 1, 'including the media query');
});

test('the findings tell the truth about the fixture: no false blocking', () => {
  const site = readLocalSite(FIXTURE);
  const model = describeSite(site);
  const findings = findingsFor(site, model);

  assert.deepEqual(findings.filter((f) => f.level === 'blocking'), [],
    'a working four-page site with a title and a viewport must not be called unbuildable');

  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('form-needs-server'), 'the form posting to a server is reported');
  assert.ok(codes.includes('external-assets'), 'the third-party links are reported');
  assert.ok(codes.includes('hand-off-links'), 'the telephone link is reported');
  assert.equal(codes.includes('client-rendered'), false,
    'pages with their text in the HTML must not be called client-rendered');
  assert.equal(codes.includes('no-viewport'), false, 'the fixture declares a viewport');

  for (const f of findings) {
    assert.ok(f.title && f.detail, `${f.code} must say what it is and why`);
    assert.ok(!/\bbut\s+since\b|\s{2,}/.test(f.detail), `malformed message in ${f.code}`);
  }
});

test('a site that cannot work is reported as blocking, not built hopefully', () => {
  const w = scratch();
  try {
    const root = path.join(w.dir, 'site');
    fs.mkdirSync(root, { recursive: true });
    // No <title> anywhere, no viewport, and a cleartext resource.
    fs.writeFileSync(path.join(root, 'index.html'),
      '<html><body><h1>Hi</h1><img src="http://insecure.example.org/logo.png"></body></html>');

    const site = readLocalSite(root);
    const model = describeSite(site);
    const findings = findingsFor(site, model);
    const codes = findings.filter((f) => f.level === 'blocking').map((f) => f.code);
    assert.ok(codes.includes('no-title'), 'a page with no title is blocking');
    assert.ok(codes.includes('mixed-content'), 'http content is blocking, because Android blocks it');
    assert.ok(findings.some((f) => f.code === 'no-viewport' && f.level === 'warning'));
  } finally { w.done(); }
});

test('a page drawn by JavaScript is recognised by what it looks like', () => {
  const w = scratch();
  try {
    const root = path.join(w.dir, 'spa');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><html><head>
      <title>Dashboard</title><meta name="viewport" content="width=device-width">
      <script src="https://cdn.example.org/framework.js"></script></head>
      <body><div id="root"></div></body></html>`);
    const findings = findingsFor(...(() => { const s = readLocalSite(root); return [s, describeSite(s)]; })());
    assert.ok(findings.some((f) => f.code === 'client-rendered' && f.level === 'warning'),
      'an empty mount point with a framework script is the signal');
  } finally { w.done(); }
});

/* ── the proposal ─────────────────────────────────────────────────────────── */

test('an app name fits Google Play without being cut mid-word', () => {
  assert.deepEqual(playSafeName('Greenfield Bakery').name, 'Greenfield Bakery');
  const long = playSafeName('The Extremely Long Name Of A Bakery In Hisar That Sells Bread');
  assert.ok(long.name.length <= 30, `got ${long.name.length} characters`);
  assert.equal(long.truncated, true);
  assert.equal(/\s$/.test(long.name), false, 'no trailing space');
  assert.equal(long.name.includes('  '), false);
  // A marketing title keeps the name, not the tagline.
  assert.equal(playSafeName('Greenfield Bakery — fresh bread daily').name, 'Greenfield Bakery');
});

test('a package name is derived, never invented from nothing', () => {
  assert.equal(packageFor({ provided: 'com.example.mine' }), 'com.example.mine', 'what was asked for is obeyed');
  assert.equal(packageFor({ host: 'bakery.example.org' }), 'org.example.bakery', 'a hostname reads backwards');
  assert.equal(packageFor({ host: 'www.greenfield.in' }), 'in.greenfield', 'www is skipped, and the host reversed is the name');
  assert.equal(packageFor({ hint: '/apps/site-demo/site' }), 'com.appmint.sitedemo', 'the directory names it');
  assert.equal(packageFor({ hint: '/srv/public' }), 'com.appmint.srv', 'a generic directory name is skipped past');
  const derived = packageFor({ hint: '/x/site' });
  assert.match(derived, /^com\.appmint\.[a-z0-9]+$/, 'and it is always a usable package name');
});

test('the palette comes from the site, and never fails its own contrast rules', () => {
  const site = readLocalSite(FIXTURE);
  const model = describeSite(site);
  const { theme, evidence } = themeFor(model);

  assert.equal(theme.primary, '#7C3F00', 'the colour the site repeats is the app colour');
  assert.ok(contrast(theme.primary, theme.onPrimary) >= 4.5, 'text on the app colour is readable');
  assert.ok(contrast(theme.background, theme.onSurface) >= 4.5, 'text on the surface is readable');
  assert.ok(['light', 'dark'].includes(theme.statusBarStyle));
  assert.ok(evidence.coloursSeen.length > 0, 'the evidence says which colours were seen');
});

test('a colour that cannot carry its text is adjusted, and the adjustment is recorded', () => {
  const w = scratch();
  try {
    const root = path.join(w.dir, 'yellow');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'),
      `<html><head><title>Bright</title><meta name="viewport" content="width=device-width">
       <style>body { background: #FFFFFF; color: #111111; } h1 { background: #FFFF00; color: #FFFF00; }</style>
       </head><body><h1>Yellow on yellow</h1></body></html>`);
    const model = describeSite(readLocalSite(root));
    const { theme, evidence } = themeFor(model);
    assert.ok(contrast(theme.primary, theme.onPrimary) >= 4.5,
      'the app colour must be able to carry its text even when the site could not');
    assert.ok(evidence.coloursSeen.includes('#FFFF00'), 'and the site colour is still reported as what was seen');
  } finally { w.done(); }
});

test('the proposal only claims capabilities the site shows a need for', () => {
  const model = describeSite(readLocalSite(FIXTURE));
  const { spec } = proposeApp(model, {});
  assert.ok(spec.capabilities.includes('share'));
  assert.equal(spec.capabilities.includes('barcode'), false, 'no camera capability without a scanner');
  assert.equal(spec.capabilities.includes('notifications'), false, 'no notification capability without a reason');
  assert.equal(spec.capabilities.includes('exactAlarms'), false);
  assert.equal(spec.app.webview.javascriptEnabled, true, 'a website brought into an app needs its scripts');
  assert.equal(spec.app.webview.localAsset, 'index.html');
  assert.equal(spec.android.cleartextTraffic, false, 'and it stays secure by default');
  // Every capability must say why it is there, because the Studio shows that.
  assert.equal(spec.capabilitiesReason.length, spec.capabilities.length);
});

/* ── the part that matters: the output must be buildable ──────────────────── */

test('the analyser produces a specification that validates and generates', () => {
  const site = readLocalSite(FIXTURE);
  const model = describeSite(site);
  const { spec } = proposeApp(model, {});

  const validation = validateSpec(spec);
  assert.equal(validation.blocked, false,
    `the analyser must not emit a specification that fails validation: ${JSON.stringify(validation.errors || [])}`);
  assert.deepEqual(validation.errors || [], []);

  const gen = generateAndroidProject(spec, { webDir: FIXTURE });
  assert.equal(gen.ok, true, 'and it must generate a real Android project');
  assert.ok(gen.files.length > 10);
  const manifest = gen.files.find((f) => f.path.endsWith('AndroidManifest.xml'));
  assert.ok(manifest, 'the manifest is generated');
  // The application id lives in build.gradle, not in the manifest: AGP 8 uses a
  // namespace in the build file and the manifest carries no package attribute.
  // Asserting the manifest contained it was wrong, and this is where the claim
  // actually holds.
  const gradle = gen.files.find((f) => f.path.endsWith('app/build.gradle'));
  assert.ok(gradle, 'the app build file is generated');
  assert.ok(gradle.data.includes(spec.identity.packageName),
    'the analysed package name must reach the build file that sets the application id');
});

test('analysing the fixture end to end changes nothing on disk unless asked', async () => {
  const w = scratch();
  try {
    const out = path.join(w.dir, 'app');
    const result = await analyse(FIXTURE);
    assert.equal(result.analysis.summary.blocking, 0);
    assert.equal(result.written, null, 'nothing is written without --out');
    assert.equal(fs.existsSync(out), false);

    const second = await analyse(FIXTURE, { out, name: 'Greenfield Bakery' });
    assert.ok(second.written, 'and everything is written with it');
    for (const rel of ['spec.json', 'analysis.json', 'web/index.html', 'web/assets/style.css', 'web/menu.html']) {
      assert.ok(fs.existsSync(path.join(out, rel)), `${rel} should have been written`);
    }
    // The written specification is the proposed one, unchanged.
    const writtenSpec = JSON.parse(fs.readFileSync(path.join(out, 'spec.json'), 'utf8'));
    assert.equal(writtenSpec.identity.appName, second.proposal.spec.identity.appName);
    assert.equal(validateSpec(writtenSpec).blocked, false, 'what lands on disk must also validate');
    // The analysis explains the specification months later.
    const analysis = JSON.parse(fs.readFileSync(path.join(out, 'analysis.json'), 'utf8'));
    assert.equal(analysis.proposal.packageName, writtenSpec.identity.packageName);
    assert.ok(Array.isArray(analysis.findings) && analysis.findings.length > 0);
  } finally { w.done(); }
});

test('the same site always produces the same specification, byte for byte', async () => {
  const w = scratch();
  try {
    const a = path.join(w.dir, 'a');
    const b = path.join(w.dir, 'b');
    await analyse(FIXTURE, { out: a });
    await analyse(FIXTURE, { out: b });
    assert.equal(fs.readFileSync(path.join(a, 'spec.json'), 'utf8'),
      fs.readFileSync(path.join(b, 'spec.json'), 'utf8'),
      'two runs must be identical, or nothing downstream can be cached or trusted');
  } finally { w.done(); }
});

/* ── rewriting, the one place the analyser edits someone's site ───────────── */

test('a URL the app could not resolve is made relative, and reported', () => {
  const w = scratch();
  try {
    const root = path.join(w.dir, 'site');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'),
      `<html><head><title>Mixed</title><link rel="stylesheet" href="/assets/main.css"></head>
       <body><img src="/assets/logo.png"><a href="/sub/page.html">sub</a>
       <a href="https://example.com/sub/page.html">absolute copy</a>
       <a href="https://elsewhere.example.org/x">away</a>
       <a href="/not-in-the-bundle.html">missing</a></body></html>`);
    fs.writeFileSync(path.join(root, 'sub', 'page.html'), '<html><head><title>Sub</title></head><body>sub</body></html>');
    fs.writeFileSync(path.join(root, 'assets', 'main.css'), 'body { background: #FFFFFF; }');
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), 'not really a png');

    const site = readLocalSite(root);
    const html = site.pages.find((p) => p.rel === 'index.html').html;
    const { html: out, rewrites } = planRewrites(site, 'index.html', html);

    assert.ok(out.includes('href="./assets/main.css"'), `root-relative CSS became relative: ${out.slice(0, 200)}`);
    assert.ok(out.includes('src="./assets/logo.png"'), 'root-relative image became relative');
    assert.ok(out.includes('href="./sub/page.html"'), 'the internal page link became relative');
    assert.ok(out.includes('href="https://elsewhere.example.org/x"'), 'a link away from the site is untouched');
    assert.ok(out.includes('href="/not-in-the-bundle.html"'),
      'a link to something not in the bundle is left alone — rewriting it would break a working link');
    assert.equal(rewrites.length, 4, `expected four rewrites, got ${JSON.stringify(rewrites)}`);
    for (const r of rewrites) assert.ok(r.from && r.to && r.page, 'every rewrite says what changed and where');

    // From a page in a subdirectory, the same rewrite has to walk up.
    const subHtml = site.pages.find((p) => p.rel === 'sub/page.html').html;
    const nested = planRewrites(site, 'sub/page.html', `${subHtml}<img src="/assets/logo.png">`);
    assert.ok(nested.html.includes('src="../assets/logo.png"'),
      `a page in a subdirectory must point up: ${nested.rewrites.map((r) => r.to).join(', ')}`);
  } finally { w.done(); }
});

test('a site that uses a real address keeps it, a directory does not invent one', async () => {
  const local = await analyse(FIXTURE);
  const startUrl = local.proposal.spec.app.webview.startUrl;
  assert.ok(startUrl.startsWith('https://appassets.androidplatform.net/'),
    `a local site has no website address, so the field records where the app really loads from: ${startUrl}`);

  const w = scratch();
  try {
    const root = path.join(w.dir, 'remote');
    fs.mkdirSync(root, { recursive: true });
    const page = '<html><head><title>Remote</title></head><body>hi</body></html>';
    const fakeFetch = async () => ({
      ok: true, status: 200, url: 'https://greenfield.example.org/',
      headers: { get: () => 'text/html; charset=utf-8' },
      arrayBuffer: async () => Buffer.from(page),
    });
    const result = await analyse('https://greenfield.example.org/', { fetchImpl: fakeFetch, fetchOptions: { fetchImpl: fakeFetch } });
    assert.equal(result.proposal.spec.app.webview.startUrl, 'https://greenfield.example.org/');
    assert.equal(result.proposal.spec.identity.packageName, 'org.example.greenfield');
    assert.deepEqual(result.proposal.spec.app.webview.allowedHosts, ['greenfield.example.org']);
  } finally { w.done(); }
});

test('sizes are described in units a person uses', () => {
  assert.equal(humanBytes(0), '0 bytes');
  assert.equal(humanBytes(900), '900 bytes');
  assert.equal(humanBytes(6 * 1024), '6 KB');
  assert.equal(humanBytes(3 * 1024 * 1024), '3.0 MB');
});
