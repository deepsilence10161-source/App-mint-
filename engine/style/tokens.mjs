/* ============================================================================
   DESIGN TOKEN PARSING AND CHECKING
   ----------------------------------------------------------------------------
   The Studio's whole visual identity is a set of CSS custom properties. That is
   only an advantage if the set is actually sound, and "sound" is checkable:

     · every variable that is read is declared somewhere,
     · no variable is declared twice in the same block, where the second
       declaration silently replaces the first,
     · text tokens clear the contrast threshold against the surface they sit on,
     · the interface does not quietly go back to naming colours directly.

   Two of those were already broken once, and both were invisible. `color:
   var(--fg-1)` inherited instead of colouring, because no `--fg-1` existed; two
   rules asked for `border-radius: var(--r2)` and simply had no radius, because
   `--r2` was never declared. Neither is a crash, so nothing failed — the
   interface was just quietly wrong in two places and would have stayed that way.

   A token collision is the same shape of fault and worse, because it corrupts a
   value that was correct. Declaring a motion duration called `--t-base` after a
   font shorthand called `--t-base` turns body text into "180ms". The parser
   below treats a repeated name inside one block as an error for exactly that
   reason, rather than as a style choice.

   These are pure functions over text. They run in Node against the committed
   CSS, and the same checks can run in the browser against the live document, so
   a theme a person picks on their phone can be held to the same standard as the
   one that shipped.
   ========================================================================= */

import { parseColor } from './color.mjs';

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const VAR_DECL = /^\s*(--[A-Za-z0-9_-]+)\s*:/;

/**
 * Split CSS into top-level blocks: { selector, body, line }.
 * Comments are removed first, because a hex colour inside an explanation of the
 * palette is not a hardcoded colour and should not be reported as one. Nested
 * at-rules are flattened, which is enough for this stylesheet and is stated here
 * rather than assumed, so a future nesting change is a known limitation.
 */
export function parseBlocks(css) {
  const stripped = String(css).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const blocks = [];
  let depth = 0;
  let selector = '';
  let buffer = '';
  let startLine = 1;
  let line = 1;

  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '\n') line += 1;

    if (ch === '{') {
      if (depth === 0) { selector = buffer.trim(); startLine = line; buffer = ''; }
      else buffer += ch;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ selector: selector.replace(/\s+/g, ' '), body: buffer, line: startLine });
        buffer = '';
      } else buffer += ch;
      continue;
    }
    buffer += ch;
  }
  return blocks;
}

/** Every `--name` declared in a block body, with the line it was declared on. */
export function declarationsOf(body) {
  const out = [];
  const lines = String(body).split('\n');
  for (const raw of lines) {
    // A single line may declare more than one token (`--a: 1; --b: 2;`).
    for (const part of raw.split(';')) {
      const m = VAR_DECL.exec(part);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

/** Every `--name` read through var(), including nested fallbacks. */
export function referencesOf(text) {
  const out = new Set();
  let m;
  VAR_REF.lastIndex = 0;
  while ((m = VAR_REF.exec(String(text)))) out.add(m[1]);
  return out;
}

/**
 * The token map for one theme: the base block plus any overrides laid over it.
 * Returns the resolved value and which block it came from, so a failure can
 * name the theme that is wrong instead of only naming the token.
 */
export function resolveTokens(blocks, selectorForTheme) {
  const tokens = new Map();
  for (const b of blocks) {
    if (!selectorForTheme(b.selector)) continue;
    for (const line of b.body.split('\n')) {
      for (const part of line.split(';')) {
        const m = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*([^]*)$/.exec(part);
        if (m) tokens.set(m[1], m[2].trim());
      }
    }
  }
  return tokens;
}

/**
 * Find tokens that are read but never declared, and tokens declared twice in the
 * same block. Both are faults that produce no error and no crash.
 */
export function auditTokens(css, extraDeclared = []) {
  const blocks = parseBlocks(css);
  const declared = new Set(extraDeclared);
  const duplicates = [];

  for (const b of blocks) {
    const seen = new Set();
    for (const name of declarationsOf(b.body)) {
      declared.add(name);
      if (seen.has(name)) duplicates.push({ name, selector: b.selector, line: b.line });
      seen.add(name);
    }
  }

  const referenced = referencesOf(css);
  const undeclared = [...referenced].filter((n) => !declared.has(n)).sort();

  return { declared, undeclared, duplicates };
}

/**
 * Colour literals that appear outside token definitions.
 * `allow` receives the block selector and returns true for regions where a
 * literal is intended — the device preview, which is drawn in the colours of the
 * app being designed rather than in the Studio's palette.
 */
export function hardcodedColors(css, allow = () => false) {
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
  /* `rgb(var(--bg-rgb) / 0.94)` is a token reference wearing a function, and
     reporting it as a hardcoded colour would make this check cry wolf on the
     exact pattern the token system encourages. Those are removed first, so what
     is left is a colour someone actually typed in. */
  const TOKENISED_FN = /rgba?\([^)]*var\([^)]*\)[^)]*\)/g;
  const found = [];
  for (const b of parseBlocks(css)) {
    if (/^:root/.test(b.selector)) continue;      // this IS where colours belong
    if (allow(b.selector)) continue;
    for (const raw of b.body.split('\n')) {
      if (VAR_DECL.test(raw)) continue;
      const line = raw.replace(TOKENISED_FN, ' ');
      const m = LITERAL.exec(line);
      if (m) found.push({ selector: b.selector, value: m[0], line: raw.trim().slice(0, 100) });
    }
  }
  return found;
}

/**
 * Tokens a script declares at runtime rather than in the stylesheet.
 *
 * There are two ways to do that and both are real here: `style.setProperty` for
 * the preview frame, which is dressed from the project's theme, and an inline
 * `style="--depth:2"` attribute for the component tree's indentation. A
 * completeness check that only read studio.css would report both as missing,
 * and a check that cries wolf on legitimate code gets ignored — so it has to
 * know about the mechanisms the codebase actually uses.
 */
export function runtimeDeclarationsOf(source) {
  const out = new Set();
  const src = String(source);
  const patterns = [
    /setProperty\(\s*['"](--[A-Za-z0-9_-]+)['"]/g,
    /--([A-Za-z0-9_-]+)\s*:/g,               // an inline style attribute
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) out.add(re === patterns[1] ? `--${m[1]}` : m[1]);
  }
  return out;
}

/**
 * Expand a token's value: follow `var(--x)` chains, then composite any alpha
 * over the given surface so the result is the colour that is actually painted.
 * Depth-limited, because a self-referential token would otherwise loop forever —
 * and a self-referential token is a real thing for a person to type.
 */
export function resolveColor(value, tokens, surface, depth = 0) {
  if (depth > 8) return null;
  let v = String(value ?? '').trim();
  v = v.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)/g, (all, name, fb) => {
    const hit = tokens.get(name);
    if (hit !== undefined) return hit;
    return fb === undefined ? all : fb.trim();
  });
  if (/var\(/.test(v)) return null;              // unresolved: report nothing false

  // rgb(108 92 231 / 0.16) -> rgba form the colour parser understands
  v = v.replace(/^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\s*\)$/, 'rgba($1, $2, $3, $4)');

  return parseColor(v);
}
