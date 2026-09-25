// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * config.ts — unified `vision-tool.json` configuration.
 *
 * Config file lives at `~/.pi/agent/vision-tool.json` (user-level, shared by all
 * projects), like the pi extension convention. Zero-config: when `provider`/
 * `model` are empty, the extension auto-discovers the first authenticated,
 * image-capable model at session start and writes it here.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VisionToolConfig {
  /** Master switch: disable automatic interception and the describe_image tool. */
  enabled: boolean;
  /** Vision provider id from pi's model registry (models.json). */
  provider: string;
  /** Vision model id under that provider; must declare input: ["text","image"]. */
  model: string;
  /** Max output tokens for the vision call (official pipeline). */
  maxOutputTokens: number;
  /** Retry count for the vision call (official pipeline; 4xx not retried). */
  maxRetries: number;
  /** Backoff ceiling in ms (official pipeline). */
  maxRetryDelayMs: number;
  /**
   * Hard image size limit in bytes. Images above this are automatically
   * compressed with pi's official `resizeImage` before being sent.
   */
  maxImageBytes: number;
  /**
   * Directory where intercepted/analyzed images are cached as files, so the
   * model can later re-analyze the exact same image via describe_image with a
   * different question. Default: `<os tmpdir>/pi-vision-tool-cache`.
   */
  cacheDir: string;
  /** Cache file TTL in hours (0 = never prune). */
  cacheTtlHours: number;
  /** Automatically describe images in user messages and tool results. */
  autoIntercept: boolean;
  /** Show `vision: provider/model` in the TUI footer after first use. */
  showInFooter: boolean;
  /**
   * Extra image formats accepted via conversion (heic/heif/avif/tiff/svg/ico...).
   * Native formats (png/jpeg/gif/webp/bmp) are always accepted.
   */
  convertFormats: string[];
}

export const DEFAULT_CONFIG: Omit<VisionToolConfig, "provider" | "model"> = {
  enabled: true,
  maxOutputTokens: 4096,
  maxRetries: 2,
  maxRetryDelayMs: 5000,
  maxImageBytes: 10 * 1024 * 1024,
  cacheDir: path.join(os.tmpdir(), "pi-vision-tool-cache"),
  cacheTtlHours: 24,
  autoIntercept: true,
  showInFooter: true,
  convertFormats: ["heic", "heif", "avif", "tiff", "tif", "svg", "ico", "jfif"],
};

export function configPath(): string {
  return path.join(getAgentDir(), "vision-tool.json");
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function str(v: unknown, d: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : d;
}

/** Read config; missing or corrupt file yields defaults (zero-config friendly). */
export function loadConfig(): VisionToolConfig {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
  } catch {
    data = {};
  }
  const d = DEFAULT_CONFIG;
  return {
    enabled: bool(data.enabled, d.enabled),
    provider: str(data.provider, ""),
    model: str(data.model, ""),
    maxOutputTokens: num(data.maxOutputTokens, d.maxOutputTokens),
    maxRetries: num(data.maxRetries, d.maxRetries),
    maxRetryDelayMs: num(data.maxRetryDelayMs, d.maxRetryDelayMs),
    maxImageBytes: num(data.maxImageBytes, d.maxImageBytes),
    cacheDir: str(data.cacheDir, d.cacheDir),
    cacheTtlHours: num(data.cacheTtlHours, d.cacheTtlHours),
    autoIntercept: bool(data.autoIntercept, d.autoIntercept),
    showInFooter: bool(data.showInFooter, d.showInFooter),
    convertFormats: Array.isArray(data.convertFormats)
      ? (data.convertFormats as unknown[]).filter((x): x is string => typeof x === "string")
      : d.convertFormats,
  };
}

export function saveConfig(cfg: VisionToolConfig): void {
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

/** Build a human-readable status summary for `/vision`. */
export function configSummary(cfg: VisionToolConfig): string {
  return [
    `pi-vision-tool`,
    `  Enabled:          ${cfg.enabled ? "on" : "off"}`,
    `  Auto intercept:   ${cfg.autoIntercept ? "on" : "off"}`,
    `  Vision model:     ${cfg.provider && cfg.model ? `${cfg.provider}/${cfg.model}` : "(not configured — auto-discovery)"}`,
    `  Max output tokens:${cfg.maxOutputTokens}`,
    `  Retries:          ${cfg.maxRetries} (backoff ≤ ${cfg.maxRetryDelayMs}ms)`,
    `  Max image bytes:  ${cfg.maxImageBytes}`,
    `  Cache dir:        ${cfg.cacheDir}`,
    `  Cache TTL:        ${cfg.cacheTtlHours}h`,
    `  Convert formats:  ${cfg.convertFormats.join(", ")}`,
    ``,
    `Config file: ${configPath()}`,
  ].join("\n");
}