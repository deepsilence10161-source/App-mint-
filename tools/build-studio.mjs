#!/usr/bin/env node
/**
 * Build the Studio into ONE self-contained HTML file.
 * ===================================================
 * Why a single file:
 *   1. It opens from a phone with no server, no install and no network.
 *   2. It renders inside a sandboxed preview iframe, which has no network and
 *      cannot resolve relative module imports.
 *   3. There is nothing to misconfigure: one file, one link.
 *
 * Why it is safe to inline the engine rather than copy it:
 *   engine/spec/toolchain.mjs, engine/spec/spec.mjs and
 *   engine/capability/permissions.mjs import nothing but each other, so the
 *   Studio runs the SAME validation code the CLI and CI run. If this were a
 *   copy, the Studio and the build would eventually disagree about what is
 *   valid, and the user would be told "fine" by one and "refused" by the other.
 *
 * Usage:  node tools/build-studio.mjs [--out studio/app.html]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Dependency order matters: a module must appear after everything it imports.
const ENGINE_MODULES = [
  'engine/spec/toolchain.mjs',
  'engine/components/scales.mjs',
  'engine/components/library.mjs',
  'engine/spec/fix-policy.mjs',
  'engine/spec/spec.mjs',
  'engine/capability/permissions.mjs',
  // The Health screen scores the same validateSpec and permissionReport
  // results the Build screen shows, so the browser must run the same code.
  'engine/spec/health.mjs',
  // The stepper groups the real steps of a GitHub run into stages. The same
  // code runs in the browser and in the tests, so the two cannot describe a
  // build differently.
  'engine/spec/pipeline.mjs',
  // The website analyser: pure by construction — no filesystem, no network — so
  // it runs in a browser unchanged. It is inlined rather than copied, because a
  // second implementation of "what does this site become" would drift from the
  // one the build pipeline uses, and the person holding the phone would have no
  // way to know which to believe.
  'engine/analyse/html.mjs',
  'engine/analyse/site.mjs',
];

/* Application sources, in the order they must be evaluated. The designer is
   listed first because it declares state at load time that the shell's boot
   reads; everything it borrows from the shell it only touches once a person
   has tapped something. */
const APP_MODULES = [
  // The history module is first because the designer calls into it the moment a
  // person moves something, and it reads the designer's selection state when it
  // records a step. Both are in one scope once bundled, but listing it first
  // keeps the dependency readable rather than something you have to trace.
  'studio/src/history.js',
  'studio/src/designer.js',
  'studio/src/website.js',
  'studio/src/studio.js',
  'studio/src/repairs.js',
  'studio/src/viewHealth.js',
  'studio/src/viewPipeline.js',
  'studio/src/viewSettings.js',
  'studio/src/logConsole.js',
  // The palette is last because it calls into everything above it: the views,
  // the build, the repair history and the theme. Bundled into one scope the
  // order would not matter at call time, but listing it last says plainly that
  // it is a caller and nothing calls it.
  'studio/src/palette.js',
];

/**
 * Strip ESM syntax so several modules can share one scope.
 * Deliberately conservative: it only removes import statements and the
 * `export ` keyword, and it refuses to continue if it meets syntax it does not
 * understand, rather than emitting something subtly broken.
 */
function stripModuleSyntax(source, file) {
  let out = source;

  // Remove import statements (single line and multi line).
  out = out.replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '');
  out = out.replace(/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm, '');

  // `export { X } from './y.mjs';` re-exports cannot survive flattening.
  const reExport = out.match(/^\s*export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?\s*$/gm);
  if (reExport) {
    throw new Error(`${file}: re-export statements cannot be flattened:\n${reExport.join('\n')}`);
  }

  // `export default` would collide across modules.
  if (/^\s*export\s+default\b/m.test(out)) {
    throw new Error(`${file}: export default is not supported by this bundler.`);
  }

  // Plain `export { A, B };` -> drop the statement; the bindings are already in scope.
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');

  // `export const/function/class/let/async` -> plain declarations.
  out = out.replace(/^(\s*)export\s+(?=(const|let|var|function|class|async)\b)/gm, '$1');

  // Anything left would have silently changed behaviour, so fail loudly.
  const leftover = out.match(/^\s*export\b.*$/m);
  if (leftover) {
    throw new Error(`${file}: unrecognised export syntax was not flattened: ${leftover[0].trim()}`);
  }
  return out;
}

/**
 * Everything is inlined into ONE scope, so two modules declaring the same
 * top-level name would silently overwrite each other — the kind of fault that
 * looks like a working app until one screen behaves oddly. Checked rather than
 * trusted, with the module names in the message so it is quick to fix.
 */
function checkForCollisions(parts) {
  const owner = new Map();
  const clashes = [];
  for (const part of parts) {
    const label = (/^\/\* ═══ (.+?) ═══ \*\//.exec(part) || [, 'inline'])[1];
    const names = new Set();
    // column zero only: a name declared inside a function is local to it and
    // cannot collide with another module
    const re = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(part))) names.add(m[1]);
    for (const name of names) {
      if (owner.has(name) && owner.get(name) !== label) clashes.push(`${name} (${owner.get(name)} and ${label})`);
      else owner.set(name, label);
    }
  }
  if (clashes.length) {
    throw new Error(`the bundle would define the same name more than once:\n  ${clashes.join('\n  ')}`);
  }
  return owner.size;
}

/**
 * Turn a parse error's offset into a file and line, so a broken bundle says
 * where to look instead of only naming a byte.
 */
function locateSyntaxError(err, script, parts) {
  const m = /bundle\.js:(\d+)/.exec(err.stack || '');
  if (!m) return '';
  const target = Number(m[1]);
  let consumed = 0;
  for (const part of parts) {
    const lines = part.split('\n').length;
    if (target <= consumed + lines) {
      const label = (/^\/\* ═══ (.+?) ═══ \*\//.exec(part) || [, 'inline'])[1];
      return `\n  in ${label}, around line ${target - consumed}`;
    }
    consumed += lines + 2; // parts are joined with a blank line
  }
  return `\n  at bundle line ${target}`;
}

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${rel}`);
  return fs.readFileSync(p, 'utf8');
}

function build({ out = 'studio/app.html' } = {}) {
  const parts = [];
  const hashes = [];

  for (const rel of ENGINE_MODULES) {
    const src = read(rel);
    hashes.push(`${rel}:${crypto.createHash('sha256').update(src).digest('hex').slice(0, 12)}`);
    parts.push(`/* ═══ ${rel} ═══ */\n${stripModuleSyntax(src, rel)}`);
  }

  for (const rel of APP_MODULES) {
    const appSrc = read(rel);
    hashes.push(`${rel}:${crypto.createHash('sha256').update(appSrc).digest('hex').slice(0, 12)}`);
    // the modules import from each other; those imports are already satisfied
    const appFlattened = appSrc
      .replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
      .replace(/^(\s*)export\s+(?=(const|let|var|function|class|async)\b)/gm, '$1')
      .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
    parts.push(`/* ═══ ${rel} ═══ */\n${appFlattened}`);
  }

  checkForCollisions(parts);

  // Parse the assembled script before it is written. Flattening several modules
  // into one scope can produce a file that builds fine and then dies in the
  // browser with "Unexpected token", leaving the user on a loading screen and
  // nothing to look at. A syntax error must never leave this file.
  const script = parts.join('\n\n');
  try {
    new vm.Script(script, { filename: 'bundle.js' });
  } catch (err) {
    const where = locateSyntaxError(err, script, parts);
    throw new Error(`the bundle would not parse: ${err.message}${where}`);
  }

  const templatesSrc = read('studio/src/templates.json');
  hashes.push(`templates:${crypto.createHash('sha256').update(templatesSrc).digest('hex').slice(0, 12)}`);

  const css = read('studio/src/studio.css');
  let html = read('studio/src/index.html');

  html = html.replace('/*__CSS__*/', () => css);
  html = html.replace('/*__ENGINE__*/', () => parts.join('\n\n'));
  html = html.replace('/*__APP__*/', () => '/* templates are inlined as data, not fetched */\n');
  html = html.replace(
    'window.__appmintBoot(window.__appmintTemplates);',
    `window.__appmintTemplates = ${templatesSrc.trim()};\nwindow.__appmintBoot(window.__appmintTemplates);`,
  );

  // A build stamp that is a hash, not a timestamp — so the output stays
  // byte-identical for identical input and can be checked into the repository.
  const digest = crypto.createHash('sha256').update(parts.join('')).update(css).update(templatesSrc)
    .digest('hex').slice(0, 16);
  html = html.replace('</head>', `<meta name="appmint-build" content="${digest}">\n</head>`);

  const outPath = path.join(ROOT, out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);

  return { outPath, digest, bytes: Buffer.byteLength(html), hashes };
}

/* ──────────────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const result = build({ out: outIdx >= 0 ? args[outIdx + 1] : 'studio/app.html' });

console.log('');
console.log('  App Mint Studio — bundled');
console.log('');
console.log(`  output   ${path.relative(ROOT, result.outPath)}`);
console.log(`  size     ${(result.bytes / 1024).toFixed(1)} KB (single file, nothing external)`);
console.log(`  build    ${result.digest}`);
console.log('');
console.log('  inlined:');
for (const h of result.hashes) console.log(`    ${h}`);
console.log('');
