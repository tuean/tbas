/**
 * Generate TBAS PNG icons without any image dependency.
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, sum]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

function draw(size) {
  const ss = 4;
  const S = size * ss;
  const big = Buffer.alloc(S * S * 4);
  const bars = [
    { x0: 0.30, x1: 0.70, y0: 0.285, y1: 0.375, a: 0.55 },
    { x0: 0.23, x1: 0.77, y0: 0.455, y1: 0.545, a: 0.8 },
    { x0: 0.30, x1: 0.70, y0: 0.625, y1: 0.715, a: 1.0 },
  ];
  const radius = 0.055;
  const shellRadius = 0.235;

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const nx = (x + 0.5) / S;
      const ny = (y + 0.5) / S;
      if (!insideRoundedRect(nx, ny, 1, 1, shellRadius)) continue;
      const t = Math.min(1, Math.max(0, (nx + ny) / 2));
      let r = 109 + (139 - 109) * t;
      let g = 139 + (92 - 139) * t;
      let b = 255 + (246 - 255) * t;
      // soft top-left highlight
      const glow = Math.max(0, 1 - Math.hypot(nx - 0.2, ny - 0.14) * 2.8) * 20;
      r = Math.min(255, r + glow);
      g = Math.min(255, g + glow);
      b = Math.min(255, b + glow);

      for (const bar of bars) {
        if (!insideRoundedRect(nx, ny, 1, 1, 0)) continue;
        if (nx < bar.x0 || nx > bar.x1 || ny < bar.y0 || ny > bar.y1) continue;
        const localRadius = Math.min((bar.y1 - bar.y0) / 2, radius);
        if (!insideRoundedRect(nx - bar.x0, ny - bar.y0, bar.x1 - bar.x0, bar.y1 - bar.y0, localRadius)) continue;
        r = r * (1 - bar.a) + 255 * bar.a;
        g = g * (1 - bar.a) + 255 * bar.a;
        b = b * (1 - bar.a) + 255 * bar.a;
      }

      const i = (y * S + x) * 4;
      big[i] = Math.round(r);
      big[i + 1] = Math.round(g);
      big[i + 2] = Math.round(b);
      big[i + 3] = 255;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const i = ((y * ss + sy) * S + (x * ss + sx)) * 4;
          const alpha = big[i + 3] / 255;
          r += big[i] * alpha;
          g += big[i + 1] * alpha;
          b += big[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return out;
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, draw(size));
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
