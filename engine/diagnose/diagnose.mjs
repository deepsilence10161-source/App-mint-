/**
 * THE DIAGNOSTIC ENGINE
 * =====================
 * Two responsibilities, kept separate on purpose:
 *
 *  1. match()   — read a build log and say exactly what went wrong.
 *  2. repair()  — apply only the repairs that are known to be safe, and write
 *                 down how to undo each one.
 *
 * If a repair is not proven safe it is not applied. The report still explains
 * the failure: what happened, why, which system is affected, and what to do.
 * Nothing is ever changed at random to "see if it helps".
 */
import { KNOWN_ERRORS, CATEGORIES } from './known-errors.mjs';

/* Log lines that are noise; they contain the words "error" or "warning" but
   carry no meaning for diagnosis. Filtering these first stops the engine from
   latching onto the wrong line. */
const NOISE = [
  /^\s*at [\w.$]+\(/,
  /Download(ing)? https?:\/\//i,
  /^\s*(Note|warning): .*deprecat/i,
  /^\s*C\+\+ build/i,
  /^\s*>\s*Task :/,
  /^\s*(Starting|Finished) a Gradle Daemon/i,
  /^\s*CONFIGURE|^\s*EXECUTE/i,
  /^\s*\d+ actionable tasks/i,
  /Consider enabling configuration cache/i,
];

/** Strip absolute paths and machine names so a report can be shared safely. */
export function redact(text) {
  return String(text)
    .replace(/\/(?:home|Users|root|Users\/runner|tmp)\/[^\s:'"]*/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s:'"]+/g, '<path>')
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '<github-token>')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '<github-token>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<jwt>')
    .replace(/(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b(?![\w-])/g, (m) => (/^[0-9a-f]{40}$/i.test(m) ? m : '<redacted>'));
}

/**
 * Read a log and return every known failure it contains, worst first.
 * Deterministic: the same log always produces the same list in the same order.
 */
export function match(logText, { spec = null } = {}) {
  const lines = String(logText).split(/\r?\n/);
  const findings = [];
  const seen = new Set();

  for (const line of lines) {
    if (!line.trim()) continue;
    if (NOISE.some((n) => n.test(line))) continue;

    for (const entry of KNOWN_ERRORS) {
      if (seen.has(entry.id)) continue;
      const re = entry.match;
      // entries match on the whole line; the capture groups are used for detail
      if (!re(line)) continue;

      seen.add(entry.id);
      const m = line.match(entry.match) || [];
      findings.push({
        id: entry.id,
        category: entry.category,
        categoryLabel: (CATEGORIES[entry.category] || {}).label || entry.category,
        confidence: entry.confidence,
        cause: entry.cause,
        explanation: entry.explanation,
        evidence: redact(line.trim()).slice(0, 400),
        capture: m.slice(1).filter(Boolean),
        repairable: Boolean(entry.repair) && entry.confidence === 'high',
        repairDescription: entry.repair ? entry.repair.describe(m) : null,
        advice: entry.advice || null,
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.id.localeCompare(b.id));
  return { ok: findings.length > 0, findings, scanned: lines.length, knownIds: new Set(seen) };
}

/**
 * Turn matches into changes. Every change is recorded with its previous value,
 * so the whole set can be undone exactly.
 *
 * Returns { applied, skipped, reversed } — skipped is as important as applied:
 * it is the list of things the engine recognised but deliberately did not touch.
 */
export function repair(logText, spec, { allow = 'all' } = {}) {
  const { findings } = match(logText, { spec });
  const applied = [];
  const skipped = [];
  const next = structuredClone(spec);

  for (const f of findings) {
    const entry = KNOWN_ERRORS.find((e) => e.id === f.id);
    if (!entry) continue;

    if (!entry.repair) {
      skipped.push({ id: f.id, reason: 'no automatic repair — this needs a human decision', found: true });
      continue;
    }
    if (f.confidence !== 'high') {
      skipped.push({ id: f.id, reason: `confidence is ${f.confidence}; suggested but not applied` });
      continue;
    }
    if (allow !== 'all' && !allow.includes(f.id)) {
      skipped.push({ id: f.id, reason: 'not in the allowed repair list for this run' });
      continue;
    }

    const change = entry.repair.apply(f.capture, next);
    if (!change) {
      skipped.push({ id: f.id, reason: 'repair does not apply to this project as configured' });
      continue;
    }

    // remember exactly what was there before, so the change can be undone
    const segs = change.path.split('.');
    let cur = next;
    for (const s of segs.slice(0, -1)) { if (cur == null) break; cur = cur[s]; }
    const last = segs[segs.length - 1];
    const before = cur && typeof cur === 'object' && last in cur ? structuredClone(cur[last]) : undefined;

    if (change.path.startsWith('__')) {
      applied.push({ id: f.id, kind: change.kind, path: change.path, value: change.value, before, describe: entry.repair.describe(f.capture), effective: false });
      continue; // engine-level action (cache clear, regeneration) — no spec change
    }

    let target = next;
    for (const s of segs.slice(0, -1)) {
      if (target[s] == null) target[s] = {};
      target = target[s];
    }
    // an object-valued change MERGES, so a repair never erases settings it did
    // not intend to touch
    if (change.value && typeof change.value === 'object' && !Array.isArray(change.value) && target[last] && typeof target[last] === 'object') {
      target[last] = { ...target[last], ...change.value };
    } else {
      target[last] = change.value;
    }

    applied.push({ id: f.id, kind: change.kind, path: change.path, before, after: structuredClone(change.value), describe: entry.repair.describe(f.capture) });
  }

  return {
    spec: next,
    applied,
    skipped,
    changed: applied.some((a) => a.effective !== false),
    findings,
  };
}

/** Undo a repair set, newest first. */
export function rollback(spec, applied) {
  const back = structuredClone(spec);
  for (const a of [...applied].reverse()) {
    if (a.path.startsWith('__')) continue;
    const segs = a.path.split('.');
    let target = back;
    let lost = false;
    for (const s of segs.slice(0, -1)) { if (target?.[s] == null) { lost = true; break; } target = target[s]; }
    if (lost) continue;
    const last = segs[segs.length - 1];
    if (a.before === undefined) delete target[last];
    else target[last] = a.before;
  }
  return back;
}

/** A complete, shareable explanation of a failed build. */
export function explain(logText, { spec = null } = {}) {
  const { findings, scanned } = match(logText, { spec });
  if (!findings.length) {
    return {
      recognised: false,
      headline: 'This failure is not in the known-error database.',
      detail: [
        `Scanned ${scanned} lines and recognised none of the ${KNOWN_ERRORS.length} known failures.`,
        'Nothing has been changed. Changing a build at random turns one fault into several, so the engine stops here instead.',
      ],
      next: [
        'Send the log exactly as it is — the lines around the first error carry the answer.',
        'Check the last change made before the build started working last time.',
        'If the error came from generated code, regenerate and compare; a deterministic generator should never produce broken output.',
      ],
    };
  }
  return {
    recognised: true,
    headline: findings[0].cause,
    findings,
    autoRepairable: findings.filter((f) => f.repairable),
    needsHuman: findings.filter((f) => !f.repairable),
  };
}

export const ERROR_DB_SIZE = KNOWN_ERRORS.length;
export { CATEGORIES };
