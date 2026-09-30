/**
 * JAVA GENERATION LINT
 * ====================
 * The generator writes Java. Java is not the language the generator is written
 * in, and every one of Java's escaping rules has to survive the trip through a
 * JavaScript template literal. That is a systematic hazard, not a one-off typo,
 * so it gets a systematic guard.
 *
 * This runs immediately after generation, before any compiler is started. It
 * catches, in about a millisecond, the failures that otherwise cost a 35-second
 * Gradle round trip — or worse, reach a user as a broken app.
 *
 * What it checks, and why each one is here:
 *
 *   escape      A backslash inside a string that is not a legal Java escape.
 *               Seen in practice: emitted `"\|"` instead of `"\\|"`.
 *   unicode     A `\u` escape that is not followed by four hex digits. Java
 *               processes these before lexing, so a bad one breaks the file in
 *               ways the error message does not explain.
 *   interface   A generated class that says `implements X` but does not actually
 *               implement every method of X. Seen in practice: an internal
 *               helper was named the same as an interface method and declared
 *               private, so the class silently stopped satisfying the interface.
 *               This is the most expensive kind of bug, because the code looks
 *               correct and a private method of the right name looks like an
 *               implementation.
 *   filename    A public class that is not in a file of the same name. Java
 *               refuses to compile it, and the message blames the wrong file.
 *   balance     Unbalanced braces or parentheses, which almost always means a
 *               template literal was closed early.
 *
 * Scope, stated honestly: this is a focused lint for code this generator
 * produces, not a general Java parser. It does not type-check, resolve imports,
 * or understand generics. It is deliberately strict about the four things above
 * and deliberately silent about everything else, because a linter that cries
 * wolf gets ignored.
 */

const ESCAPES = new Set(['b', 't', 'n', 'f', 'r', '"', "'", '\\']);

/* A statement that happens to be followed by "(" looks exactly like a method
   header. These words can never be a return type, so rejecting them keeps
   `return helper(` from being read as a method called helper. */
const NOT_A_TYPE = new Set([
  'return', 'new', 'if', 'else', 'while', 'for', 'switch', 'catch', 'do', 'throw',
  'try', 'synchronized', 'assert', 'case', 'instanceof', 'super', 'this', 'yield',
]);

/**
 * Walk the source once, tracking lexical state, and collect:
 *  - problems
 *  - declared interfaces and their method names
 *  - classes and what they implement
 *  - methods declared in each class
 */
function scan(source, fileName) {
  const problems = [];
  const classes = [];
  const interfaces = new Map(); // name -> [{name, arity}]
  const methods = new Map(); // className -> [{name, arity, visibility, line}]
  const implemented = []; // {className, names:[], line}

  let i = 0;
  let line = 1;
  let braces = 0;
  let parens = 0;
  let stack = []; // {kind:'class'|'interface', name}
  const n = source.length;

  const bump = (s) => { for (const ch of s) if (ch === '\n') line++; };

  while (i < n) {
    const ch = source[i];

    /* line comment */
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    /* block comment */
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      bump(source.slice(i, end === -1 ? n : end));
      i = end === -1 ? n : end + 2;
      continue;
    }
    /* string literal */
    if (ch === '"') {
      const startLine = line;
      i++;
      while (i < n && source[i] !== '"') {
        if (source[i] === '\n') { line++; i++; continue; }
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (esc === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              problems.push({
                file: fileName, line: startLine, kind: 'unicode',
                message: `A \\u escape is not followed by four hex digits (found "${hex}"). Java resolves these before it lexes the file.`,
              });
              i += 2; continue;
            }
            i += 6; continue;
          }
          if (!ESCAPES.has(esc)) {
            problems.push({
              file: fileName, line: startLine, kind: 'escape',
              message: `"\\${esc}" is not a legal Java escape inside a string. In Java a literal backslash must itself be escaped, so a regular expression that means "\\${esc}" has to be written "\\\\${esc}".`,
            });
            i += 2; continue;
          }
          i += 2; continue;
        }
        i++;
      }
      i++;
      continue;
    }
    /* char literal — same rules, single character */
    if (ch === "'") {
      const startLine = line;
      i++;
      while (i < n && source[i] !== "'") {
        if (source[i] === '\n') break;
        if (source[i] === '\\') {
          if (source[i + 1] === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              problems.push({ file: fileName, line: startLine, kind: 'unicode', message: `A \\u escape in a character literal is malformed ("${hex}").` });
            }
            i += 6; continue;
          }
          if (!ESCAPES.has(source[i + 1])) {
            problems.push({ file: fileName, line: startLine, kind: 'escape', message: `"\\${source[i + 1]}" is not a legal Java escape inside a character literal.` });
          }
          i += 2; continue;
        }
        i++;
      }
      i++;
      continue;
    }

    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '(') parens++;
    if (ch === ')') parens--;

    /* declarations. Generated code is written in a fixed style, so a direct
       match is reliable here — and if the style ever changes, the lint goes
       quiet rather than producing nonsense. */
    if (/\w/.test(ch) && (i === 0 || !/[\w$]/.test(source[i - 1]))) {
      const rest = source.slice(i, i + 900);
      let m;
      if ((m = /^(public\s+|final\s+|abstract\s+)*class\s+(\w+)(?:\s+extends\s+[\w.<>]+)?(?:\s+implements\s+([\w.,\s<>]+?))?\s*\{/.exec(rest))) {
        const name = m[2];
        classes.push({ name, isPublic: /^\s*public/.test(rest) || /public\s+class/.test(m[0]), line });
        stack.push({ kind: 'class', name, depth: braces + 1 });
        if (m[3]) implemented.push({ className: name, names: m[3].split(',').map((s) => s.trim().replace(/<.*$/, '')).filter(Boolean), line, depth: braces });
        i += m[0].length - 1; continue;
      }
      if ((m = /^(public\s+|abstract\s+|static\s+)*interface\s+(\w+)/.exec(rest))) {
        interfaces.set(m[2], []);
        stack.push({ kind: 'interface', name: m[2], depth: braces + 1 });
        i += m[0].length - 1; continue;
      }
    }

    /* methods and interface method declarations.
       Both are read at the opening parenthesis — that is the only point where
       a declaration and a call can be told apart, because the character after
       the matching ")" says which one it is: ";" declares, "{" implements. */
    if (ch === '(') {
      // A declaration can only begin after a newline, a brace or a semicolon.
      // Cutting there first means a declaration written on the same line as
      // its enclosing brace is still read correctly.
      const rawHead = source.slice(Math.max(0, i - 400), i);
      const cut = Math.max(rawHead.lastIndexOf('\n'), rawHead.lastIndexOf('{'), rawHead.lastIndexOf('}'), rawHead.lastIndexOf(';'));
      const segment = rawHead.slice(cut + 1);
      const h = /^[ \t]*((?:@\w+(?:\([^)]*\))?[ \t]*)*)(public|protected|private)?[ \t]*(?:static[ \t]+)?(?:final[ \t]+)?(?:abstract[ \t]+)?(?:synchronized[ \t]+)?([\w<>\[\],.\s?]+?)[ \t]+(\w+)[ \t]*$/.exec(segment);
      if (h) {
        const returnType = h[3].trim().split(/\s+/).pop();
        if (!NOT_A_TYPE.has(returnType)) {
          let depth = 0;
          let j = i;
          for (; j < n; j++) {
            if (source[j] === '(') depth++;
            else if (source[j] === ')') { depth--; if (depth === 0) break; }
          }
          const paramsRaw = source.slice(i + 1, j);
          const arity = paramsRaw.trim() === '' ? 0 : splitTopLevel(paramsRaw).length;
          let k = j + 1;
          while (k < n && /\s/.test(source[k])) k++;
          const follows = source[k];
          const current = stack[stack.length - 1];
          if (current && current.kind === 'interface' && follows === ';') {
            interfaces.get(current.name).push({ name: h[4], arity });
          } else if (current && follows === '{') {
            let at = methods.get(current.name);
            if (!at) { at = []; methods.set(current.name, at); }
            at.push({ name: h[4], arity, visibility: h[2] || 'package', line });
          }
          bump(source.slice(i, j));
          i = j;
          continue;
        }
      }
    }

    if (i > 0 && /}/.test(ch) && stack.length && stack[stack.length - 1].depth > braces) stack.pop();
    i++;
  }

  if (braces !== 0)
    problems.push({ file: fileName, line, kind: 'balance', message: `Braces do not balance (${braces > 0 ? braces + ' unclosed' : Math.abs(braces) + ' extra'} at the end of the file). This usually means a template literal closed early.` });
  if (parens !== 0)
    problems.push({ file: fileName, line, kind: 'balance', message: `Parentheses do not balance (${parens > 0 ? parens + ' unclosed' : Math.abs(parens) + ' extra'}).` });

  return { problems, classes, interfaces, methods, implemented };
}

function splitTopLevel(s) {
  const out = [];
  let depth = 0; let cur = '';
  for (const ch of s) {
    if ('<([{'.includes(ch)) depth++;
    if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Lint a set of generated files.
 * @param {{path:string,data:string|Uint8Array}[]} files
 * @returns {{ok:boolean, errors:object[], warnings:object[]}}
 */
/** Exposed for the test suite: shows what the scanner understood from a file.
 *  A lint that silently understands nothing is worse than no lint at all. */
export function scanForTests(source, fileName = 'Test.java') {
  return scan(source, fileName);
}

export function lintGeneratedJava(files) {
  const errors = [];
  const allInterfaces = new Map();
  const scans = [];

  for (const f of files) {
    if (!/\.java$/.test(f.path)) continue;
    const data = typeof f.data === 'string' ? f.data : new TextDecoder().decode(f.data);
    const fileName = f.path.split('/').pop();
    const s = scan(data, fileName);
    scans.push({ fileName, data, ...s });
    errors.push(...s.problems);
    for (const [k, v] of s.interfaces) allInterfaces.set(k, v.map((m) => ({ ...m, from: fileName })));

    // a public class must live in a file of its own name
    for (const c of s.classes) {
      const declaredPublic = new RegExp(`public\\s+(?:final\\s+|abstract\\s+)?class\\s+${c.name}\\b`).test(data);
      if (declaredPublic && c.name + '.java' !== fileName) {
        errors.push({
          file: fileName, line: c.line, kind: 'filename',
          message: `The public class ${c.name} is declared in ${fileName}. Java requires a public class to be in a file with its own name.`,
        });
      }
    }
  }

  /* interface completeness — the check that would have caught the private
     method that silently shadowed an interface method */
  for (const s of scans) {
    for (const impl of s.implemented) {
      for (const ifaceName of impl.names) {
        // `implements Actions.Navigator` names an interface that lives in
        // another file, so match on the last segment as well as the full name.
        const iface = allInterfaces.get(ifaceName) || allInterfaces.get(String(ifaceName).split('.').pop());
        if (!iface || !iface.length) continue; // an interface from a library, not ours
        const own = s.methods.get(impl.className) || [];
        for (const want of iface) {
          const hit = own.find((m) => m.name === want.name && m.arity === want.arity);
          if (!hit) {
            errors.push({
              file: s.fileName, line: impl.line, kind: 'interface',
              message: `${impl.className} says it implements ${ifaceName}, but there is no ${want.name}(${want.arity} argument${want.arity === 1 ? '' : 's'}) method in it. A method of the right name is not enough — Java requires the declared method, with the right visibility.`,
            });
          } else if (hit.visibility === 'private') {
            errors.push({
              file: s.fileName, line: hit.line, kind: 'interface',
              message: `${impl.className} implements ${ifaceName}, but its ${want.name} method is private. A private method does not satisfy an interface, and the code around it otherwise looks correct.`,
            });
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings: [] };
}

/** Human-readable summary, used by the CLI and the build report. */
export function formatLint(result) {
  if (result.ok) return 'generated Java: clean';
  const lines = [`generated Java: ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}`];
  for (const e of result.errors) lines.push(`  ${e.file}:${e.line}  [${e.kind}] ${e.message}`);
  return lines.join('\n');
}
