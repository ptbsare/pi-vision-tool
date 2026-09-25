// SPDX-License-Identifier: GPL-3.0-or-later
// pi-vision-tool — see LICENSE for the full GPLv3 text.
// Copyright (C) 2026 ptbsare

/**
 * discovery.ts — find image-capable models in pi's model registry.
 *
 * Auto-discovery: on session start, if no provider/model is configured, pick the
 * first available (authenticated, image-capable) model and write it to
 * vision-tool.json. Falls back automatically when the configured model becomes
 * unavailable.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function isVisionModel(m: Model<Api>): boolean {
  return Array.isArray(m.input) && m.input.includes("image");
}

export function listVisionModels(ctx: ExtensionContext): Model<Api>[] {
  const all: Model<Api>[] = [];
  const ra = ctx.modelRegistry as unknown as Record<string, unknown>;
  if (typeof ra.getAvailable === "function") {
    all.push(...(ra.getAvailable() as Model<Api>[]));
  } else if (typeof ra.getAll === "function") {
    all.push(...(ra.getAll() as Model<Api>[]));
  } else if (Array.isArray((ctx as unknown as { scopedModels?: unknown[] }).scopedModels)) {
    all.push(...((ctx as unknown as { scopedModels: { model: Model<Api> }[] }).scopedModels.map((s) => s.model)));
  }
  return all
    .filter(isVisionModel)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

export function findFirstVisionModel(ctx: ExtensionContext): Model<Api> | undefined {
  return listVisionModels(ctx)[0];
}

export function findConfiguredModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  if (!provider || !modelId) return undefined;
  try {
    const m = ctx.modelRegistry.find(provider, modelId);
    return m && isVisionModel(m) ? m : undefined;
  } catch {
    return undefined;
  }
}

export function modelRef(m: Model<Api>): string {
  return `${m.provider}/${m.id}`;
}