// Produces packages/vscode/icon.png — a 128x128 marketplace-ready
// placeholder icon. Pure Node stdlib; no dependencies so the regen
// script stays runnable in CI without install.
//
// Design: deep navy background, accent blue "state slot" with a white
// bookmark dot in the middle. Replace with a designed SVG-sourced PNG
// when the brand assets land.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Buffer } from "node:buffer";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const W = 128;
const H = 128;

const navy = [0x0b, 0x2d, 0x4e, 0xff];
const accent = [0x22, 0x66, 0xcc, 0xff];
const white = [0xff, 0xff, 0xff, 0xff];

const pixels = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let c = navy;

    // Rounded-ish inner rectangle
    const margin = 16;
    const r = 12;
    const inBox =
      x >= margin && x < W - margin && y >= margin && y < H - margin;
    const cornerCut =
      (x < margin + r && y < margin + r && (margin + r - x) ** 2 + (margin + r - y) ** 2 > r * r) ||
      (x >= W - margin - r && y < margin + r && (x - (W - margin - r)) ** 2 + (margin + r - y) ** 2 > r * r) ||
      (x < margin + r && y >= H - margin - r && (margin + r - x) ** 2 + (y - (H - margin - r)) ** 2 > r * r) ||
      (x >= W - margin - r && y >= H - margin - r && (x - (W - margin - r)) ** 2 + (y - (H - margin - r)) ** 2 > r * r);
    if (inBox && !cornerCut) c = accent;

    // Bookmark dot
    const cx = W / 2;
    const cy = H / 2;
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    if (d2 < 22 * 22) c = white;

    pixels[i] = c[0];
    pixels[i + 1] = c[1];
    pixels[i + 2] = c[2];
    pixels[i + 3] = c[3];
  }
}

const scanlineLen = W * 4;
const raw = Buffer.alloc(H * (1 + scanlineLen));
for (let y = 0; y < H; y++) {
  raw[y * (1 + scanlineLen)] = 0; // filter: None
  pixels.copy(
    raw,
    y * (1 + scanlineLen) + 1,
    y * scanlineLen,
    (y + 1) * scanlineLen
  );
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression: zlib
ihdr[11] = 0; // filter: adaptive
ihdr[12] = 0; // interlace: none

const idat = deflateSync(raw);

const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = "packages/vscode/icon.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
