// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * vision.ts — single vision-model call through pi's official pipeline.
 *
 * Uses `ctx.modelRegistry.complete()`, so auth, protocol serialization and
 * retries are handled by pi itself, supporting
 * google-generative-ai / openai-completions / anthropic-messages providers.
 * `maxRetries` and `maxRetryDelayMs` come from the shared vision-tool.json.
 */
import type { Api, AssistantMessage, Model, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VisionToolConfig } from "./config";

const SYSTEM_PROMPT =
  "You are a precise image analysis assistant for a coding agent. " +
  "Answer the user's question about the attached image factually and precisely. " +
  "Respond in the same language as the question. " +
  "If the image contains text, code, or error messages, transcribe them accurately. " +
  "Include exact values, coordinates, colors and quoted text where relevant. " +
  "State uncertainty instead of inventing details.";

export interface VisionAnswer {
  text: string;
  model: string;
  /** Normalized image persisted to disk (for later re-analysis). */
  cachePath?: string;
  note?: string;
}

function extractText(message: AssistantMessage): string {
  const text = message.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (text) return text;
  const thinking = message.content
    .filter((c): c is ThinkingContent => c.type === "thinking" && typeof c.thinking === "string")
    .map((c) => c.thinking)
    .join("\n")
    .trim();
  return thinking;
}

/**
 * Combine the parent (session) signal with a per-call timeout.
 * Returns a fresh signal that aborts on parent abort or after timeoutMs ms;
 * returns the parent unchanged when timeoutMs <= 0.
 */
function withTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) return parent;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("vision-call-timed-out")), timeoutMs);
  if (parent) {
    if (parent.aborted) {
      clearTimeout(timer);
      return parent;
    }
    parent.addEventListener("abort", () => {
      clearTimeout(timer);
      ac.abort(parent.reason);
    }, { once: true });
  }
  ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ac.signal;
}

export async function describeWithPipeline(
  ctx: ExtensionContext,
  model: Model<Api>,
  cfg: VisionToolConfig,
  image: { data: string; mimeType: string },
  question: string,
  signal?: AbortSignal,
): Promise<VisionAnswer> {
  const effectiveSignal = withTimeoutSignal(signal, cfg.timeoutSeconds * 1000);
  const timedOut = { current: false };
  if (effectiveSignal) {
    effectiveSignal.addEventListener("abort", () => {
      timedOut.current = effectiveSignal.reason instanceof Error && effectiveSignal.reason.message === "vision-call-timed-out";
    }, { once: true });
  }

  const result: AssistantMessage = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text" as const, text: question },
            { type: "image" as const, data: image.data, mimeType: image.mimeType },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: cfg.maxOutputTokens,
      maxRetries: cfg.maxRetries,
      maxRetryDelayMs: cfg.maxRetryDelayMs,
      signal: effectiveSignal,
      temperature: 0,
    },
  );

  if (result.stopReason === "aborted") {
    if (timedOut.current) {
      throw new Error(`Vision call timed out after ${cfg.timeoutSeconds}s (configurable via timeoutSeconds, 0 = no limit)`);
    }
    throw new Error("Vision call was aborted");
  }
  if (result.stopReason === "error") {
    throw new Error(`Vision model error: ${result.errorMessage ?? "unknown"}`);
  }

  const text = extractText(result);
  if (!text) throw new Error("vision model returned no text");
  return { text, model: `${model.provider}/${model.id}` };
}

/** Format the analysis block injected into context / tool results. */
export function buildAnalysisContext(
  answer: { text: string; cachePath?: string; note?: string },
  imageRef?: string,
): string {
  const lines = ["<image-analysis>"];
  if (imageRef) lines.push(`image: ${imageRef}`);
  if (answer.note) lines.push(`note: ${answer.note}`);
  lines.push(answer.text.trim());
  if (answer.cachePath) {
    lines.push(
      ``,
      `cached-at: ${answer.cachePath}`,
      `For further analysis of this exact image, call describe_image with image_path="${answer.cachePath}" and a specific question (e.g. "extract all text verbatim", "what hex color is the header?", "list every button and its coordinates").`,
    );
  }
  lines.push("</image-analysis>");
  return lines.join("\n");
}