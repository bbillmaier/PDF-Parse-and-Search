/**
 * Default safety limits for the PDF object engine (Epic B). Values are
 * generous defaults suitable for the target document profile in
 * docs/DESIGN.md section 4, not tuned performance budgets — callers can
 * override any subset through `ParseOptions.limits`.
 */

import type { SafetyLimits } from "../types.ts";

export const DEFAULT_SAFETY_LIMITS: SafetyLimits = {
  maxInputBytes: 512 * 1024 * 1024,
  maxObjectCount: 500_000,
  maxObjectStreamExpansionBytes: 256 * 1024 * 1024,
  maxDecodedStreamBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 300,
  maxReferenceDepth: 64,
  maxPageTreeDepth: 64,
  maxContentOperationsPerPage: 200_000,
  maxImageDimensionPx: 20_000,
  maxImagePixelCount: 64_000_000,
  maxCMapBytes: 16 * 1024 * 1024,
  maxCMapMappingCount: 2_000_000,
  maxNestingDepth: 64,
  maxTokenLength: 64 * 1024,
};

export function resolveLimits(partial?: Partial<SafetyLimits>): SafetyLimits {
  return { ...DEFAULT_SAFETY_LIMITS, ...partial };
}
