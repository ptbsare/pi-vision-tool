// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * intercept.ts — transparent interception so text-only models can "see"
 * images without changing the session model:
 *
 *  - `input`:             materialize TUI-pasted / referenced image paths into
 *                         native attachments (the user message stays intact).
 *  - `context`:          describe images inside user messages, inject
 *                         <image-analysis> + cached image path, and strip raw
 *                         `type: "image"` blocks to prevent pi-ai's
 *                         "(image omitted...)" placeholders from appearing.
 *  - `tool_result`:       describe images returned by tools (read on an image,
 *                         browser screenshots, image_generate output...), strip
 *                         "Image: original WxH...", "model does not support images"
 *                         and conversion warnings, inject <image-analysis> +
 *                         cached image path.
 *
 * Analysis results are cached per-image-hash for the session lifetime:
 * historical messages with images hit the cache instantly (no vision API
 * call, no delay), only genuinely new images trigger a vision call. Failed
 * analyses are NOT cached, so they retry on the next context event.
 *
 * Only runs when the active model has no `image` input modality. Multimodal
 * models are never intercepted. Analysis crosses pi's official pipeline.
 */
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { loadImageFromContent, loadImageFromFile, imageHash, needsConversion } from "./images";
import { describeWithPipeline, buildAnalysisContext } from "./vision";
import { findConfiguredModel, modelRef } from "./discovery";
import { extractInputImagePaths } from "./input-images";
import type { VisionToolConfig } from "./config";

interface InterceptDeps {
  getConfig: () => VisionToolConfig;
  onCall?: (ok: boolean) => void;
  debugLog?: (msg: string) => void;
}

type ContextTransform = { messages: ContextEvent["messages"] };

function isUserMessage(msg: {
  role?: string;
  content?: unknown;
}): msg is { role: "user"; content: Array<{ type: string; [k: string]: unknown }> } {
  return msg.role === "user" && Array.isArray(msg.content);
}

function userMessageImages(msg: { content: unknown[] }): ImageContent[] {
  return msg.content.filter(
    (p): p is ImageContent =>
      typeof p === "object" && p !== null && (p as { type?: string }).type === "image" &&
      typeof (p as ImageContent).data === "string",
  );
}

function userMessageText(msg: { content: unknown[] }): string {
  return msg.content
    .filter((p): p is { type: "text"; text: string } =>
      typeof p === "object" && p !== null && (p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}

/**
 * Strip system-generated image warnings/dimension hints that are confusing to LLMs.
 * Removes:
 *   - [Image: original WxH, displayed at WxH. Multiply coordinates by...]
 *   - [Current model does not support images...]
 *   - [Image converted from X to Y.]
 */
function cleanImageTextNotes(text: string): string {
  return text
    .replace(/<file name="[^"]*">\s*\[Image: original \d+x\d+[^<]*\]\s*<\/file>\n?/g, "")
    .replace(/\n?\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]/g, "")
    .replace(/\n?\[Current model does not support images\..*?\]/g, "")
    .replace(/\n?\[Image converted from .*? to .*?\.\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toolAnalysisPrompt(toolName: string, input: Record<string, unknown> | undefined): string {
  const rawPath =
    typeof input?.path === "string"
      ? input.path
      : typeof input?.file_path === "string"
        ? input.file_path
        : undefined;
  if (toolName === "read" && rawPath) {
    return `Describe the image file "${rawPath}" in detail: layout, UI elements, all visible text (transcribed verbatim), code, colors, alignment, styling.`;
  }
  if (rawPath) {
    return `Describe the image "${rawPath}" in detail: layout, UI elements, all visible text (transcribed verbatim), code, colors, alignment, styling.`;
  }
  return "Describe this image in detail: layout, UI elements, all visible text (transcribed verbatim), code, colors, alignment, styling.";
}

export function registerInterceptors(pi: ExtensionAPI, deps: InterceptDeps): void {
  const dbg = (m: string) => deps.debugLog?.(m);

  /**
   * Session-lifetime cache: imageHash -> analysis block string.
   * - Hit: no vision API call, instant.
   * - Miss: analyze, cache on success only.
   * - Failure: NOT cached, so the next context event retries.
   */
  const analysisCache = new Map<string, string>();

  /**
   * Many API gateways silently drop requests with bodies > ~1MB.
   */
  async function analyzeOneImage(
    img: ImageContent,
    hash: string,
    question: string,
    ctx: ExtensionContext,
  ): Promise<string | undefined> {
    const cfg = deps.getConfig();
    const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
    if (!model) return undefined;
    const loaded = await loadImageFromContent(img, cfg);
    dbg(`  [${hash.slice(0, 8)}] loaded, mime=${loaded.mimeType} base64Len=${loaded.data.length} cached=${loaded.cachePath}`);
    const answer = await describeWithPipeline(ctx, model, cfg, loaded, question, ctx.signal);
    return buildAnalysisContext({
      text: answer.text,
      cachePath: answer.cachePath ?? loaded.cachePath,
      note: loaded.note ?? answer.note,
    });
  }

  async function analyzeImages(
    images: ImageContent[],
    question: string,
    ctx: ExtensionContext,
  ): Promise<Map<string, string>> {
    const cfg = deps.getConfig();
    const out = new Map<string, string>();
    for (const img of images) {
      const hash = imageHash(img.data, img.mimeType);

      // Cache hit: instant, no API call
      const cached = analysisCache.get(hash);
      if (cached !== undefined) {
        out.set(hash, cached);
        continue;
      }

      // Cache miss: analyze
      try {
        const block = await analyzeOneImage(img, hash, question, ctx);
        if (block) {
          analysisCache.set(hash, block);
          out.set(hash, block);
          deps.onCall?.(true);
        }
      } catch (e) {
        // NOT cached — will retry on next context event
        const msg = e instanceof Error ? e.message : String(e);
        const kb = Math.round(img.data.length / 1024);
        dbg(`  [${hash.slice(0, 8)}] FAILED (${kb}KB): ${msg}`);
        if (img.data.length > 400 * 1024) {
          dbg(`  [${hash.slice(0, 8)}] hint: image is large (${kb}KB); the vision gateway may reject bodies > ~512KB. Consider lowering maxImageBytes in vision-tool.json (currently ${cfg ? Math.round(cfg.maxImageBytes / 1024) : "?"}KB) — this is informational, no auto-retry.`);
        }
        deps.onCall?.(false);
      }
    }
    dbg(`analyzeImages: ${out.size}/${images.length} ok (cache size=${analysisCache.size})`);
    return out;
  }

  pi.on("before_agent_start", (event) => {
    dbg(`before_agent_start: images=${(event.images ?? []).length}`);
  });

  pi.on("agent_settled", () => {
    dbg(`agent_settled (cache retains ${analysisCache.size} entries for next turn)`);
  });

  // --- 1. TUI paste / referenced image paths -> native attachments ----------
  pi.on("input", async (event, ctx) => {
    if (!ctx.model) { dbg("input: no model"); return; }
    const input = (ctx.model.input ?? ["text"]) as string[];
    if (input.includes("image")) { dbg("input: multimodal"); return; }
    const cfg = deps.getConfig();
    if (!cfg.enabled || !cfg.autoIntercept) { dbg("input: disabled"); return; }
    dbg(`input: textLen=${event.text.length} nativeImages=${(event.images ?? []).length}`);

    // pi's own attach pipeline only inlines png/jpeg/gif/webp/bmp. HEIC/AVIF/
    // TIFF/SVG/ICO attachments get rejected by pi as "[Image omitted: could not
    // be converted to a supported inline image format.]" BEFORE our context
    // hook ever sees them. Convert such native attachments to JPEG here so pi
    // accepts them and the image actually reaches the vision pipeline.
    let images: ImageContent[] = [];
    for (const img of event.images ?? []) {
      try {
        if (needsConversion(img.data, cfg)) {
          const loaded = await loadImageFromContent(img, cfg);
          images.push({ type: "image", data: loaded.data, mimeType: loaded.mimeType });
          dbg(`input: converted native attachment (${img.mimeType} → ${loaded.mimeType}, ${loaded.data.length}b)`);
        } else {
          images.push(img);
        }
      } catch (e) {
        dbg(`input: native attachment convert failed: ${e instanceof Error ? e.message : String(e)}`);
        images.push(img); // fall back to original
      }
    }

    const { paths } = extractInputImagePaths(event.text);
    for (const p of paths) {
      try {
        const loaded = await loadImageFromFile(p, cfg);
        images.push({ type: "image", data: loaded.data, mimeType: loaded.mimeType });
        dbg(`input: materialized ${p}`);
      } catch {
        // not a readable image -> leave text untouched
      }
    }
    const cleanedText = cleanImageTextNotes(event.text);
    if (images.length === 0 && cleanedText === event.text.trim()) return;
    return { action: "transform", text: cleanedText || event.text, images } as never;
  });

  // --- 2. user messages -> inject analysis and strip image blocks ------------
  pi.on("context", async (event, ctx): Promise<ContextTransform | undefined> => {
    if (!ctx.model) { dbg("context: no model"); return undefined; }
    const input = (ctx.model.input ?? ["text"]) as string[];
    if (input.includes("image")) { dbg("context: multimodal"); return undefined; }
    const cfg = deps.getConfig();
    if (!cfg.enabled || !cfg.autoIntercept) { dbg("context: disabled"); return undefined; }
    dbg(`context: messages=${event.messages.length}`);

    const messages: ContextEvent["messages"] = [];
    let changed = false;
    for (const msg of event.messages) {
      if (!isUserMessage(msg)) { messages.push(msg); continue; }
      const images = userMessageImages(msg);
      if (images.length === 0) { messages.push(msg); continue; }
      dbg(`context: user msg has ${images.length} image(s)`);

      // analyzeImages consults the per-image cache: historical images are
      // instant, only genuinely new images hit the vision API.
      const textMap = await analyzeImages(images, userMessageText(msg), ctx);
      const blocks = images
        .map((img) => textMap.get(imageHash(img.data, img.mimeType)))
        .filter((b): b is string => Boolean(b));

      if (blocks.length === 0) {
        dbg(`context: blocks EMPTY for ${images.length} image(s) — keeping original`);
        messages.push(msg);
        continue;
      }
      dbg(`context: injected ${blocks.length}/${images.length} block(s)`);
      changed = true;

      // Strip image blocks so pi-ai's downgradeUnsupportedImages never inserts
      // "(image omitted...)". TUI transcript retains originals.
      const nonImageParts = (msg.content as Array<{ type: string; text?: string; [k: string]: unknown }>)
        .filter((part) => part.type !== "image")
        .map((part) => {
          if (part.type === "text" && typeof part.text === "string") {
            return { ...part, text: cleanImageTextNotes(part.text) };
          }
          return part;
        });

      messages.push({
        ...msg,
        content: [
          { type: "text" as const, text: blocks.join("\n\n") },
          ...nonImageParts,
        ],
      });
    }
    return changed ? { messages } : undefined;
  });

  // --- 3. tool results -> inject analysis and clean notes --------------------
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    if (!ctx.model) return undefined;
    const input = (ctx.model.input ?? ["text"]) as string[];
    if (input.includes("image")) return undefined;
    const cfg = deps.getConfig();
    if (!cfg.enabled || !cfg.autoIntercept) return undefined;
    if (event.isError) return undefined;

    const images = (event.content ?? []).filter(
      (p): p is ImageContent => typeof p === "object" && p !== null && (p as { type?: string }).type === "image",
    );
    if (images.length === 0) return undefined;

    const question = toolAnalysisPrompt(event.toolName ?? "", (event.input ?? {}) as Record<string, unknown>);
    const texts = await analyzeImages(images, question, ctx);
    if (texts.size === 0) return undefined;

    const blocks = images
      .map((img) => texts.get(imageHash(img.data, img.mimeType)))
      .filter((b): b is string => Boolean(b));

    const content = (event.content ?? [])
      .filter((part) => (part as { type?: string }).type !== "image")
      .map((part) => {
        if ((part as { type?: string }).type === "text") {
          const cleaned = cleanImageTextNotes((part as { text: string }).text);
          return {
            type: "text" as const,
            text: cleaned ? `${cleaned}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n"),
          };
        }
        return part;
      });

    if (!content.some((p) => (p as { type?: string }).type === "text")) {
      content.unshift({ type: "text", text: blocks.join("\n\n") });
    }
    return { content, blockCount: images.length, tokenCount: 0 } as never;
  });
}

export { modelRef };