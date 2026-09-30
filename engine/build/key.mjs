/**
 * THE BUILD KEY
 * =============
 *
 * One question underlies every build cache ever written: are these inputs the
 * same as the ones I built before? This file answers it, and nothing else.
 *
 * The key is a SHA-256 over exactly four things:
 *
 *   1. The specification  — what the app should be.
 *   2. The generators     — the code that turns that into an Android project.
 *   3. The toolchain      — the Android Gradle Plugin, Gradle and SDK versions
 *                           the project will be compiled with.
 *   4. The build type     — debug or release. They produce different files.
 *
 * Leaving any of the four out would produce a key that matches when the output
 * would not, which is the one failure mode a cache must never have. Leaving
 * something in unnecessarily only causes a rebuild that could have been
 * avoided: a miss costs time, a false hit ships the wrong app. The rules below
 * are therefore biased towards including things.
 *
 * ── what a hit does and does not claim ──────────────────────────────────────
 *
 * A hit means: an artefact exists that was produced by building this key, and
 * it is the same bytes now as when it was stored.
 *
 * It does NOT mean the build is reproducible. Android's own build tool stamps
 * timestamps and archive ordering into its output, so building the same inputs
 * twice produces two files that behave identically but do not hash identically.
 * The cache reuses the result of a build that provably happened, and the
 * manifest records which build that was. It never claims to have rebuilt
 * anything, and it never pretends the byte-for-byte output would match.
 *
 * Being precise about that distinction is the difference between a cache you
 * can trust and one that quietly lies to you about what it did.
 */

import crypto from 'node:crypto';
import { resolveToolchain } from '../spec/toolchain.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── canonical JSON ─────────────────────────────────────────────────────────
   Two specifications that differ only in the order their keys happen to be
   written are the same specification, and must produce the same key. JSON.parse
   preserves insertion order, and the Studio writes whatever order the editor
   happened to create — so a specification saved, reloaded and saved again can
   legally have its keys in a different order with no change in meaning.

   Without canonicalisation, that would be a cache miss on every reopen.        */

/**
 * JSON with object keys in a fixed order at every depth.
 *
 * Arrays keep their order, because the order of screens or components is part
 * of what the app is. Objects are sorted, because the order of named fields is
 * not part of anything except the file's own history.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/** The SHA-256 of a string, hex, full length. */
export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/* ── the generators ─────────────────────────────────────────────────────── */

/**
 * A digest of the files that decide what gets generated.
 *
 * The line is drawn at "does this file put bytes into the app?" and everything
 * that does is included:
 *
 *   engine/gen/          the generators themselves
 *   engine/components/   what a component or an action becomes in Java
 *   engine/spec/         the version numbers and defaults written into the project
 *   engine/capability/   which permissions end up in the manifest
 *
 * Two directories are left out, and the reasoning matters because both are
 * cases where the conservative answer is the wrong one:
 *
 *   engine/cli.mjs       a front end; it generates nothing
 *   engine/build/        the cache and the key. These decide whether to rebuild,
 *                        never what to build.
 *
 * Including the build machinery would have made the cache invalidate itself:
 * every improvement to caching would discard every cached build, so the cache
 * would work perfectly and never once save anything. A digest that covers too
 * much is not "safe", it is a cache that costs more than it returns.
 *
 * The boundary is checked rather than assumed — there are tests that change a
 * generator and require the digest to move, and change the cache itself and
 * require it not to.
 */
const GENERATOR_DIRS = ['gen', 'components', 'spec', 'capability'];

export function generatorDigest(engineDir = ENGINE_DIR) {
  const files = [];
  for (const dir of GENERATOR_DIRS) walk(path.join(engineDir, 'engine', dir), files);
  const relevant = files.sort();

  const h = crypto.createHash('sha256');
  for (const file of relevant) {
    const rel = path.relative(engineDir, file);
    h.update(rel);                       // the name, so a rename counts
    h.update('\0');
    h.update(fs.readFileSync(file));     // the bytes
    h.update('\0');
  }
  return { digest: h.digest('hex'), files: relevant.length };
}

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
}

/* ── the key ────────────────────────────────────────────────────────────── */

/**
 * Everything the key is made of, kept as named pieces rather than one opaque
 * hash, so a miss can be explained ("the generator changed") instead of only
 * announced ("not in the cache").
 */
/**
 * The toolchain values a build depends on.
 *
 * Resolved here rather than at each call site, because the two call sites had
 * already drifted apart: the builder asked resolveToolchain() for a `.resolved`
 * property that does not exist and quietly fell back to four raw fields, while
 * the command line fell back to the whole profile. Same specification, two keys,
 * and nothing to notice it by: the key is only ever compared with another key,
 * so a key that is consistently wrong looks exactly like a key that is right.
 * CI made it worse by naming the cache with one of them and looking builds up
 * with the other.
 *
 * `name` and `label` are dropped because they are how the profile is described
 * to a person, not what gets built: they never reach a generated file. Keeping
 * them would mean that rewording a description threw away every cached build.
 * Everything else is kept, deliberately including fields this key does not use
 * yet — over-covering costs a rebuild, under-covering ships a stale app, and
 * only one of those two is recoverable.
 */
/** Drop the fields that describe a profile to a person rather than build it. */
function withoutPresentation(values) {
  const { label, name, ...rest } = values || {};
  return rest;
}

export function toolchainFor(spec) {
  let resolved;
  try {
    resolved = resolveToolchain(spec);
  } catch {
    // A specification broken enough to defeat resolution still gets a key, and
    // it is a key derived from what was written rather than a guess.
    resolved = spec?.build?.toolchain || { compileSdk: spec?.android?.compileSdk ?? null };
  }
  return withoutPresentation(resolved);
}

export function buildKeyParts(spec, { buildType = 'debug', toolchain = null, engineDir = ENGINE_DIR } = {}) {
  const gen = generatorDigest(engineDir);
  // An explicit override goes through the same rule, so the key covers the same
  // things whether the toolchain came from the specification or was handed in.
  const resolved = withoutPresentation(toolchain || toolchainFor(spec));

  return {
    spec: sha256(canonicalJson(spec)),
    generator: gen.digest,
    generatorFiles: gen.files,
    toolchain: sha256(canonicalJson(resolved)),
    toolchainValues: resolved,
    buildType,
  };
}

/**
 * The build key for a specification.
 *
 * Returns the short form for labelling (what a person sees in a filenames and
 * cache keys) and the full hash, which is what the manifest stores. The short
 * form is only ever a label: two different keys sharing the first 16 hex
 * characters of a SHA-256 is possible, if astronomically unlikely, and the
 * manifest always stores and compares the full value.
 */
export function buildKey(spec, options = {}) {
  const parts = buildKeyParts(spec, options);
  const full = sha256(canonicalJson(parts));
  return {
    full,
    short: full.slice(0, 16),
    parts,
  };
}

/**
 * Which part of the key differs from another key's parts.
 *
 * This is what turns "cache miss" into something a person can act on. Without
 * it, the only honest thing a cache can say is "not found", which is useless
 * when what you want to know is why not.
 */
export function diffKeyParts(a, b) {
  const changed = [];
  if (a.spec !== b.spec) changed.push({ part: 'spec', why: 'the specification changed' });
  if (a.generator !== b.generator) changed.push({ part: 'generator', why: 'the app generators changed' });
  if (a.toolchain !== b.toolchain) changed.push({ part: 'toolchain', why: 'the build toolchain changed' });
  if (a.buildType !== b.buildType) changed.push({ part: 'buildType', why: `the build type changed (${a.buildType} → ${b.buildType})` });
  return changed;
}
