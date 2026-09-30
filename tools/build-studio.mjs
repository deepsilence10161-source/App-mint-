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
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Dependency order matters: a module must appear after everything it imports.
const ENGINE_MODULES = [
  'engine/spec/toolchain.mjs',
  'engine/spec/spec.mjs',
  'engine/capability/permissions.mjs',
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

  const appSrc = read('studio/src/studio.js');
  hashes.push(`studio/src/studio.js:${crypto.createHash('sha256').update(appSrc).digest('hex').slice(0, 12)}`);

  // studio.js imports the engine; those imports are already satisfied above.
  let appFlattened = appSrc
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^(\s*)export\s+(?=(const|let|var|function|class|async)\b)/gm, '$1')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');

  parts.push(`/* ═══ studio/src/studio.js ═══ */\n${appFlattened}`);

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
