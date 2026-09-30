/**
 * MINIMAL PNG ENCODER + SOFTWARE RASTERIZER (zero dependencies)
 * ============================================================
 * Why this exists: a generated Android app must ship a real launcher icon.
 * A placeholder or a missing icon is a defect we found in the existing repos,
 * and every extra npm package is one more thing that can break offline or grow
 * the dependency tree. Node's built-in zlib is all PNG actually needs.
 *
 * Deterministic: the same spec always yields byte-identical PNGs, so the
 * content-addressed build cache can rely on the hash.
 */

import zlib from 'node:zlib';

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode an RGBA buffer to a PNG.
 * @param {Buffer} rgba length must be width*height*4
 */
export function encodePNG(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: None (keeps output deterministic & simple)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- colour helpers ---------------- */
export function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* ---------------- canvas with 4x supersampling ---------------- */
export class Canvas {
  constructor(size, ss = 4) {
    this.size = size;
    this.ss = ss;
    this.w = size * ss;
    this.buf = new Float32Array(this.w * this.w * 4); // premultiplied-ish linear accumulation
  }

  /** composite a single device pixel at supersample coords (floats allowed) */
  _px(x, y, rgba, alphaMul = 1) {
    const [r, g, b, a] = rgba;
    const idx = (y * this.w + x) * 4;
    const src = (a / 255) * alphaMul;
    const dstA = this.buf[idx + 3] / 255;
    const outA = src + dstA * (1 - src);
    if (outA <= 0) return;
    this.buf[idx]     = (r * src + this.buf[idx]     * dstA * (1 - src)) / outA;
    this.buf[idx + 1] = (g * src + this.buf[idx + 1] * dstA * (1 - src)) / outA;
    this.buf[idx + 2] = (b * src + this.buf[idx + 2] * dstA * (1 - src)) / outA;
    this.buf[idx + 3] = outA * 255;
  }

  /** fill every supersampled pixel where `fn(x1,y1) === true` (x1,y1 in 0..1 space) */
  fill(test, colorFn) {
    const W = this.w, S = this.size;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W, v = (y + 0.5) / W;
        const hit = test(u, v);
        if (!hit) continue;
        const c = typeof colorFn === 'function' ? colorFn(u, v) : colorFn;
        this._px(x, y, c);
      }
    }
  }

  /** downsample supersampled buffer to final RGBA */
  toRGBA() {
    const S = this.size, ss = this.ss, out = Buffer.alloc(S * S * 4);
    const n = ss * ss;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < ss; dy++) {
          for (let dx = 0; dx < ss; dx++) {
            const i = ((y * ss + dy) * this.w + (x * ss + dx)) * 4;
            const pa = this.buf[i + 3] / 255;
            r += this.buf[i] * pa; g += this.buf[i + 1] * pa; b += this.buf[i + 2] * pa;
            a += pa;
          }
        }
        const idx = (y * S + x) * 4;
        if (a > 0) { out[idx] = clamp255(r / a); out[idx + 1] = clamp255(g / a); out[idx + 2] = clamp255(b / a); }
        out[idx + 3] = clamp255((a / n) * 255);
      }
    }
    return out;
  }

  toPNG() { return encodePNG(this.toRGBA(), this.size, this.size); }
}

/* ---------------- shapes ---------------- */
export const shapes = {
  roundedRect(radius) {
    return (u, v) => {
      const r = Math.min(radius, 0.5);
      const dx = Math.max(r - u, 0, u - (1 - r));
      const dy = Math.max(r - v, 0, v - (1 - r));
      return Math.hypot(dx, dy) <= r || (u >= r && u <= 1 - r) || (v >= r && v <= 1 - r) ? true : Math.hypot(dx, dy) <= r;
    };
  },
  circle: () => (u, v) => Math.hypot(u - 0.5, v - 0.5) <= 0.5,
  /** isometric "package" cube — the App Mint mark: an app being minted */
  cube(scale = 1) {
    // three rhombi forming a hexagon-ish cube
    const s = 0.5 * scale;
    const c = 0.5;
    const top = [[c, c - s], [c + s * 0.866, c - s * 0.5], [c, c], [c - s * 0.866, c - s * 0.5]];
    const left = [[c - s * 0.866, c - s * 0.5], [c, c], [c, c + s], [c - s * 0.866, c + s * 0.5]];
    const right = [[c + s * 0.866, c - s * 0.5], [c + s * 0.866, c + s * 0.5], [c, c + s], [c, c]];
    const inPoly = (pt, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    return (u, v) => inPoly([u, v], top) || inPoly([u, v], left) || inPoly([u, v], right);
  },
  /** a downward chevron/arrow — "convert & ship" */
  arrow(scale = 1) {
    return (u, v) => {
      const w = 0.16 * scale;
      const cx = 0.5;
      const stemTop = 0.5 - 0.26 * scale, stemBot = 0.5 + 0.08 * scale;
      const inStem = Math.abs(u - cx) <= w * 0.55 && v >= stemTop && v <= stemBot;
      const headTop = 0.5 + 0.02 * scale, tip = 0.5 + 0.3 * scale;
      const t = (v - headTop) / (tip - headTop);
      const inHead = v >= headTop && v <= tip && Math.abs(u - cx) <= w * (1 - t) * 1.7;
      return inStem || inHead;
    };
  },
};

/** vertical/diagonal linear gradient between two colours */
export function gradient(from, to, angleDeg = 135) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  const fromRgb = hexToRgb(from), toRgb = hexToRgb(to);
  return (u, v) => {
    let t = (u * dx + v * dy);
    t = (t - Math.min(0, dx) - Math.min(0, dy)) / (Math.abs(dx) + Math.abs(dy) || 1);
    t = Math.max(0, Math.min(1, t));
    return [...mix(fromRgb, toRgb, t), 255];
  };
}
