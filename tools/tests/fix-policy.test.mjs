/**
 * THE GUARD ON AUTOMATIC REPAIR
 * =============================
 *
 * These tests exist because of one specific way this kind of system goes wrong:
 * someone adds a new finding with a repair attached, it is technically valid,
 * and it starts being applied to people's projects automatically because
 * nobody remembered that automatic application was opt-in per code.
 *
 * So the first test does not test behaviour at all. It reads the engine's own
 * source, finds every finding that carries a repair, and insists that each one
 * appears in the policy table with a written reason. Adding a repairable finding
 * without deciding how safe it is becomes a failing build rather than a silent
 * change in what the app does to someone's work.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { FIX_POLICY, confidenceOf, isAutoFixable, policyCodes } from '../../engine/spec/fix-policy.mjs';
import { defaultSpec, validateSpec, planFixes, repair, rollbackFix } from '../../engine/spec/spec.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function engineSources(dir = join(ROOT, 'engine')) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...engineSources(p));
    else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

/**
 * Every finding code the engine can raise together with a repair.
 *
 * Parsed from the source rather than by exercising the engine, because the
 * point is to catch codes that no test happens to reach: a finding that only
 * appears for a rare configuration must still be declared.
 */
function repairableCodesInSource() {
  const found = new Map();
  const call = /(?:issue|p)\(\s*'([A-Z]_[A-Z0-9_]+)'/g;
  for (const file of engineSources()) {
    if (file.endsWith('fix-policy.mjs')) continue;
    const src = readFileSync(file, 'utf8');
    let m;
    while ((m = call.exec(src))) {
      // Walk to the matching close paren so we only look inside this call.
      const from = m.index;
      let depth = 0;
      let end = src.length;
      for (let i = from; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      const body = src.slice(from, end);
      if (/fix:\s*\{/.test(body)) found.set(m[1], file.replace(ROOT + '/', ''));
    }
  }
  return found;
}

test('every repairable finding has a written decision about whether it may be automatic', () => {
  const inSource = repairableCodesInSource();
  assert.ok(inSource.size >= 10, `expected to find the engine's repairable findings, found ${inSource.size}`);

  const undeclared = [...inSource.keys()].filter((code) => !(code in FIX_POLICY));
  assert.deepEqual(undeclared, [],
    `These findings carry a repair but are not in engine/spec/fix-policy.mjs:\n` +
    undeclared.map((c) => `  ${c}  (${inSource.get(c)})`).join('\n') +
    `\n\nAdd each one to FIX_POLICY with confidence 'high' or 'review' and a reason.` +
    `\nUntil then they are treated as needing a decision, which is safe but silent.`);
});

test('the policy has no entry for a finding that no longer exists', () => {
  const inSource = repairableCodesInSource();
  const stale = policyCodes().filter((code) => !inSource.has(code));
  assert.deepEqual(stale, [], `These policy entries name findings the engine no longer raises: ${stale.join(', ')}`);
});

test('every policy entry explains itself in words a person would understand', () => {
  for (const [code, entry] of Object.entries(FIX_POLICY)) {
    assert.ok(['high', 'review'].includes(entry.confidence), `${code}: confidence must be high or review`);
    assert.ok(typeof entry.why === 'string' && entry.why.length >= 40,
      `${code}: needs a real reason, not a placeholder (got ${JSON.stringify(entry.why)})`);
    // A reason is shown to someone on a phone in place of the repair button.
    assert.ok(!/TODO|FIXME|XXX/.test(entry.why), `${code}: unfinished reason`);
  }
});

test('an unknown code is never treated as safe to apply on its own', () => {
  const unknown = confidenceOf('E_SOMETHING_NOBODY_DECIDED_YET');
  assert.equal(unknown.confidence, 'review');
  assert.equal(isAutoFixable('E_SOMETHING_NOBODY_DECIDED_YET'), false);
  assert.ok(unknown.why.length > 20, 'the fallback must say why nothing was done');
});

test('the default policy leaves the honest split visible', () => {
  const high = policyCodes().filter(isAutoFixable);
  const review = policyCodes().filter((c) => !isAutoFixable(c));
  // The point of the split is that neither side is empty: a policy that calls
  // everything safe would be reckless, and one that calls nothing safe would
  // make "repair everything safe" a button that does nothing.
  assert.ok(high.length >= 5, `only ${high.length} codes may be repaired automatically`);
  assert.ok(review.length >= 3, `only ${review.length} codes are marked as needing a decision`);
});

/* ── the planner ─────────────────────────────────────────────────────────── */

/** A specification with one provable problem and two that are judgement calls. */
function specWithBothKinds() {
  const s = defaultSpec();
  s.identity.appName = 'Repair Test';
  s.identity.packageName = 'com.mysite.repairtest';
  s.android.compileSdk = 36;
  s.android.targetSdk = 26;          // lower than the minimum — describes no device, forced repair
  s.android.minSdk = 36;
  s.android.cleartextTraffic = true; // legal, but a decision — review repair
  s.android.allowBackup = true;      // same
  return s;
}

/**
 * A specification whose repair is offered but cannot be carried out.
 *
 * targetSdk is above the highest value the schema allows, so the engine's rule
 * for the compile/target mismatch — set compile to target — would copy an
 * out-of-range number into a second field and leave two errors where there was
 * one. The repair has to be refused rather than performed.
 */
function specWithARepairThatWouldBackfire() {
  const s = defaultSpec();
  s.identity.appName = 'Backfire Test';
  s.identity.packageName = 'com.mysite.backfire';
  s.android.compileSdk = 36;
  s.android.targetSdk = 40;   // above the schema maximum
  return s;
}

test('the plan does not alter the specification it was given', () => {
  const s = specWithBothKinds();
  const before = JSON.stringify(s);
  planFixes(s);
  assert.equal(JSON.stringify(s), before, 'planning must work on a copy');
});

test('a forced repair is offered as automatic and a judgement call is not', () => {
  const s = specWithBothKinds();
  const plan = planFixes(s, validateSpec(s).issues);
  const auto = plan.stepsAuto.map((x) => x.code);
  const review = plan.stepsReview.map((x) => x.code);

  assert.ok(auto.includes('E_SDK_ORDER'), `expected the impossible SDK pairing to be repairable, got ${auto}`);
  assert.ok(review.includes('W_CLEARTEXT'), `expected the HTTP question to need a decision, got ${review}`);
  assert.ok(!auto.includes('W_CLEARTEXT'), 'turning off HTTP traffic must never be automatic — it can break the app');
  assert.ok(!auto.includes('W_BACKUP'), 'turning off backup can lose a user\'s data — not an automatic change');
});

test('every step shows what the value is now and what it would become', () => {
  const s = specWithBothKinds();
  const plan = planFixes(s, validateSpec(s).issues);

  const sdk = plan.steps.find((x) => x.code === 'E_SDK_ORDER');
  assert.ok(sdk, `expected the impossible SDK pairing in the plan, got ${plan.steps.map((x) => x.code)}`);
  assert.equal(sdk.before, 36, 'the minimum as it stands now');
  assert.equal(sdk.after, 26, 'the minimum it would become — the target, which is the only value that can work');
  assert.equal(sdk.path, 'android.minSdk', 'the step must name the exact field');
  assert.ok(sdk.why.length > 40, 'the step must explain itself');

  const http = plan.steps.find((x) => x.code === 'W_CLEARTEXT');
  assert.equal(http.before, true);
  assert.equal(http.after, false);
});

test('the plan refuses a repair that would leave more problems than it solves', () => {
  const s = specWithARepairThatWouldBackfire();
  const plan = planFixes(s, validateSpec(s).issues);

  const errorsNow = validateSpec(s).issues.filter((i) => i.severity === 'error').length;
  const errorsAfter = plan.preview.result.issues.filter((i) => i.severity === 'error').length;
  assert.ok(errorsAfter <= errorsNow, `the automatic pass made things worse: ${errorsNow} errors became ${errorsAfter}`);

  assert.equal(plan.preview.spec.android.compileSdk, s.android.compileSdk,
    'the out-of-range value must not have been copied into the compile version');
  assert.ok(plan.preview.refused.length >= 1, 'a repair that was declined must be reported, not silently skipped');
  assert.ok(plan.preview.refused[0].why.length > 20, 'the refusal must explain itself');

  const { spec: repaired, applied } = repair(s);
  assert.equal(applied.length, 0, 'nothing should have been applied to a specification whose only repair backfires');
  assert.equal(repaired.android.compileSdk, 36, 'the caller is left with exactly what they had');
});

test('the preview describes the finished state, not just the first step', () => {
  const s = specWithBothKinds();
  const plan = planFixes(s, validateSpec(s).issues);
  assert.ok(plan.changed >= 1);
  // The preview specification is as repaired as it can be, and the owner's
  // judgement calls are still theirs to make.
  assert.equal(plan.preview.spec.android.minSdk, 26, 'the impossible pairing should be resolved');
  assert.equal(plan.preview.spec.android.cleartextTraffic, true,
    'a judgement call must survive the automatic pass untouched');
  assert.equal(plan.preview.spec.android.allowBackup, true, 'and so must the other one');
  const errorsBefore = validateSpec(s).issues.filter((i) => i.severity === 'error').length;
  const errorsAfter = plan.preview.result.issues.filter((i) => i.severity === 'error').length;
  assert.ok(errorsAfter < errorsBefore, `expected fewer errors, ${errorsBefore} became ${errorsAfter}`);
});

test('repairing applies the forced repairs and leaves the judgement calls alone', () => {
  const s = specWithBothKinds();
  const { spec: fixed, applied, after } = repair(s);
  assert.ok(applied.length >= 1, 'expected at least one repair');
  assert.ok(applied.every((a) => isAutoFixable(a.code)), `applied something not marked safe: ${applied.map((a) => a.code)}`);
  assert.equal(fixed.android.cleartextTraffic, true, 'the HTTP setting is the owner\'s to change');
  assert.equal(s.android.compileSdk, 36, 'the caller\'s object must not be mutated');

  const rejected = after.issues.filter((i) => i.severity === 'critical' || i.severity === 'error');
  assert.deepEqual(rejected, [], `repair left errors behind: ${rejected.map((i) => i.code)}`);
});

test('a judgement call can still be applied when it is asked for by name', () => {
  const s = specWithBothKinds();
  const { spec: fixed, applied } = repair(s, { codes: ['W_CLEARTEXT'] });
  assert.deepEqual(applied.map((a) => a.code), ['W_CLEARTEXT']);
  assert.equal(fixed.android.cleartextTraffic, false, 'asking for it by name must apply it');
});

test('every repair can be undone, and undoing restores the specification exactly', () => {
  const s = specWithBothKinds();
  const { spec: fixed, applied } = repair(s, { codes: ['E_COMPILE_BELOW_TARGET', 'W_CLEARTEXT'] });
  assert.equal(applied.length, 2);

  // Walk the record backwards, exactly as an undo button would.
  const undone = JSON.parse(JSON.stringify(fixed));
  for (const entry of [...applied].reverse()) {
    assert.equal(rollbackFix(undone, entry), true, `could not undo ${entry.code}`);
  }
  assert.deepEqual(undone, s, 'undo must put every field back exactly as it was');
});

test('repairing a specification that needs nothing does nothing at all', () => {
  const s = defaultSpec();
  const { applied, changed, spec: out } = repair(s, { codes: null });
  assert.equal(applied.length, 0);
  assert.equal(changed, 0);
  assert.deepEqual(out, s);
});

test('a repair cannot be applied twice', () => {
  const s = specWithBothKinds();
  const once = repair(s).spec;
  const twice = repair(once).spec;
  assert.deepEqual(twice, once, 'a second pass must find nothing left to do');
});
