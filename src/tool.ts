// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * tool.ts — the `describe_image` tool.
 *
 * The main model decides when to call it, passing an image path and a specific
 * question. The image goes through pi's official pipeline to the configured
 * vision model; the result returns as a tool_result.
 *
 * Multi-format: image_path may point to heic/heif/avif/tiff/svg/... — they are
 * auto-converted to JPEG. If the image was already described automatically, the
 * <image-analysis> block gave a `cached-at` path: pass that path here with a
 * specific question to analyze the same image further.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadImageFromFile } from "./images";
import { describeWithPipeline } from "./vision";
import { findConfiguredModel, modelRef } from "./discovery";
import type { VisionToolConfig } from "./config";

export interface DescribeImageDeps {
  getConfig: () => VisionToolConfig;
  onCall?: (ok: boolean) => void;
}

function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: text }, isError: false };
}

export function registerDescribeTool(pi: ExtensionAPI, deps: DescribeImageDeps): void {
  pi.registerTool({
    name: "describe_image",
    label: "Describe Image",
    description:
      "Analyze an image file with a vision-capable model and answer a specific question. " +
      "Pass the on-disk path and a precise question, e.g. \"extract the stack trace in line 4\" or " +
      "\"why is the button shifted 10px to the right?\" or \"what hex color is the header?\". " +
      "Supports PNG/JPEG/GIF/WebP/BMP natively and HEIC/HEIF/AVIF/TIFF/SVG via automatic conversion. " +
      "If an earlier <image-analysis> block contained `cached-at: <path>`, you may pass that exact path " +
      "with a specific question to analyze the same image further (e.g. extract all text verbatim). " +
      "The tool reads the file once, sends it to the configured vision model once, " +
      "and returns the model's answer as text.",
    promptSnippet: "Analyze an image file with a vision model, answering a precise question",
    promptGuidelines: [
      "Use describe_image when the user asks to analyze/extract information from an image file on disk — reading error messages or stack traces, checking screenshots or layout issues, transcribing text or diagrams. Pass the file path and a precise question; never guess image content from the path alone.",
      "Automatic interception already describes images in the conversation; when a previous <image-analysis> includes `cached-at: <path>`, you can call describe_image with that path and a specific question to get further details (text, numbers, colors) from the same image.",
      "Only call this when the actual image content matters — never attempt to read image bytes yourself with read/python/OCR when describe_image is available.",
    ],
    parameters: Type.Object({
      image_path: Type.String({
        description:
          "Absolute or workspace-relative path to the image file (png/jpeg/gif/webp/bmp, or heic/heif/avif/tiff/svg which are auto-converted). May also be a `cached-at` path from a previous <image-analysis>.",
      }),
      question: Type.String({
        description: "The specific question to answer about the image content.",
      }),
    }),
    async execute(_toolCallId, params: { image_path: string; question: string }, signal, _onUpdate, ctx) {
      const cfg = deps.getConfig();
      if (!cfg.enabled) {
        return errResult("vision tool is disabled. Run /vision on to enable it.");
      }
      if (!cfg.provider || !cfg.model) {
        return errResult(
          "vision model is not configured yet (auto-discovery will pick the first available image model at session start, or run /vision set <provider> <model>).",
        );
      }
      const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
      if (!model) {
        return errResult(`configured vision model ${cfg.provider}/${cfg.model} is unavailable. Run /vision list to see image-capable models.`);
      }
      try {
        const loaded = await loadImageFromFile(params.image_path, cfg);
        const answer = await describeWithPipeline(ctx, model, cfg, loaded, params.question, signal);
        deps.onCall?.(true);
        const lines = [answer.text.trim()];
        if (loaded.note) lines.push(`\n[note: ${loaded.note}]`);
        if (loaded.cachePath) lines.push(`\n[cached-at: ${loaded.cachePath}]`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { model: modelRef(model), image_path: params.image_path, cached_at: loaded.cachePath, note: loaded.note },
        };
      } catch (e) {
        deps.onCall?.(false);
        const msg = e instanceof Error ? e.message : String(e);
        return errResult(`describe_image failed (${modelRef(model)}): ${msg}`);
      }
    },
  });
}

export type { Model, Api, ExtensionContext };