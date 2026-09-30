#!/usr/bin/env node
/**
 * BUILD ONE APP, USING THE CACHE WHEN IT PROVABLY CAN
 * ===================================================
 *
 *   node tools/build-apk.mjs apps/native-demo/spec.json --out build/apk/native.apk
 *
 * What it does, in order:
 *
 *   1. Work out the build key for this specification — the specification, the
 *      generators, the toolchain and the build type, hashed together.
 *   2. Ask the cache for that key. A hit is only accepted after every stored
 *      file has been re-hashed and compared.
 *   3. On a verified hit: copy the artefact out, write a receipt that says it
 *      came from the cache, and stop. Android's build tool is not run at all.
 *   4. On a miss: generate the project, compile it, verify the APK exists and
 *      is not empty, file it under the key, and write a receipt that says it
 *      was built.
 *
 * ── the rule this file exists to obey ───────────────────────────────────────
 *
 * It never reports success it did not observe. Every exit path either produces
 * a file whose size and hash it has just checked, or prints what failed and
 * exits non-zero. There is no path that writes "build successful" because a
 * previous step looked like it worked.
 *
 * The distinction between "built" and "restored" is carried all the way into
 * the receipt, because they are different facts and a report that blurs them is
 * a report you cannot audit.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { BuildCache, builtReceipt, cachedReceipt, writeReceipt } from '../engine/keys/cache.mjs';
import { buildKey } from '../engine/keys/key.mjs';
import { validateSpec, defaultSpec } from '../engine/spec/spec.mjs';
import { generateAndroidProject } from '../engine/gen/android.mjs';

/* ── arguments ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[argv[i].slice(2)] = next; i++; }
    else flags[argv[i].slice(2)] = true;
  } else positional.push(argv[i]);
}

const specFile = positional[0];
if (!specFile) {
  console.error('Usage: build-apk.mjs <spec.json> --out <apk path> [--cache <dir>] [--type debug|release] [--no-cache] [--keep-project]');
  process.exit(2);
}

const outApk = flags.out || 'build/apk/app.apk';
const cacheDir = flags.cache || process.env.APPMINT_CACHE || 'build/.cache';
const buildType = flags.type || 'debug';
const projectDir = flags.project || path.join(path.dirname(outApk), `${path.basename(specFile, '.json')}-project`);
const useCache = !flags['no-cache'];

const log = (...a) => console.log('  ' + a.join(' '));
const step = (n, total, msg) => console.log(`\n  [${n}/${total}] ${msg}`);

/* ── read the specification ─────────────────────────────────────────────── */

const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const name = spec?.identity?.appName || path.basename(specFile);

// The same key the CLI prints, so a person can check the two agree without
// having to trust either of them. The resolution lives in the key module so
// there is exactly one answer to "what does this build depend on".
const key = buildKey(spec, { buildType });

// --key-only answers one question and stops: which key would this build use?
// CI names its cache with this, and names it with the builder's answer rather
// than a second opinion, so the name and the lookup cannot disagree.
if (flags['key-only']) {
  if (flags.json) console.log(JSON.stringify({ spec: specFile, buildType, key: key.full, short: key.short, parts: key.parts }, null, 2));
  else console.log(key.short);
  process.exit(0);
}

console.log(`\n  ${name}`);
console.log(`  specification  ${specFile}`);
console.log(`  build key      ${key.short}`);

/* ── 1. the cache ───────────────────────────────────────────────────────── */

const cache = new BuildCache(cacheDir);
const startedAt = new Date();
let source = 'built';

if (useCache) {
  const hit = cache.get(key, { verify: true });
  if (hit.hit) {
    // Everything the build produced is restored, not only the APK. A build
    // leaves behind the description of what it was — BUILD-INFO.json — and the
    // steps after this one read it. Restoring the APK alone left that file
    // missing, so a cached run failed in a later step with "Cannot find module
    // ./build/out/BUILD-INFO.json": the cache had returned the app without the
    // paperwork that describes it.
    fs.mkdirSync(path.dirname(outApk), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    const art = hit.artefacts.find((a) => a.name.endsWith('.apk')) || hit.artefacts[0];
    // Declared out here because the copy size is reported after the loop.
    let written = 0;
    for (const a of hit.artefacts) {
      const from = path.join(cache.entryDir(hit.key16), a.name);
      if (a.name.endsWith('.apk')) {
        fs.copyFileSync(from, outApk);
        // Check the copy that was actually written, not the one that was read.
        written = fs.statSync(outApk).size;
        if (written !== a.bytes) {
          console.error(`\n  FAILED: the copied file is ${written} bytes, expected ${a.bytes}. The cache entry is not usable.\n`);
          cache.quarantine(hit.key16, `copy mismatch: expected ${a.bytes} bytes, wrote ${written}`);
          process.exit(1);
        }
      } else if (a.name === 'BUILD-INFO.json') {
        fs.copyFileSync(from, path.join(projectDir, a.name));
      }
    }

    // An entry stored before the description was cached alongside the app holds
    // only the APK. Generation is deterministic and takes about a second, and
    // doing it does not risk disagreeing with the cached APK: the entry was
    // filed under a key that covers the generators, so the same specification
    // and the same generators produce the same project.
    let descriptionRegenerated = false;
    if (!fs.existsSync(path.join(projectDir, 'BUILD-INFO.json'))) {
      // Nothing to restore, so produce it. If it cannot be produced, stop: every
      // step after this one expects the app and its description to arrive
      // together, and the CI run that taught us this died in a later step with
      // "Cannot find module ./build/out/BUILD-INFO.json" — a confusing place to
      // learn it. Failing here says what is missing and why.
      if (!regenerate()) {
        console.error(`\n  FAILED: this build was restored from the cache, but the project could not be generated, so there is no description of what was built.`);
        console.error(`  The app itself is intact at ${outApk}, but a build without its description breaks the steps that follow.`);
        console.error(`  Build key ${key.full}. Re-run after checking that the specification still validates.\n`);
        process.exit(1);
      }
      descriptionRegenerated = true;
    }

    const receipt = cachedReceipt({ key, hit, startedAt, source: cacheDir, descriptionRegenerated });
    writeReceipts(projectDir, outApk, receipt);

    console.log(`\n  From the cache — verified.`);
    log(`built      ${hit.manifest.builtAt}`);
    log(`file       ${outApk}  ${(written / 1024 / 1024).toFixed(1)} MB`);
    log(`sha256     ${art.sha256.slice(0, 16)}…`);
    log(`compiler   not run (nothing changed)`);
    if (descriptionRegenerated) log(`description generated again (the cached entry predates storing it)`);
    console.log('');
    process.exit(0);
  }

  const why = hit.reason === 'not-stored' ? cache.explain(key) : { message: hit.detail || 'the stored entry did not verify' };
  console.log(`\n  Cache miss (${hit.reason}): ${why.message}`);
  if (hit.key16) log(`entry      ${hit.key16}`);
  if (hit.detail) log(`detail     ${hit.detail}`);
  source = 'built';
}

/* ── 2. generate ────────────────────────────────────────────────────────── */

/** Write the generated project to disk. Used by the build, and by a cached
    run that has to fill in a description an older entry did not carry. */
function regenerate() {
  const webDir = path.join(path.dirname(specFile), 'web');
  const gen = generateAndroidProject(spec, { webDir: fs.existsSync(webDir) ? webDir : null });
  if (!gen.ok) return null;
  fs.rmSync(projectDir, { recursive: true, force: true });
  for (const f of gen.files) {
    const full = path.join(projectDir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.data);
  }
  fs.writeFileSync(path.join(projectDir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
  fs.writeFileSync(path.join(projectDir, 'BUILD-INFO.json'),
    JSON.stringify({ ...gen.report, contentHash: contentHashOf(gen.files) }, null, 2) + '\n');
  return gen;
}

step(1, 3, 'Generating the Android project');

// The validator stands between a specification and a compiler for a reason: a
// build of something that cannot work wastes minutes and produces a confusing
// error from deep inside another tool. We stop here and say why.
const validation = validateSpec(spec);
if (validation.blocked) {
  console.error(`\n  FAILED: this specification has ${validation.blocking.length} blocking problem(s), so it was not sent to the compiler.`);
  for (const i of validation.blocking) console.error(`    ${i.code}  ${i.message}`);
  console.error(`\n  Run:  node engine/cli.mjs validate ${specFile} --fix\n`);
  process.exit(1);
}

// A project may ship its own bundled pages beside its specification.
const webDir = path.join(path.dirname(specFile), 'web');
const gen = generateAndroidProject(spec, { webDir: fs.existsSync(webDir) ? webDir : null });
if (!gen.ok) {
  console.error('\n  FAILED: the generator refused this specification:');
  for (const e of gen.errors) console.error(`    ${e}`);
  console.error('');
  process.exit(1);
}

// Written exactly as the generate command writes them, so the project on disk
// is the same project whether a person ran the CLI or this script did.
fs.rmSync(projectDir, { recursive: true, force: true });
for (const f of gen.files) {
  const full = path.join(projectDir, f.path);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, f.data);
}
fs.writeFileSync(path.join(projectDir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
fs.writeFileSync(path.join(projectDir, 'BUILD-INFO.json'),
  JSON.stringify({ ...gen.report, contentHash: contentHashOf(gen.files) }, null, 2) + '\n');

const androidDir = path.join(projectDir, 'android');
if (!fs.existsSync(androidDir)) {
  console.error(`\n  FAILED: the generator produced ${gen.files.length} files but no Android project at ${androidDir}\n`);
  process.exit(1);
}
log(`project    ${androidDir}  (${gen.files.length} files)`);

/* ── 3. compile ─────────────────────────────────────────────────────────── */

step(2, 3, `Compiling (${buildType})`);
const compileStart = new Date();
try {
  execFileSync('gradle', [`assemble${buildType[0].toUpperCase()}${buildType.slice(1)}`, '--console=plain', '--no-daemon'], {
    cwd: androidDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Size the compiler's heap to the machine rather than to the runner. A
      // fixed 2560 MB is right on a CI runner with 16 GB and fatal on a small
      // laptop with 2 GB, where the daemon is killed mid-build and the error
      // says only "the Gradle daemon disappeared unexpectedly". Setting it by
      // what is actually available turns a crash into a slower build.
      GRADLE_OPTS: process.env.GRADLE_OPTS || defaultGradleOpts(),
    },
  });
} catch (err) {
  // A real failure is reported as itself. It is never turned into a cache miss
  // or a partial success.
  console.error(`\n  FAILED: the compiler exited with an error for "${name}".`);
  console.error(`  Build key ${key.short}. The cache was not written, so the next attempt will really compile again.\n`);
  process.exit(1);
}
const compileEnd = new Date();

/* ── 4. find what was produced, and check it ────────────────────────────── */

step(3, 3, 'Checking the output');
const found = findApks(androidDir);
if (!found.length) {
  console.error(`\n  FAILED: the compiler reported success but produced no APK under ${androidDir}.\n`);
  process.exit(1);
}
const apk = found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
const size = fs.statSync(apk).size;
if (size < 4096) {
  // An APK smaller than a few kilobytes cannot contain a working Android app;
  // it is a placeholder or a truncated write, and treating it as success is
  // exactly the false success this project forbids.
  console.error(`\n  FAILED: the APK is only ${size} bytes, which is too small to be a real app.\n`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outApk), { recursive: true });
fs.copyFileSync(apk, outApk);
log(`apk        ${outApk}  ${(size / 1024 / 1024).toFixed(1)} MB`);
log(`compiled   ${((compileEnd - compileStart) / 1000).toFixed(0)}s`);

/* ── 5. file it away ────────────────────────────────────────────────────── */

if (useCache) {
  try {
    // BUILD-INFO.json is stored with the APK because it is part of the same
    // result: a build is the app and the description of what it was.
    const toStore = [outApk];
    const buildInfo = path.join(projectDir, 'BUILD-INFO.json');
    if (fs.existsSync(buildInfo)) toStore.push(buildInfo);

    const manifest = cache.put(key, toStore, {
      spec: { appName: name, packageName: spec?.identity?.packageName, mode: spec?.app?.mode },
      compileMs: compileEnd - compileStart,
    });
    cache.prune({ keep: Number(process.env.APPMINT_CACHE_KEEP || 20) });
    log(`cache      stored as ${manifest.keyShort}`);
  } catch (err) {
    // A cache that cannot be written is a slower build, not a failed one.
    log(`cache      could not be written (${err.message}) — the build itself succeeded`);
  }
}

const receipt = builtReceipt({
  key, artefacts: [outApk], startedAt, finishedAt: compileEnd,
  toolchain: gen?.meta?.toolchain || toolchain, spec,
  note: `Compiled from ${specFile}.`,
});
writeReceipts(projectDir, outApk, receipt);

console.log(`\n  Built. ${key.short}\n`);

/* ── helpers ────────────────────────────────────────────────────────────── */

/** The same content hash the generate command reports, computed the same way. */
function contentHashOf(files) {
  const hashes = files.map((f) => `${crypto.createHash('sha256').update(f.path).digest('hex').slice(0, 8)} ${f.path}`).sort();
  const h = crypto.createHash('sha256');
  for (const x of hashes) h.update(x);
  return h.digest('hex');
}

/* ── helpers ────────────────────────────────────────────────────────────── */

/**
 * Write a receipt in two places.
 *
 * Beside the APK under a name derived from it, which is what someone finds when
 * they go looking at the artefact; and in the project directory under the plain
 * name, which is what a report reads when it knows only the project.
 *
 * Two apps sharing an output directory would otherwise overwrite each other's
 * receipts, which is how a report ends up confidently describing the wrong
 * build. Failing to write a receipt is not fatal to the build itself: the APK is
 * the product, the receipt is the record of it.
 */
function writeReceipts(dir, apkPath, receipt) {
  try {
    fs.writeFileSync(apkPath + '.receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  } catch { /* the record is worth having, but not worth failing a build over */ }
  try {
    writeReceipt(dir, receipt);
  } catch { /* same */ }
}

/** A heap the machine can actually hold, written into GRADLE_OPTS. */
function defaultGradleOpts() {
  let totalMb = null;
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = /MemTotal:\s+(\d+) kB/.exec(info);
    if (kb) totalMb = Math.floor(Number(kb[1]) / 1024);
  } catch { /* not linux, or unreadable — fall through to the runner default */ }

  if (!totalMb) return '-Dorg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m';

  // Leave the machine room to run everything else. Gradle is not the only
  // process here: the emulator, the browser and this script all need memory.
  const heap = Math.max(512, Math.min(2560, Math.floor(totalMb * 0.5)));
  const metaspace = Math.max(256, Math.min(768, Math.floor(heap / 4)));
  return `-Dorg.gradle.jvmargs=-Xmx${heap}m -XX:MaxMetaspaceSize=${metaspace}m`;
}

function findApks(dir) {
  const out = [];
  const visit = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.apk')) out.push(p);
    }
  };
  visit(dir);
  return out;
}
