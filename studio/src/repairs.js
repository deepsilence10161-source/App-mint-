/**
 * THE REPAIR SCREEN
 * =================
 *
 * The engine can repair a specification. This file is the part that decides
 * what a person is allowed to see before that happens, and what they are told
 * afterwards.
 *
 * The rule it is built around: nothing changes in a project without the owner
 * having been shown what would change, and nothing that was changed is ever
 * hidden afterwards. That is not decoration. A tool that quietly edits your
 * work — even correctly — is one you cannot check, and a tool you cannot check
 * is one you cannot rely on. There is a button for people in a hurry, and it is
 * honest about exactly what it will do before they press it and exactly what it
 * did after.
 *
 * Three groups of work are kept strictly apart:
 *
 *   Ready to repair  The value cannot work as it stands. One press fixes all of
 *                    them, and the press is preceded by the list.
 *   Your call        A repair exists and is reasonable, but it changes a
 *                    decision the owner made. Never applied in bulk, never
 *                    applied first, offered one at a time.
 *   Left alone       A repair was offered and declined, because carrying it out
 *                    would have left more problems than it solved. Explained,
 *                    not skipped silently.
 */

import { planFixes, repair, rollbackFix, showValue } from '../../engine/spec/spec.mjs';
import { derivePermissions } from '../../engine/capability/permissions.mjs';
import { el, svg, say } from './studio.js';

/* ── the journal ──────────────────────────────────────────────────────────
   Every repair this project has had, in order, each with the exact inverse
   operation needed to undo it. Stored on the project itself, so it survives a
   reload along with everything else, and so reopening a project shows what was
   done to it rather than a clean page that hides its own history.            */

export function journalOf(project) {
  if (!Array.isArray(project.repairs)) project.repairs = [];
  return project.repairs;
}

/** The permission names a repair would add or remove, as a plain list. */
function permissionDelta(beforeSpec, afterSpec) {
  const names = (spec) => {
    try {
      const d = derivePermissions(spec);
      return new Set((d.permissions || []).map((p) => (typeof p === 'string' ? p : p.permission || p.name)));
    } catch { return new Set(); }
  };
  const a = names(beforeSpec), b = names(afterSpec);
  return {
    added: [...b].filter((x) => !a.has(x)),
    removed: [...a].filter((x) => !b.has(x)),
  };
}

/** "36 → 26", or a word when the value is not a number. */
function changeLine(step) {
  const short = (v) => {
    const s = showValue(v);
    return s.length > 42 ? s.slice(0, 39) + '…' : s;
  };
  return `${short(step.before)} → ${short(step.after)}`;
}

/* ── the screen ─────────────────────────────────────────────────────────── */

/**
 * Everything to do with repair, for the Build section.
 *
 * Returns an array of cards: what can be repaired, what was repaired, and what
 * was deliberately left alone.
 */
export function viewRepairs(ctx) {
  const { spec, result, onSpecChange, onSay } = ctx;
  const plan = planFixes(spec, result.issues);
  const auto = plan.stepsAuto;
  const review = plan.stepsReview;
  const refused = plan.preview.refused || [];
  const journal = journalOf(ctx.project);

  const cards = [];

  /* ── what can be repaired without asking ─────────────────────────────── */

  if (auto.length) {
    const delta = permissionDelta(spec, plan.preview.spec);
    const consequences = [];
    if (delta.added.length) {
      // A repair that switches on a capability asks Android for a permission,
      // and that is the user's business before it happens, not after.
      consequences.push(el('p', { class: 'consequence' },
        `These repairs will also ask Android for ${say(delta.added.length, 'permission')}: ${delta.added.join(', ')}. ` +
        'That is because a feature you built needs it, but you should see it before it happens.'));
    }

    const preview = el('div', { class: 'repair-preview' }, auto.map((s) => el('div', { class: 'repair-step' }, [
      el('div', { class: 'rs-head' }, [
        el('span', { class: 'rs-path' }, s.path),
        el('span', { class: 'rs-change' }, changeLine(s)),
      ]),
      el('div', { class: 'rs-why' }, s.why),
    ])));

    cards.push(sectionLike('Ready to repair', auto.length, [
      el('div', { class: 'banner fail' }, el('div', {}, [
        el('strong', {}, auto.length === 1
          ? 'One problem here cannot work as it stands.'
          : `${auto.length} problems here cannot work as they stand.`),
        ' These are not matters of taste — the build would stop, or the app would not do what it says. Each is repaired by setting a value that has only one possible answer.',
      ])),
      ...consequences,
      el('button', {
        class: 'btn primary block',
        onclick: () => applyRepairs(ctx, auto.map((s) => s.code), auto.length),
      }, `Repair ${say(auto.length, 'problem')}`),
      preview,
    ]));
  }

  /* ── what is the owner's to decide ───────────────────────────────────── */

  if (review.length) {
    cards.push(sectionLike('Your call', review.length, [
      el('p', { class: 'hint' },
        'A repair exists for each of these, and each one would be a reasonable answer. They are listed rather than applied, because they change something you chose — and one of them could stop a site that only serves http:// from loading at all.'),
      ...review.map((s) => el('div', { class: 'repair-decision' }, [
        el('div', { class: 'rs-head' }, [
          el('span', { class: 'rs-path' }, s.path),
          el('span', { class: 'rs-change' }, changeLine(s)),
        ]),
        el('div', { class: 'rs-why' }, s.why),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn ghost sm',
            onclick: () => applyRepairs(ctx, [s.code], 1),
          }, 'Apply this one'),
        ]),
      ])),
    ]));
  }

  /* ── repairs that were declined because they would backfire ──────────── */

  if (refused.length) {
    cards.push(sectionLike('Left alone', refused.length, refused.map((r) => el('div', { class: 'repair-declined' }, [
      el('div', { class: 'rs-head' }, [
        el('span', { class: 'rs-path' }, r.path),
        el('span', { class: 'rs-change' }, r.code),
      ]),
      el('div', { class: 'rs-why' }, r.why),
      el('div', { class: 'rs-why' }, `Carrying it out would have left ${say(r.wouldGive, 'problem')} where there ${r.had === 1 ? 'is' : 'are'} ${r.had}.`),
    ]))));
  }

  /* ── what has already been repaired in this project ──────────────────── */

  if (journal.length) {
    cards.push(sectionLike('Repaired in this project', journal.length, [
      el('p', { class: 'hint' },
        'Every repair is recorded with the value it replaced, so any one of them can be put back exactly as it was.'),
      ...journal.map((entry, i) => el('div', { class: 'repair-done' }, [
        el('div', { class: 'rs-head' }, [
          el('span', { class: 'okmark', html: svg('<path d="m5 13 4 4 10-10"/>') }),
          el('span', { class: 'rs-path' }, entry.path),
          el('span', { class: 'rs-change' }, `${showValue(entry.before)} → ${showValue(entry.after)}`),
        ]),
        el('div', { class: 'rs-why' }, entry.code + (entry.decided ? ' · applied because you chose it' : '')),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn ghost sm', onclick: () => undoOne(ctx, i) }, 'Undo'),
        ]),
      ])),
      el('button', { class: 'btn ghost block', onclick: () => undoAll(ctx) }, 'Undo every repair in this project'),
    ]));
  }

  return cards;
}

/**
 * A card whose heading carries the count, so the number of things waiting is
 * visible without opening anything.
 */
function sectionLike(title, count, children) {
  return el('section', { class: 'card' }, [
    el('h2', {}, [el('span', {}, title), el('span', { class: 'count' }, String(count))]),
    ...children.filter(Boolean),
  ]);
}

/* ── carrying a repair out ──────────────────────────────────────────────── */

function applyRepairs(ctx, codes, expected) {
  const { spec, result, project } = ctx;
  const { spec: fixed, applied } = repair(spec, { codes, issues: result.issues });

  if (!applied.length) {
    // Never claim success that did not happen.
    ctx.onSay('Nothing was changed — that repair does not apply to the current values.');
    return;
  }

  // Record the inverse of each change on the project, so undo is exact rather
  // than "put it back to something like it was".
  const journal = journalOf(project);
  for (const a of applied) {
    const step = planStepFor(ctx, a, codes);
    journal.push({
      code: a.code,
      path: a.path,
      message: a.message,
      before: step ? step.before : undefined,
      after: step ? step.after : undefined,
      undo: a.undo,
      decided: expected === 1 && !codes.every((c) => isAuto(ctx, c)),
      at: new Date().toISOString(),
    });
  }

  ctx.onSpecChange(fixed);

  // Say what actually happened, counted, not implied. Repairing every error
  // while warnings remain is a real and common outcome, and calling that
  // "nothing is outstanding" next to a header that says three warnings is how
  // a tool teaches people to stop believing it.
  const remaining = ctx.recheck(fixed);
  const errors = remaining.counts.critical + remaining.counts.error;
  const warns = remaining.counts.warning;
  const did = say(applied.length, 'problem');
  ctx.onSay(errors
    ? `Repaired ${did}. ${say(errors, 'problem')} still cannot work and ${errors === 1 ? 'is' : 'are'} listed below.`
    : (warns
        ? `Repaired ${did}. Nothing is broken now; ${say(warns, 'warning')} left to read.`
        : `Repaired ${did}. Nothing is outstanding now.`));
}

/** The before/after values for a repair the engine just performed. */
function planStepFor(ctx, applied, codes) {
  const plan = planFixes(ctx.spec, ctx.result.issues, { onlyCodes: codes });
  return plan.steps.find((s) => s.code === applied.code && s.path === applied.path)
      || plan.steps.find((s) => s.code === applied.code);
}

function isAuto(ctx, code) {
  const plan = planFixes(ctx.spec, ctx.result.issues);
  return plan.stepsAuto.some((s) => s.code === code);
}

/* ── undoing ────────────────────────────────────────────────────────────── */

function undoOne(ctx, index) {
  const journal = journalOf(ctx.project);
  const entry = journal[index];
  if (!entry) return;

  const spec = JSON.parse(JSON.stringify(ctx.spec));
  const ok = rollbackFix(spec, entry);
  if (!ok) {
    ctx.onSay('That repair could not be undone — the field has changed since it was made. Nothing was altered.');
    return;
  }
  journal.splice(index, 1);
  ctx.onSpecChange(spec);
  ctx.recheck(spec);
  ctx.onSay('Undone. The value is back to what it was.');
}

function undoAll(ctx) {
  const journal = journalOf(ctx.project);
  if (!journal.length) return;

  // Backwards, because a later repair can depend on an earlier one.
  const spec = JSON.parse(JSON.stringify(ctx.spec));
  let undone = 0, failed = 0;
  for (let i = journal.length - 1; i >= 0; i--) {
    if (rollbackFix(spec, journal[i])) undone++; else failed++;
  }
  ctx.project.repairs = [];
  ctx.onSpecChange(spec);
  ctx.recheck(spec);
  ctx.onSay(failed
    ? `Undid ${undone}. ${failed} could not be undone — those fields have changed since.`
    : `Undid every repair (${undone}). The project is back to how it was before them.`);
}
