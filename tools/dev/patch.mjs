#!/usr/bin/env node
/**
 * EDIT A FILE, OR FAIL LOUDLY
 * ===========================
 *
 * Written because the same fault reached the codebase three times:
 *
 *   a source patch whose search text did not match returned the file unchanged
 *   and reported success.
 *
 * It cost a session once (`writeReceipts` was called for hours with no
 * definition anywhere), it broke CI once (a scope mistake that a text scan could
 * not see), and it silently dropped a fix this session — the cache's explanation
 * of an old-format entry — which was only caught because a test had been written
 * for that exact behaviour.
 *
 * `python -c "s = s.replace(a, b)"` cannot tell the difference between "replaced
 * it" and "there was nothing to replace". This can:
 *
 *   node tools/dev/patch.mjs <file> <anchor-file> <replacement-file> [--count N]
 *
 * The anchor and replacement are files rather than arguments so that the shell
 * never has to quote them, and so a diff can be read afterwards. The anchor must
 * occur exactly the expected number of times (once by default) or nothing is
 * written at all.
 */

import fs from 'node:fs';
import process from 'node:process';

const [file, anchorFile, replacementFile, ...rest] = process.argv.slice(2);

if (!file || !anchorFile || !replacementFile) {
  console.error('usage: node tools/dev/patch.mjs <file> <anchor-file> <replacement-file> [--count N]');
  process.exit(2);
}

let expected = 1;
const countFlag = rest.indexOf('--count');
if (countFlag !== -1) {
  expected = Number(rest[countFlag + 1]);
  if (!Number.isInteger(expected) || expected < 1) {
    console.error('--count needs a whole number of at least 1');
    process.exit(2);
  }
}

for (const f of [file, anchorFile, replacementFile]) {
  if (!fs.existsSync(f)) {
    console.error(`nothing to do: ${f} does not exist`);
    process.exit(2);
  }
}

const source = fs.readFileSync(file, 'utf8');
const anchor = fs.readFileSync(anchorFile, 'utf8');

// Count occurrences without a regex: the anchor is source code, and escaping it
// correctly for a regex is exactly the kind of detail that goes wrong quietly.
let found = 0;
let at = source.indexOf(anchor);
while (at !== -1) {
  found += 1;
  at = source.indexOf(anchor, at + anchor.length);
}

if (found !== expected) {
  console.error(`the anchor does not match this file: found ${found} occurrence${found === 1 ? '' : 's'}, expected ${expected}.`);
  console.error(`${file} has NOT been modified.`);
  console.error('The text to match has to be copied from the file as it is, not as it was written from memory.');
  process.exit(1);
}

const replacement = fs.readFileSync(replacementFile, 'utf8');
let out = '';
let cursor = 0;
for (let i = 0; i < found; i += 1) {
  const next = source.indexOf(anchor, cursor);
  out += source.slice(cursor, next) + replacement;
  cursor = next + anchor.length;
}
out += source.slice(cursor);

if (out === source) {
  // Replacing the anchor with itself is almost always a mistake — an empty or
  // identical replacement file — and it is worth saying so rather than
  // reporting a successful edit that changed nothing.
  console.error('the replacement is identical to the anchor, so nothing changed. Refusing to report success.');
  process.exit(1);
}

fs.writeFileSync(file, out);
console.log(`${file}: replaced ${found} occurrence${found === 1 ? '' : 's'} (${anchor.length} → ${replacement.length} characters)`);
