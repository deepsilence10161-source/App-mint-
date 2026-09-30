/**
 * THE BUILD CACHE
 * ===============
 *
 * Most of these tests are about one failure: a cache that reports a hit when it
 * should not. That is the only way a build cache can do real harm — it hands
 * back the wrong app, and every check downstream then measures the wrong thing
 * while reporting success. A cache that misses too often is merely slow.
 *
 * So the tests below spend their effort on the dishonest directions: a tampered
 * artefact, a missing one, a manifest that disagrees with itself, a key that
 * collides. Every one of them must produce a miss and a real build.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256, generatorDigest, buildKey, buildKeyParts, diffKeyParts } from '../../engine/keys/key.mjs';
import { BuildCache, builtReceipt, cachedReceipt, readReceipt, writeReceipt, hashFile } from '../../engine/keys/cache.mjs';
import { defaultSpec } from '../../engine/spec/spec.mjs';

/* ── helpers ────────────────────────────────────────────────────────────── */

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appmint-cache-'));
  return {
    dir,
    cache: new BuildCache(path.join(dir, 'cache')),
    /** A pretend APK with given contents. */
    fakeApk(name, contents) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, contents);
      return p;
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function specFor(name = 'Cache Test') {
  const s = defaultSpec();
  s.identity.appName = name;
  s.identity.packageName = 'com.mysite.' + name.toLowerCase().replace(/[^a-z]/g, '');
  return s;
}

/* ── the key ────────────────────────────────────────────────────────────── */

test('two specifications that differ only in key order are the same key', () => {
  // JSON.parse keeps insertion order, and the Studio writes whatever order the
  // editor created, so this is a real difference between two saved files.
  const a = { identity: { appName: 'X', packageName: 'com.a.b' }, android: { minSdk: 24 } };
  const b = { android: { minSdk: 24 }, identity: { packageName: 'com.a.b', appName: 'X' } };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(buildKey(a).full, buildKey(b).full);
});

test('array order is part of the app, and does change the key', () => {
  const a = { screens: ['Home', 'List'] };
  const b = { screens: ['List', 'Home'] };
  assert.notEqual(canonicalJson(a), canonicalJson(b));
  assert.notEqual(buildKey(a).full, buildKey(b).full);
});

test('the same specification always gives the same key', () => {
  const s = specFor();
  assert.equal(buildKey(s).full, buildKey(s).full);
});

test('every input that can change the output changes the key', () => {
  const base = specFor();

  const renamed = specFor();
  renamed.identity.appName = 'Something Else';

  const reSdk = JSON.parse(JSON.stringify(base));
  reSdk.android.minSdk = 33;

  const reCap = JSON.parse(JSON.stringify(base));
  reCap.capabilities = [...(reCap.capabilities || []), 'share'];

  const release = buildKey(base, { buildType: 'release' });

  for (const [what, variant] of [['the app name', renamed], ['the minimum SDK', reSdk], ['a capability', reCap]]) {
    assert.notEqual(buildKey(variant).full, buildKey(base).full, `changing ${what} must change the key`);
  }
  assert.notEqual(release.full, buildKey(base).full, 'a release build is not a debug build');
});

test('the toolchain is part of the key', () => {
  const s = specFor();
  const a = buildKey(s, { toolchain: { agp: '8.7.0', gradle: '8.9' } });
  const b = buildKey(s, { toolchain: { agp: '9.4.0', gradle: '9.6' } });
  assert.notEqual(a.full, b.full, 'a different build tool can produce a different app');
});

test('explaining a build that is cached says so, in a whole sentence', () => {
  // Given an exact match, explain() used to fall into the miss wording and
  // return "This app has been built before, but  since." — a sentence with a
  // hole in it, produced by joining an empty list of changes. A person reading
  // that learns nothing and assumes the tool is broken.
  const w = workspace();
  try {
    const spec = specFor();
    const key = buildKey(spec);
    const apk = w.fakeApk('native.apk', 'a previously built app');
    w.cache.put(key, [apk], { spec: { appName: spec.identity.appName } });

    const why = w.cache.explain(key);
    assert.equal(why.reason, 'exact');
    assert.ok(!/\bbut\s+since\b/.test(why.message), `a sentence with a hole: ${why.message}`);
    assert.ok(!/\s{2,}/.test(why.message.trim()), `doubled space in: ${why.message}`);
    assert.match(why.message, /in the cache/);
    assert.ok(why.entry, 'and it should hand back the entry it found');
  } finally { w.cleanup(); }
});

test('explaining a genuine miss names what changed', () => {
  const w = workspace();
  try {
    const spec = specFor();
    const apk = w.fakeApk('native.apk', 'the first build');
    w.cache.put(buildKey(spec), [apk], { spec: { appName: spec.identity.appName } });

    const changed = specFor();
    changed.identity.appName = 'Renamed After The Build';
    const why = w.cache.explain(buildKey(changed));

    assert.ok(['inputs-changed', 'different-app'].includes(why.reason), why.reason);
    assert.match(why.message, /\w/, 'the message must contain words');
    assert.ok(!/\s{2,}/.test(why.message), `doubled space in: ${why.message}`);
  } finally { w.cleanup(); }
});

test('a version that reaches the build changes the key', () => {
  // jdk is written into build.gradle as a source/target compatibility, so two
  // specifications that differ only in it produce different projects and must
  // not share a cache entry.
  const base = specFor();
  const other = specFor();
  other.build = { ...(other.build || {}), toolchain: { jdk: '21' } };
  assert.notEqual(
    buildKey(base).full, buildKey(other).full,
    'a toolchain version that is written into the project must change the key',
  );
});

test('how a toolchain profile is described does not change the key', () => {
  // name and label are for a person reading a specification. If they counted,
  // rewording a label would throw away every cached build for no reason.
  const plain = { agp: '8.13.2', gradle: '8.13', buildTools: '36.0.0', jdk: '17', maxCompileSdk: 36 };
  const described = { ...plain, name: 'modern', label: 'Modern — Play-compliant (compileSdk 36)' };
  assert.equal(
    buildKey(specFor(), { toolchain: plain }).full,
    buildKey(specFor(), { toolchain: described }).full,
    'a description of a profile is not part of what gets built',
  );
  assert.equal(
    buildKey(specFor(), { toolchain: plain }).parts.toolchainValues.label, undefined,
    'and it should not appear in the values the key records either',
  );
});

test('the key is the same wherever it is derived', () => {
  // The key answers "what does this build depend on", so it cannot depend on
  // anything about the machine asking — not the environment, not the clock.
  const spec = specFor();
  const first = buildKey(spec).full;
  const before = { ...process.env };
  process.env.JAVA_HOME = '/somewhere/else';
  process.env.ANDROID_HOME = '/another/place';
  try {
    assert.equal(buildKey(spec).full, first, 'the key moved with the environment');
    assert.equal(buildKey(spec).full, first, 'and it must not move between calls either');
  } finally {
    for (const k of ['JAVA_HOME', 'ANDROID_HOME']) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
  }
});

test('the generators are part of the key', () => {
  // Build a throwaway engine tree, change a generator's bytes, and watch the
  // digest move. If this did not happen, updating a generator would keep
  // serving APKs built by the old one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appmint-engine-'));
  try {
    fs.mkdirSync(path.join(dir, 'engine', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'engine', 'gen', 'android.mjs'), 'export const v = 1;\n');
    const before = generatorDigest(dir);

    fs.writeFileSync(path.join(dir, 'engine', 'gen', 'android.mjs'), 'export const v = 2;\n');
    const after = generatorDigest(dir);

    assert.equal(before.files, 1);
    assert.notEqual(before.digest, after.digest, 'a changed generator must change the digest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the build cache is not part of the digest, so it cannot invalidate itself', () => {
  /*
   * engine/keys/ decides whether to rebuild; it never decides what to build.
   * Including it made every improvement to the cache discard every cached
   * build, so the cache worked perfectly and could never save anything. This is
   * the boundary the digest is drawn at, and it is asserted rather than
   * assumed.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appmint-engine-'));
  try {
    fs.mkdirSync(path.join(dir, 'engine', 'gen'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'engine', 'build'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'engine', 'diagnose'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'engine', 'gen', 'android.mjs'), 'export const v = 1;\n');
    fs.writeFileSync(path.join(dir, 'engine', 'build', 'cache.mjs'), 'export const cache = 1;\n');
    fs.writeFileSync(path.join(dir, 'engine', 'cli.mjs'), 'console.log(1);\n');
    const before = generatorDigest(dir);

    fs.writeFileSync(path.join(dir, 'engine', 'build', 'cache.mjs'), 'export const cache = 2;\n');
    fs.writeFileSync(path.join(dir, 'engine', 'cli.mjs'), 'console.log(2);\n');
    const after = generatorDigest(dir);

    assert.equal(before.digest, after.digest,
      'changing the cache or the command line must not discard every cached build');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every directory that does put bytes into the app IS part of the digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appmint-engine-'));
  try {
    for (const d of ['gen', 'components', 'spec', 'capability']) {
      fs.mkdirSync(path.join(dir, 'engine', d), { recursive: true });
      fs.writeFileSync(path.join(dir, 'engine', d, 'x.mjs'), 'export const v = 1;\n');
    }
    const base = generatorDigest(dir).digest;
    for (const d of ['gen', 'components', 'spec', 'capability']) {
      fs.writeFileSync(path.join(dir, 'engine', d, 'x.mjs'), 'export const v = 2;\n');
      assert.notEqual(generatorDigest(dir).digest, base, `a change under engine/${d}/ must change the digest`);
      fs.writeFileSync(path.join(dir, 'engine', d, 'x.mjs'), 'export const v = 1;\n');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry from an older cache format explains itself as one', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'built by an older version')]);
    const manifestFile = w.cache.manifestPath(key.short);
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    m.cacheVersion = 1;
    fs.writeFileSync(manifestFile, JSON.stringify(m));

    const got = w.cache.get(key);
    assert.equal(got.hit, false, 'an entry from an older format is not a hit');
    const why = w.cache.explain(key);
    assert.equal(why.reason, 'old-format');
    assert.match(why.message, /older version of the cache/);
    assert.doesNotMatch(why.message, /records what it was built from/,
      'a format change must not be described as corruption');
  } finally { w.cleanup(); }
});

test('a miss can say which input changed', () => {
  const s = specFor();
  const before = buildKeyParts(s);
  const after = buildKeyParts({ ...s, android: { ...s.android, minSdk: 33 } });
  const changed = diffKeyParts(before, after);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].part, 'spec');

  const genChanged = diffKeyParts(before, { ...before, generator: 'something-else' });
  assert.ok(genChanged.some((c) => c.part === 'generator'), 'a generator change must be named as such');
});

/* ── storing and fetching ───────────────────────────────────────────────── */

test('a build that was stored comes back intact', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    const apk = w.fakeApk('app-debug.apk', 'PK\u0003\u0004 pretend this is an apk');
    w.cache.put(key, [apk], { spec: { appName: 'Cache Test' } });

    const got = w.cache.get(key);
    assert.equal(got.hit, true);
    assert.equal(got.reason, 'verified');
    assert.equal(got.manifest.key, key.full);
    assert.equal(got.artefacts.length, 1);
    assert.equal(got.artefacts[0].sha256, sha256('PK\u0003\u0004 pretend this is an apk'));
  } finally { w.cleanup(); }
});

test('a key that was never stored is a miss, not an error', () => {
  const w = workspace();
  try {
    const got = w.cache.get(buildKey(specFor('Never Built')));
    assert.equal(got.hit, false);
    assert.equal(got.reason, 'not-stored');
  } finally { w.cleanup(); }
});

test('an artefact that has been altered is refused, not served', () => {
  // This is the test that matters. A single flipped byte must not be handed
  // back as a successful build.
  const w = workspace();
  try {
    const key = buildKey(specFor());
    const apk = w.fakeApk('app-debug.apk', 'a genuine build');
    w.cache.put(key, [apk]);

    const stored = path.join(w.cache.entryDir(key.short), 'app-debug.apk');
    fs.writeFileSync(stored, 'a tampered build');

    const got = w.cache.get(key);
    assert.equal(got.hit, false, 'a changed file must never be a hit');
    assert.equal(got.reason, 'incomplete');
    assert.match(got.detail, /changed since it was stored/);
  } finally { w.cleanup(); }
});

test('an artefact that has gone missing is refused', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'contents')]);
    fs.rmSync(path.join(w.cache.entryDir(key.short), 'app-debug.apk'));

    const got = w.cache.get(key);
    assert.equal(got.hit, false);
    assert.match(got.detail, /missing/);
  } finally { w.cleanup(); }
});

test('an artefact of the wrong length is refused even if the hash somehow matched', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'contents')]);
    const manifestFile = w.cache.manifestPath(key.short);
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    m.artefacts[0].bytes = 999999;                    // a lie about the size
    fs.writeFileSync(manifestFile, JSON.stringify(m));

    const got = w.cache.get(key);
    assert.equal(got.hit, false);
    assert.match(got.detail, /not the size it was stored at/);
  } finally { w.cleanup(); }
});

test('a manifest that declares a different key is refused', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'contents')]);
    const manifestFile = w.cache.manifestPath(key.short);
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    m.key = 'a'.repeat(64);                           // filed under the wrong name
    fs.writeFileSync(manifestFile, JSON.stringify(m));

    const got = w.cache.get(key);
    assert.equal(got.hit, false);
    assert.equal(got.reason, 'corrupt');
  } finally { w.cleanup(); }
});

test('an unreadable manifest is a miss, not a crash', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'contents')]);
    fs.writeFileSync(w.cache.manifestPath(key.short), '{ this is not json');
    const got = w.cache.get(key);
    assert.equal(got.hit, false);
    assert.equal(got.reason, 'not-stored');
  } finally { w.cleanup(); }
});

test('calling get on a directory that does not exist yet is a miss', () => {
  // The first build in a fresh workspace lands here.
  const cache = new BuildCache(path.join(os.tmpdir(), 'appmint-nonexistent-' + Date.now()));
  const got = cache.get(buildKey(specFor()));
  assert.equal(got.hit, false);
  assert.equal(got.reason, 'not-stored');
});

test('an entry can be marked unusable, and stays marked', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'a build that was later found bad')]);
    assert.equal(w.cache.get(key).hit, true);

    w.cache.quarantine(key.short, 'the emulator refused to install it');
    const got = w.cache.get(key);
    assert.equal(got.hit, false);
    assert.equal(got.reason, 'quarantined');
    assert.match(got.detail, /refused to install/);

    // and the evidence is still there to look at
    assert.ok(fs.existsSync(path.join(w.cache.entryDir(key.short), 'app-debug.apk')));
  } finally { w.cleanup(); }
});

test('storing the same key twice does not duplicate it in the index', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'first')]);
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'second')]);
    const listed = w.cache.list();
    assert.equal(listed.length, 1, `expected one entry, found ${listed.length}`);
    // and the newest contents are the ones served
    const got = w.cache.get(key);
    const served = fs.readFileSync(path.join(w.cache.entryDir(key.short), 'app-debug.apk'), 'utf8');
    assert.equal(got.hit, true);
    assert.equal(served, 'second');
  } finally { w.cleanup(); }
});

test('listing a cache describes its entries as usable rather than as missing', () => {
  // The list used to pass the full hash where the directory name was expected,
  // so every healthy entry was reported as not-stored: a cache claiming to be
  // empty while holding the builds.
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'a real build')]);
    const listed = w.cache.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].usable, true, `entry reported as ${listed[0].problem}`);
    assert.equal(listed[0].problem, null);
    assert.equal(listed[0].key16, key.short);
    assert.equal(listed[0].key, key.full);
  } finally { w.cleanup(); }
});

test('listing still reports an entry that has genuinely gone bad', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'a real build')]);
    fs.writeFileSync(path.join(w.cache.entryDir(key.short), 'app-debug.apk'), 'ruined');
    const listed = w.cache.list();
    assert.equal(listed[0].usable, false);
    assert.equal(listed[0].problem, 'incomplete');
  } finally { w.cleanup(); }
});

test('different apps get different entries', () => {
  const w = workspace();
  try {
    const a = buildKey(specFor('First App'));
    const b = buildKey(specFor('Second App'));
    w.cache.put(a, [w.fakeApk('a.apk', 'app one')]);
    w.cache.put(b, [w.fakeApk('b.apk', 'app two')]);
    assert.equal(w.cache.list().length, 2);
    assert.equal(w.cache.get(a).manifest.artefacts[0].name, 'a.apk');
    assert.equal(w.cache.get(b).manifest.artefacts[0].name, 'b.apk');
  } finally { w.cleanup(); }
});

/* ── explaining ─────────────────────────────────────────────────────────── */

test('a miss says whether the app changed or the generator did', () => {
  const w = workspace();
  try {
    const s = specFor();
    const first = buildKey(s);
    w.cache.put(first, [w.fakeApk('app-debug.apk', 'the first build')]);

    // Same app, but the generator has moved on since.
    const afterGeneratorChange = buildKey(s, { engineDir: w.dir });
    const explanation = w.cache.explain(afterGeneratorChange);
    assert.equal(explanation.reason, 'inputs-changed');
    assert.match(explanation.message, /generator/i);
  } finally { w.cleanup(); }
});

test('a miss for an unfamiliar app says so without inventing a reason', () => {
  const w = workspace();
  try {
    w.cache.put(buildKey(specFor('Some Other App')), [w.fakeApk('x.apk', 'x')]);
    const explanation = w.cache.explain(buildKey(specFor('Never Seen Before')));
    assert.equal(explanation.reason, 'different-app');
    assert.match(explanation.message, /[Nn]othing matches this specification/);
  } finally { w.cleanup(); }
});

test('an empty cache explains itself as empty rather than as a mismatch', () => {
  const w = workspace();
  try {
    const e = w.cache.explain(buildKey(specFor()));
    assert.equal(e.reason, 'empty');
  } finally { w.cleanup(); }
});

/* ── housekeeping ───────────────────────────────────────────────────────── */

test('pruning keeps the newest entries and drops the rest', () => {
  const w = workspace();
  try {
    const keys = [];
    for (let i = 0; i < 5; i++) {
      const k = buildKey(specFor('App ' + i));
      keys.push(k);
      // now() moves forward so "newest" is well defined
      w.cache.now = () => new Date(Date.now() + i * 1000);
      w.cache.put(k, [w.fakeApk(`app${i}.apk`, 'build ' + i)]);
    }
    const result = w.cache.prune({ keep: 2 });
    assert.equal(result.freed, 3);
    assert.equal(w.cache.list().length, 2);

    // the newest survive
    assert.equal(w.cache.get(keys[4]).hit, true);
    assert.equal(w.cache.get(keys[3]).hit, true);
    assert.equal(w.cache.get(keys[0]).hit, false);
  } finally { w.cleanup(); }
});

test('a dry run of pruning removes nothing', () => {
  const w = workspace();
  try {
    for (let i = 0; i < 3; i++) w.cache.put(buildKey(specFor('App ' + i)), [w.fakeApk(`a${i}.apk`, 'x')]);
    const preview = w.cache.prune({ keep: 1, dryRun: true });
    assert.equal(preview.freed, 2);
    assert.equal(w.cache.list().length, 3, 'a dry run must not delete anything');
  } finally { w.cleanup(); }
});

test('the cache can report how much room it is taking', () => {
  const w = workspace();
  try {
    w.cache.put(buildKey(specFor()), [w.fakeApk('app-debug.apk', 'x'.repeat(1000))]);
    const size = w.cache.size();
    assert.ok(size.bytes > 1000, `expected more than the artefact alone, got ${size.bytes}`);
    assert.ok(size.files >= 2, 'the manifest counts too');
  } finally { w.cleanup(); }
});

test('a stored build carries the description of itself, not only the app', () => {
  /*
   * The first version cached the APK alone. A cached run then failed in a later
   * step with "Cannot find module ./build/out/BUILD-INFO.json" — the cache had
   * handed back the app without the record of what it was. Anything the build
   * produces belongs in the entry.
   */
  const w = workspace();
  try {
    const key = buildKey(specFor());
    const apk = w.fakeApk('app-debug.apk', 'the app');
    const info = w.fakeApk('BUILD-INFO.json', JSON.stringify({ architecture: 'native-screens', packageName: 'com.mysite.cachetest' }));

    w.cache.put(key, [apk, info], { spec: { appName: 'Cache Test' } });
    const hit = w.cache.get(key);

    assert.equal(hit.hit, true);
    assert.equal(hit.artefacts.length, 2, 'both the app and its description must be stored');
    const names = hit.artefacts.map((a) => a.name).sort();
    assert.deepEqual(names, ['BUILD-INFO.json', 'app-debug.apk']);
    // and both verify, so a corrupted description is caught like a corrupted app
    for (const a of hit.artefacts) assert.ok(a.sha256 && a.bytes > 0);
  } finally { w.cleanup(); }
});

test('a description that has gone bad is refused along with the app', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    const apk = w.fakeApk('app-debug.apk', 'the app');
    const info = w.fakeApk('BUILD-INFO.json', '{"architecture":"native-screens"}');
    w.cache.put(key, [apk, info]);

    fs.writeFileSync(path.join(w.cache.entryDir(key.short), 'BUILD-INFO.json'), '{"architecture":"webview"}');
    const got = w.cache.get(key);
    assert.equal(got.hit, false, 'a build whose description changed is not the build that was stored');
    assert.match(got.detail, /BUILD-INFO\.json has changed/);
  } finally { w.cleanup(); }
});

/* ── the receipt ────────────────────────────────────────────────────────── */

test('a receipt records which build produced the file, not merely that one did', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    const apk = w.fakeApk('app-debug.apk', 'a real build');
    const started = new Date(Date.now() - 42000);
    const receipt = builtReceipt({
      key, artefacts: [apk], startedAt: started, finishedAt: new Date(),
      spec: specFor(), note: 'compiled on the runner',
    });

    assert.equal(receipt.source, 'built');
    assert.equal(receipt.key, key.full);
    assert.equal(receipt.artefacts[0].sha256, hashFile(apk));
    assert.ok(receipt.durationMs >= 41000, `duration was ${receipt.durationMs}`);

    const file = writeReceipt(path.join(w.dir, 'out'), receipt);
    assert.deepEqual(readReceipt(path.join(w.dir, 'out')), receipt);
    assert.ok(fs.existsSync(file));
  } finally { w.cleanup(); }
});

test('a cached receipt says what it was restored from and when it was really built', () => {
  const w = workspace();
  try {
    const key = buildKey(specFor());
    w.cache.put(key, [w.fakeApk('app-debug.apk', 'built last week')], { spec: { appName: 'Cache Test' } });
    const hit = w.cache.get(key);

    const receipt = cachedReceipt({ key, hit, startedAt: new Date(), source: 'build/.cache' });
    assert.equal(receipt.source, 'cache');
    assert.equal(receipt.cacheReason, 'verified');
    assert.equal(receipt.durationMs, 0);
    assert.ok(receipt.originalBuildAt, 'the original build time must be carried through');
    assert.match(receipt.note, /Restored from the cache/);
    assert.deepEqual(receipt.artefacts[0].sha256, hit.artefacts[0].sha256);
  } finally { w.cleanup(); }
});

test('a receipt that was never written reads back as nothing, not as a guess', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appmint-receipt-'));
  try {
    assert.equal(readReceipt(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
