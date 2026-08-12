/**
 * Semantic block construction (TKT-013): turns TKT-012's per-page
 * structure view (or, for untagged pages, TKT-011's geometry fallback)
 * into the public `DocumentBlock[]` model — headings, paragraphs, lists,
 * figures, and (via `tables.ts`) tables. Also owns stable in-document ID
 * generation shared across a whole document.
 *
 * This module has no dependency on `parser/document.ts`/`PdfDocument`: link
 * resolution (which needs to read an annotation's `/A`/`/Dest`) is injected
 * through `BlockBuildContext.resolveLinkForNode` so this module stays
 * pure-data and independently testable, matching `structure/geometry.ts`
 * and `structure/tagged.ts`.
 */

import type { DocumentBlock, FigureBlock, HeadingBlock, LinkTarget, ListBlock, ListItem, ParagraphBlock, ParseWarning, ParseWarningCode, TextRun } from "../types.ts";
import {
  DEFAULT_GEOMETRY_THRESHOLDS,
  groupIntoLines,
  joinFragmentsText,
  reconstructReadingOrder,
  type GeometryThresholds,
  type NormalizedFragment,
  type TextLine,
} from "./geometry.ts";
import type { PageStructureEntry, PageStructureNode } from "./tagged.ts";
import { buildTableBlock } from "./tables.ts";

// ---------------------------------------------------------------------------
// Stable ID generation
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics left over from NFKD normalization
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Generates deterministic, document-unique block/list-item IDs from structural emission order, never mutable text. */
export class IdGenerator {
  private readonly counters = new Map<string, number>();

  next(prefix: string, _seedText?: string): string {
    const safePrefix = slugify(prefix) || "block";
    const nextValue = (this.counters.get(safePrefix) ?? 0) + 1;
    this.counters.set(safePrefix, nextValue);
    return `${safePrefix}-${nextValue}`;
  }
}

// ---------------------------------------------------------------------------
// Build context
// ---------------------------------------------------------------------------

export interface XObjectMcidPlacement {
  name: string;
  imageId?: string;
}

export interface BlockBuildContext {
  pageNumber: number;
  ids: IdGenerator;
  fragmentsByMcid: Map<number, NormalizedFragment[]>;
  xobjectsByMcid: Map<number, XObjectMcidPlacement[]>;
  thresholds: GeometryThresholds;
  warnings: ParseWarning[];
  /** Resolves a `Link` structure element's target via its `/OBJR`-referenced annotation, if any. */
  resolveLinkForNode: (node: PageStructureNode) => Promise<LinkTarget | undefined>;
}

export function createBlockBuildContext(params: {
  pageNumber: number;
  ids: IdGenerator;
  fragmentsByMcid: Map<number, NormalizedFragment[]>;
  xobjectsByMcid: Map<number, XObjectMcidPlacement[]>;
  resolveLinkForNode: (node: PageStructureNode) => Promise<LinkTarget | undefined>;
  thresholds?: GeometryThresholds;
}): BlockBuildContext {
  return {
    pageNumber: params.pageNumber,
    ids: params.ids,
    fragmentsByMcid: params.fragmentsByMcid,
    xobjectsByMcid: params.xobjectsByMcid,
    thresholds: params.thresholds ?? DEFAULT_GEOMETRY_THRESHOLDS,
    warnings: [],
    resolveLinkForNode: params.resolveLinkForNode,
  };
}

export function warn(ctx: BlockBuildContext, message: string, code: ParseWarningCode = "structure-inconsistency"): void {
  ctx.warnings.push({ code, message, pageNumber: ctx.pageNumber });
}

/** Joins the geometry-reconstructed lines for one MCID's fragments into a single `TextRun` (TKT-012's "use geometry inside an element"). */
export function textRunsForMcid(ctx: BlockBuildContext, mcid: number): TextRun[] {
  const fragments = ctx.fragmentsByMcid.get(mcid);
  if (!fragments || fragments.length === 0) return [];
  const lines = groupIntoLines(fragments, ctx.thresholds);
  const text = lines.map((line) => line.text).join(" ");
  return text.length > 0 ? [{ text }] : [];
}

function appendRuns(target: TextRun[], addition: TextRun[]): void {
  if (addition.length === 0) return;
  if (target.length > 0) {
    const lastText = target[target.length - 1].text;
    const firstText = addition[0].text;
    if (lastText.length > 0 && firstText.length > 0 && !/\s$/.test(lastText) && !/^\s/.test(firstText)) {
      target.push({ text: " " });
    }
  }
  target.push(...addition);
}

function attachLink(runs: TextRun[], target: LinkTarget): TextRun[] {
  return runs.map((run) => ({ ...run, link: run.link ?? target }));
}

// ---------------------------------------------------------------------------
// Role classification
// ---------------------------------------------------------------------------

const HEADING_LEVELS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
const INLINE_MERGE_ROLES = new Set(["Span", "Link", "Lbl", "Code"]);

function isHeadingRole(role: string): boolean {
  return role in HEADING_LEVELS || role === "H";
}

/** Matches labels already embedded in the text of Word-generated numbered paragraphs (for example `4.`, `1.2.3.`, or `A2.1.`). */
function hasStructuredNumberPrefix(text: string): boolean {
  return /^(?:[A-Z]\d+|\d+)(?:\.\d+)*\.\s/.test(text.trimStart());
}

function hasHierarchicalNumberPrefix(text: string): boolean {
  return /^(?:[A-Z]\d+|\d+)(?:\.\d+)+\.\s/.test(text.trimStart());
}

function fragmentsForEntries(entries: PageStructureEntry[], ctx: BlockBuildContext): NormalizedFragment[] {
  const fragments: NormalizedFragment[] = [];
  const seenMcids = new Set<number>();
  const visit = (items: PageStructureEntry[]): void => {
    for (const entry of items) {
      if (entry.kind === "mcid") {
        if (seenMcids.has(entry.mcid)) continue;
        seenMcids.add(entry.mcid);
        fragments.push(...(ctx.fragmentsByMcid.get(entry.mcid) ?? []));
      } else if (entry.kind === "element") {
        visit(entry.node.entries);
      }
    }
  };
  visit(entries);
  return fragments;
}

/** Reconstructs a container jointly so adjacent text split across sibling MCIDs is spaced from geometry rather than structure boundaries. */
function geometryRunsForEntries(entries: PageStructureEntry[], ctx: BlockBuildContext): TextRun[] {
  const fragments = fragmentsForEntries(entries, ctx);
  if (fragments.length === 0) return [];
  const sorted = fragments.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: NormalizedFragment[][] = [];
  for (const fragment of sorted) {
    const current = lines[lines.length - 1];
    if (!current) {
      lines.push([fragment]);
      continue;
    }
    const averageY = current.reduce((sum, item) => sum + item.y, 0) / current.length;
    const tolerance = Math.max(
      ctx.thresholds.sameLineBaselineToleranceMinPt,
      Math.max(fragment.fontSize, current[0].fontSize) * ctx.thresholds.sameLineBaselineToleranceEm,
    );
    if (Math.abs(fragment.y - averageY) <= tolerance) current.push(fragment);
    else lines.push([fragment]);
  }
  const text = lines
    .map((line) => joinFragmentsText(line.sort((a, b) => a.x - b.x), ctx.thresholds))
    .join(" ");
  return text.length > 0 ? [{ text }] : [];
}

function entriesContainRole(entries: PageStructureEntry[], role: string): boolean {
  return entries.some((entry) => entry.kind === "element" && (entry.node.role === role || entriesContainRole(entry.node.entries, role)));
}

function entriesAreGeometrySafeInlineText(entries: PageStructureEntry[]): boolean {
  const safeContainers = new Set(["Span", "Reference", "Code", "Lbl"]);
  return entries.every((entry) =>
    entry.kind !== "element" || (safeContainers.has(entry.node.role) && entriesAreGeometrySafeInlineText(entry.node.entries)),
  );
}

// ---------------------------------------------------------------------------
// Inline text collection (Span/Link/Code and any accidentally-nested block content)
// ---------------------------------------------------------------------------

export async function collectInlineRuns(entries: PageStructureEntry[], ctx: BlockBuildContext): Promise<TextRun[]> {
  const runs: TextRun[] = [];
  for (const entry of entries) {
    if (entry.kind === "mcid") {
      appendRuns(runs, textRunsForMcid(ctx, entry.mcid));
      continue;
    }
    if (entry.kind === "objRef") continue;

    const node = entry.node;
    if (node.role === "Link") {
      const inner = await collectInlineRuns(node.entries, ctx);
      const target = await ctx.resolveLinkForNode(node);
      appendRuns(runs, target ? attachLink(inner, target) : inner);
      continue;
    }
    if (isHeadingRole(node.role) || node.role === "L" || node.role === "Table" || node.role === "Figure") {
      warn(ctx, `A ${node.rawRole} element was nested inside inline text on page ${ctx.pageNumber}; its structure was flattened to plain text.`);
    }
    appendRuns(runs, await collectInlineRuns(node.entries, ctx));
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Block construction from a tagged structure view
// ---------------------------------------------------------------------------

async function buildHeading(node: PageStructureNode, ctx: BlockBuildContext): Promise<HeadingBlock | undefined> {
  const runs = await collectInlineRuns(node.entries, ctx);
  const text = runs.map((r) => r.text).join("");
  if (text.trim().length === 0) {
    warn(ctx, `A ${node.rawRole} heading on page ${ctx.pageNumber} had no decodable text; it was dropped.`);
    return undefined;
  }
  let level = HEADING_LEVELS[node.role];
  if (level === undefined) {
    level = 2;
    warn(ctx, `Generic /H heading on page ${ctx.pageNumber} declared no level; approximated as level 2.`);
  }
  return { type: "heading", id: ctx.ids.next("h", text || node.title), pageNumber: ctx.pageNumber, level, text: runs };
}

async function buildParagraphNode(node: PageStructureNode, ctx: BlockBuildContext): Promise<ParagraphBlock[]> {
  const directMcids = node.entries.filter((entry): entry is Extract<PageStructureEntry, { kind: "mcid" }> => entry.kind === "mcid");
  if (directMcids.length > 1 && directMcids.length === node.entries.length) {
    const splitRuns = directMcids.map((entry) => textRunsForMcid(ctx, entry.mcid));
    const splitTexts = splitRuns.map((runs) => runs.map((run) => run.text).join("").trim());
    if (splitTexts.every((text) => text.length > 0 && hasStructuredNumberPrefix(text))) {
      return splitRuns.map((text, index) => ({
        type: "paragraph",
        id: ctx.ids.next("p", splitTexts[index]),
        pageNumber: ctx.pageNumber,
        text,
      }));
    }
  }

  const descendantFragments = fragmentsForEntries(node.entries, ctx);
  const descendantMcids = new Set(descendantFragments.map((fragment) => fragment.mcid).filter((mcid): mcid is number => mcid !== undefined));
  if (descendantMcids.size > 1 && !entriesContainRole(node.entries, "Link") && entriesAreGeometrySafeInlineText(node.entries)) {
    const geometryRuns = geometryRunsForEntries(node.entries, ctx);
    const geometryText = geometryRuns.map((run) => run.text).join("").replace(/[ \t]+/g, " ").trim();
    if (geometryText.length > 0) {
      return [{ type: "paragraph", id: ctx.ids.next("p", geometryText), pageNumber: ctx.pageNumber, text: [{ text: geometryText }] }];
    }
  }

  const text = await collectInlineRuns(node.entries, ctx);
  const combined = text.map((run) => run.text).join("");
  return combined.trim().length > 0
    ? [{ type: "paragraph", id: ctx.ids.next("p", combined), pageNumber: ctx.pageNumber, text }]
    : [];
}

function looksLikeOrderedLabel(label: string): boolean {
  return /^[A-Za-z0-9]+[.):]/.test(label.trim());
}

function removeLeadingRunText(runs: TextRun[], charsToRemove: number): TextRun[] {
  let remaining = charsToRemove;
  const out: TextRun[] = [];
  for (const run of runs) {
    if (remaining <= 0) {
      out.push(run);
      continue;
    }
    if (run.text.length <= remaining) {
      remaining -= run.text.length;
      continue;
    }
    out.push({ ...run, text: run.text.slice(remaining) });
    remaining = 0;
  }
  return out;
}

function stripLeadingLiteralOMarker(blocks: DocumentBlock[], ctx: BlockBuildContext): void {
  const first = blocks[0];
  if (!first || first.type !== "paragraph") return;
  const text = first.text.map((run) => run.text).join("");
  const match = /^o\s+/.exec(text);
  if (!match) return;
  const strippedText = text.slice(match[0].length);
  blocks[0] = {
    ...first,
    id: ctx.ids.next("p", strippedText),
    text: removeLeadingRunText(first.text, match[0].length),
  };
}

async function buildListItem(
  bodyEntries: PageStructureEntry[],
  ctx: BlockBuildContext,
  label: string | undefined,
  hasExplicitLabel: boolean,
): Promise<ListItem> {
  const blocks = await buildBlocksFromEntries(bodyEntries, ctx);
  if (label && label.length > 0) {
    if (blocks.length > 0 && blocks[0].type === "paragraph") {
      const withLabel: ParagraphBlock = { ...blocks[0], text: [{ text: `${label} ` }, ...blocks[0].text] };
      blocks[0] = withLabel;
    } else {
      blocks.unshift({ type: "paragraph", id: ctx.ids.next("p", label), pageNumber: ctx.pageNumber, text: [{ text: label }] });
    }
  } else if (!hasExplicitLabel) {
    stripLeadingLiteralOMarker(blocks, ctx);
  }
  return { id: ctx.ids.next("li"), blocks };
}

async function buildList(node: PageStructureNode, ctx: BlockBuildContext): Promise<ListBlock> {
  const items: ListItem[] = [];
  let ordered = false;
  let orderedDecided = false;

  for (const entry of node.entries) {
    if (entry.kind !== "element") continue;
    const liNode = entry.node;
    if (liNode.role !== "LI") {
      warn(ctx, `List on page ${ctx.pageNumber} contains a non-LI child (role ${liNode.rawRole}); treated as one list item.`);
      items.push(await buildListItem(liNode.entries, ctx, undefined, true));
      continue;
    }

    let label: string | undefined;
    let hasExplicitLabel = false;
    const bodyEntries: PageStructureEntry[] = [];
    for (const liEntry of liNode.entries) {
      if (liEntry.kind === "element" && liEntry.node.role === "Lbl") {
        hasExplicitLabel = true;
        const labelRuns = await collectInlineRuns(liEntry.node.entries, ctx);
        label = labelRuns.map((r) => r.text).join("").trim();
        continue;
      }
      if (liEntry.kind === "element" && liEntry.node.role === "LBody") {
        bodyEntries.push(...liEntry.node.entries);
        continue;
      }
      bodyEntries.push(liEntry);
    }

    if (label && !orderedDecided) {
      ordered = looksLikeOrderedLabel(label);
      orderedDecided = true;
    }
    items.push(await buildListItem(bodyEntries, ctx, label, hasExplicitLabel));
  }

  return { type: "list", id: ctx.ids.next("list"), pageNumber: ctx.pageNumber, ordered, items };
}

function singletonNumberedParagraph(list: ListBlock): ParagraphBlock | undefined {
  if (list.items.length !== 1 || list.items[0].blocks.length !== 1) return undefined;
  const [onlyBlock] = list.items[0].blocks;
  if (onlyBlock.type === "list") return singletonNumberedParagraph(onlyBlock);
  if (onlyBlock.type !== "paragraph") return undefined;
  const text = onlyBlock.text.map((run) => run.text).join("");
  return hasHierarchicalNumberPrefix(text) ? onlyBlock : undefined;
}

async function buildFigure(node: PageStructureNode, ctx: BlockBuildContext): Promise<FigureBlock> {
  let imageId: string | undefined;
  for (const entry of node.entries) {
    if (entry.kind === "mcid") {
      const placements = ctx.xobjectsByMcid.get(entry.mcid);
      if (placements && placements.length > 0) {
        imageId = placements[0].imageId ?? `p${ctx.pageNumber}-xobj-${placements[0].name}`;
        break;
      }
    }
  }
  if (!imageId) {
    imageId = ctx.ids.next("fig-placeholder");
    warn(
      ctx,
      `Figure on page ${ctx.pageNumber} could not be matched to a supported placed image XObject; using a placeholder asset ID.`,
      "unsupported-image",
    );
  }

  let caption: TextRun[] | undefined;
  for (const entry of node.entries) {
    if (entry.kind === "element" && entry.node.role === "Caption") {
      const runs = await collectInlineRuns(entry.node.entries, ctx);
      if (runs.length > 0) caption = runs;
      break;
    }
  }

  return {
    type: "figure",
    id: ctx.ids.next("fig", node.title),
    pageNumber: ctx.pageNumber,
    imageId,
    altText: node.alt,
    caption,
    unsupported: imageId.startsWith("fig-placeholder"),
  };
}

/**
 * Builds `DocumentBlock`s from an ordered list of page-structure entries,
 * accumulating inline (`Span`/`Link`/`Code`/bare-MCID) content into
 * implicit paragraphs and flushing whenever a block-level role (heading,
 * list, table, figure) or any other container/paragraph role is
 * encountered — the latter recurses so nested containers (`Div`, `Sect`,
 * ...) simply flatten into their contents, which the public model has no
 * wrapper type for.
 */
export async function buildBlocksFromEntries(entries: PageStructureEntry[], ctx: BlockBuildContext): Promise<DocumentBlock[]> {
  const out: DocumentBlock[] = [];
  let currentRuns: TextRun[] = [];

  const flush = (): void => {
    if (currentRuns.length === 0) return;
    const runs = currentRuns;
    currentRuns = [];
    const text = runs.map((r) => r.text).join("");
    if (text.trim().length === 0) return;
    out.push({ type: "paragraph", id: ctx.ids.next("p", text), pageNumber: ctx.pageNumber, text: runs });
  };

  for (const entry of entries) {
    if (entry.kind === "mcid") {
      appendRuns(currentRuns, textRunsForMcid(ctx, entry.mcid));
      continue;
    }
    if (entry.kind === "objRef") continue;

    const node = entry.node;

    if (node.role === "P") {
      flush();
      out.push(...(await buildParagraphNode(node, ctx)));
      continue;
    }
    if (node.role === "TOCI") {
      flush();
      const runs = geometryRunsForEntries(node.entries, ctx);
      const text = runs.map((run) => run.text).join("").replace(/\s+/g, " ").trim();
      if (text.trim().length > 0) {
        out.push({ type: "paragraph", id: ctx.ids.next("p", text), pageNumber: ctx.pageNumber, text: [{ text }] });
      }
      continue;
    }
    if (isHeadingRole(node.role)) {
      flush();
      const heading = await buildHeading(node, ctx);
      if (heading) out.push(heading);
      continue;
    }
    if (node.role === "L") {
      flush();
      const list = await buildList(node, ctx);
      out.push(singletonNumberedParagraph(list) ?? list);
      continue;
    }
    if (node.role === "Table") {
      flush();
      out.push(await buildTableBlock(node, ctx));
      continue;
    }
    if (node.role === "Figure") {
      flush();
      out.push(await buildFigure(node, ctx));
      continue;
    }
    if (INLINE_MERGE_ROLES.has(node.role)) {
      const innerRuns = await collectInlineRuns(node.entries, ctx);
      if (node.role === "Link") {
        const target = await ctx.resolveLinkForNode(node);
        appendRuns(currentRuns, target ? attachLink(innerRuns, target) : innerRuns);
      } else {
        appendRuns(currentRuns, innerRuns);
      }
      continue;
    }

    // P, Reference, BibEntry, BlockQuote, Note, TOCI, Quote, and every container
    // role (Div, Sect, Part, Art, Document, TOC, NonStruct, Private, Unknown, ...):
    // flush what came before, then recurse so this element's own content becomes
    // its own sibling block(s).
    flush();
    out.push(...(await buildBlocksFromEntries(node.entries, ctx)));
  }

  flush();
  return out;
}

export async function buildTaggedPageBlocks(nodes: PageStructureNode[], ctx: BlockBuildContext): Promise<DocumentBlock[]> {
  const entries: PageStructureEntry[] = nodes.map((node) => ({ kind: "element", node }));
  return buildBlocksFromEntries(entries, ctx);
}

// ---------------------------------------------------------------------------
// Geometry fallback for untagged pages/content (TKT-011 integration)
// ---------------------------------------------------------------------------

function computeBodyFontSize(paragraphs: TextLine[][]): number {
  const sizes: number[] = [];
  for (const paragraph of paragraphs) for (const line of paragraph) sizes.push(line.fontSize);
  if (sizes.length === 0) return 12;
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

function guessHeadingLevel(sizeRatio: number): 1 | 2 | 3 | undefined {
  if (sizeRatio >= 1.8) return 1;
  if (sizeRatio >= 1.5) return 2;
  if (sizeRatio >= 1.25) return 3;
  return undefined;
}

/**
 * Conservative untagged-page fallback (spec 8.5): groups fragments into
 * paragraphs via `structure/geometry.ts` and only additionally guesses
 * headings, from a clear font-size outlier on an otherwise-standalone
 * line. Table reconstruction is intentionally not attempted here — per the
 * design, returning separate paragraph/line blocks is preferable to a
 * geometry-only table guess that risks merging unrelated columns.
 */
export function buildGeometryFallbackBlocks(fragments: NormalizedFragment[], ctx: BlockBuildContext): DocumentBlock[] {
  const { paragraphs, warnings: geometryWarnings } = reconstructReadingOrder(fragments, ctx.thresholds);
  for (const message of geometryWarnings) warn(ctx, message, "ambiguous-reading-order");

  const bodyFontSize = computeBodyFontSize(paragraphs);
  const out: DocumentBlock[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length === 1) {
      const line = paragraph[0];
      const level = guessHeadingLevel(line.fontSize / Math.max(1, bodyFontSize));
      if (level !== undefined && line.text.trim().length > 0) {
        out.push({ type: "heading", id: ctx.ids.next("h", line.text), pageNumber: ctx.pageNumber, level, text: [{ text: line.text }] });
        warn(ctx, `Heading level for "${line.text.slice(0, 40)}" on page ${ctx.pageNumber} was approximated from font size (untagged page).`, "ambiguous-reading-order");
        continue;
      }
    }
    const text = paragraph.map((line) => line.text).join(" ").trim();
    if (text.length === 0) continue;
    out.push({ type: "paragraph", id: ctx.ids.next("p", text), pageNumber: ctx.pageNumber, text: [{ text }] });
  }

  return out;
}
