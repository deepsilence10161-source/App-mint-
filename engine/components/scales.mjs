/**
 * SHARED VISUAL CONSTANTS
 * =======================
 * The numbers and glyphs that decide how a screen looks.
 *
 * Why this file exists
 * --------------------
 * There are two things that draw a designed screen: the Android renderer inside
 * the generated app, and the preview inside the Studio. If each of them carries
 * its own copy of "large spacing is 20" then sooner or later the preview shows
 * one thing and the phone shows another, and the design tool quietly stops
 * being trustworthy. That is the single worst failure a tool like this can have,
 * because the user has no way to tell which one is lying.
 *
 * So both read from here. The generator emits these into Java, the preview uses
 * them directly, and a test checks that the Java the generator emits carries the
 * same numbers.
 */

/** Space between and inside things, in dp. */
export const SPACINGS = { none: 0, xs: 2, sm: 6, md: 12, lg: 20, xl: 32 };

/** Text sizes in sp. */
export const TEXT_SIZES = { sm: 12, md: 14, lg: 17, xl: 21, '2xl': 26 };

/** Corner radii in dp. `pill` means fully rounded. */
export const RADII = { none: 0, sm: 6, md: 12, lg: 20, pill: 999 };

/** Heights for media in dp, used when a component asks for a size rather than a number. */
export const HEIGHTS = { xs: 60, sm: 110, md: 180, lg: 260, xl: 420 };

/**
 * Icons are single characters rather than image files. A generated app that
 * needs a drawable for every icon is a generated app that breaks when one is
 * missing, and an icon font is another thing to download. A character is
 * always there, always renders, and costs nothing — and no action in the
 * library can reach outside the app, which is a security property as much as a
 * practical one.
 */
export const ICON_GLYPHS = {
  home: '\u2302',
  search: '\u2315',
  menu: '\u2261',
  back: '\u2190',
  close: '\u2715',
  add: '+',
  settings: '\u2699',
  user: '\u25CF',
  share: '\u2197',
  star: '\u2605',
  cart: '\u25A3',
  bell: '\u25D0',
};

/** What an icon shows when the requested one is not in the table. */
export const ICON_FALLBACK = '\u25CB';

/** The icon names a person can choose from, in a fixed order. */
export const ICON_NAMES = Object.keys(ICON_GLYPHS);

/** Look up a glyph, never failing. */
export function iconGlyph(name) {
  return ICON_GLYPHS[name] ?? ICON_FALLBACK;
}

/** Look up a scale value, never failing. */
export function scale(table, key, fallback) {
  return table[key] ?? fallback;
}

/**
 * Escape a character for a Java string literal.
 * Only the four things that need it are escaped; everything else, including
 * every glyph above, is written as a `\uXXXX` escape so the file is pure ASCII
 * and cannot be mangled by an editor or a transfer that changes encoding.
 */
export function javaEscape(glyph) {
  const code = glyph.codePointAt(0);
  if (glyph === '"') return '\\"';
  if (glyph === '\\') return '\\\\';
  if (glyph === "'") return "\\'";
  if (code < 128) return glyph;
  return '\\u' + code.toString(16).toUpperCase().padStart(4, '0');
}
