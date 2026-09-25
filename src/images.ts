// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * images.ts — image loading, format detection, conversion and caching.
 *
 * Native formats (png/jpeg/gif/webp/bmp) are detected by magic bytes and pass
 * straight through. Non-native formats (heic/heif/avif/tiff/svg/ico/...) are
 * converted to JPEG via a conversion chain, using bundled npm dependencies:
 *   1. heic-convert (bundled dep, pure JS/WASM — HEIC/HEIF, no native build)
 *   2. sharp        (bundled dep, prebuilt libvips — AVIF/TIFF/SVG/ICO/WebP)
 *   3. system tools (magick | convert | ffmpeg | heif-convert | sips) — last resort
 * Converted bytes then go through pi's official `resizeImage` when over the
 * configured size limit.
 *
 * Every normalized image is also persisted to a cache directory (default
 * `<tmp>/pi-vision-tool-cache`) with a stable unique file name, so the model
 * can re-analyze the exact same bytes later via `describe_image`.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, stat, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { VisionToolConfig } from "./config";

const execFileP = promisify(execFile);

export interface LoadedImage {
  /** Base64 data ready to send to the vision model (always a native JPEG/PNG/etc). */
  data: string;
  /** MIME of `data` — always a natively vision-supported type. */
  mimeType: string;
  /** Cache file path where the exact analyzed bytes are persisted on disk. */
  cachePath?: string;
  /** Human-readable note about conversion/resize that happened. */
  note?: string;
}

export function sniffFormat(bytes: Buffer): { mime: string; ext: string; convertible: boolean } {
  const len = bytes.length;
  const ascii = (start: number, n: number) => bytes.subarray(start, start + n).toString("ascii");
  if (len >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png", convertible: false };
  }
  if (len >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg", convertible: false };
  }
  if (len >= 6 && ascii(0, 4) === "GIF8") {
    return { mime: "image/gif", ext: "gif", convertible: false };
  }
  if (len >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return { mime: "image/webp", ext: "webp", convertible: false };
  }
  if (len >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { mime: "image/bmp", ext: "bmp", convertible: false };
  }
  // HEIC/HEIF/AVIF (ISO-BMFF "ftyp")
  if (len >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", ext: "avif", convertible: true };
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return { mime: "image/heic", ext: "heic", convertible: true };
    }
    return { mime: "image/heif", ext: "heif", convertible: true };
  }
  // TIFF: "II*\0" (little) or "MM\0*" (big)
  if (len >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) {
    return { mime: "image/tiff", ext: "tiff", convertible: true };
  }
  // SVG / XML
  if (len >= 5 && bytes[0] === 0x3c) {
    const head = bytes.toString("utf8", 0, Math.min(512, len)).toLowerCase();
    if (head.includes("<svg") || head.includes("xmlns=\"http://www.w3.org/2000/svg\"")) {
      return { mime: "image/svg+xml", ext: "svg", convertible: true };
    }
  }
  // ICO: 00 00 01 00
  if (len >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return { mime: "image/x-icon", ext: "ico", convertible: true };
  }
  return { mime: "application/octet-stream", ext: "bin", convertible: true };
}

function convertibleAllowed(ext: string, cfg: VisionToolConfig): boolean {
  return cfg.convertFormats.some((f) => f.toLowerCase().replace(/^\./, "") === ext.toLowerCase());
}

async function convertViaSharp(bytes: Buffer): Promise<Buffer | undefined> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(bytes, { failOn: "none" })
      .rotate() // honor EXIF orientation
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer();
    return out;
  } catch {
    return undefined;
  }
}

async function convertViaHeicConvert(bytes: Buffer): Promise<Buffer | undefined> {
  try {
    const convert = (await import("heic-convert")).default;
    const out = await convert({ buffer: bytes, format: "JPEG", quality: 0.9 });
    return Buffer.from(out);
  } catch {
    return undefined;
  }
}

async function convertViaSystem(bytes: Buffer, ext: string): Promise<Buffer | undefined> {
  const tmpIn = join(tmpdir(), `pvt-in-${randomUUID()}.${ext}`);
  const tmpOut = join(tmpdir(), `pvt-out-${randomUUID()}.jpg`);
  try {
    await writeFile(tmpIn, bytes);
    const attempts: Array<[string, string[]]> = [
      ["magick", ["-auto-orient", tmpIn, tmpOut]],
      ["convert", ["-auto-orient", tmpIn, tmpOut]],
      ["ffmpeg", ["-y", "-loglevel", "error", "-i", tmpIn, "-frames:v", "1", "-q:v", "2", tmpOut]],
      ["heif-convert", [tmpIn, tmpOut]],
      ["sips", ["-s", "format", "jpeg", tmpIn, "--out", tmpOut]],
    ];
    for (const [bin, args] of attempts) {
      try {
        await execFileP(bin, args, { timeout: 30_000 });
        const out = await readFile(tmpOut);
        if (out.length > 0) return out;
      } catch {
        // try next converter
      }
    }
    return undefined;
  } finally {
    await Promise.allSettled([rm(tmpIn, { force: true }), rm(tmpOut, { force: true })]);
  }
}

/** Normalize raw image bytes for the vision model: convert + resize. */
async function normalizeBuffer(
  bytes: Buffer,
  mimeHint: string | undefined,
  cfg: VisionToolConfig,
): Promise<{ data: string; mimeType: string; note?: string }> {
  const sniffed = sniffFormat(bytes);
  let buf = bytes;
  let mime = sniffed.mime !== "application/octet-stream" ? sniffed.mime : mimeHint ?? "image/png";
  const noteParts: string[] = [];

  if (sniffed.convertible && convertibleAllowed(sniffed.ext, cfg)) {
    // Conversion chain: heic-convert (pure JS/WASM, HEIC/HEIF) -> sharp
    // (prebuilt libvips: AVIF/TIFF/SVG/ICO/WebP) -> system tools (last resort).
    const converted =
      (await convertViaHeicConvert(bytes)) ??
      (await convertViaSharp(bytes)) ??
      (await convertViaSystem(bytes, sniffed.ext));
    if (converted) {
      buf = converted;
      mime = "image/jpeg";
      noteParts.push(`${sniffed.ext.toUpperCase()} → JPEG`);
    } else {
      throw new Error(
        `format "${sniffed.ext}" could not be converted: heic-convert and sharp failed, and no system converter ` +
          `(magick/convert/ffmpeg/heif-convert) is available. Reinstall dependencies (npm i heic-convert sharp).`,
      );
    }
  } else if (sniffed.convertible && !convertibleAllowed(sniffed.ext, cfg)) {
    throw new Error(`unsupported image format "${sniffed.ext}" (add it to convertFormats to enable conversion)`);
  }

  // Official pi resizeImage for oversized payloads.
  if (buf.byteLength > cfg.maxImageBytes) {
    const resized = await resizeImage(buf, mime, { maxBytes: cfg.maxImageBytes });
    if (resized) {
      const before = formatBytes(buf.byteLength);
      buf = Buffer.from(resized.data, "base64");
      mime = resized.mimeType ?? mime;
      noteParts.push(`${before} → ${formatBytes(buf.byteLength)}`);
    }
  }

  return { data: buf.toString("base64"), mimeType: mime, note: noteParts.length ? `[${noteParts.join(", ")}]` : undefined };
}

async function persistCache(data: string, mimeType: string, cfg: VisionToolConfig): Promise<string> {
  await mkdir(cfg.cacheDir, { recursive: true });
  const ext = mimeToExt(mimeType);
  const file = join(cfg.cacheDir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`);
  await writeFile(file, Buffer.from(data, "base64"));
  if (cfg.cacheTtlHours > 0) await pruneCache(cfg.cacheDir, cfg.cacheTtlHours);
  return file;
}


/** True when the image bytes are in a format pi itself cannot attach inline
 *  (i.e. not png/jpeg/gif/webp/bmp) and our conversion chain can convert it. */
export function needsConversion(data: string, cfg: VisionToolConfig): boolean {
  const bytes = Buffer.from(data, "base64");
  const sniffed = sniffFormat(bytes);
  return sniffed.convertible && convertibleAllowed(sniffed.ext, cfg);
}

/** Load an image from a file path (supports HEIC/AVIF/TIFF/SVG/... via conversion). */
export async function loadImageFromFile(imagePath: string, cfg: VisionToolConfig): Promise<LoadedImage> {
  const bytes = await readFile(imagePath);
  const normalized = await normalizeBuffer(bytes, undefined, cfg);
  const cachePath = await persistCache(normalized.data, normalized.mimeType, cfg);
  return { ...normalized, cachePath, note: normalized.note };
}

/** Load an image from an in-memory ImageContent (native attachment / tool result). */
export async function loadImageFromContent(
  content: { data: string; mimeType: string },
  cfg: VisionToolConfig,
): Promise<LoadedImage> {
  const bytes = Buffer.from(content.data, "base64");
  const normalized = await normalizeBuffer(bytes, content.mimeType, cfg);
  const cachePath = await persistCache(normalized.data, normalized.mimeType, cfg);
  return { ...normalized, cachePath, note: normalized.note };
}

/** Load an already-normalized base64 image (skip sniff/convert) and cache it. */
export async function cacheNormalizedImage(data: string, mimeType: string, cfg: VisionToolConfig): Promise<string> {
  return persistCache(data, mimeType, cfg);
}

export function imageHash(data: string, mimeType: string): string {
  const h = createHash("sha256");
  h.update(mimeType);
  h.update("\0");
  h.update(data);
  return h.digest("hex");
}

export interface CacheStats {
  count: number;
  bytes: number;
}

export async function cacheStats(dir: string): Promise<CacheStats> {
  try {
    const names = await readdir(dir);
    let bytes = 0;
    let count = 0;
    for (const name of names) {
      try {
        const p = join(dir, name);
        const st = await stat(p);
        if (st.isFile()) {
          count += 1;
          bytes += st.size;
        }
      } catch {
        /* ignore */
      }
    }
    return { count, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export async function pruneCache(dir: string, ttlHours: number): Promise<void> {
  if (ttlHours <= 0) return;
  const ttlMs = ttlHours * 3600_000;
  const now = Date.now();
  try {
    const names = await readdir(dir);
    for (const name of names) {
      try {
        const p = join(dir, name);
        const st = await stat(p);
        if (st.isFile() && now - st.mtimeMs > ttlMs) await rm(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export async function clearCache(dir: string): Promise<number> {
  try {
    const names = await readdir(dir);
    let removed = 0;
    for (const name of names) {
      try {
        const p = join(dir, name);
        const st = await stat(p);
        if (st.isFile()) {
          await rm(p, { force: true });
          removed += 1;
        }
      } catch {
        /* ignore */
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

export function mimeToExt(mime: string): string {
  switch (mime) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/bmp": return "bmp";
    default: return "img";
  }
}

export function isLikelyImagePath(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif", ".avif", ".tiff", ".tif", ".svg", ".ico"].includes(ext);
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}