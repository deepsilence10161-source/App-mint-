/**
 * BACKEND CONFIGURATION
 * =====================
 *
 * A backend that is selected in the Studio and then silently does nothing is
 * worse than no backend option: the configuration screen implies that picking
 * "Supabase" connected something. These tests hold the two ends of that promise
 * together — the validator refuses a backend that cannot work, and the generator
 * emits the module that is the app's only path to it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSpec, defaultSpec } from '../../engine/spec/spec.mjs';
import { generateAndroidProject } from '../../engine/gen/android.mjs';
import { dataRuntime } from '../../engine/backend/data-runtime.mjs';
import { projectHealth } from '../../engine/spec/health.mjs';
import { permissionReport } from '../../engine/capability/permissions.mjs';

const withBackend = (backend, over = {}) => {
  const s = defaultSpec();
  s.identity.packageName = 'com.example.backendtest';
  s.backend = backend;
  return { ...s, ...over };
};

const GOOD = {
  kind: 'supabase',
  url: 'https://example.supabase.co',
  requiresAuth: true,
  tablesRequiringRls: ['orders', 'profiles'],
};

const codesOf = (spec) => validateSpec(spec).issues.map((i) => i.code);

/* ── the validator ──────────────────────────────────────────────────────── */

test('a backend with no address is refused', () => {
  const spec = withBackend({ kind: 'supabase', url: '' });
  assert.ok(codesOf(spec).includes('E_BACKEND_NO_URL'), codesOf(spec).join(', '));
  assert.equal(validateSpec(spec).blocked, true);
});

test('a backend reached over plain HTTP is a critical finding', () => {
  // Not a warning. Sign-in goes over this connection, and anything on the path
  // can read it.
  const spec = withBackend({ ...GOOD, url: 'http://example.supabase.co' });
  const found = validateSpec(spec).issues.find((i) => i.code === 'E_BACKEND_NOT_HTTPS');
  assert.ok(found, codesOf(spec).join(', '));
  assert.equal(found.severity, 'critical');
  assert.equal(validateSpec(spec).blocked, true);
});

test('the HTTP finding offers the change but does not apply it by itself', () => {
  const spec = withBackend({ ...GOOD, url: 'http://example.supabase.co' });
  const found = validateSpec(spec).issues.find((i) => i.code === 'E_BACKEND_NOT_HTTPS');
  assert.equal(found.fix.value, 'https://example.supabase.co', 'the offered repair should be the same address over https');
  // fix-policy.test.mjs is what enforces that this is classified `review`
  // rather than `high`; asserting the offered value here keeps the two honest
  // about describing the same change.
});

test('a properly configured backend is not accused of anything', () => {
  const spec = withBackend(GOOD);
  const backendCodes = codesOf(spec).filter((c) => /BACKEND/.test(c));
  assert.deepEqual(backendCodes, [], `unexpected: ${backendCodes.join(', ')}`);
});

test('no backend at all is a legitimate configuration, not a finding', () => {
  const spec = withBackend({ kind: 'none' });
  const backendCodes = codesOf(spec).filter((c) => /BACKEND/.test(c));
  assert.deepEqual(backendCodes, []);
});

/* ── the generator ──────────────────────────────────────────────────────── */

test('a project with a backend gets the data runtime, and one without does not', () => {
  const withIt = generateAndroidProject(withBackend(GOOD));
  assert.equal(withIt.ok, true, withIt.errors.join('; '));
  const runtime = withIt.files.find((f) => f.path.endsWith('data-runtime.js'));
  assert.ok(runtime, 'the runtime was not emitted');
  assert.ok(runtime.data.length > 2000, `only ${runtime.data.length} bytes`);

  const without = generateAndroidProject(withBackend({ kind: 'none' }));
  assert.equal(without.ok, true);
  assert.equal(without.files.some((f) => f.path.includes('data-runtime')), false,
    'an app with no backend should not be given a module that talks to one');
});

test('the emitted runtime is the one the generator module produces, byte for byte', () => {
  // If these ever differ, the app ships something the tests did not check.
  const spec = withBackend(GOOD);
  const fromGenerator = generateAndroidProject(spec).files.find((f) => f.path.endsWith('data-runtime.js'));
  assert.equal(fromGenerator.data, dataRuntime(spec).code);
});

test('the runtime is emitted where the app can load it, beside the bundled web assets', () => {
  const spec = withBackend(GOOD);
  const runtime = generateAndroidProject(spec).files.find((f) => f.path.endsWith('data-runtime.js'));
  assert.equal(runtime.path, 'android/app/src/main/assets/www/data-runtime.js');
});

test('a backend that cannot produce a runtime fails the build instead of shipping without one', () => {
  // The runtime is the only thing allowed to know the backend's address. An app
  // that configured a backend and got no runtime would reach it from anywhere.
  const spec = withBackend({ ...GOOD, url: 'http://example.supabase.co' });
  const out = generateAndroidProject(spec);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /data runtime/i.test(e)), out.errors.join('; '));
});

test('the backend address in the spec is the address in the runtime', () => {
  const spec = withBackend({ ...GOOD, url: 'https://other-project.supabase.co' });
  const code = dataRuntime(spec).code;
  assert.ok(code.includes('"https://other-project.supabase.co"'), 'the configured address did not reach the runtime');
});

/* ── the health ring ────────────────────────────────────────────────────── */

const healthOf = (spec) => projectHealth(spec, validateSpec(spec), permissionReport(spec));

test('the backend category scores a configured backend and stays silent on none', () => {
  assert.equal(healthOf(withBackend({ kind: 'none' })).categories.find((c) => c.key === 'backend').score, null);
  assert.notEqual(healthOf(withBackend(GOOD)).categories.find((c) => c.key === 'backend').score, null);
});

test('an http backend fails the backend category rather than warning it', () => {
  const backend = healthOf(withBackend({ ...GOOD, url: 'http://example.supabase.co' }))
    .categories.find((c) => c.key === 'backend');
  assert.ok(backend.checks.some((c) => c.status === 'fail' && /HTTPS/.test(c.name)));
  assert.equal(backend.score < 40, true, `scored ${backend.score}`);
});

test('the runtime is one of the things the backend score is made of', () => {
  const backend = healthOf(withBackend(GOOD)).categories.find((c) => c.key === 'backend');
  assert.ok(backend.checks.some((c) => /controlled path to the backend/.test(c.name)),
    backend.checks.map((c) => c.name).join('; '));
  assert.ok(backend.checks.some((c) => /privileged credential/.test(c.name)),
    'whether the generated runtime holds a secret is a backend health question, not a separate one');
});

test('requiring auth without naming the tables warns, and naming them does not', () => {
  const bare = healthOf(withBackend({ ...GOOD, tablesRequiringRls: [] })).categories.find((c) => c.key === 'backend');
  const named = healthOf(withBackend(GOOD)).categories.find((c) => c.key === 'backend');
  assert.ok(bare.checks.some((c) => c.status === 'warn' && /row-level security/.test(c.name)));
  assert.ok(named.checks.every((c) => c.status === 'pass' || !/row-level security/.test(c.name)));
  assert.ok(named.score > bare.score, `named ${named.score} vs bare ${bare.score}`);
});
