/**
 * RUN THE BUILD SCRIPT, DON'T JUST READ IT
 * ========================================
 *
 * The text checks in tool-scripts.test.mjs find functions that were never
 * defined. They cannot find a variable used outside the block that declared it —
 * and that is exactly the fault that reached CI:
 *
 *     ReferenceError: written is not defined
 *
 * in the cache-hit path of tools/build-apk.mjs. It had been tested by reading it
 * and by running the miss path, which does not touch that variable. The cache
 * worked; the code that reports the cache working did not.
 *
 * So these tests execute the script. The cache-hit path needs no compiler, no
 * network and no Android SDK — it copies files that are already there and stops
 * — which makes it cheap enough to run on every commit. The miss path is
 * exercised as far as it can be without a toolchain: far enough to prove that a
 * specification which cannot work is refused before anything is compiled.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BuildCache } from '../../engine/keys/cache.mjs';
import { buildKey } from '../../engine/keys/key.mjs';
import { defaultSpec } from '../../engine/spec/spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'build-apk.mjs');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appmint-build-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Run the build script and capture how it went. */
function runBuild(args, { expectFailure = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120000,
    });
    return { code: 0, out: stdout };
  } catch (err) {
    if (!expectFailure) {
      // Surfaced as a test failure with the output, which is what you need to
      // see when a script dies in a way no assertion anticipated.
      assert.fail(`the build script exited ${err.status}:\n${err.stdout || ''}\n${err.stderr || ''}`);
    }
    return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
}

/** A specification valid enough to build, written to a temporary file. */
function writeSpec(dir, name = 'Build Script Test') {
  const spec = defaultSpec();
  spec.identity.appName = name;
  spec.identity.packageName = 'com.mysite.buildscript';
  const file = path.join(dir, 'spec.json');
  fs.writeFileSync(file, JSON.stringify(spec, null, 2));
  return { file, spec };
}

test('the builder and the command line derive the same key, for every app', () => {
  /*
   * CI names its build cache with one of these and looks builds up with the
   * other. When they disagree the cache never hits, every run compiles from
   * nothing, and nothing anywhere reports a problem — a fault with no symptom
   * except a slow pipeline and a bill. They had already drifted apart: the
   * builder asked for a `.resolved` property that resolveToolchain() does not
   * return, fell back to four raw fields, and derived a different key from the
   * command line for the identical specification.
   */
  const apps = fs.readdirSync(path.join(ROOT, 'apps'))
    .filter((d) => fs.existsSync(path.join(ROOT, 'apps', d, 'spec.json')))
    .sort();
  assert.ok(apps.length >= 2, 'this test is only meaningful with the real app specifications');

  for (const app of apps) {
    const spec = path.join('apps', app, 'spec.json');
    const fromCli = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'engine', 'cli.mjs'), 'build-key', spec, '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
    })).key;
    const fromBuilder = JSON.parse(execFileSync(process.execPath, [SCRIPT, spec, '--key-only', '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
    })).key;
    assert.equal(fromBuilder, fromCli, `the two must agree for ${app}, or the cache key names nothing`);
  }
});

test('the cache-hit path runs, and restores the app and its description', () => {
  // The fault this exists for was a ReferenceError in this path, reached only
  // when an entry was found. Reading the code did not catch it and neither did
  // running the path where nothing is found.
  const w = scratch();
  try {
    const { file, spec } = writeSpec(w.dir);
    const key = buildKey(spec);

    // Seed the cache exactly as a previous build would have.
    const cacheDir = path.join(w.dir, 'cache');
    const cache = new BuildCache(cacheDir);
    const apk = path.join(w.dir, 'app-debug.apk');
    const info = path.join(w.dir, 'BUILD-INFO.json');
    fs.writeFileSync(apk, 'PK\u0003\u0004 a stand-in for a real apk, comfortably over the size floor');
    fs.writeFileSync(info, JSON.stringify({ packageName: spec.identity.packageName, architecture: 'webview' }));
    cache.put(key, [apk, info], { spec: { appName: spec.identity.appName } });

    const outApk = path.join(w.dir, 'out', 'app.apk');
    const projectDir = path.join(w.dir, 'project');
    const result = runBuild([file, '--out', outApk, '--project', projectDir, '--cache', cacheDir]);

    assert.match(result.out, /From the cache — verified/, 'the script should say where the APK came from');
    assert.match(result.out, /compiler\s+not run/, 'and that nothing was compiled');
    assert.ok(fs.existsSync(outApk), 'the APK should have been written');
    assert.ok(fs.existsSync(path.join(projectDir, 'BUILD-INFO.json')),
      'the description must be restored too — a later step reads it, and a run without it dies with "Cannot find module"');
    assert.ok(fs.existsSync(outApk + '.receipt.json'), 'the receipt should be written beside the artefact');
    assert.ok(fs.existsSync(path.join(projectDir, 'build-receipt.json')), 'and in the project directory');

    const receipt = JSON.parse(fs.readFileSync(path.join(projectDir, 'build-receipt.json'), 'utf8'));
    assert.equal(receipt.source, 'cache');
    assert.equal(receipt.keyShort, key.short);
    assert.ok(receipt.originalBuildAt, 'a restored build must say when it was really built');
    assert.equal(receipt.descriptionRegenerated, false,
      'a complete entry needs no regeneration, and saying it did would be misleading');
  } finally { w.done(); }
});

test('a hit never runs a compiler, even when one is available', () => {
  // If a hit silently fell through to compiling, every measurement of the cache
  // would be wrong while the output still looked right — the worst kind of
  // fault, because it would only show up as CI being slow.
  const w = scratch();
  try {
    const { file, spec } = writeSpec(w.dir, 'No Compile Test');
    const key = buildKey(spec);
    const cacheDir = path.join(w.dir, 'cache');
    const cache = new BuildCache(cacheDir);

    const apk = path.join(w.dir, 'app-debug.apk');
    fs.writeFileSync(apk, 'PK\u0003\u0004 stand-in');
    cache.put(key, [apk]);

    const result = runBuild([file, '--out', path.join(w.dir, 'out', 'app.apk'),
      '--project', path.join(w.dir, 'project'), '--cache', cacheDir]);

    assert.doesNotMatch(result.out, /BUILD SUCCESSFUL/, 'the compiler reported a build, so it ran');
    assert.doesNotMatch(result.out, /\[2\/3\] Compiling/, 'the compile step was reached');
    assert.match(result.out, /From the cache/);
  } finally { w.done(); }
});

test('an entry holding only the app still produces the description', () => {
  /*
   * The first version of the cache stored the APK and nothing else. Those
   * entries are read as complete hits — the app in them is verified — but the
   * description is missing, and a later step dies with "Cannot find module
   * ./build/out/BUILD-INFO.json" if nothing puts it back. So a hit without one
   * regenerates it: generation is deterministic, takes about a second, and
   * cannot disagree with the cached app because the key covers the generators.
   *
   * There is a deliberate second line of defence in the copy as well, comparing
   * the bytes that landed against the bytes stored. It is not tested here
   * because the cache verifies size and hash on read and refuses first, which
   * makes the copy check unreachable without failing the disk underneath it.
   * Saying that plainly is better than a test that passes for another reason.
   */
  const w = scratch();
  try {
    const { file, spec } = writeSpec(w.dir, 'Older Entry Test');
    const key = buildKey(spec);
    const cacheDir = path.join(w.dir, 'cache');
    const cache = new BuildCache(cacheDir);

    const apk = path.join(w.dir, 'app-debug.apk');
    fs.writeFileSync(apk, 'PK\u0003\u0004 a stand-in for a real apk');
    cache.put(key, [apk]);   // the app alone, as the first version stored it

    const projectDir = path.join(w.dir, 'project');
    const result = runBuild([file, '--out', path.join(w.dir, 'out', 'app.apk'),
      '--project', projectDir, '--cache', cacheDir]);

    assert.match(result.out, /From the cache — verified/);
    assert.ok(fs.existsSync(path.join(projectDir, 'BUILD-INFO.json')),
      'a hit that carries no description must regenerate one');
    assert.match(result.out, /description generated again/,
      'the work it did instead of compiling must be stated, not hidden behind "nothing changed"');
    assert.doesNotMatch(result.out, /BUILD SUCCESSFUL/, 'no compiler should have run');

    const receipt = JSON.parse(fs.readFileSync(path.join(projectDir, 'build-receipt.json'), 'utf8'));
    assert.equal(receipt.descriptionRegenerated, true, 'the receipt must carry the same fact as the log');
  } finally { w.done(); }
});

test('a specification that cannot work is refused before anything is compiled', () => {
  // The validator stands in front of the compiler on purpose: a build of
  // something impossible wastes minutes and fails somewhere unhelpful.
  const w = scratch();
  try {
    const { file, spec } = writeSpec(w.dir, 'Impossible Test');
    spec.android.minSdk = 36;
    spec.android.targetSdk = 26;                 // no device could run this
    fs.writeFileSync(file, JSON.stringify(spec, null, 2));

    const result = runBuild([file, '--out', path.join(w.dir, 'out', 'app.apk'),
      '--project', path.join(w.dir, 'project'), '--cache', path.join(w.dir, 'cache')], { expectFailure: true });

    assert.notEqual(result.code, 0);
    assert.match(result.out, /blocking problem/);
    assert.doesNotMatch(result.out, /Compiling/, 'nothing should have been compiled');
    assert.ok(!fs.existsSync(path.join(w.dir, 'cache')),
      'a refused build must not leave anything in the cache');
  } finally { w.done(); }
});

test('a build that is not cached says so, and says why', () => {
  const w = scratch();
  try {
    // An empty cache: the script will try to compile, which is not available
    // here, so it fails — but the reason it gives must be about the cache and
    // the compiler, not a crash.
    const { file } = writeSpec(w.dir, 'Cold Cache Test');
    const result = runBuild([file, '--out', path.join(w.dir, 'out', 'app.apk'),
      '--project', path.join(w.dir, 'project'), '--cache', path.join(w.dir, 'cache')], { expectFailure: true });

    assert.match(result.out, /Cache miss \(not-stored\)/, 'a cold cache must be reported as a miss');
    assert.match(result.out, /Nothing has been built in this workspace yet/,
      'and explained, not merely announced');
    assert.doesNotMatch(result.out, /From the cache/, 'nothing was there to restore');
  } finally { w.done(); }
});
