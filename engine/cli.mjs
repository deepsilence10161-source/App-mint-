#!/usr/bin/env node
/**
 * APP MINT — command line interface
 * =================================
 *   node engine/cli.mjs validate <spec.json> [--json] [--fix] [--overrides a,b]
 *   node engine/cli.mjs generate <spec.json> --out <dir> [--profile modern|bleeding|legacy]
 *   node engine/cli.mjs permissions <spec.json>
 *   node engine/cli.mjs explain <spec.json>
 *
 * Everything is deterministic and offline. No network, no AI, no accounts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateSpec, applyFixes, planFixes, repair, defaultSpec, showValue } from './spec/spec.mjs';
import { confidenceOf, isAutoFixable } from './spec/fix-policy.mjs';
import { generateAndroidProject, TOOLCHAIN_PROFILES } from './gen/android.mjs';
import { permissionReport, derivePermissions } from './capability/permissions.mjs';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', blue: '\x1b[34m',
};
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColour ? `${c}${s}${C.reset}` : s);

function readSpec(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

/* ---------------------------------------------------------------- *
 * validate
 * ---------------------------------------------------------------- */
function cmdValidate(args) {
  const file = args._[1];
  if (!file) return fail('Usage: validate <spec.json>');
  const spec = readSpec(file);
  const overrides = args.overrides ? String(args.overrides).split(',').map((s) => s.trim()).filter(Boolean) : [];
  let result = validateSpec(spec, { overrides });
  let fixedSpec = null;

  if (args.fix && result.issues.some((i) => i.fix)) {
    // Repair only what is provably wrong. A repair that changes a decision the
    // owner made is listed and left alone, however sensible it looks: --fix is
    // not consent for changes the owner never saw. (Before this, --fix applied
    // every repair the engine knew how to make, including turning off Android
    // backup and plain-HTTP traffic, which can quietly break a working app.)
    const plan = planFixes(spec, result.issues);
    const { spec: repaired, applied, after, before } = repair(spec);
    fixedSpec = repaired;
    if (!args.json) {
      if (applied.length) {
        console.log(paint(C.cyan, `\n  Repaired ${applied.length} problem(s) that could not have worked as they were:`));
        for (const a of applied) {
          const step = plan.steps.find((x) => x.code === a.code);
          const was = step ? showValue(step.before) : '?';
          const now = step ? showValue(step.after) : '?';
          console.log(`    ${paint(C.green, 'FIXED')}  ${a.code}  ${paint(C.dim, a.path)}`);
          console.log(`           ${was} → ${now}`);
        }
      } else {
        console.log(paint(C.dim, '\n  Nothing could be repaired automatically.'));
      }

      // What was declined, and why — including repairs that were declined
      // because carrying them out would have made things worse.
      const declined = plan.stepsReview.filter((x) => after.issues.some((i) => i.code === x.code));
      for (const r of plan.preview.refused) {
        console.log(paint(C.yellow, `\n  Declined to repair ${r.code} (${r.path}):`));
        console.log(`    ${r.why}`);
      }
      if (declined.length) {
        console.log(paint(C.yellow, `\n  ${declined.length} problem(s) need your decision — a repair exists, but it changes something you chose:`));
        for (const d of declined) {
          console.log(`    ${paint(C.yellow, 'YOURS')}  ${d.code}  ${paint(C.dim, d.path)}`);
          console.log(`           ${d.why}`);
        }
      }

      if (args.write) {
        fs.writeFileSync(file, JSON.stringify(repaired, null, 2) + '\n');
        console.log(paint(C.green, `\n  Written back to ${file}`));
      } else {
        console.log(paint(C.dim, `\n  (dry run — pass --write to save. Every repair is reversible.)`));
      }
    }
    result = after;
    if (before.counts.error !== after.counts.error || before.counts.warning !== after.counts.warning) {
      // Say plainly what the repair did and did not achieve.
      const left = after.counts.critical + after.counts.error + after.counts.warning;
      if (!args.json && left) console.log(paint(C.dim, `\n  ${left} finding(s) remain.`));
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      ok: result.ok, blocked: result.blocked, counts: result.counts,
      issues: result.issues, overridesApplied: result.overridesApplied,
    }, null, 2));
    return result.ok ? 0 : 1;
  }

  console.log(paint(C.bold, `\n  APP MINT — specification check`));
  console.log(paint(C.dim, `  ${file}\n`));

  const SEV = { critical: [C.red, 'CRITICAL'], error: [C.red, 'FAIL'], warning: [C.yellow, 'WARNING'], info: [C.blue, 'INFO'] };
  for (const [layer, info] of Object.entries(result.byLayer)) {
    if (info.issues.length === 0) {
      console.log(`  ${paint(C.green, 'PASS')}  Layer ${layer} — ${info.name}`);
      continue;
    }
    console.log(`  ${paint(C.green, 'PASS')}  Layer ${layer} — ${info.name} ${paint(C.dim, `(${info.issues.length} finding(s))`)}`);
    for (const i of info.issues) {
      const [col, label] = SEV[i.severity] || [C.dim, i.severity];
      const overridden = result.overridesApplied.includes(i.code);
      console.log(`        ${paint(col, label.padEnd(8))} ${i.message}`);
      const repairNote = i.fix ? (isAutoFixable(i.code) ? '  repair available' : '  repair available — your decision') : '';
      console.log(`                 ${paint(C.dim, `code=${i.code}  field=${i.path || '(root)'}${overridden ? '  OVERRIDDEN' : ''}${repairNote}`)}`);
      if (i.options && i.options.length) console.log(`                 ${paint(C.dim, `did you mean: ${i.options.slice(0, 4).join(', ')}`)}`);
      if (i.hint) console.log(`                 ${paint(C.dim, i.hint)}`);
    }
  }

  console.log('');
  console.log(`  ${result.counts.critical || 0} critical · ${result.counts.error || 0} error · ${result.counts.warning || 0} warning · ${result.counts.info || 0} info`);
  if (result.blocked) {
    console.log(paint(C.red, '\n  BLOCKED — this specification will not be sent to a build.\n'));
    return 1;
  }
  console.log(paint(C.green, '\n  READY — this specification can be built.\n'));
  return 0;
}

/* ---------------------------------------------------------------- *
 * generate
 * ---------------------------------------------------------------- */
function cmdGenerate(args) {
  const file = args._[1];
  if (!file) return fail('Usage: generate <spec.json> --out <dir>');
  const spec = readSpec(file);
  const outDir = args.out || path.join('build', path.basename(file, '.json'));

  const v = validateSpec(spec);
  if (v.blocked) {
    console.log(paint(C.red, `\n  Refusing to generate: ${v.blocking.length} blocking problem(s).\n`));
    for (const i of v.blocking) console.log(`    ${paint(C.red, i.code)}  ${i.message}`);
    console.log(paint(C.dim, '\n  Run:  node engine/cli.mjs validate <spec.json> --fix\n'));
    return 1;
  }

  // A project may ship its own bundled pages in a web/ directory beside its spec.
  const webDir = path.join(path.dirname(file), 'web');
  const gen = generateAndroidProject(spec, {
    profile: args.profile,
    webDir: fs.existsSync(webDir) ? webDir : null,
  });
  if (!gen.ok) { console.log(paint(C.red, `\n  Generation failed:`)); gen.errors.forEach((e) => console.log(`    ${e}`)); return 1; }

  // Clean the destination so output is genuinely deterministic.
  fs.rmSync(outDir, { recursive: true, force: true });
  const hashes = [];
  for (const f of gen.files) {
    const full = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.data);
    hashes.push(`${crypto.createHash('sha256').update(f.path).digest('hex').slice(0, 8)} ${f.path}`);
  }

  // Content hash of the whole output — this is what the build cache keys on.
  const treeHash = crypto.createHash('sha256');
  for (const h of [...hashes].sort()) treeHash.update(h);
  const contentHash = treeHash.digest('hex');

  fs.writeFileSync(path.join(outDir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'BUILD-INFO.json'), JSON.stringify({
    ...gen.report, contentHash,
  }, null, 2) + '\n');

  console.log(paint(C.bold, `\n  APP MINT — generated\n`));
  console.log(`  ${paint(C.green, 'OK')}  ${gen.files.length} files written to ${paint(C.cyan, outDir)}`);
  console.log(`  ${paint(C.dim, 'toolchain')}  AGP ${gen.meta.toolchain.agp} · Gradle ${gen.meta.toolchain.gradle} · Build Tools ${gen.meta.toolchain.buildTools} · JDK ${gen.meta.toolchain.jdk}`);
  console.log(`  ${paint(C.dim, 'signing')}    ${spec.signing?.mode || 'debug'}`);
  console.log(`  ${paint(C.dim, 'content hash')} ${contentHash.slice(0, 32)}…`);
  console.log('');
  printPermissions(spec);
  return 0;
}

/* ---------------------------------------------------------------- *
 * permissions
 * ---------------------------------------------------------------- */
function printPermissions(spec) {
  const rep = permissionReport(spec);
  const hasDerived = derivePermissions(spec);
  console.log(paint(C.bold, '  Permissions — derived from your capabilities, nothing extra\n'));
  if (rep.rows.length === 0) {
    console.log(paint(C.dim, '    (none required)\n'));
  } else {
    for (const r of rep.rows) {
      console.log(`    ${paint(C.cyan, r.permission.padEnd(28))} ${paint(C.dim, r.scope.padEnd(16))} ${r.why}`);
      console.log(`    ${' '.repeat(28)} ${paint(C.dim, `feature: ${r.feature}`)}`);
    }
  }
  if (hasDerived.dropped.length) {
    console.log(paint(C.bold, '\n  Deliberately NOT requested\n'));
    for (const d of hasDerived.dropped) console.log(`    ${paint(C.dim, d.name.padEnd(28) + ' ' + d.reason)}`);
  }
  console.log(`\n  ${rep.total} permission(s), ${rep.prompts} runtime prompt(s).\n`);
}

function cmdPermissions(args) {
  const file = args._[1];
  if (!file) return fail('Usage: permissions <spec.json>');
  printPermissions(readSpec(file));
  return 0;
}

/* ---------------------------------------------------------------- *
 * explain / helpers
 * ---------------------------------------------------------------- */
function cmdExplain() {
  console.log(paint(C.bold, `
  APP MINT — what this is
  =======================
  A free, offline, deterministic app factory.

  * No account, no subscription, no credits, no AI, no paid API.
  * The Project Specification is the single source of truth; the generator and
    the visual editor both read and write that one object.
  * Five validation layers run before anything is built, and a critical or
    error finding stops the build.
  * Repairs are rule-based and reversible; unknown problems are explained, never
    guessed at.
  * Permissions are derived from capabilities, so disabling a feature removes
    its permission from the manifest.

  Commands
    validate <spec.json> [--fix] [--write] [--json]   check the specification
    generate <spec.json> --out <dir> [--profile ...]  produce an Android project
    permissions <spec.json>                           show the permission table
    explain                                           this text

  Toolchain profiles
${Object.entries(TOOLCHAIN_PROFILES).map(([k, v]) => `    ${k.padEnd(9)} AGP ${v.agp} · Gradle ${v.gradle} · Build Tools ${v.buildTools} · up to SDK ${v.maxCompileSdk}`).join('\n')}

`));
  return 0;
}

function fail(msg) { console.error(paint(C.red, `\n  ${msg}\n`)); return 2; }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

/* ---------------------------------------------------------------- */
const argv = process.argv.slice(2);
const args = parseArgs(argv);
const cmd = args._[0];

const ROUTES = {
  validate: cmdValidate,
  generate: cmdGenerate,
  permissions: cmdPermissions,
  explain: cmdExplain,
};

if (!cmd) { cmdExplain(); process.exit(0); }
const fn = ROUTES[cmd];
if (!fn) { fail(`Unknown command "${cmd}". Run without arguments for help.`); process.exit(2); }
process.exit(fn(args) || 0);
