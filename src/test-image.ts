// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * test-image.ts — generate a small PNG (red/blue/green blocks) with zero deps,
 * used by `/vision test` to verify the full describe pipeline end-to-end.
 */
import { deflateSync } from "node:zlib";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CRC_TABLE = (() => {
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export async function generateTestImage(): Promise<string> {
  const w = 192;
  const h = 64;
  // RGB scanlines, filter byte 0 per row
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      if (x < w / 3) {
        raw[p] = 255; raw[p + 1] = 20; raw[p + 2] = 20;        // red
      } else if (x < (2 * w) / 3) {
        raw[p] = 20; raw[p + 1] = 20; raw[p + 2] = 255;        // blue
      } else {
        raw[p] = 20; raw[p + 1] = 200; raw[p + 2] = 20;        // green
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const dir = await mkdtemp(join(tmpdir(), "pi-vision-test-"));
  const p = join(dir, "test.png");
  await writeFile(p, png);
  return p;
}