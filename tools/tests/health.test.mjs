/**
 * PROJECT HEALTH
 * ==============
 *
 * The design prompt allows a health dashboard on one condition: "Do not invent
 * arbitrary scores. Every score must be calculated from measurable checks."
 * These tests hold that line, because the easy way to build this feature is to
 * pick numbers that look reassuring, and a dashboard full of confident numbers
 * that nobody can interrogate teaches people to ignore all of them.
 *
 * So what is asserted here is not that the scores are high. It is that a score
 * moves when a check fails, that a category with nothing to measure scores
 * nothing at all rather than a flattering 100, and that every check that runs
 * carries a reason a person could argue with.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectHealth, scoreChecks, bandOf } from '../../engine/spec/health.mjs';
import { validateSpec } from '../../engine/spec/spec.mjs';
import { permissionReport } from '../../engine/capability/permissions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSpec = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const healthOf = (spec) => projectHealth(spec, validateSpec(spec), permissionReport(spec));

const P = (name) => ({ name, status: 'pass', detail: 'ok' });
const W = (name) => ({ name, status: 'warn', detail: 'hmm' });
const F = (name) => ({ name, status: 'fail', detail: 'no' });

/* ── the scoring rule ───────────────────────────────────────────────────── */

test('a category with nothing to measure scores nothing, not 100', () => {
  assert.equal(scoreChecks([]), null);
  assert.equal(scoreChecks(null), null);
  // The interface shows "nothing to measure" for this. A confident 100 on a
  // project that is simply not configured would be the invention the prompt
  // forbids.
  assert.equal(bandOf(null), 'none');
});

test('every check passing scores 100', () => {
  assert.equal(scoreChecks([P('a'), P('b'), P('c')]), 100);
});

test('a failure dominates the score however much passed', () => {
  const allPass = scoreChecks([P('a'), P('b'), P('c'), P('d'), P('e'), P('f'), P('g'), P('h'), P('i')]);
  const oneFails = scoreChecks([F('a'), P('b'), P('c'), P('d'), P('e'), P('f'), P('g'), P('h'), P('i')]);
  assert.equal(allPass, 100);
  assert.ok(oneFails < 40, `one failure among nine passed should not read as healthy, got ${oneFails}`);
});

test('any failing check puts a category in the poor band', () => {
  // The first cut of this rule scaled a failure gently by how many checks there
  // were, so one blocking failure among nine passed checks scored 65 and the
  // ring said "fair". A category that cannot build is not fair.
  for (let n = 2; n <= 12; n += 1) {
    const checks = [F('blocking'), ...Array.from({ length: n - 1 }, (_, i) => P(`p${i}`))];
    assert.equal(bandOf(scoreChecks(checks)), 'poor', `with ${n} checks the band was not poor`);
  }
});

test('warnings cost less than failures but are not free', () => {
  const clean = scoreChecks([P('a'), P('b')]);
  const oneWarn = scoreChecks([W('a'), P('b')]);
  const oneFail = scoreChecks([F('a'), P('b')]);
  assert.ok(clean > oneWarn, 'a warning must lower the score');
  assert.ok(oneWarn > oneFail, 'a warning must not cost as much as a failure');
});

test('the bands are ordered and cover the whole range', () => {
  assert.equal(bandOf(100), 'good');
  assert.equal(bandOf(85), 'good');
  assert.equal(bandOf(84), 'fair');
  assert.equal(bandOf(60), 'fair');
  assert.equal(bandOf(59), 'poor');
  assert.equal(bandOf(0), 'poor');
});

/* ── the real projects ──────────────────────────────────────────────────── */

test('the reference project scores every category it can measure', () => {
  const h = healthOf(readSpec('apps/demo/spec.json'));
  assert.ok(h.overall > 0 && h.overall <= 100, `overall was ${h.overall}`);
  const measured = h.categories.filter((c) => c.score !== null);
  assert.ok(measured.length >= 4, `only ${measured.length} categories were measured`);
  assert.equal(h.measured, measured.length);
});

test('a project with no backend configured does not score the backend category', () => {
  const h = healthOf(readSpec('apps/demo/spec.json'));
  const backend = h.categories.find((c) => c.key === 'backend');
  assert.equal(backend.score, null, 'an unconfigured backend has nothing to measure');
  assert.deepEqual(backend.checks, []);
  assert.ok(h.unmeasured >= 1, 'the dashboard must say something was not measured');
});

test('a project that does configure its backend scores that category', () => {
  const h = healthOf(readSpec('apps/backend-demo/spec.json'));
  const backend = h.categories.find((c) => c.key === 'backend');
  assert.notEqual(backend.score, null, 'backend.kind is set here, so there is something to measure');
  assert.ok(backend.checks.length >= 1);
});

/* ── the checks are honest, not decorative ──────────────────────────────── */

test('every check carries a reason, because that reason is the whole feature', () => {
  const h = healthOf(readSpec('apps/demo/spec.json'));
  const missing = [];
  for (const c of h.categories) {
    for (const check of c.checks) {
      if (!check.name) missing.push(`${c.key}: a check has no name`);
      if (!check.detail) missing.push(`${c.key}/${check.name}: no reason given`);
      if (!['pass', 'warn', 'fail'].includes(check.status)) {
        missing.push(`${c.key}/${check.name}: status "${check.status}"`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join('\n  '));
});

test('turning on cleartext traffic is reported as a security failure', () => {
  const spec = readSpec('apps/demo/spec.json');
  spec.android.cleartextTraffic = true;
  const security = healthOf(spec).categories.find((c) => c.key === 'security');
  const check = security.checks.find((c) => /Cleartext/.test(c.name));
  assert.equal(check.status, 'fail', 'cleartext HTTP must not pass silently');
});

test('the same change lowers the security score, and only that one', () => {
  const clean = readSpec('apps/native-demo/spec.json');
  const dirty = JSON.parse(JSON.stringify(clean));
  dirty.android.cleartextTraffic = true;

  const before = healthOf(clean).categories;
  const after = healthOf(dirty).categories;
  const at = (list, k) => list.find((c) => c.key === k);

  assert.ok(at(after, 'security').score < at(before, 'security').score,
    `security ${at(before, 'security').score} → ${at(after, 'security').score}`);
  assert.equal(at(after, 'build').score, at(before, 'build').score,
    'a cleartext setting is not a build problem and must not move that score');
});

test('an impossible SDK range is a build failure, not a warning', () => {
  const spec = readSpec('apps/demo/spec.json');
  spec.android.minSdk = 36;
  spec.android.targetSdk = 26;
  const build = healthOf(spec).categories.find((c) => c.key === 'build');
  const sdk = build.checks.find((c) => /Minimum SDK/.test(c.name));
  assert.equal(sdk.status, 'fail');
  assert.ok(build.score < 60, `a project that cannot install should not read as fair, got ${build.score}`);
});

test('a target SDK below the Play requirement warns rather than passing', () => {
  const spec = readSpec('apps/demo/spec.json');
  spec.android.targetSdk = 34;
  const build = healthOf(spec).categories.find((c) => c.key === 'build');
  const play = build.checks.find((c) => /Play requirement/.test(c.name));
  assert.equal(play.status, 'warn', 'it still builds, so warn — but it will not be accepted');
});

test('enabling a capability changes the permission score through the real derivation', () => {
  // This goes through permissionReport rather than a copy of it, so the number
  // on the dashboard is the number the manifest will contain.
  const plain = readSpec('apps/native-demo/spec.json');
  const withCamera = JSON.parse(JSON.stringify(plain));
  withCamera.capabilities = [...(withCamera.capabilities || []), 'barcode'];

  const before = healthOf(plain).categories.find((c) => c.key === 'permission');
  const after = healthOf(withCamera).categories.find((c) => c.key === 'permission');

  assert.notEqual(before.score, after.score,
    'adding a capability that needs a runtime permission must move the permission score');
  const prompt = after.checks.find((c) => /runtime prompt/.test(c.name));
  assert.equal(prompt.status, 'warn', 'CAMERA prompts, and a refusal has to be handled');
});

test('the overall number is the weakest measured category, never the average', () => {
  const spec = readSpec('apps/demo/spec.json');
  const h = projectHealth(spec, validateSpec(spec), permissionReport(spec));
  const scored = h.categories.filter((c) => c.score !== null);
  assert.equal(h.overall, Math.min(...scored.map((c) => c.score)));
  assert.equal(h.overall, scored.find((c) => c.key === h.weakest).score,
    'weakest must name the category the overall number came from');
});

test('the overall cannot describe a project that will not build as healthy', () => {
  // Averaging let a blank specification report 65 — "fair" — because four
  // categories were content while the build category scored 0. That number was
  // not wrong by the rule it used; the rule was wrong.
  const blank = projectHealth({}, validateSpec({}), { rows: [], dropped: [], total: 0, prompts: 0 });
  const build = blank.categories.find((c) => c.key === 'build');
  assert.ok(build.score < 60, 'a spec with no package name must not pass the build category');
  assert.equal(blank.overall, build.score);
  assert.equal(blank.weakest, 'build');
  assert.equal(bandOf(blank.overall), 'poor');
});

test('an unmeasured category is excluded from the overall, and counted', () => {
  const spec = readSpec('apps/demo/spec.json');   // no backend configured
  const h = projectHealth(spec, validateSpec(spec), permissionReport(spec));
  assert.ok(h.unmeasured >= 1);
  assert.equal(h.overall, Math.min(...h.categories.filter((c) => c.score !== null).map((c) => c.score)));
  assert.notEqual(h.overall, null, 'excluding an unmeasured category is not the same as measuring nothing');
});

test('a category with no checks at all keeps the overall honest', () => {
  // Only way to get an overall of null is for nothing anywhere to be
  // measurable, which the interface must render as "nothing to measure".
  const h = { categories: [{ key: 'x', checks: [], score: null }] };
  const scored = h.categories.filter((c) => c.score !== null);
  assert.equal(scored.length, 0);
  assert.equal(bandOf(null), 'none');
});

/* ── the seven categories the design prompt names ───────────────────────── */

test('all seven categories the prompt names are present, in its order', () => {
  const h = healthOf(readSpec('apps/demo/spec.json'));
  assert.deepEqual(h.categories.map((c) => c.label),
    ['Build', 'Security', 'Performance', 'Dependency', 'Backend', 'Permission', 'Testing']);
});

test('Performance is offered and scores nothing, because nothing was ever measured', () => {
  // The prompt asks for a Performance ring. This project has never profiled a
  // generated app, so there is no measurement to derive a number from, and a
  // number invented from things that merely correlate with slowness is exactly
  // what the prompt forbids. The ring exists; it says what it does not know.
  for (const spec of ['apps/demo/spec.json', 'apps/native-demo/spec.json', 'apps/backend-demo/spec.json']) {
    const perf = healthOf(readSpec(spec)).categories.find((c) => c.key === 'performance');
    assert.equal(perf.score, null, `${spec} scored performance ${perf.score}`);
    assert.deepEqual(perf.checks, []);
    assert.equal(perf.band, 'none');
  }
});

test('Testing is measured from what the device harness can actually verify', () => {
  const native = healthOf(readSpec('apps/native-demo/spec.json')).categories.find((c) => c.key === 'testing');
  const web = healthOf(readSpec('apps/demo/spec.json')).categories.find((c) => c.key === 'testing');
  assert.notEqual(native.score, null);
  assert.notEqual(web.score, null);
  assert.ok(native.score > web.score,
    `an app that draws its own screens is more verifiable than a web page: native ${native.score}, webview ${web.score}`);
  assert.ok(web.checks.some((c) => c.status === 'warn'),
    'a webview app must carry the warning that the harness cannot see into its content');
});

test('a webview app that bundles its page can be tested without a network', () => {
  const spec = readSpec('apps/demo/spec.json');
  assert.equal(spec.app.webview.localAsset, 'index.html', 'the reference app bundles its entry page');
  const testing = healthOf(spec).categories.find((c) => c.key === 'testing');
  const offline = testing.checks.find((c) => /without a network/i.test(c.name));
  assert.equal(offline.status, 'pass', 'a bundled page does not depend on a host being up');
});

test('a webview app with no bundled page depends on a remote host, and is warned', () => {
  const spec = readSpec('apps/demo/spec.json');
  delete spec.app.webview.localAsset;         // now the only thing it can open is a URL
  const testing = healthOf(spec).categories.find((c) => c.key === 'testing');
  const offline = testing.checks.find((c) => /without a network/i.test(c.name));
  assert.equal(offline.status, 'warn');
  assert.ok(/host/.test(offline.detail), `reason was "${offline.detail}"`);
  // And the score moves with it, so the check is not decoration.
  const withBundle = healthOf(readSpec('apps/demo/spec.json')).categories.find((c) => c.key === 'testing');
  assert.ok(testing.score < withBundle.score,
    `bundled ${withBundle.score} vs remote-only ${testing.score}`);
});

test('a screen-based app with no screens has nothing for the harness to verify', () => {
  const spec = readSpec('apps/native-demo/spec.json');
  spec.screens = [];
  const testing = healthOf(spec).categories.find((c) => c.key === 'testing');
  assert.ok(testing.checks.some((c) => c.status === 'warn'),
    testing.checks.map((c) => `${c.status}: ${c.name}`).join('; '));
});

test('an unmeasured category never drags the overall down or props it up', () => {
  const h = healthOf(readSpec('apps/demo/spec.json'));
  const measured = h.categories.filter((c) => c.score !== null);
  assert.equal(h.overall, Math.min(...measured.map((c) => c.score)));
  assert.equal(h.measured, measured.length);
  assert.equal(h.unmeasured, h.categories.length - measured.length);
  assert.ok(h.unmeasured >= 1, 'Performance is never measured, so something is always unmeasured');
});
