// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * input-images.ts — extract image paths from raw user input (TUI pastes).
 *
 * Pi's TUI saves Ctrl+V clipboard images to a temp `pi-clipboard-*.png` file and
 * inserts the path into the editor. This module also picks up absolute / quoted
 * image paths so they can be materialized as native image attachments,
 * covering HEIC/AVIF/etc. thanks to `isLikelyImagePath`.
 */
import { isLikelyImagePath } from "./images";

const IMAGE_PATH_HINT = /\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|svg|ico)(?:[\s"']|$)/i;

const pathSingleLine =
  /(?:"([^"\n]+\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|svg|ico))"|'([^'\n]+\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|svg|ico))'|((?:~|\/|\.\/|\.\.\/)(?:\\ |[^\s"'])+\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|svg|ico)))/gi;

export function mayContainInputImage(text: string): boolean {
  return IMAGE_PATH_HINT.test(text);
}

function normalize(raw: string): string {
  let p = raw.trim();
  if (p.startsWith("~")) {
    p = p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  }
  return p;
}

export interface ExtractedInputImages {
  text: string;
  paths: string[];
}

/**
 * Return the list of plausible image file paths in `text`.
 * Does not read or verify files (that happens in the interceptor), keeping this
 * cheap and synchronous-friendly for the `input` hook.
 */
export function extractInputImagePaths(text: string): ExtractedInputImages {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isBarePath = trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed.startsWith("./") || trimmed.startsWith("../");
    if (isBarePath && isLikelyImagePath(trimmed)) {
      found.push(normalize(trimmed));
      continue;
    }
    for (const m of trimmed.matchAll(pathSingleLine)) {
      const v = m[1] ?? m[2] ?? m[3];
      if (v && isLikelyImagePath(v)) found.push(normalize(v));
    }
  }
  // de-dup, keep order
  return { text, paths: [...new Set(found)] };
}

/** Unescape a path string (used when we resolve a path found in quoted text). */
export function unescapePath(p: string): string {
  return p.replace(/\\ /g, " ");
}