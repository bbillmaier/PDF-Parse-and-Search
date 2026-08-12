/**
 * Geometric line/paragraph reconstruction (TKT-011): normalizes decoded
 * text-fragment coordinates for page rotation, groups fragments into lines
 * by compatible baselines, infers spaces from the precise start/end
 * positions TKT-009/010 already computed (no independent width
 * recomputation), and groups lines into conservative paragraphs using
 * vertical spacing and indentation. All thresholds live in
 * `DEFAULT_GEOMETRY_THRESHOLDS` below — nothing else in this module hides a
 * magic number.
 *
 * This module is reading-order-agnostic about *why* it was called: the
 * caller may pass every fragment on an untagged page (the design-mandated
 * geometry fallback) or just the fragments inside one tagged structure
 * element (TKT-012's "use geometry inside an element").
 */

import type { DecodedTextFragment } from "../fonts/resolve.ts";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface GeometryThresholds {
  /** Baseline-Y tolerance, as a fraction of font size, for two fragments to be on the same line. */
  sameLineBaselineToleranceEm: number;
  /** Floor for the baseline tolerance in points, so tiny/zero font sizes don't collapse every line together. */
  sameLineBaselineToleranceMinPt: number;
  /** Horizontal gap, as a fraction of font size, beyond which a space is inferred between adjacent fragments on a line. */
  spaceGapEmFraction: number;
  /** Horizontal gap, as a fraction of font size, beyond which fragments on the same baseline are treated as separate columns/segments rather than one line. */
  columnGapEmFraction: number;
  /** A line-to-line vertical gap larger than this fraction beyond the paragraph's typical line spacing starts a new paragraph. */
  paragraphGapLineFraction: number;
  /** Left-edge shift (in points) from the current paragraph's margin that starts a new paragraph even at normal line spacing (e.g. a new indented paragraph). */
  indentTolerancePt: number;
  /** A fragment whose start->end direction deviates from horizontal by more than this many degrees is kept in its own line rather than merged with horizontal neighbors. */
  maxHorizontalSkewDeg: number;
  /** A consecutive-line font-size ratio beyond this starts a new paragraph even at otherwise-normal line spacing (a heading-to-body or body-to-caption size jump). */
  fontSizeChangeRatio: number;
}

export const DEFAULT_GEOMETRY_THRESHOLDS: GeometryThresholds = {
  sameLineBaselineToleranceEm: 0.25,
  sameLineBaselineToleranceMinPt: 0.5,
  spaceGapEmFraction: 0.12,
  columnGapEmFraction: 2.5,
  paragraphGapLineFraction: 0.4,
  indentTolerancePt: 6,
  maxHorizontalSkewDeg: 3,
  fontSizeChangeRatio: 1.2,
};

// ---------------------------------------------------------------------------
// Rotation normalization
// ---------------------------------------------------------------------------

export interface PageGeometryContext {
  /** `[x0, y0, x1, y1]`, already min/max-normalized (as produced by `parser/pages.ts`). */
  mediaBox: readonly [number, number, number, number];
  /** One of 0/90/180/270 (as produced by `parser/pages.ts`). */
  rotate: number;
}

/**
 * Maps a point in raw PDF user space (origin at the MediaBox's bottom-left,
 * y increasing upward) to reading-order page space (origin at the
 * *displayed* page's top-left, y increasing downward), honoring `/Rotate`.
 * Derived by composing a y-flip with a clockwise image rotation; see the
 * module-level geometry fixtures for a worked numeric check per rotation.
 */
export function rotatePoint(x: number, y: number, ctx: PageGeometryContext): { x: number; y: number } {
  const [x0, y0, x1, y1] = ctx.mediaBox;
  const w = x1 - x0;
  const h = y1 - y0;
  const px = x - x0;
  const py = y - y0;
  switch (ctx.rotate) {
    case 90:
      return { x: py, y: px };
    case 180:
      return { x: w - px, y: py };
    case 270:
      return { x: h - py, y: w - px };
    default:
      return { x: px, y: h - py };
  }
}

export interface NormalizedFragment {
  pageNumber: number;
  text: string;
  /** Start (glyph-origin) point in reading-order page space. */
  x: number;
  y: number;
  /** End point (immediately after this fragment's glyphs) in reading-order page space. */
  endX: number;
  endY: number;
  /** Effective font size (nominal `Tf` size scaled by the text matrix), used for all em-relative thresholds. */
  fontSize: number;
  /** Degrees of the start->end direction from horizontal, in normalized page space. */
  rotationDeg: number;
  mcid: number | undefined;
  tags: string[];
  artifact: boolean;
  sourceOffset: number;
  unknownGlyphCount: number;
}

export function normalizeFragment(fragment: DecodedTextFragment, ctx: PageGeometryContext): NormalizedFragment {
  const start = rotatePoint(fragment.matrix[4], fragment.matrix[5], ctx);
  const end = rotatePoint(fragment.endMatrix[4], fragment.endMatrix[5], ctx);
  const scale = Math.hypot(fragment.matrix[0], fragment.matrix[1]) || 1;
  const rotationDeg = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;

  return {
    pageNumber: fragment.pageNumber,
    text: fragment.text,
    x: start.x,
    y: start.y,
    endX: end.x,
    endY: end.y,
    fontSize: fragment.fontSize * scale,
    rotationDeg,
    mcid: fragment.mcid,
    tags: fragment.tags,
    artifact: fragment.artifact,
    sourceOffset: fragment.sourceOffset,
    unknownGlyphCount: fragment.unknownGlyphCount,
  };
}

// ---------------------------------------------------------------------------
// Line grouping
// ---------------------------------------------------------------------------

export interface TextLine {
  pageNumber: number;
  text: string;
  /** Representative baseline Y (average of member fragments), in reading-order page space. */
  y: number;
  startX: number;
  endX: number;
  /** Largest member fragment font size, used as this line's reference size for paragraph-spacing decisions. */
  fontSize: number;
  /** 1 for an unambiguous line; lower when a skewed fragment or a wide internal gap made grouping uncertain. */
  confidence: number;
  fragments: NormalizedFragment[];
}

function isHorizontal(fragment: NormalizedFragment, thresholds: GeometryThresholds): boolean {
  const deg = ((fragment.rotationDeg % 180) + 180) % 180;
  const distanceFromAxis = Math.min(deg, 180 - deg);
  return distanceFromAxis <= thresholds.maxHorizontalSkewDeg;
}

function baselineTolerance(fontSize: number, thresholds: GeometryThresholds): number {
  return Math.max(thresholds.sameLineBaselineToleranceMinPt, fontSize * thresholds.sameLineBaselineToleranceEm);
}

/** Infers spaces from the precise end-of-fragment -> start-of-next-fragment gap; never inserts a space where the decoded text already has adjoining whitespace. */
export function joinFragmentsText(fragmentsSortedByX: NormalizedFragment[], thresholds: GeometryThresholds): string {
  let text = "";
  let prev: NormalizedFragment | undefined;
  for (const fragment of fragmentsSortedByX) {
    if (prev) {
      const gap = fragment.x - prev.endX;
      const em = Math.max(prev.fontSize, fragment.fontSize, 1);
      const prevEndsWithSpace = /\s$/.test(prev.text);
      const nextStartsWithSpace = /^\s/.test(fragment.text);
      if (gap > em * thresholds.spaceGapEmFraction && !prevEndsWithSpace && !nextStartsWithSpace) {
        text += " ";
      }
    }
    text += fragment.text;
    prev = fragment;
  }
  return text;
}

/** Splits an x-sorted, same-baseline fragment run wherever the gap looks like a column/tab break rather than intra-line spacing. */
function splitByColumnGap(fragmentsSortedByX: NormalizedFragment[], thresholds: GeometryThresholds): NormalizedFragment[][] {
  const segments: NormalizedFragment[][] = [];
  let current: NormalizedFragment[] = [];
  let prev: NormalizedFragment | undefined;

  for (const fragment of fragmentsSortedByX) {
    if (prev) {
      const gap = fragment.x - prev.endX;
      const em = Math.max(prev.fontSize, fragment.fontSize, 1);
      if (gap > em * thresholds.columnGapEmFraction) {
        segments.push(current);
        current = [];
      }
    }
    current.push(fragment);
    prev = fragment;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Groups fragments into `TextLine`s by baseline proximity (not by input
 * order, so out-of-stream-order content still lands on the right line),
 * splitting same-baseline runs that contain a column-sized horizontal gap
 * into separate lines. Non-horizontal fragments (beyond
 * `maxHorizontalSkewDeg`) are never merged with horizontal neighbors.
 */
export function groupIntoLines(fragments: NormalizedFragment[], thresholds: GeometryThresholds = DEFAULT_GEOMETRY_THRESHOLDS): TextLine[] {
  const horizontal: NormalizedFragment[] = [];
  const skewed: NormalizedFragment[] = [];
  for (const fragment of fragments) {
    if (fragment.text.length === 0) continue;
    (isHorizontal(fragment, thresholds) ? horizontal : skewed).push(fragment);
  }

  const sorted = horizontal.slice().sort((a, b) => a.y - b.y || a.x - b.x);

  const clusters: NormalizedFragment[][] = [];
  let currentCluster: NormalizedFragment[] = [];
  let runningY = 0;

  for (const fragment of sorted) {
    if (currentCluster.length === 0) {
      currentCluster = [fragment];
      runningY = fragment.y;
      continue;
    }
    const tolerance = baselineTolerance(Math.max(fragment.fontSize, currentCluster[0].fontSize), thresholds);
    if (Math.abs(fragment.y - runningY) <= tolerance) {
      currentCluster.push(fragment);
      runningY = (runningY * (currentCluster.length - 1) + fragment.y) / currentCluster.length;
    } else {
      clusters.push(currentCluster);
      currentCluster = [fragment];
      runningY = fragment.y;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  const lines: TextLine[] = [];
  for (const cluster of clusters) {
    const byX = cluster.slice().sort((a, b) => a.x - b.x);
    for (const segment of splitByColumnGap(byX, thresholds)) {
      lines.push(buildLine(segment, thresholds, 1));
    }
  }
  for (const fragment of skewed) {
    lines.push(buildLine([fragment], thresholds, 0.5));
  }

  return lines.sort((a, b) => {
    const tolerance = baselineTolerance(Math.max(a.fontSize, b.fontSize), thresholds);
    return Math.abs(a.y - b.y) <= tolerance ? a.startX - b.startX : a.y - b.y;
  });
}

function buildLine(fragments: NormalizedFragment[], thresholds: GeometryThresholds, confidence: number): TextLine {
  const y = fragments.reduce((sum, f) => sum + f.y, 0) / fragments.length;
  const startX = Math.min(...fragments.map((f) => f.x));
  const endX = Math.max(...fragments.map((f) => f.endX));
  const fontSize = Math.max(...fragments.map((f) => f.fontSize));
  return {
    pageNumber: fragments[0].pageNumber,
    text: joinFragmentsText(fragments, thresholds),
    y,
    startX,
    endX,
    fontSize,
    confidence,
    fragments,
  };
}

// ---------------------------------------------------------------------------
// Paragraph grouping
// ---------------------------------------------------------------------------

/**
 * Groups top-to-bottom-sorted lines into conservative paragraphs using
 * vertical spacing (relative to the paragraph's own typical line spacing)
 * and left-edge indentation changes. Lines are expected to already be in
 * `groupIntoLines`'s output order.
 */
export function groupLinesIntoParagraphs(
  lines: TextLine[],
  thresholds: GeometryThresholds = DEFAULT_GEOMETRY_THRESHOLDS,
): TextLine[][] {
  const paragraphs: TextLine[][] = [];
  let current: TextLine[] = [];
  let typicalGap: number | undefined;

  for (const line of lines) {
    const prev = current.length > 0 ? current[current.length - 1] : undefined;
    if (!prev) {
      current = [line];
      paragraphs.push(current);
      continue;
    }

    const gap = line.y - prev.y;
    const indentShift = Math.abs(line.startX - current[0].startX);
    // Before a paragraph has established its own typical spacing, fall back to a
    // generic single-line-spacing estimate (~1.2x font size) so the very first
    // line-to-line transition can still detect an oversized gap (e.g. a title
    // followed by a much-more-tightly-leaded body paragraph).
    const referenceGap = typicalGap ?? Math.max(line.fontSize, prev.fontSize) * 1.2;
    const gapLooksNormal = gap <= referenceGap * (1 + thresholds.paragraphGapLineFraction);
    const newByGap = !gapLooksNormal;
    const newByIndent = gapLooksNormal && indentShift > thresholds.indentTolerancePt;
    const sizeRatio = Math.max(line.fontSize, prev.fontSize) / Math.max(1, Math.min(line.fontSize, prev.fontSize));
    const newByFontSize = sizeRatio > thresholds.fontSizeChangeRatio;

    if (newByGap || newByIndent || newByFontSize) {
      current = [line];
      paragraphs.push(current);
      typicalGap = undefined;
    } else {
      current.push(line);
      typicalGap = typicalGap === undefined ? gap : typicalGap * 0.5 + gap * 0.5;
    }
  }

  return paragraphs;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export interface ReadingOrderResult {
  paragraphs: TextLine[][];
  /** Human-readable notes on ambiguous grouping decisions (e.g. a likely multi-column split); the caller maps these to `ambiguous-reading-order` warnings. */
  warnings: string[];
}

export function reconstructReadingOrder(
  fragments: NormalizedFragment[],
  thresholds: GeometryThresholds = DEFAULT_GEOMETRY_THRESHOLDS,
): ReadingOrderResult {
  const lines = groupIntoLines(fragments, thresholds);
  const paragraphs = groupLinesIntoParagraphs(lines, thresholds);
  const warnings: string[] = [];
  for (const line of lines) {
    if (line.confidence < 1) {
      warnings.push(`Non-horizontal text near (${line.startX.toFixed(1)}, ${line.y.toFixed(1)}) was kept as its own line.`);
    }
  }
  return { paragraphs, warnings };
}
