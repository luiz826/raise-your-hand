// Generates the extension icons (16/48/128 PNG) — a white raised hand on the
// brand-blue rounded square. Self-contained: renders supersampled RGBA and
// encodes PNG with Node's zlib (no image dependency). Run: npm run icons

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// ---- minimal PNG encoder ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(size: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---- shape helpers (normalized 0..1 coords) ----
function inRoundedRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = px < x0 + r ? x0 + r : px > x1 - r ? x1 - r : px;
  const cy = py < y0 + r ? y0 + r : py > y1 - r ? y1 - r : py;
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}
const finger = (nx: number, ny: number, cx: number, top: number, hw: number) =>
  inRoundedRect(nx, ny, cx - hw, top, cx + hw, 0.54, hw);

// A raised open hand: palm + four fingers + thumb.
function inHand(nx: number, ny: number): boolean {
  if (inRoundedRect(nx, ny, 0.31, 0.46, 0.71, 0.78, 0.09)) return true; // palm
  if (finger(nx, ny, 0.375, 0.25, 0.05)) return true; // index
  if (finger(nx, ny, 0.475, 0.20, 0.05)) return true; // middle
  if (finger(nx, ny, 0.575, 0.23, 0.05)) return true; // ring
  if (finger(nx, ny, 0.665, 0.31, 0.046)) return true; // pinky
  if (inRoundedRect(nx, ny, 0.20, 0.52, 0.33, 0.68, 0.06)) return true; // thumb
  return false;
}

function render(size: number): Buffer {
  const S = 4; // supersample
  const W = size * S;
  const hi = Buffer.alloc(W * W * 4);
  const rSquare = W * 0.22;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!inRoundedRect(x, y, 0, 0, W, W, rSquare)) continue; // transparent outside
      const nx = x / W, ny = y / W;
      if (inHand(nx, ny)) {
        hi[i] = 255; hi[i + 1] = 255; hi[i + 2] = 255; hi[i + 3] = 255;
      } else {
        hi[i] = 31; hi[i + 1] = 111; hi[i + 2] = 235; hi[i + 3] = 255; // #1f6feb
      }
    }
  }
  // box-downsample S×S for antialiasing
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < S; dy++)
        for (let dx = 0; dx < S; dx++) {
          const j = ((y * S + dy) * W + (x * S + dx)) * 4;
          const af = hi[j + 3];
          r += hi[j] * af; g += hi[j + 1] * af; b += hi[j + 2] * af; a += af;
        }
      const o = (y * size + x) * 4;
      out[o + 3] = Math.round(a / (S * S));
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
    }
  }
  return out;
}

const dir = path.join("extension", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
