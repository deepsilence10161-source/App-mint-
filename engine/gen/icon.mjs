/**
 * LAUNCHER ICON GENERATOR
 * =======================
 * Generates every density of a real adaptive icon from the project theme.
 *
 * This closes a defect found in the existing repositories: the shipped APK
 * contained NO launcher-icon resource at all and fell back to Android's generic
 * platform glyph (`@android:drawable/ic_menu_compass`).
 *
 * Outputs per density (mdpi 1x, hdpi 1.5x, xhdpi 2x, xxhdpi 3x, xxxhdpi 4x):
 *   mipmap-*dpi/ic_launcher.png             48dp legacy square
 *   mipmap-*dpi/ic_launcher_round.png       48dp legacy circle
 *   mipmap-*dpi/ic_launcher_foreground.png  108dp adaptive foreground (glyph
 *                                           inside the 72dp safe zone)
 * plus:
 *   mipmap-anydpi-v26/ic_launcher.xml       adaptive-icon binding
 *   mipmap-anydpi-v26/ic_launcher_round.xml
 *   values/ic_launcher_background.xml       background colour
 */

import { Canvas, shapes, gradient, hexToRgb } from './png.mjs';

const DENSITIES = [
  { name: 'mdpi',    scale: 1 },
  { name: 'hdpi',    scale: 1.5 },
  { name: 'xhdpi',   scale: 2 },
  { name: 'xxhdpi',  scale: 3 },
  { name: 'xxxhdpi', scale: 4 },
];

const LEGACY_DP = 48;
const ADAPTIVE_DP = 108;
const SAFE_ZONE = 72 / 108; // glyph must stay inside the centre 72dp

/** Pick the mark for this project. Deterministic: derived from the spec only. */
function pickMark(spec) {
  const explicit = spec?.theme?.iconShape;
  if (explicit && shapes[explicit]) return { fn: shapes[explicit], name: explicit };
  const pkg = (spec?.identity?.packageName || 'app').toLowerCase();
  const marks = ['cube', 'arrow'];
  const idx = [...pkg].reduce((a, c) => a + c.charCodeAt(0), 0) % marks.length;
  return { fn: shapes[marks[idx]], name: marks[idx] };
}

function darken(hex, amount = 0.35) {
  const [r, g, b] = hexToRgb(hex);
  return `#${[r * (1 - amount), g * (1 - amount), b * (1 - amount)]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * @returns {{files: Array<{path:string, data:Buffer|string}>, mark:string}}
 */
export function generateIcons(spec) {
  const theme = spec?.theme || {};
  const primary = theme.primary || '#2563EB';
  const accent = theme.accent || '#22D3EE';
  const bgTop = primary;
  const bgBottom = darken(primary, 0.42);
  const mark = pickMark(spec);

  const files = [];

  for (const d of DENSITIES) {
    const legacyPx = Math.round(LEGACY_DP * d.scale);

    // ---- legacy square ------------------------------------------------
    {
      const c = new Canvas(legacyPx, 4);
      c.fill(shapes.roundedRect(0.22), gradient(bgTop, bgBottom, 135));
      c.fill((u, v) => mark.fn(0.62)(u, v), [255, 255, 255, 255]);
      files.push({ path: `mipmap-${d.name}/ic_launcher.png`, data: c.toPNG() });
    }

    // ---- legacy round -------------------------------------------------
    {
      const c = new Canvas(legacyPx, 4);
      c.fill(shapes.circle(), gradient(bgTop, bgBottom, 135));
      c.fill((u, v) => mark.fn(0.62)(u, v), [255, 255, 255, 255]);
      files.push({ path: `mipmap-${d.name}/ic_launcher_round.png`, data: c.toPNG() });
    }

    // ---- adaptive foreground -----------------------------------------
    // Transparent PNG. The visible area of an adaptive icon is the centre
    // 72dp of 108dp, so the glyph is scaled into that box to survive every
    // launcher mask (circle, squircle, teardrop) without being cropped.
    {
      const fgPx = Math.round(ADAPTIVE_DP * d.scale);
      const c = new Canvas(fgPx, 4);
      const inset = (1 - SAFE_ZONE) / 2;
      const inner = (u, v) => {
        const uu = (u - inset) / SAFE_ZONE;
        const vv = (v - inset) / SAFE_ZONE;
        if (uu < 0 || uu > 1 || vv < 0 || vv > 1) return false;
        return mark.fn(0.70)(uu, vv);
      };
      c.fill(inner, [255, 255, 255, 255]);
      files.push({ path: `mipmap-${d.name}/ic_launcher_foreground.png`, data: c.toPNG() });
    }
  }

  // ---- adaptive icon bindings ------------------------------------------
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  files.push({ path: 'mipmap-anydpi-v26/ic_launcher.xml', data: adaptive });
  files.push({ path: 'mipmap-anydpi-v26/ic_launcher_round.xml', data: adaptive });
  files.push({
    path: 'values/ic_launcher_background.xml',
    data: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Generated from theme.primary ("${primary}"). -->
    <color name="ic_launcher_background">${primary}</color>
</resources>
`,
  });

  return { files, mark: mark.name, accent };
}
