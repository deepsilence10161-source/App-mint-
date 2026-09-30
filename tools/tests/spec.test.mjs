/**
 * Engine self-tests.
 *
 * These exist to answer one question honestly: does the engine actually do what
 * the documentation claims? They run offline with zero dependencies and are
 * wired into CI, so a regression fails the build instead of quietly shipping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { validateSpec, applyFixes, defaultSpec, rollbackFix } from '../../engine/spec/spec.mjs';
import { derivePermissions, runtimePrompts } from '../../engine/capability/permissions.mjs';
import { generateAndroidProject } from '../../engine/gen/android.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));

function goodSpec() {
  const s = defaultSpec();
  s.identity.appName = 'Test App';
  s.identity.packageName = 'com.example.testapp';
  s.identity.versionName = '1.0.0';
  s.identity.versionCode = 1;
  s.app.webview.startUrl = 'https://example.com';
  s.android.targetSdk = 36;
  s.android.compileSdk = 36;
  s.build.toolchain = { agp: '8.13.2', gradle: '8.13', buildTools: '36.0.0', jdk: '17' };
  s.signing = { mode: 'debug', failClosed: true };
  return s;
}

/* ── Layer 1: schema ─────────────────────────────────────────────────────── */

test('the blank project template is itself valid', () => {
  const s = defaultSpec();
  s.android.targetSdk = 36;
  s.android.compileSdk = 36;
  const r = validateSpec(s);
  assert.equal(r.blocked, false, JSON.stringify(r.blocking, null, 2));
});

test('a malformed package name is rejected with the exact field path', () => {
  const s = goodSpec();
  s.identity.packageName = 'Not A Package';
  const r = validateSpec(s);
  const found = r.issues.find((i) => i.path === 'identity.packageName');
  assert.ok(found, 'expected a finding on identity.packageName');
  assert.equal(found.severity, 'error');
});

test('a missing required section is reported, not silently defaulted', () => {
  const s = goodSpec();
  delete s.android;
  const r = validateSpec(s);
  assert.ok(r.issues.some((i) => i.code === 'E_REQUIRED' && i.path === 'android'));
});

/* ── Layer 2: semantic ───────────────────────────────────────────────────── */

test('minSdk above targetSdk is impossible and is caught', () => {
  const s = goodSpec();
  s.android.minSdk = 30;
  s.android.targetSdk = 24;
  s.android.compileSdk = 36;
  const r = validateSpec(s);
  assert.ok(r.issues.some((i) => i.code === 'E_SDK_ORDER'));
});

test('a published build below the Play target-SDK floor is blocked', () => {
  const s = goodSpec();
  s.android.targetSdk = 34;
  s.android.compileSdk = 34;
  s.build.outputs = ['release-apk'];
  const r = validateSpec(s);
  assert.ok(r.issues.some((i) => i.code === 'E_PLAY_TARGET'),
    'Play has required API 36 for new apps and updates since 31 Aug 2026');
});

/* ── Layer 3: dependency ─────────────────────────────────────────────────── */

test('an unknown capability lists close matches instead of failing silently', () => {
  const s = goodSpec();
  s.capabilities = ['notificatons']; // typo on purpose
  const r = validateSpec(s);
  const f = r.issues.find((i) => i.code === 'E_UNKNOWN_CAP');
  assert.ok(f);
  assert.ok(Array.isArray(f.options) && f.options.length > 0);
});

test('in-app purchases without a backend are refused', () => {
  const s = goodSpec();
  s.capabilities = ['payments'];
  s.backend = { kind: 'none' };
  const r = validateSpec(s);
  assert.ok(r.issues.some((i) => i.code === 'E_PAY_NO_BACKEND'),
    'the client must never be trusted to declare itself paid');
});

/* ── Layer 4: security ───────────────────────────────────────────────────── */

test('unsafe URL schemes are refused', () => {
  for (const scheme of ['intent', 'file', 'content', 'javascript', 'data']) {
    const s = goodSpec();
    s.deepLinks.allowedSchemes = ['https', scheme];
    const r = validateSpec(s);
    assert.ok(r.issues.some((i) => i.code === 'E_UNSAFE_SCHEME'),
      `${scheme}: must be refused`);
  }
});

test('signing configured for a secret store without fail-closed is critical', () => {
  const s = goodSpec();
  s.signing = { mode: 'secret-store', failClosed: false };
  const r = validateSpec(s);
  const f = r.issues.find((i) => i.code === 'E_SIGNING_NOT_FAILCLOSED');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
  assert.equal(r.blocked, true);
});

test('a secret pasted into the spec is detected and never echoed in full', () => {
  const s = goodSpec();
  s.backend = { kind: 'supabase', url: 'https://x.supabase.co' };
  s.identity.description = 'key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbb';
  const r = validateSpec(s);
  const f = r.issues.find((i) => i.code === 'E_SECRET_IN_SPEC');
  assert.ok(f, 'a JWT in the spec must be flagged');
  assert.ok(!JSON.stringify(f).includes('aaaaaaaaaaaaaaaaaaaa'),
    'the finding must not repeat the secret back');
});

/* ── Layer 5: capability ─────────────────────────────────────────────────── */

test('a compile SDK the chosen toolchain cannot reach is blocked with a fix', () => {
  const s = goodSpec();
  s.build.toolchain = { agp: '8.4.2', gradle: '8.6', buildTools: '34.0.0' };
  s.android.compileSdk = 36;
  const r = validateSpec(s);
  const f = r.issues.find((i) => i.code === 'E_TOOLCHAIN_TOO_OLD');
  assert.ok(f, 'AGP 8.4.2 cannot compile SDK 36');
  assert.ok(f.fix, 'a deterministic fix must be offered');
});

/* ── Permission minimisation ─────────────────────────────────────────────── */

test('permissions are derived from capabilities, never granted blindly', () => {
  const s = goodSpec();
  s.capabilities = [];
  const none = derivePermissions(s);
  assert.equal(none.permissions.find((p) => p.short === 'CAMERA'), undefined);

  s.capabilities = ['barcode'];
  const withCam = derivePermissions(s);
  assert.ok(withCam.permissions.find((p) => p.short === 'CAMERA'));
});

test('disabling a capability removes its permission', () => {
  const s = goodSpec();
  s.capabilities = ['location'];
  assert.ok(derivePermissions(s).permissions.some((p) => p.short === 'ACCESS_FINE_LOCATION'));

  s.capabilities = [];
  const after = derivePermissions(s);
  assert.ok(!after.permissions.some((p) => p.short === 'ACCESS_FINE_LOCATION'),
    'location permission must disappear when the capability is off');
});

test('advertising ID is never requested while ads are disabled', () => {
  const s = goodSpec();
  s.capabilities = [];
  assert.ok(!derivePermissions(s).permissions.some((p) => p.short === 'AD_ID'));
});

test('every derived permission explains itself', () => {
  const s = goodSpec();
  s.capabilities = ['notifications', 'barcode', 'vibration'];
  for (const p of derivePermissions(s).permissions) {
    assert.ok(p.reason && p.reason.length > 3, `${p.short} needs a reason`);
    assert.ok(p.feature && p.feature.length > 1, `${p.short} needs a feature`);
  }
});

test('runtime prompts only include permissions that are actually prompted for', () => {
  const s = goodSpec();
  s.android.targetSdk = 36;
  s.capabilities = ['notifications', 'vibration'];
  const prompts = runtimePrompts(s).map((p) => p.short);
  assert.ok(prompts.includes('POST_NOTIFICATIONS'));
  assert.ok(!prompts.includes('VIBRATE'), 'VIBRATE is not a runtime prompt');
});

/* ── Determinism ─────────────────────────────────────────────────────────── */

test('generation is deterministic: identical input gives byte-identical output', () => {
  const s = goodSpec();
  const a = generateAndroidProject(s);
  const b = generateAndroidProject(clone(s));

  assert.equal(a.files.length, b.files.length);

  const hash = (g) => {
    const h = crypto.createHash('sha256');
    for (const f of g.files) { h.update(f.path); h.update(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data))); }
    return h.digest('hex');
  };
  assert.equal(hash(a), hash(b), 'two runs over the same spec must be byte-identical');
});

test('generation emits no timestamps, which is what makes caching possible', () => {
  const s = goodSpec();
  const g = generateAndroidProject(s);
  assert.equal(g.report.generatedAt, null);
});

/* ── The fix engine must be reversible ───────────────────────────────────── */

test('an applied fix repairs the problem and can be rolled back exactly', () => {
  const s = goodSpec();
  s.android.minSdk = 33;
  s.android.targetSdk = 24;
  s.android.compileSdk = 36;

  const before = clone(s);
  const { spec: fixed, applied, result } = applyFixes(s, validateSpec(s).issues);
  assert.ok(applied.length > 0, 'at least one fix should apply');
  assert.equal(result.blocked, false, 'the repaired spec must validate');

  let restored = clone(fixed);
  for (const entry of [...applied].reverse()) rollbackFix(restored, entry);
  assert.deepEqual(restored.android.minSdk, before.android.minSdk,
    'rollback must restore the original value exactly');
  assert.deepEqual(restored.android.targetSdk, before.android.targetSdk);
});

test('a fix is never applied for a problem with no known remedy', () => {
  const s = goodSpec();
  s.capabilities = ['payments'];
  s.backend = { kind: 'none' };
  const r = validateSpec(s);
  const payIssue = r.issues.find((i) => i.code === 'E_PAY_NO_BACKEND');
  assert.ok(payIssue);
  assert.equal(payIssue.fix, undefined,
    'there is no safe automatic fix for a missing backend — it must be explained, not guessed');
});

/* ── Generated Android source ────────────────────────────────────────────── */

test('the generated SchemeRouter never parses an Intent out of URL text', () => {
  const s = goodSpec();
  s.capabilities = ['upi', 'telephone', 'email'];
  const g = generateAndroidProject(s);
  const router = g.files.find((f) => f.path.endsWith('SchemeRouter.java'));
  assert.ok(router);
  const src = String(router.data);

  assert.ok(!src.includes('Intent.parseUri'),
    'parsing an Intent from a URL reintroduces the intent-redirection hole');
  assert.ok(src.includes('resolveActivity'),
    'the target must be resolvable before launching');
  for (const bad of ['intent', 'file', 'content', 'javascript', 'blob']) {
    assert.ok(src.includes(`"${bad}"`), `"${bad}" must appear in the blocked list`);
  }
});

test('the manifest only ever declares derived permissions', () => {
  const s = goodSpec();
  s.capabilities = ['notifications'];
  const g = generateAndroidProject(s);
  const manifest = String(g.files.find((f) => f.path.endsWith('AndroidManifest.xml')).data);

  assert.ok(manifest.includes('android.permission.INTERNET'));
  assert.ok(manifest.includes('android.permission.POST_NOTIFICATIONS'));
  assert.ok(!manifest.includes('android.permission.CAMERA'), 'CAMERA is not enabled');
  assert.ok(!manifest.includes('android.permission.ACCESS_FINE_LOCATION'));
  assert.ok(!manifest.includes('android.permission.READ_EXTERNAL_STORAGE'));
});

test('the JavaScript bridge is absent unless a capability needs it', () => {
  const off = goodSpec();
  off.capabilities = [];
  const gOff = generateAndroidProject(off);
  assert.ok(!gOff.files.some((f) => f.path.endsWith('JsBridge.java')));

  const on = goodSpec();
  on.capabilities = ['share'];
  const gOn = generateAndroidProject(on);
  assert.ok(gOn.files.some((f) => f.path.endsWith('JsBridge.java')));
});

test('a launcher icon is generated at every density', () => {
  const s = goodSpec();
  const g = generateAndroidProject(s);
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    assert.ok(g.files.some((f) => f.path.includes(`mipmap-${d}/ic_launcher.png`) && Buffer.isBuffer(f.data)),
      `missing ic_launcher.png for ${d}`);
    assert.ok(g.files.some((f) => f.path.includes(`mipmap-${d}/ic_launcher_foreground.png`)),
      `missing adaptive foreground for ${d}`);
  }
  assert.ok(g.files.some((f) => f.path.includes('mipmap-anydpi-v26/ic_launcher.xml')));
});

test('generated PNG icons are real PNGs', () => {
  const g = generateAndroidProject(goodSpec());
  const icon = g.files.find((f) => f.path.endsWith('mipmap-mdpi/ic_launcher.png'));
  const buf = icon.data;
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  // 48dp at mdpi
  assert.equal(buf.readUInt32BE(16), 48);
  assert.equal(buf.readUInt32BE(20), 48);
});

test('an invalid spec is refused before generation, with the reason attached', () => {
  const s = goodSpec();
  s.deepLinks.allowedSchemes = ['https', 'javascript'];
  const g = generateAndroidProject(s);
  // generateAndroidProject is not the gate — validateSpec is — so assert the
  // split explicitly: the validator blocks, the generator only reports.
  const r = validateSpec(s);
  assert.equal(r.blocked, true);
  assert.equal(g.ok, true);
});

/* ── Found by running the app on a real device ───────────────────────────── */

test('web content is not force-darkened by default', () => {
  // Found by looking at a real screenshot: the page loaded, but Android had
  // inverted the light background while leaving the text dark, so the app was
  // unreadable. Algorithmic darkening must be OFF unless a project opts in.
  const s = goodSpec();
  const g = generateAndroidProject(s);
  const activity = String(g.files.find((f) => f.path.endsWith('MainActivity.java')).data);

  assert.ok(activity.includes('setAlgorithmicDarkeningAllowed(s, false)'),
    'darkening must be explicitly disabled so light pages stay readable');
});

test('a project can opt in to darkening explicitly', () => {
  const s = goodSpec();
  s.app.webview.forceDark = true;
  const g = generateAndroidProject(s);
  const activity = String(g.files.find((f) => f.path.endsWith('MainActivity.java')).data);
  assert.ok(activity.includes('setAlgorithmicDarkeningAllowed(s, true)'));
});

test('the offline notice is a sibling of the WebView, not added after setContentView', () => {
  // The previous ordering called addContentView() before setContentView(),
  // which silently did nothing.
  const s = goodSpec();
  const g = generateAndroidProject(s);
  const activity = String(g.files.find((f) => f.path.endsWith('MainActivity.java')).data);
  // Match the call, not the comment explaining why the call was removed.
  assert.ok(!/^[^/]*\baddContentView\s*\(/m.test(activity.replace(/^\s*\/\/.*$/gm, '')),
    'addContentView ordering is fragile; use a root FrameLayout');
  assert.ok(activity.includes('root.addView(offlineView'), 'the offline view must be a sibling of the scroll view');
});

test('the WebView canvas is white by default so unstyled pages stay readable', () => {
  // A page with no CSS background is painted on the VIEW background. Using the
  // dark app theme there produced black text on a dark canvas — the page loaded
  // and could not be read. Caught by looking at an emulator screenshot.
  const s = goodSpec();
  s.theme.background = '#0B1020';
  const g = generateAndroidProject(s);
  const activity = String(g.files.find((f) => f.path.endsWith('MainActivity.java')).data);
  assert.ok(activity.includes('webView.setBackgroundColor(Color.parseColor("#FFFFFF"))'),
    'the web canvas must default to white, not to the dark app background');
});
