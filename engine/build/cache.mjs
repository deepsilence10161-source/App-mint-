/**
 * THE BUILD CACHE
 * ===============
 *
 * A directory of build results, each filed under the key of the inputs that
 * produced it.
 *
 * The whole design is arranged around one requirement: a hit must be proved
 * rather than assumed. Every stored artefact is hashed when it is put away and
 * re-hashed when it is fetched, and anything that does not match — a file that
 * has been truncated, a file that has gone missing, a manifest that has been
 * edited — is treated as a miss. Not a warning, not a "probably fine": a miss,
 * followed by a real build.
 *
 * That matters more than the time saved. A cache that hands back the wrong APK
 * is worse than no cache at all, because the app that gets tested is not the app
 * that was described, and every check downstream is then measuring the wrong
 * thing while reporting success.
 *
 * ── layout ──────────────────────────────────────────────────────────────────
 *
 *   build/.cache/
 *     index.json                     every entry, newest first
 *     <key16>/manifest.json          what was built, from what, and when
 *     <key16>/<artefacts>            the files themselves
 *     <key16>/.failed                present if this entry is known to be bad
 *
 * ── what is never done ──────────────────────────────────────────────────────
 *
 * No entry is ever overwritten in place. A build that fails leaves no entry at
 * all. An entry that fails verification is marked and left for inspection
 * rather than deleted, because the interesting question when this happens is
 * "what corrupted it", and deleting the evidence answers nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { buildKey, buildKeyParts, diffKeyParts, sha256 } from './key.mjs';

/*
 * Bumped when the set of files an entry holds changes. The version is checked
 * when an entry is read, so an entry written by an older version reads as "not
 * stored" rather than as a hit that is missing something the build now needs.
 *
 *   1  the APK alone
 *   2  the APK and BUILD-INFO.json — a build is the app and the description of
 *      what it was, and a later step reads that description
 */
export const CACHE_VERSION = 2;

/** The hash of a file on disk, or null if it is not there. */
export function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export class BuildCache {
  /**
   * @param {string} root  the directory to keep entries in
   * @param {object} opts  now: () => Date,  for tests that need fixed time
   */
  constructor(root, { now = () => new Date() } = {}) {
    this.root = path.resolve(root);
    this.now = now;
  }

  entryDir(key16) { return path.join(this.root, key16); }
  manifestPath(key16) { return path.join(this.entryDir(key16), 'manifest.json'); }
  indexPath() { return path.join(this.root, 'index.json'); }

  /* ── looking up ───────────────────────────────────────────────────────── */

  /**
   * Fetch the artefacts for a key, if they are all present and intact.
   *
   * Returns `{ hit, reason, manifest, artefacts }`. `hit` is true only after
   * every stored file has been re-read and re-hashed. When it is false, the
   * reason is one of: 'not-stored', 'corrupt', 'incomplete', 'quarantined' —
   * never a vague failure, because the caller has to be able to say what
   * happened.
   */
  get(key, { verify = true } = {}) {
    const key16 = typeof key === 'string' ? key : key.short;
    const full = typeof key === 'string' ? null : key.full;

    if (fs.existsSync(path.join(this.entryDir(key16), '.failed'))) {
      return { hit: false, reason: 'quarantined', key16, detail: this.failNote(key16) };
    }

    const manifest = this.readManifest(key16);
    if (!manifest) return { hit: false, reason: 'not-stored', key16 };

    // The short name is a label; the full hash is the identity. If a manifest
    // was somehow filed under a name that does not match its own key, that is a
    // fault worth catching rather than serving.
    if (full && manifest.key !== full) {
      return { hit: false, reason: 'corrupt', key16, detail: 'the manifest declares a different key' };
    }

    if (!verify) return { hit: true, reason: 'unverified', key16, manifest, artefacts: manifest.artefacts };

    const problems = [];
    for (const art of manifest.artefacts) {
      const file = path.join(this.entryDir(key16), art.name);
      const actual = hashFile(file);
      if (actual === null) problems.push(`${art.name} is missing`);
      else if (actual !== art.sha256) problems.push(`${art.name} has changed since it was stored`);
      else if (fs.statSync(file).size !== art.bytes) problems.push(`${art.name} is not the size it was stored at`);
    }

    if (problems.length) return { hit: false, reason: 'incomplete', key16, manifest, detail: problems.join('; ') };
    return { hit: true, reason: 'verified', key16, manifest, artefacts: manifest.artefacts };
  }

  readManifest(key16) {
    return this.inspectManifest(key16).manifest;
  }

  /**
   * The manifest, and why it could not be used.
   *
   * Kept separate from readManifest so a miss can say "stored by an older
   * version of the cache" instead of the misleading "none of these entries
   * records what it was built from" — a sentence that reads as corruption when
   * the truth is a format change, and would send someone hunting for a broken
   * file that does not exist.
   */
  inspectManifest(key16) {
    const file = this.manifestPath(key16);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { manifest: null, reason: fs.existsSync(file) ? 'unreadable' : 'absent' };
    }
    if (!raw || typeof raw !== 'object') return { manifest: null, reason: 'unreadable' };
    if (!Array.isArray(raw.artefacts)) return { manifest: null, reason: 'unreadable' };
    if (raw.cacheVersion !== CACHE_VERSION) {
      return { manifest: null, reason: 'old-format', foundVersion: raw.cacheVersion };
    }
    return { manifest: raw, reason: null };
  }

  failNote(key16) {
    try { return fs.readFileSync(path.join(this.entryDir(key16), '.failed'), 'utf8').trim(); } catch { return ''; }
  }

  /* ── filing a result away ─────────────────────────────────────────────── */

  /**
   * Store the artefacts of a completed build.
   *
   * Copies rather than moves, so a failure part way through leaves the caller's
   * files untouched, and writes the manifest last, so an entry without a
   * manifest is an incomplete entry rather than a corrupt one.
   */
  put(key, sourceFiles, meta = {}) {
    const key16 = key.short;
    const dir = this.entryDir(key16);
    fs.mkdirSync(dir, { recursive: true });

    const artefacts = [];
    for (const src of sourceFiles) {
      const name = path.basename(src);
      const dest = path.join(dir, name);
      fs.copyFileSync(src, dest);
      artefacts.push({ name, sha256: hashFile(dest), bytes: fs.statSync(dest).size, source: src });
    }

    const manifest = {
      cacheVersion: CACHE_VERSION,
      key: key.full,
      keyShort: key16,
      parts: key.parts,
      buildType: key.parts.buildType,
      artefacts,
      builtAt: this.now().toISOString(),
      storedAt: this.now().toISOString(),
      ...meta,
    };
    fs.writeFileSync(this.manifestPath(key16), JSON.stringify(manifest, null, 2) + '\n');
    this.updateIndex(key16, manifest);
    return manifest;
  }

  /**
   * Mark an entry as unusable, with the reason, and leave it in place.
   *
   * Deleting it would tidy the directory and destroy the only evidence of what
   * went wrong, which is a poor trade when the diagnosis is the hard part.
   */
  quarantine(key16, reason) {
    const dir = this.entryDir(key16);
    if (!fs.existsSync(dir)) return;
    fs.writeFileSync(path.join(dir, '.failed'), `${this.now().toISOString()}  ${reason}\n`);
  }

  updateIndex(key16, manifest) {
    const index = this.readIndex();
    index.entries = index.entries.filter((e) => e.key16 !== key16);
    index.entries.unshift({
      key16,
      key: manifest.key,
      builtAt: manifest.builtAt,
      artefacts: manifest.artefacts.map((a) => ({ name: a.name, bytes: a.bytes })),
      spec: manifest.spec || null,
    });
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.indexPath(), JSON.stringify(index, null, 2) + '\n');
  }

  readIndex() {
    try {
      const i = JSON.parse(fs.readFileSync(this.indexPath(), 'utf8'));
      if (Array.isArray(i?.entries)) return i;
    } catch { /* fall through */ }
    return { cacheVersion: CACHE_VERSION, entries: [] };
  }

  /* ── explaining a miss ────────────────────────────────────────────────── */

  /**
   * Why is this build not in the cache?
   *
   * The answer is more useful than the fact. It compares this key against every
   * entry that shares the same specification, and reports which part moved —
   * the generators, the toolchain, the build type — so a person can tell the
   * difference between "I changed my app" and "the generator was updated".
   */
  explain(key, { limit = 5 } = {}) {
    const index = this.readIndex();
    if (!index.entries.length) {
      return { reason: 'empty', message: 'Nothing has been built in this workspace yet.' };
    }

    const inspected = index.entries.map((e) => ({ entry: e, ...this.inspectManifest(e.key16) }));
    const withParts = inspected.filter((x) => x.manifest && x.manifest.parts);
    const oldFormat = inspected.filter((x) => x.reason === 'old-format');

    if (!withParts.length && oldFormat.length) {
      // A format change, stated as one. The rebuild that follows is expected
      // rather than a fault, and saying so keeps the message honest.
      const versions = [...new Set(oldFormat.map((x) => `v${x.foundVersion}`))].join(', ');
      return {
        reason: 'old-format',
        message: `${oldFormat.length === 1 ? 'The one entry was' : `All ${oldFormat.length} entries were`} stored by an older version of the cache (${versions}), which cannot be reused. The next build compiles and stores a current one.`,
      };
    }
    if (!withParts.length) {
      return { reason: 'no-comparable', message: `There ${index.entries.length === 1 ? 'is 1 entry' : `are ${index.entries.length} entries`}, but none records what it was built from.` };
    }

    // The build being asked about is in the cache. Saying so is the whole
    // answer, and it has to come first: the explanation below is written for a
    // miss, and given an exact match it produced "This app has been built
    // before, but  since." — a sentence with a hole where the reason goes.
    const exact = withParts.find((x) => x.entry.key === key.full);
    if (exact) {
      return {
        reason: 'exact',
        message: `This build is in the cache, stored ${exact.manifest.builtAt || 'at an unrecorded time'}. Nothing needs to be compiled.`,
        entry: exact.manifest,
      };
    }

    // Same specification, different everything else: the most informative case,
    // because it isolates what changed to the parts that are not the app.
    const sameSpec = withParts.filter((x) => x.manifest.parts.spec === key.parts.spec);
    if (sameSpec.length) {
      const newest = sameSpec[0];
      const changed = diffKeyParts(newest.manifest.parts, key.parts);
      if (!changed.length) {
        // The parts are equal but the entries are not, which means the keys
        // were derived from different sets of parts. Better to say that than to
        // print a half-finished sentence about nothing changing.
        return {
          reason: 'unexplained',
          message: 'An entry for this specification exists, but its key does not match. The next build compiles and stores a current one.',
          previous: newest.manifest,
        };
      }
      return {
        reason: 'inputs-changed',
        message: `This app has been built before, but ${changed.map((c) => c.why).join(' and ')} since.`,
        changed,
        previous: newest.manifest,
        others: sameSpec.length - 1,
      };
    }

    const closest = withParts.slice(0, limit);
    return {
      reason: 'different-app',
      message: `Nothing matches this specification. ${withParts.length === 1 ? 'The one entry' : `${withParts.length} entries`} stored ${withParts.length === 1 ? 'is' : 'are'} for other apps.`,
      nearest: closest.map((x) => ({ key16: x.entry.key16, builtAt: x.entry.builtAt, spec: x.entry.spec })),
    };
  }

  /* ── housekeeping ─────────────────────────────────────────────────────── */

  /**
   * Every entry, with whether it would still be a verified hit.
   *
   * The index stores both names, and this passes both: the short name is the
   * directory, the full hash is the identity inside the manifest. Passing only
   * the full hash here looked for a directory named after the full hash, found
   * nothing, and reported every healthy entry as "not-stored" — which is a
   * cache telling you it is empty while holding your builds.
   */
  list() {
    return this.readIndex().entries.map((e) => {
      const got = this.get({ full: e.key, short: e.key16 }, { verify: true });
      return { ...e, usable: got.hit, problem: got.hit ? null : got.reason, detail: got.detail || null };
    });
  }

  /**
   * Keep the most recent entries, drop the rest.
   *
   * Free and unlimited does not mean keeping every APK ever built on a disk
   * that has to hold them. Newest first, because the newest is the one most
   * likely to be wanted again.
   */
  prune({ keep = 20, dryRun = false } = {}) {
    const entries = this.readIndex().entries;
    const doomed = entries.slice(keep);
    if (dryRun) return { removed: doomed.map((e) => e.key16), freed: doomed.length, kept: Math.min(entries.length, keep) };

    for (const e of doomed) {
      try { fs.rmSync(this.entryDir(e.key16), { recursive: true, force: true }); } catch { /* keep going */ }
    }
    const index = this.readIndex();
    index.entries = index.entries.slice(0, keep);
    fs.writeFileSync(this.indexPath(), JSON.stringify(index, null, 2) + '\n');
    return { removed: doomed.map((e) => e.key16), freed: doomed.length, kept: index.entries.length };
  }

  /** How much disk the cache is using, in bytes. */
  size() {
    let total = 0, files = 0;
    const visit = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) visit(p);
        else { try { total += fs.statSync(p).size; files++; } catch { /* gone */ } }
      }
    };
    visit(this.root);
    return { bytes: total, files };
  }
}

/* ── the receipt ────────────────────────────────────────────────────────────
   A record of what a build actually did, written next to its output. This is
   what a report reads, and what stops a later reader having to guess whether a
   file was compiled just now or restored from a cache three weeks ago.       */

export function writeReceipt(dir, receipt) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'build-receipt.json');
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
  return file;
}

export function readReceipt(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'build-receipt.json'), 'utf8')); } catch { return null; }
}

/**
 * The receipt for a build that was just compiled.
 *
 * `source` is one of 'built' or 'cache'. It is never inferred: the caller knows
 * which happened, and the receipt states it, because a report that guesses
 * wrong about this is worse than a report that says nothing.
 */
export function builtReceipt({ key, artefacts, startedAt, finishedAt, toolchain, spec, note }) {
  return {
    outcome: 'built',
    source: 'built',
    key: key.full,
    keyShort: key.short,
    parts: key.parts,
    toolchain: toolchain || key.parts.toolchainValues,
    startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
    finishedAt: finishedAt instanceof Date ? finishedAt.toISOString() : finishedAt,
    durationMs: finishedAt && startedAt ? new Date(finishedAt) - new Date(startedAt) : null,
    artefacts: artefacts.map((f) => ({ name: path.basename(f), sha256: hashFile(f), bytes: fs.existsSync(f) ? fs.statSync(f).size : null })),
    spec: spec ? { appName: spec?.identity?.appName, packageName: spec?.identity?.packageName, mode: spec?.app?.mode } : null,
    note: note || '',
  };
}

/** The receipt for a build that was taken from the cache. */
export function cachedReceipt({ key, hit, startedAt, source, descriptionRegenerated = false }) {
  return {
    outcome: 'built',
    source: 'cache',
    cacheReason: hit.reason,
    key: key.full,
    keyShort: key.short,
    parts: key.parts,
    toolchain: key.parts.toolchainValues,
    startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    originalBuildAt: hit.manifest?.builtAt || null,
    artefacts: (hit.artefacts || []).map((a) => ({ name: a.name, sha256: a.sha256, bytes: a.bytes })),
    // Recorded because it explains a cache hit that took longer than a copy:
    // the app came from the cache and the description was produced again.
    descriptionRegenerated,
    note: descriptionRegenerated
      ? `Restored from the cache (${hit.reason}). Originally built ${hit.manifest?.builtAt || 'at an unrecorded time'}. The entry held no description of the build, so one was generated again.`
      : `Restored from the cache (${hit.reason}). Originally built ${hit.manifest?.builtAt || 'at an unrecorded time'}.`,
    restoredFrom: source || null,
  };
}

export { buildKey, buildKeyParts, diffKeyParts, sha256 };
