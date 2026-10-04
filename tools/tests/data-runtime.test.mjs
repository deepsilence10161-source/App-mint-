/**
 * DATA RUNTIME
 * ============
 *
 * The architecture the prompt asks for is a chain — application, data runtime,
 * backend adapter, backend — and its whole value is the claim that nothing
 * reaches the backend except through the middle link. A test that only reads the
 * generated text cannot check that claim, so these tests run the generated
 * module in a VM against a fake fetch and watch what it actually does.
 *
 * What is asserted is behaviour under failure, because that is where a runtime
 * like this goes wrong: whether a failed write gets retried (and charges someone
 * twice), whether cached data is passed off as current, and whether entitlement
 * can be written by the thing that wants to be premium.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { dataRuntime, unsafePatterns, runtimeReport } from '../../engine/backend/data-runtime.mjs';

const SPEC = {
  backend: {
    kind: 'supabase',
    url: 'https://example.supabase.co',
    requiresAuth: true,
    tablesRequiringRls: ['orders', 'profiles'],
  },
};

/** A response shaped like fetch's. */
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * Load the generated runtime into a sandbox with a fake fetch, and return the
 * runtime plus a record of every request it made.
 */
function load(spec = SPEC, handler) {
  const generated = dataRuntime(spec);
  assert.equal(generated.ok, true, generated.errors.join('; '));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({
      url: String(url),
      method: (opts && opts.method) || 'GET',
      body: opts && opts.body,
      headers: (opts && opts.headers) || {},
    });
    return handler(calls.length, url, opts);
  };
  const sandbox = {
    fetch: fetchImpl,
    navigator: { onLine: true },
    setTimeout: (fn) => { fn(); return 0; },   // no real waiting in a test
    Promise, console, JSON, Object, Array, encodeURIComponent,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(generated.code, { filename: 'data-runtime.js' }).runInContext(sandbox);
  return { rt: sandbox.DataRuntime, calls, generated };
}

/* ── what is generated ──────────────────────────────────────────────────── */

test('a configured backend produces a runtime, and an unconfigured one does not', () => {
  assert.equal(dataRuntime(SPEC).ok, true);
  const none = dataRuntime({ backend: { kind: 'none' } });
  assert.equal(none.ok, false);
  assert.equal(none.code, '', 'nothing should be generated for an app with no backend');
});

test('the runtime refuses to be generated for an insecure or missing address', () => {
  for (const url of ['', 'http://example.supabase.co', 'ftp://example.com']) {
    const r = dataRuntime({ backend: { kind: 'supabase', url } });
    assert.equal(r.ok, false, `"${url}" was accepted`);
    assert.ok(r.errors.length, 'it failed without saying why');
  }
});

test('generation is deterministic, so the committed file can be checked against its source', () => {
  assert.equal(dataRuntime(SPEC).code, dataRuntime(SPEC).code);
  assert.equal(dataRuntime(SPEC).code, dataRuntime(JSON.parse(JSON.stringify(SPEC))).code);
});

test('the generated file goes where the bundled web assets live', () => {
  assert.equal(dataRuntime(SPEC).file, 'android/app/src/main/assets/www/data-runtime.js');
});

test('the generated module is valid JavaScript and defines exactly one global', () => {
  const { rt, generated } = load();
  assert.equal(typeof rt, 'object');
  // The point of a single entry point: one name, so there is one thing to
  // search for when checking that nothing went around it.
  assert.ok(!/global\.\w+\s*=/.test(generated.code.replace('global.DataRuntime = runtime;', '')),
    'the runtime defines more than one global');
});

/* ── the runtime owns the URL ───────────────────────────────────────────── */

test('nothing in the app is given the backend address', () => {
  const { rt } = load();
  const cfg = rt.config();
  assert.equal(cfg.url, 'https://example.supabase.co');
  // And handing out the config must not hand out a way to repoint it.
  cfg.url = 'https://attacker.example';
  cfg.tablesRequiringRls.push('secrets');
  assert.equal(rt.config().url, 'https://example.supabase.co', 'the URL was mutable from outside');
  assert.deepEqual([...rt.config().tablesRequiringRls], ['orders', 'profiles'],
    'the table list was mutable from outside');
});

test('every request goes to the configured host and nowhere else', async () => {
  const { rt, calls } = load(SPEC, () => res(200, []));
  await rt.query('orders');
  await rt.entitlement();
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    assert.ok(c.url.startsWith('https://example.supabase.co/'), `request escaped to ${c.url}`);
  }
});

/* ── retries: reads yes, writes never ───────────────────────────────────── */

test('a read that fails is retried, up to a limit', async () => {
  const { rt, calls } = load(SPEC, (n) => (n <= 2 ? res(503, 'unavailable') : res(200, [{ id: 1 }])));
  const out = await rt.query('orders');
  assert.equal(out.ok, true);
  assert.equal(calls.length, 3, `expected the read to be retried twice, saw ${calls.length} attempts`);
});

test('a read that keeps failing stops, and says it was a server problem', async () => {
  const { rt, calls } = load(SPEC, () => res(500, 'down'));
  const out = await rt.query('orders');
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'server');
  assert.ok(calls.length <= 3, `it retried ${calls.length} times; a bounded retry means bounded`);
});

test('a failed write is never retried, because it may have landed', async () => {
  // This is the check that matters. Retrying a mutation that the server may
  // already have applied is how an app charges somebody twice, and it looks
  // identical to good error handling right up until it does that.
  const { rt, calls } = load(SPEC, () => res(500, 'down'));
  const out = await rt.mutate('orders', { id: 7, status: 'paid' }, { status: 'pending' });
  assert.equal(calls.length, 1, `the write was attempted ${calls.length} times`);
  assert.equal(out.ok, false);
  assert.equal(out.rolledBack, true, 'a refused write must put the previous value back');
  assert.deepEqual(out.previous, { status: 'pending' });
});

/* ── offline and stale data ─────────────────────────────────────────────── */

test('a cached read is served as stale, not as current', async () => {
  let fail = false;
  const { rt } = load(SPEC, () => (fail ? res(503, 'unavailable') : res(200, [{ id: 1 }])));
  const first = await rt.query('orders');
  assert.equal(first.stale, false);

  fail = true;
  const second = await rt.query('orders');
  assert.equal(second.ok, true, 'the last good read should still be usable');
  assert.equal(second.stale, true, 'serving cached data without saying so is lying');
  assert.ok(second.reason, 'and it should say why it is stale');
});

test('a first read that fails with nothing cached is a failure, not an empty list', async () => {
  const { rt } = load(SPEC, () => res(503, 'unavailable'));
  const out = await rt.query('orders');
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'server');
});

test('the runtime reports whether it is offline rather than guessing', () => {
  const { rt } = load();
  assert.equal(rt.online(), true);
});

/* ── entitlement is not the client's to decide ──────────────────────────── */

test('entitlement comes from the server and there is no way to set it', async () => {
  const { rt } = load(SPEC, () => res(200, [{ plan: 'pro', expires_at: '2030-01-01' }]));
  const e = await rt.entitlement();
  assert.equal(e.plan, 'pro');
  assert.equal(e.source, 'server');
  assert.equal(typeof rt.setEntitlement, 'undefined', 'a setter for premium status is the vulnerability');
  assert.equal(typeof rt.premium, 'undefined');
});

test('when the server cannot be reached, entitlement is free — not whatever was last seen', async () => {
  const { rt } = load(SPEC, () => res(500, 'down'));
  const e = await rt.entitlement();
  assert.equal(e.ok, false);
  assert.equal(e.plan, 'free', 'failing open on entitlement is the whole attack');
});

/* ── authentication ─────────────────────────────────────────────────────── */

test('signing in stores a session in memory, and signing out drops it', async () => {
  const { rt } = load(SPEC, () => res(200, { access_token: 'a-token', refresh_token: 'r' }));
  assert.equal(rt.isSignedIn(), false);
  const out = await rt.signIn('a@b.c', 'pw');
  assert.equal(out.ok, true);
  assert.equal(rt.isSignedIn(), true);
  await rt.signOut();
  assert.equal(rt.isSignedIn(), false);
});

test('a failed sign-in is not retried', async () => {
  const { rt, calls } = load(SPEC, () => res(401, 'bad credentials'));
  const out = await rt.signIn('a@b.c', 'wrong');
  assert.equal(calls.length, 1, `sign-in was attempted ${calls.length} times`);
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'unauthorised');
});

test('a session is sent on later requests', async () => {
  const { rt, calls } = load(SPEC, (n) => (n === 1
    ? res(200, { access_token: 'a-token' })
    : res(200, [])));
  await rt.signIn('a@b.c', 'pw');
  await rt.query('orders');
  assert.equal(calls[1].headers.Authorization, 'Bearer a-token',
    `the second request sent ${JSON.stringify(calls[1].headers)}`);
});

/* ── the tables that must be protected ──────────────────────────────────── */

test('a table that was not declared as protected is refused when auth is on', async () => {
  const { rt, calls } = load(SPEC, () => res(200, []));
  const out = await rt.query('audit_log');
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0, 'it must not reach the network for a table nobody declared');
  assert.ok(/tablesRequiringRls/.test(out.message), `reason was "${out.message}"`);
});

/* ── the checks for going around it ─────────────────────────────────────── */

test('the generated runtime passes its own safety checks', () => {
  assert.deepEqual(unsafePatterns(dataRuntime(SPEC).code), []);
});

test('a service-role key in generated output is caught', () => {
  const found = unsafePatterns('const k = "service_role key goes here";');
  assert.ok(found.some((f) => f.code === 'SERVICE_ROLE_IN_CLIENT'), JSON.stringify(found));
});

test('a baked-in token is caught', () => {
  const jwt = 'eyJ' + 'a'.repeat(50) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
  const found = unsafePatterns(`const token = "${jwt}";`);
  assert.ok(found.some((f) => f.code === 'JWT_EMBEDDED_IN_SOURCE'), JSON.stringify(found));
});

test('a client created directly against a URL is caught', () => {
  const found = unsafePatterns("const c = supabase('https://example.supabase.co', key);");
  assert.ok(found.some((f) => f.code === 'DIRECT_CLIENT_INIT'));
});

test('premium status read from local storage is caught', () => {
  const found = unsafePatterns("if (localStorage.getItem('is_premium') === '1') unlock();");
  assert.ok(found.some((f) => f.code === 'CLIENT_CONTROLLED_ENTITLEMENT'),
    'this is the one the prompt names explicitly, and it is trivial to write by accident');
});

test('clean code is not accused', () => {
  assert.deepEqual(unsafePatterns('const total = items.reduce((n, i) => n + i.price, 0);'), []);
});

/* ── the report the UI and health checks read ───────────────────────────── */

test('the report describes what was generated', () => {
  const r = runtimeReport(SPEC);
  assert.equal(r.configured, true);
  assert.equal(r.kind, 'supabase');
  assert.equal(r.generated, true);
  assert.equal(r.requiresAuth, true);
  assert.deepEqual([...r.tables], ['orders', 'profiles']);
  assert.ok(r.bytes > 1000, `only ${r.bytes} bytes were generated`);
  assert.deepEqual(r.unsafe, []);
});

test('the report says so when there is nothing to generate', () => {
  const r = runtimeReport({ backend: { kind: 'none' } });
  assert.equal(r.configured, false);
  assert.equal(r.generated, false);
  assert.equal(r.bytes, 0);
});

test('the report carries the reason a runtime could not be generated', () => {
  const r = runtimeReport({ backend: { kind: 'supabase', url: 'http://insecure.example' } });
  assert.equal(r.generated, false);
  assert.ok(r.errors.some((e) => /https/.test(e)), r.errors.join('; '));
});
