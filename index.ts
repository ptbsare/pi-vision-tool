// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * pi-vision-tool — Pi extension that gives text-only coding models vision:
 *
 *  - full transparent interception (input / context / tool_result)
 *  - a describe_image tool on pi's official pipeline
 *    (maxRetries / maxRetryDelayMs configurable)
 *  - official resizeImage auto-compression with a configurable size cap
 *  - multi-format support: PNG/JPEG/GIF/WebP/BMP native, HEIC/HEIF/AVIF/TIFF/
 *    SVG/ICO via automatic conversion (sharp | heic-convert | system tools)
 *  - every analysis returns a cached image path (default under
 *    <tmp>/pi-vision-tool-cache, configurable) so the model can keep analyzing
 *    the exact same image with describe_image and a specific question
 *  - zero-config: auto-discovers the first authenticated image-capable model
 *    and writes it to ~/.pi/agent/vision-tool.json, with automatic fallback
 *    when the configured model becomes unavailable
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  loadConfig,
  saveConfig,
  configPath,
  configSummary,
  DEFAULT_CONFIG,
  type VisionToolConfig,
} from "./src/config";
import { findConfiguredModel, findFirstVisionModel, listVisionModels, modelRef } from "./src/discovery";
import { registerInterceptors } from "./src/intercept";
import { registerDescribeTool } from "./src/tool";
import { describeWithPipeline } from "./src/vision";
import { loadImageFromFile, cacheStats, clearCache, formatBytes, loadAnalysisCache } from "./src/images";
import { generateTestImage } from "./src/test-image";
// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/* DEBUG LOG — controlled by "debug": true in vision-tool.json. Writes runtime
 * diagnostics to stderr so they land in the pi-web systemd journal. */
import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
const __dbg = (m: string) => process.stderr.write(`[pi-vision-tool][debug] ${m}\n`);
{
  const __cfg0 = loadConfig();
  if (__cfg0.debug) {
    __dbg(`module: ${import.meta.url}`);
    __dbg(`node ${process.version} @ ${process.execPath}`);
    try {
      __dbg(`agentDir: ${getAgentDir()}`);
      __dbg(`configPath: ${configPath()}`);
      __dbg(`configRaw: ${readFileSync(configPath(), "utf-8").replace(/\s+/g, " ").slice(0, 500)}`);
    } catch (e) {
      __dbg(`config read FAIL: ${e instanceof Error ? e.message : String(e)}`);
    }
    __dbg(
      `parsed: provider=${__cfg0.provider} model=${__cfg0.model} enabled=${__cfg0.enabled} ` +
      `maxRetries=${__cfg0.maxRetries} timeoutSeconds=${__cfg0.timeoutSeconds} maxImageBytes=${__cfg0.maxImageBytes} cacheDir=${__cfg0.cacheDir}`,
    );
  }
}
/* END DEBUG */

export default function visionToolExtension(pi: ExtensionAPI): void {
  let cfg = loadConfig();
  // Shared analysis cache — persisted to cacheDir/analysis-cache.json, loaded
  // once at startup so results survive pi-web restarts, and cleared together
  // with /vision cache clear.
  const sharedAnalysisCache = loadAnalysisCache(cfg);
  let footerVisible = false;
  let toolRegistered = false;

  function getConfig(): VisionToolConfig {
    return cfg;
  }

  function refreshFooter(ctx: ExtensionContext): void {
    if (!cfg.showInFooter || !footerVisible || !cfg.enabled || !cfg.provider || !cfg.model) {
      ctx.ui.setStatus("vision", undefined);
      return;
    }
    ctx.ui.setStatus("vision", `👁 ${cfg.provider}/${cfg.model}`);
  }

  function ensureToolActive(active: boolean): void {
    const current = pi.getActiveTools();
    const has = current.includes("describe_image");
    if (active && !has) pi.setActiveTools([...current, "describe_image"]);
    else if (!active && has) pi.setActiveTools(current.filter((t) => t !== "describe_image"));
  }

  function registerToolOnce(): void {
    if (toolRegistered) return;
    toolRegistered = true;
    registerDescribeTool(pi, {
      getConfig,
      onCall: (ok) => {
        footerVisible = true;
        lastCallOk = ok;
      },
    });
  }

  let lastCallOk = true;

  function enableTool(): void {
    registerToolOnce();
    ensureToolActive(true);
  }

  function applyModel(provider: string, model: string): void {
    cfg = { ...cfg, provider, model, enabled: true };
    saveConfig(cfg);
    enableTool();
  }

  /** Zero-config: pick the first available image model, or fall back when the
   *  configured one is unavailable. Writes back to vision-tool.json. */
  async function initialize(ctx: ExtensionContext): Promise<void> {
    const configured = findConfiguredModel(ctx, cfg.provider, cfg.model);
    if (cfg.provider && cfg.model) {
      if (!cfg.enabled) return; // user disabled — stay quiet
      if (configured) {
        enableTool();
        return;
      }
      // configured model broken → auto-fallback to first available
      const fallback = findFirstVisionModel(ctx);
      if (fallback) {
        cfg = { ...cfg, provider: fallback.provider, model: fallback.id };
        saveConfig(cfg);
        enableTool();
        ctx.ui.notify(
          `pi-vision-tool: configured model unavailable, fell back to ${modelRef(fallback)}. Use /vision set to change.`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        "pi-vision-tool: no image-capable models available; tool stays inactive. Configure one with /vision set <provider> <model>.",
        "warning",
      );
      return;
    }
    // Zero-config auto-discovery
    const first = findFirstVisionModel(ctx);
    if (first) {
      applyModel(first.provider, first.id);
      ctx.ui.notify(
        `pi-vision-tool: auto-configured vision model ${modelRef(first)}. Adjust with /vision set <provider> <model>.`,
        "info",
      );
    } else {
      ctx.ui.notify(
        "pi-vision-tool: no image-capable model found; tool stays inactive. Run /vision set <provider> <model> after /login.",
        "warning",
      );
    }
  }

  registerInterceptors(pi, {
    getConfig,
    onCall: (ok) => {
      footerVisible = true;
      lastCallOk = ok;
    },
    debugLog: (msg) => {
      if (getConfig().debug) process.stderr.write(`[pi-vision-tool] ${msg}\n`);
    },
    analysisCache: sharedAnalysisCache,
  });

  pi.on("session_start", async (_event, ctx) => {
    cfg = loadConfig();
    footerVisible = false;
    await initialize(ctx);
    refreshFooter(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    refreshFooter(ctx);
  });

  pi.registerCommand("vision", {
    description: "pi-vision-tool settings: status | set | list | on/off | intercept | config | test | cache | help",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["status", "set", "list", "on", "off", "intercept", "config", "test", "cache", "help"];
      if (!prefix || !prefix.includes(" ")) {
        return subs.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s }));
      }
      return [];
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";

      const usageText = [
        "Usage:",
        "  /vision                 show current status",
        "  /vision status          same as above",
        "  /vision set <provider> <model>   configure the vision model",
        "  /vision list            list image-capable models",
        "  /vision on | off         enable / disable everything",
        "  /vision intercept on|off  toggle automatic image interception",
        "  /vision config <key> <value>     set maxOutputTokens | maxRetries | maxRetryDelayMs | timeoutSeconds | maxImageBytes | cacheDir | cacheTtlHours | showInFooter | debug",
        "  /vision test [path]     run an end-to-end analysis test",
        "  /vision cache           show cache stats (add clear to wipe)",
      ].join("\n");

      switch (sub) {
        case "":
        case "status": {
          ctx.ui.notify(configSummary(cfg), "info");
          const st = await cacheStats(cfg.cacheDir);
          ctx.ui.notify(`cache: ${st.count} file(s), ${formatBytes(st.bytes)} under ${cfg.cacheDir}`, "info");
          return;
        }
        case "set": {
          const provider = parts[1];
          const model = parts.slice(2).join(" ");
          if (!provider || !model) {
            ctx.ui.notify("Usage: /vision set <provider> <model>", "warning");
            return;
          }
          const m = findConfiguredModel(ctx, provider, model);
          if (!m) {
            ctx.ui.notify(
              `${provider}/${model} is unavailable (not in registry, no image input, or not authenticated). Run /vision list.`,
              "error",
            );
            return;
          }
          applyModel(provider, model);
          refreshFooter(ctx);
          ctx.ui.notify(`pi-vision-tool: vision model set to ${modelRef(m)}`, "info");
          return;
        }
        case "list": {
          const models = listVisionModels(ctx);
          if (models.length === 0) {
            ctx.ui.notify("No image-capable models available. /login first, then /vision set.", "warning");
            return;
          }
          const current = cfg.provider && cfg.model ? `${cfg.provider}/${cfg.model}` : "";
          ctx.ui.notify(
            `Available image models:\n${models.map((m) => `- ${modelRef(m)}${modelRef(m) === current ? " ← current" : ""}`).join("\n")}`,
            "info",
          );
          return;
        }
        case "on":
        case "off": {
          cfg = { ...cfg, enabled: sub === "on" };
          saveConfig(cfg);
          ensureToolActive(cfg.enabled);
          refreshFooter(ctx);
          ctx.ui.notify(`pi-vision-tool ${sub === "on" ? "enabled" : "disabled"}.`, "info");
          return;
        }
        case "intercept": {
          const v = parts[1];
          if (v !== "on" && v !== "off") {
            ctx.ui.notify(`Automatic interception is currently ${cfg.autoIntercept ? "on" : "off"}. Use /vision intercept on|off.`, "info");
            return;
          }
          cfg = { ...cfg, autoIntercept: v === "on" };
          saveConfig(cfg);
          ctx.ui.notify(`Automatic interception ${v}.`, "info");
          return;
        }
        case "config": {
          const key = parts[1];
          const raw = parts.slice(2).join(" ");
          if (!key) {
            ctx.ui.notify(
              `Configurable keys: maxOutputTokens, maxRetries, maxRetryDelayMs, timeoutSeconds (per-call vision timeout in s, 0 = no limit), maxImageBytes, cacheDir, cacheTtlHours (TTL for both image files and analysis cache, 0 = never prune), showInFooter (true|false), debug (true|false), convertFormats (comma list)`,
              "info",
            );
            return;
          }
          switch (key) {
            case "maxOutputTokens":
            case "maxRetries":
            case "maxRetryDelayMs":
            case "maxImageBytes":
            case "cacheTtlHours":
            case "timeoutSeconds": {
              const n = Number(raw);
              if (!Number.isFinite(n) || n < 0) {
                ctx.ui.notify(`Invalid number for ${key}: "${raw}"`, "error");
                return;
              }
              cfg = { ...cfg, [key]: n } as VisionToolConfig;
              saveConfig(cfg);
              ctx.ui.notify(`${key} = ${n}`, "info");
              return;
            }
            case "cacheDir": {
              if (!raw) {
                ctx.ui.notify(`cacheDir = ${cfg.cacheDir}`, "info");
                return;
              }
              cfg = { ...cfg, cacheDir: raw };
              saveConfig(cfg);
              ctx.ui.notify(`cacheDir = ${raw}`, "info");
              return;
            }
            case "showInFooter": {
              const b = raw === "true" || raw === "on";
              cfg = { ...cfg, showInFooter: b };
              saveConfig(cfg);
              refreshFooter(ctx);
              ctx.ui.notify(`showInFooter = ${b}`, "info");
              return;
            }
            case "debug": {
              const b = raw === "true" || raw === "on";
              cfg = { ...cfg, debug: b };
              saveConfig(cfg);
              ctx.ui.notify(
                `debug = ${b}${b ? " — diagnostics print to stderr (view: journalctl -u pi-web | grep pi-vision-tool)" : ""}`,
                "info",
              );
              return;
            }
            case "convertFormats": {
              const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_CONFIG.convertFormats;
              cfg = { ...cfg, convertFormats: list };
              saveConfig(cfg);
              ctx.ui.notify(`convertFormats = [${list.join(", ")}]`, "info");
              return;
            }
            default:
              ctx.ui.notify(`Unknown config key "${key}".`, "error");
              return;
          }
        }
        case "test": {
          if (!cfg.enabled || !cfg.provider || !cfg.model) {
            ctx.ui.notify("pi-vision-tool is not active. /vision set or /vision on first.", "warning");
            return;
          }
          const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
          if (!model) {
            ctx.ui.notify(`${cfg.provider}/${cfg.model} is unavailable. Run /vision list.`, "error");
            return;
          }
          const p = parts[1] ?? (await generateTestImage());
          ctx.ui.notify(`Analyzing ${p} with ${cfg.provider}/${cfg.model} ...`, "info");
          try {
            const loaded = await loadImageFromFile(p, cfg);
            const answer = await describeWithPipeline(ctx, model, cfg, loaded, "What solid colors are in this image, left to right?", ctx.signal);
            ctx.ui.notify(`pi-vision-tool test OK (${modelRef(model)}):\n${answer.text.slice(0, 400)}${answer.text.length > 400 ? " …" : ""}`, "info");
          } catch (e) {
            ctx.ui.notify(`pi-vision-tool test failed: ${e instanceof Error ? e.message : String(e)}`, "error");
          }
          return;
        }
        case "cache": {
          if (parts[1] === "clear") {
            const n = await clearCache(cfg.cacheDir);
            sharedAnalysisCache.clear();
            ctx.ui.notify(`Removed ${n} cache file(s) from ${cfg.cacheDir} (incl. analysis cache).`, "info");
            return;
          }
          const st = await cacheStats(cfg.cacheDir);
          ctx.ui.notify(`cache: ${st.count} file(s), ${formatBytes(st.bytes)} under ${cfg.cacheDir} (TTL ${cfg.cacheTtlHours}h)`, "info");
          return;
        }
        case "help":
        default:
          ctx.ui.notify(usageText, "info");
          return;
      }
    },
  });
}