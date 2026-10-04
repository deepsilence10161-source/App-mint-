/* ============================================================================
   COLOUR MATHEMATICS
   ----------------------------------------------------------------------------
   Small, dependency-free helpers for reasoning about colour. They exist because
   "is this readable" is a measurable question with a published answer (WCAG 2.x
   relative luminance and contrast ratio), and an interface that asserts it is
   accessible without computing it is asserting a preference, not a fact.

   Nothing here touches the DOM, so the same numbers can be checked in Node by
   the test suite and in the browser by the Studio. That matters: a contrast
   check that only runs in CI would not be able to warn a person who has just
   picked a theme that fails, and a check that only runs in the browser would
   not stop a bad token being committed.
   ========================================================================= */

/**
 * Parse the colour notations this project actually produces into RGB 0-255.
 * Deliberately narrow: #rgb, #rrggbb, rgb()/rgba() in both the comma and the
 * space-separated syntax. Anything else returns null rather than a guess, so a
 * caller can distinguish "not a colour" from "a colour I could not read".
 */
export function parseColor(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (fn) {
    const a = fn[4] === undefined ? 1 : (fn[4].endsWith('%') ? Number.parseFloat(fn[4]) / 100 : Number.parseFloat(fn[4]));
    return {
      r: Math.round(Number.parseFloat(fn[1])),
      g: Math.round(Number.parseFloat(fn[2])),
      b: Math.round(Number.parseFloat(fn[3])),
      a: Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1,
    };
  }

  return null;
}

/**
 * WCAG 2.x relative luminance. The sRGB transfer function is not linear, so the
 * low end is scaled rather than gamma-corrected — that detail is the whole
 * reason a naive average of the channels gives the wrong answer for dark text
 * on a dark background.
 */
export function luminance(color) {
  const c = typeof color === 'string' ? parseColor(color) : color;
  if (!c) return null;
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/**
 * WCAG contrast ratio, 1:1 (identical) to 21:1 (black on white).
 * Returns null if either side is not a colour, never a flattering default.
 */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Composite a translucent foreground over an opaque background.
 * Necessary because the tokens express tints as alpha over a surface, and the
 * contrast that reaches the eye is that of the composited result — checking the
 * un-composited value would grade a colour that is never actually displayed.
 */
export function over(fg, bg) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!f || !b) return null;
  const a = f.a;
  const mix = (x, y) => Math.round(x * a + y * (1 - a));
  return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b), a: 1 };
}

export function toHex(c) {
  if (!c) return null;
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** True when the pair clears the WCAG AA threshold for the given text size. */
export function meetsAA(a, b, { large = false } = {}) {
  const r = contrastRatio(a, b);
  return r !== null && r >= (large ? 3 : 4.5);
}
