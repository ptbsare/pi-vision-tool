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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return parent;
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
  // Defensive: never let a missing/NaN timeoutSeconds produce setTimeout(NaN)
  // (Node coerces NaN to 1ms -> instant abort). 0 means "no timeout".
  const timeoutSeconds =
    typeof cfg.timeoutSeconds === "number" && Number.isFinite(cfg.timeoutSeconds) && cfg.timeoutSeconds > 0
      ? cfg.timeoutSeconds
      : 0;

  /**
   * pi's provider retry (retryProviderRequest) only covers HTTP errors that
   * carry `status`/`headers` (429/5xx/408). Stream-interruption errors like
   * "Stream ended without finish_reason" (EOF before the provider sent a
   * finish_reason) are plain Errors with no status, so pi never retries them.
   * This inner retry exists purely to catch those. Transient network failures
   * (ECONNRESET etc.) sometimes also surface without status — retrying them a
   * couple of times is safe because vision calls are idempotent (same image +
   * question = same answer, and results are cached by image hash anyway).
   */
  const STREAM_ERROR_RE =
    /Stream ended without finish_reason|Unexpected end of stream|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|terminated|incomplete response/i;
  // maxRetries covers both pi's HTTP-error retry (inside complete()) and our
  // stream-interruption retry here. The two are orthogonal: STREAM_ERROR_RE
  // only matches plain Errors without HTTP status, so HTTP retries are never
  // double-counted.
  const extraRetries = Math.max(0, cfg.maxRetries);

  const attempt = async (): Promise<AssistantMessage> => {
    const effectiveSignal = withTimeoutSignal(signal, timeoutSeconds * 1000);
    return ctx.modelRegistry.complete(
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
  };

  let lastError: unknown;
  for (let attemptNum = 0; attemptNum <= extraRetries; attemptNum++) {
    try {
      const result: AssistantMessage = await attempt();
      if (result.stopReason === "aborted") {
        if (signal?.aborted) throw new Error("Vision call was aborted");
        throw new Error(`Vision call timed out after ${timeoutSeconds}s (configurable via timeoutSeconds, 0 = no limit)`);
      }
      if (result.stopReason === "error") {
        throw new Error(`Vision model error: ${result.errorMessage ?? "unknown"}`);
      }
      const text = extractText(result);
      if (!text) throw new Error("vision model returned no text");
      return { text, model: `${model.provider}/${model.id}` };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only stream-interruption errors get our extra retry. Everything else
      // (HTTP errors, auth, abort, timeout) is final — pi's own retry already
      // handled the retryable HTTP cases inside complete().
      const isStreamError = STREAM_ERROR_RE.test(msg);
      if (!isStreamError || attemptNum >= extraRetries) break;
      const delay = Math.min(500 * 2 ** attemptNum, cfg.maxRetryDelayMs || 5000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
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