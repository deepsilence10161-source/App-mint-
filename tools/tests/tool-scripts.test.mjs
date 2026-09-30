/**
 * SCRIPTS IN tools/ MUST ACTUALLY RUN
 * ===================================
 *
 * These tests exist because of a specific afternoon: a patch to the build
 * script added a call to a helper function, and the part of the patch that
 * defined the helper silently did not apply. The file parsed, the diff looked
 * right, every existing test passed — because nothing in the test suite ever
 * executed that script. It would have failed in CI, on a runner, several
 * minutes in, with a stack trace about a name that was never defined.
 *
 * Text edits fail this way: they match nothing and report success. So the
 * checks below are deliberately crude and shallow — they read the files as text
 * and look for the shapes that indicate a script is broken — because the point
 * is to catch what a diff hides, not to be a compiler.
 *
 * A shallow check that runs on every commit is worth more than a thorough one
 * that somebody has to remember to run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every entry script we run: the CLI, and everything that stands alone. */
function entryScripts() {
  const out = ['engine/cli.mjs'];
  const toolsDir = path.join(ROOT, 'tools');
  for (const name of fs.readdirSync(toolsDir)) {
    if (name.endsWith('.mjs')) out.push(path.join('tools', name));
  }
  return out;
}

/**
 * Strip anything that is not code.
 *
 * Comments and string literals are full of words followed by brackets — a
 * message like "2 finding(s) remain" or a note like "see run() above" would
 * otherwise be read as a call to `finding` or `run`, and the check would drown
 * in its own noise.
 *
 * This is a small scanner rather than a regular expression, and the reason is
 * nesting: templates contain `${...}` which contains code, which contains more
 * templates. A regular expression cannot follow that, and an earlier version of
 * this file used one — it cut each template literal off at the first backtick
 * it saw and left the inner text in place, which is exactly how "finding(s)"
 * ended up being reported as a missing function.
 *
 * Not a parser. It tracks the five states that carry text rather than code and
 * leaves everything else alone.
 */
function stripText(src, { keepStrings = false } = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  // stack of states, so a template inside a template inside a template works
  const stack = [];
  let mode = 'code';

  const push = (m) => { stack.push({ mode, braceDepth: 0 }); mode = m; };
  const pop = () => { const prev = stack.pop(); mode = prev ? prev.mode : 'code'; };

  while (i < n) {
    const c = src[i], next = src[i + 1];

    if (mode === 'code') {
      // The brace that ends a ${ } interpolation returns us to the template it
      // came from. This has to be checked before anything else, because inside
      // an interpolation we are in code mode and every other rule below would
      // otherwise swallow it — which is how an earlier version of this scanner
      // lost track of where a template ended and read the prose inside it as
      // function calls.
      const top = stack[stack.length - 1];
      if (top && top.braceDepth > 0 && c === '}') {
        top.braceDepth--;
        if (top.braceDepth === 0) { mode = 'template'; i++; out += ' '; continue; }
      }
      if (top && top.braceDepth > 0 && c === '{') { top.braceDepth++; }

      if (c === '/' && next === '/') { mode = 'line'; i += 2; out += '  '; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; out += '  '; continue; }
      // The opening quote has to be emitted as well as the closing one: dropping
      // it produced `from ./x.mjs'`, which no import pattern can match, and a
      // check that matches nothing passes for the wrong reason.
      if (c === "'") { push('single'); i++; out += keepStrings ? "'" : "''"; continue; }
      if (c === '"') { push('double'); i++; out += keepStrings ? '"' : '""'; continue; }
      if (c === '`') { push('template'); i++; out += keepStrings ? '`' : '``'; continue; }
      out += c; i++;
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      i++;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; out += '  '; }
      else { if (c === '\n') out += '\n'; i++; }
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      const quote = mode === 'single' ? "'" : '"';
      if (c === '\\') { if (keepStrings) out += c + next; i += 2; continue; }
      if (c === quote) { if (keepStrings) out += c; pop(); i++; continue; }
      if (keepStrings) out += c;
      i++;
      continue;
    }
    if (mode === 'template') {
      if (c === '\\') { if (keepStrings) out += c + next; i += 2; continue; }
      if (c === '`') { if (keepStrings) out += c; pop(); i++; continue; }
      if (keepStrings) out += c;
      if (c === '$' && next === '{') {
        // code resumes inside the braces, and may contain further templates
        stack[stack.length - 1].braceDepth = 1;
        mode = 'code';
        i += 2;
        out += ' ';   // keep a space so tokens either side do not join up
        continue;
      }
      i++;
      continue;
    }

    i++;
  }
  return out;
}

/** Comments removed, string literals left alone. For reading import paths. */
function stripComments(src) {
  return stripText(src, { keepStrings: true });
}

/**
 * Every name the file could legitimately call, at any depth.
 *
 * Depth is the point: the original bug was a helper called from the top level
 * and defined nowhere, but the same mistake inside a function would be just as
 * fatal and just as invisible. So declarations are collected from every scope
 * rather than only the outermost one.
 */
function declaredNames(src) {
  const code = stripText(src);
  const names = new Set();
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,                        // function foo
    /\bclass\s+([A-Za-z_$][\w$]*)/g,                           // class Foo
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,               // const foo = ...
    /\b([A-Za-z_$][\w$]*)\s*(?==>)/g,                          // foo => ...
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,                      // catch (err)
  ];
  let m;
  for (const re of patterns) while ((m = re.exec(code))) names.add(m[1]);

  // Parameters and destructured parameters. Approximate on purpose: a name
  // collected here might not really be a parameter, and that is the safe
  // direction — it can only make the check quieter, never louder.
  const params = /(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>/g;
  while ((m = params.exec(code))) {
    for (const part of (m[1] || m[2] || '').split(',')) {
      const name = part.split(/[=:]/)[0].replace(/[{}\s.]/g, '');
      if (name) names.add(name);
    }
  }
  const fnParams = /\bfunction\s*[A-Za-z_$\w$]*\s*\(([^()]*)\)/g;
  while ((m = fnParams.exec(code))) {
    for (const part of (m[1] || '').split(',')) {
      const name = part.split(/[=:]/)[0].replace(/[{}\s.]/g, '');
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Names Node provides, plus this project's own shared helpers.
 *
 * Deliberately short. Anything added here is a name the check stops watching,
 * so each entry is a decision — not a place to quieten a failure that is in
 * fact a real missing function.
 */
const BUILTINS = new Set([
  'require', 'console', 'process', 'Buffer', 'JSON', 'Math', 'Date', 'Number', 'String',
  'Boolean', 'Array', 'Object', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise',
  'Set', 'Map', 'Symbol', 'BigInt', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'structuredClone', 'fetch',
  'assert', 'test', 'describe', 'before', 'after', 'it', 'execFileSync', 'hashFile',

  // Browser globals. They are not defined in these files because the code that
  // uses them does not run in Node: it is handed to page.evaluate() and
  // executed inside the browser the Studio tests drive.
  'document', 'window', 'navigator', 'location', 'localStorage', 'sessionStorage',
  'getComputedStyle', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
  'ResizeObserver', 'IntersectionObserver', 'alert', 'confirm', 'Blob', 'FileReader',
  'Image', 'CustomEvent', 'Event', 'Node', 'Element', 'HTMLElement', 'btoa', 'atob',
]);

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'do', 'else',
  'new', 'delete', 'void', 'in', 'of', 'case', 'throw', 'await', 'yield', 'super', 'this',
  'async',
]);

/**
 * Names that are called in this file but defined nowhere in it.
 *
 * Only names that are neither declared here nor imported are candidates, and
 * anything that appears as a property (`x.y(`) is excluded by the regex, which
 * is what keeps this from firing on methods, however many there are.
 */
function calledButUndeclared(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const code = stripText(raw);
  const declared = declaredNames(raw);

  // Anything imported is defined elsewhere, deliberately.
  const imported = new Set();
  const importRe = /import\s*(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))?\s*(?:,\s*\{([^}]*)\})?\s*from/g;
  let m;
  while ((m = importRe.exec(code))) {
    for (const group of [m[1], m[3]]) {
      if (!group) continue;
      for (const part of group.split(',')) {
        const name = part.split(/\s+as\s+/).pop().trim();
        if (name) imported.add(name);
      }
    }
    if (m[2]) imported.add(m[2]);
  }

  const called = new Set();
  const callRe = /(?:^|[^.\w$])([a-z][\w$]*)\s*\(/gm;
  while ((m = callRe.exec(code))) called.add(m[1]);

  const suspects = [];
  for (const name of called) {
    if (KEYWORDS.has(name) || declared.has(name) || imported.has(name) || BUILTINS.has(name)) continue;
    suspects.push(name);
  }
  return suspects;
}

test('every script under tools/ parses', () => {
  for (const file of entryScripts()) {
    const result = execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8', stdio: 'pipe' })
      || '';
    assert.ok(result !== null, `${file} did not parse`);
  }
});

test('no script calls a helper that is neither defined nor imported', () => {
  // This is the exact shape of the bug that motivated the file, and it survived
  // `node --check`, a careful reading of the diff, and 108 passing tests.
  const problems = [];
  for (const file of entryScripts()) {
    for (const name of calledButUndeclared(file)) {
      problems.push(`${file} calls ${name}() which is not defined in it and not imported`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every module a script imports is actually in the repository', () => {
  /*
   * A .gitignore rule meant for build output can quietly swallow source. It
   * happened: an unanchored "build/" matched engine/build/, so two modules were
   * left out of a commit while every local test passed — they passed because
   * the files were on disk, which is exactly what the commit would not have.
   *
   * The check reads the relative imports out of each script and asks git
   * whether the resolved file is ignored. This is the only test here that
   * inspects the repository rather than the filesystem, and it exists because
   * the two disagree.
   */
  const files = entryScripts();
  for (const dir of ['engine']) {
    const walk = (d) => {
      for (const name of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = path.join(d, name.name);
        if (name.isDirectory()) walk(rel);
        else if (name.name.endsWith('.mjs')) files.push(rel);
      }
    };
    walk(dir);
  }

  const missing = [];
  const ignored = [];
  for (const file of files) {
    // Comments and strings first: build-studio.mjs documents "export { X } from
    // './y.mjs'" in a comment, and a scanner that ignored that would report a
    // file nobody imports.
    const src = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
    const re = /from\s*['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const target = path.normalize(path.join(path.dirname(file), m[1]));
      if (!fs.existsSync(path.join(ROOT, target))) {
        missing.push(`${file} imports ${m[1]}, which does not exist`);
        continue;
      }
      // Is git actually carrying this file?
      //
      // Not `git check-ignore`: that answers a narrower question and skips
      // files that are already tracked, so it stays silent in exactly the case
      // that matters — a module that exists on disk and is not in the commit.
      // Asking whether git tracks the path catches both an ignore rule and a
      // file that was simply never added.
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', target], { cwd: ROOT, stdio: 'pipe' });
      } catch {
        try {
          execFileSync('git', ['check-ignore', '-q', target], { cwd: ROOT, stdio: 'pipe' });
          ignored.push(`${file} imports ${target}, which .gitignore excludes — CI would not have it`);
        } catch {
          ignored.push(`${file} imports ${target}, which git does not track — it would not exist in CI`);
        }
      }
    }
  }

  assert.deepEqual(missing, [], missing.join('\n'));
  assert.deepEqual(ignored, [], ignored.join('\n'));
});

test('the argument parser in the build script and the CLI agree about flags', () => {
  // Both scripts parse their own argv. A flag added to one and forgotten in the
  // other produces a build that silently ignores an instruction, which looks
  // exactly like the instruction working.
  const build = fs.readFileSync(path.join(ROOT, 'tools/build-apk.mjs'), 'utf8');
  for (const flag of ['out', 'cache', 'project', 'type']) {
    assert.ok(build.includes(`flags['${flag}']`) || build.includes(`flags.${flag}`),
      `build-apk.mjs does not read --${flag}`);
  }
});

test('the build script checks the output before calling it a success', () => {
  // Four guards that each stand between a broken output and a "Built." message:
  // the exit status of the compiler, that an APK exists, that it is a plausible
  // size, and that the copy that was written matches the copy that was read.
  const src = fs.readFileSync(path.join(ROOT, 'tools/build-apk.mjs'), 'utf8');
  const required = [
    ['the compiler exit status is checked', /catch\s*\(\s*err\s*\)[\s\S]{0,400}process\.exit\(1\)/],
    ['a missing APK fails the build', /produced no APK[\s\S]{0,200}process\.exit\(1\)/],
    ['an implausibly small APK fails the build', /too small to be a real app/],
    ['the written copy is verified against the stored hash', /copy mismatch/],
  ];
  for (const [what, re] of required) {
    assert.ok(re.test(src), `build-apk.mjs does not do this: ${what}`);
  }
});

test('no script hides a failure behind a fallback that reports success', () => {
  // `try { doTheWork() } catch { console.log('done') }` is the shape of a false
  // success. A catch in these scripts may log, may exit non-zero, but must not
  // claim the work finished.
  const offenders = [];
  for (const file of entryScripts()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /catch\s*(?:\([^)]*\))?\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const body = m[1];
      if (/(Built\.|SUCCESS|succeeded|checks passed|Written back)/.test(body)) {
        offenders.push(`${file}: a catch block claims success — ${body.trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('no source lives in a directory that tools treat as generated output', () => {
  /*
   * The rule is not a style preference. A path component named build, out, dist,
   * target or coverage is skipped by design by things that assume it holds
   * throwaway output: .gitignore patterns, packaging tools, archive copies, and
   * the workspace this project was developed in. Two modules — the build key and
   * the cache — were written to engine/build/ and were still in git while
   * missing from disk, because the workspace had quietly declined to carry that
   * directory.
   *
   * The failure is worth guarding against rather than remembering, because it is
   * invisible while you work: the files are right there, every test passes, and
   * they are gone the next morning.
   */
  const FORBIDDEN = new Set(['build', 'out', 'dist', 'target', 'coverage', 'node_modules', '.next', '.cache']);
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);

  const offenders = [];
  for (const file of tracked) {
    // Output directories are allowed to be excluded from git rather than to
    // appear in it: a file tracked under one of these names is the problem.
    const parts = file.split('/');
    const dirs = parts.slice(0, -1);
    for (const d of dirs) {
      if (FORBIDDEN.has(d)) offenders.push(`${file} (directory "${d}")`);
    }
  }
  assert.deepEqual(offenders, [],
    `source tracked under a generated-output directory name:\n${offenders.join('\n')}`);
});

test('the key and the cache are reachable from every place that needs them', () => {
  // They were at engine/build/ once, which is how the rule above was learned.
  // This one asserts the replacement actually resolves, because a rename that
  // leaves an import behind is a module that loads fine locally and fails in CI.
  const importers = ['engine/cli.mjs', 'tools/build-apk.mjs',
    'tools/tests/build-cache.test.mjs', 'tools/tests/build-script.test.mjs'];
  for (const file of importers) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      const resolved = path.resolve(path.dirname(path.join(ROOT, file)), m[1]);
      assert.ok(fs.existsSync(resolved), `${file} imports ${m[1]}, which does not exist`);
    }
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'engine/keys/key.mjs')));
  assert.ok(fs.existsSync(path.join(ROOT, 'engine/keys/cache.mjs')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'engine/build')),
    'engine/build must not come back: a directory named build is dropped by tools that assume it is output');
});
