// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * intercept.ts — transparent interception so text-only models can "see"
 * images without changing the session model:
 *
 *  - `input`:             materialize TUI-pasted / referenced image paths into
 *                         native attachments (the user message stays intact).
 *  - `context`:           describe images inside user messages, inject
 *                         <image-analysis> + cached image path.
 *  - `tool_result`:       describe images returned by tools (read on an image,
 *                         browser screenshots, image_generate output...), strip
 *                         "model does not support images" warnings, inject
 *                         <image-analysis> + cached image path.
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
import { loadImageFromContent, imageHash } from "./images";
import { describeWithPipeline, buildAnalysisContext } from "./vision";
import { findConfiguredModel, modelRef } from "./discovery";
import { extractInputImagePaths } from "./input-images";
import { loadImageFromFile } from "./images";
import type { VisionToolConfig } from "./config";

interface InterceptDeps {
  getConfig: () => VisionToolConfig;
  onCall?: (ok: boolean) => void;
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
  let activePromptKey: string | undefined;
  let activeAnalysis:
    | { key: string; result?: Map<string, string>; pending?: Promise<Map<string, string>>; completed?: boolean }
    | undefined;

  async function analyzeImages(
    images: ImageContent[],
    question: string,
    ctx: ExtensionContext,
  ): Promise<Map<string, string>> {
    const cfg = deps.getConfig();
    const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
    if (!model) return new Map();
    const out = new Map<string, string>();
    for (const img of images) {
      try {
        const loaded = await loadImageFromContent(img, cfg);
        const answer = await describeWithPipeline(ctx, model, cfg, loaded, question, ctx.signal);
        // Key by the ORIGINAL ImageContent hash — the lookup side (context /
        // tool_result) iterates the original content parts and must find the
        // block even when conversion/resize changed the sent bytes (HEIC→JPEG
        // or an oversized image). The cache path inside the block refers to
        // the exact bytes that were analyzed.
        out.set(
          imageHash(img.data, img.mimeType),
          buildAnalysisContext({ text: answer.text, cachePath: answer.cachePath ?? loaded.cachePath, note: loaded.note ?? answer.note }),
        );
        deps.onCall?.(true);
      } catch {
        deps.onCall?.(false);
        // keep the image block; the parent model still sees the raw attachment
      }
    }
    return out;
  }

  pi.on("before_agent_start", (event) => {
    const h = createHash("sha256");
    h.update(event.prompt ?? "");
    for (const img of event.images ?? []) {
      h.update("\0");
      h.update(img.mimeType);
      h.update(img.data);
    }
    activePromptKey = h.digest("hex");
    activeAnalysis = undefined;
  });

  pi.on("agent_settled", () => {
    activePromptKey = undefined;
    activeAnalysis = undefined;
  });

  // --- 1. TUI paste / referenced image paths -> native attachments ----------
  pi.on("input", async (event, ctx) => {
    if (!ctx.model) return;
    const input = (ctx.model.input ?? ["text"]) as string[];
    if (input.includes("image")) return; // multimodal models pass through unchanged
    const cfg = deps.getConfig();
    if (!cfg.enabled || !cfg.autoIntercept) return;
    let images = [...(event.images ?? [])];
    const { paths } = extractInputImagePaths(event.text);
    for (const p of paths) {
      try {
        const loaded = await loadImageFromFile(p, cfg);
        images.push({ type: "image", data: loaded.data, mimeType: loaded.mimeType });
      } catch {
        // not a readable image -> leave the text untouched
      }
    }
    if (images.length === 0) return;
    return { action: "transform", text: event.text, images } as never;
  });

  // --- 2. user messages -> inject analysis --------------------------------
  pi.on("context", async (event, ctx): Promise<ContextTransform | undefined> => {
    if (!ctx.model) return undefined;
    const input = (ctx.model.input ?? ["text"]) as string[];
    if (input.includes("image")) return undefined;
    const cfg = deps.getConfig();
    if (!cfg.enabled || !cfg.autoIntercept) return undefined;
    const key = activePromptKey;
    if (!key) return undefined;

    const messages: ContextEvent["messages"] = [];
    let changed = false;
    for (const msg of event.messages) {
      if (!isUserMessage(msg)) {
        messages.push(msg);
        continue;
      }
      const images = userMessageImages(msg);
      if (images.length === 0) {
        messages.push(msg);
        continue;
      }
      const prompt = userMessageText(msg);
      const imgKey = prompt + "\0" + images.map((i) => imageHash(i.data, i.mimeType)).join(",");
      if (!activeAnalysis || activeAnalysis.key !== key) {
        activeAnalysis = { key, pending: undefined as never };
      }
      let text: Map<string, string> | undefined;
      if (activeAnalysis.key === key && activeAnalysis.result) {
        text = activeAnalysis.result;
      } else if (activeAnalysis.key === key && activeAnalysis.pending) {
        text = await activeAnalysis.pending;
      } else {
        const pending = analyzeImages(images, prompt || "Describe the attached image(s) in detail.", ctx);
        activeAnalysis.pending = pending as never;
        text = await pending;
        activeAnalysis.result = text;
        delete (activeAnalysis as { pending?: unknown }).pending;
      }
      const blocks = images
        .map((img) => text?.get(imageHash(img.data, img.mimeType)))
        .filter((b): b is string => Boolean(b));
      if (blocks.length === 0) {
        messages.push(msg);
        continue;
      }
      changed = true;
      messages.push({
        ...msg,
        content: [
          { type: "text" as const, text: blocks.join("\n\n") },
          ...(msg.content as Array<{ type: string; [k: string]: unknown }>),
        ],
      });
    }
    return changed ? { messages } : undefined;
  });

  // --- 3. tool results -> inject analysis ----------------------------------
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

    const content = (event.content ?? []).map((part) => {
      if ((part as { type?: string }).type === "text") {
        const cleaned = (part as { text: string }).text
          .replace(/\n?\[Current model does not support images\..*?\]/g, "")
          .trim();
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