/**
 * Epic C orchestration: composes the content interpreter (TKT-009), font
 * decoding (TKT-010), geometry reconstruction (TKT-011), tagged-structure
 * resolution (TKT-012), and semantic block construction (TKT-013) into one
 * per-page and per-document entry point. This is the only module in the
 * library that imports from all four of `content/`, `fonts/`, and
 * `structure/` together — those stay independent of each other and of this
 * file, per the design's dependency direction.
 *
 * Not itself wired into `worker.ts` yet: that final integration (replacing
 * the Epic A placeholder result) is deliberately left to a later ticket so
 * this Epic C slice stays scoped to text/semantic extraction. Every
 * function here is exercised directly against the sample corpus by
 * `test/integration/epic-c-sample-corpus.integration.test.ts`.
 */

import type { DocumentAsset, DocumentMetadata, DocumentPage, OutlineItem, ParseWarning, ParseTimings } from "./types.ts";
import { NOOP_PARSE_RUNTIME, type ParseRuntime } from "./runtime.ts";
import type { PdfDocument } from "./parser/document.ts";
import type { PageDescriptor } from "./parser/pages.ts";
import { dictGet, isDict, isPdfString, type PdfValue } from "./parser/objects.ts";
import {
  interpretPageContent,
  resolvePageContentBytes,
  type MeasureTextFn,
} from "./content/interpreter.ts";
import { DEFAULT_MEASURE_TEXT } from "./content/interpreter.ts";
import { computeStringAdvanceForFont, decodePageText, FontCache, resolvePageFonts } from "./fonts/resolve.ts";
import { DEFAULT_GEOMETRY_THRESHOLDS, normalizeFragment, type PageGeometryContext } from "./structure/geometry.ts";
import {
  decodePdfTextString,
  parseStructTree,
  partitionArtifacts,
  resolvePageStructure,
  type PageStructureNode,
  type StructTree,
} from "./structure/tagged.ts";
import { resolveLinkTarget, resolveOutline } from "./structure/outline.ts";
import {
  buildGeometryFallbackBlocks,
  buildTaggedPageBlocks,
  createBlockBuildContext,
  IdGenerator,
  type XObjectMcidPlacement,
} from "./structure/blocks.ts";
import { extractPageImages, imagePlacementKey, type ImageTimingDiagnostics } from "./images/extract.ts";

// ---------------------------------------------------------------------------
// Document-level parse context
// ---------------------------------------------------------------------------

export interface DocumentParseContext {
  structTree: StructTree | undefined;
  pageRefToNumber: Map<string, number>;
  namedDestsRoot: PdfValue | undefined;
  fontCache: FontCache;
  ids: IdGenerator;
  imageAssetCache: Map<string, DocumentAsset>;
  imageTimings: ImageTimingDiagnostics;
}

async function resolveNamedDestsRoot(doc: PdfDocument): Promise<PdfValue | undefined> {
  const catalog = await doc.resolve(doc.trailer.get("Root"));
  if (!isDict(catalog)) return undefined;
  const namesVal = await doc.resolve(dictGet(catalog, "Names"));
  return isDict(namesVal) ? dictGet(namesVal, "Dests") : undefined;
}

export async function createDocumentParseContext(doc: PdfDocument, pages: PageDescriptor[]): Promise<DocumentParseContext> {
  const pageRefToNumber = new Map(pages.map((p) => [`${p.ref.num}:${p.ref.gen}`, p.pageNumber]));
  const structTree = await doc.runtime.timeAsync("structure-reconstruction", () => parseStructTree(doc, pageRefToNumber));
  const namedDestsRoot = await resolveNamedDestsRoot(doc);
  return {
    structTree,
    pageRefToNumber,
    namedDestsRoot,
    fontCache: new FontCache(),
    ids: new IdGenerator(),
    imageAssetCache: new Map(),
    imageTimings: { jpegPassThroughMs: 0, flateImageDecodeMs: 0, pngEncodeMs: 0, imageBytes: 0 },
  };
}

export async function resolveDocumentMetadata(doc: PdfDocument, pageCount: number): Promise<DocumentMetadata> {
  const infoVal = await doc.resolve(doc.trailer.get("Info"));
  let title: string | undefined;
  let producer: string | undefined;
  if (isDict(infoVal)) {
    const titleVal = await doc.resolve(dictGet(infoVal, "Title"));
    const producerVal = await doc.resolve(dictGet(infoVal, "Producer"));
    if (isPdfString(titleVal)) title = decodePdfTextString(titleVal.bytes);
    if (isPdfString(producerVal)) producer = decodePdfTextString(producerVal.bytes);
  }
  return { pageCount, title, producer };
}

export async function parseDocumentOutline(doc: PdfDocument, ctx: DocumentParseContext): Promise<OutlineItem[]> {
  return resolveOutline(doc, ctx.pageRefToNumber);
}

// ---------------------------------------------------------------------------
// Marked-content /Properties resolution (page resource -> MCID)
// ---------------------------------------------------------------------------

async function buildPropertiesResolver(
  doc: PdfDocument,
  page: PageDescriptor,
): Promise<(name: string) => { mcid?: number } | undefined> {
  if (!page.resources) return () => undefined;
  const propsVal = await doc.resolve(dictGet(page.resources, "Properties"));
  if (!isDict(propsVal)) return () => undefined;

  const byName = new Map<string, number>();
  for (const [name, value] of propsVal.map) {
    const resolved = await doc.resolve(value);
    if (isDict(resolved)) {
      const mcidVal = dictGet(resolved, "MCID");
      if (typeof mcidVal === "number") byName.set(name, mcidVal);
    }
  }
  return (name: string) => (byName.has(name) ? { mcid: byName.get(name) } : undefined);
}

// ---------------------------------------------------------------------------
// Per-page parsing
// ---------------------------------------------------------------------------

export async function parsePage(doc: PdfDocument, page: PageDescriptor, ctx: DocumentParseContext, options: { preserveImages?: boolean } = {}): Promise<DocumentPage> {
  const warnings: ParseWarning[] = [...page.warnings];
  const runtime: ParseRuntime = doc.runtime ?? NOOP_PARSE_RUNTIME;

  await runtime.checkpoint(`page ${page.pageNumber} setup`);
  const contentBytesResult = await runtime.timeAsync("page-content-decode", () => resolvePageContentBytes(doc, page), page.pageNumber);
  warnings.push(...contentBytesResult.warnings);

  const fonts = await runtime.timeAsync("font-decoding", () => resolvePageFonts(doc, page, ctx.fontCache, warnings), page.pageNumber);
  const measureText: MeasureTextFn = (fontResourceName, bytes, state) => {
    const font = fontResourceName ? fonts.get(fontResourceName) : undefined;
    return font ? computeStringAdvanceForFont(font, bytes, state) : DEFAULT_MEASURE_TEXT(fontResourceName, bytes, state);
  };
  const resolveMarkedContentProperties = await buildPropertiesResolver(doc, page);

  const interpretResult = await runtime.timeAsync("page-content-interpret", async () => interpretPageContent(contentBytesResult.bytes, page.pageNumber, {
    limits: doc.limits,
    measureText,
    resolveMarkedContentProperties,
    isCancelled: runtime.isCancelled,
  }), page.pageNumber);
  warnings.push(...interpretResult.warnings);

  const decodedFragments = decodePageText(interpretResult.fragments, fonts, warnings);

  const geometryContext: PageGeometryContext = { mediaBox: page.mediaBox, rotate: page.rotate };
  const normalizedFragments = decodedFragments.map((fragment) => normalizeFragment(fragment, geometryContext));

  const { content: contentFragments } = partitionArtifacts(normalizedFragments);
  const { content: contentXObjects } = partitionArtifacts(interpretResult.xobjects);

  let imageIdsByPlacement = new Map<string, string>();
  if (options.preserveImages) {
    const imageResult = await runtime.timeAsync("image-extraction", () => extractPageImages({
      doc,
      page,
      xobjects: contentXObjects,
      assetCache: ctx.imageAssetCache,
      warnings,
      timings: ctx.imageTimings,
    }), page.pageNumber);
    imageIdsByPlacement = imageResult.placementImageIds;
  }

  const fragmentsByMcid = new Map<number, typeof contentFragments>();
  for (let i = 0; i < contentFragments.length; i += 1) {
    if (i % 512 === 0) await runtime.checkpoint(`page ${page.pageNumber} MCID text grouping`);
    const fragment = contentFragments[i];
    if (fragment.mcid === undefined) continue;
    const list = fragmentsByMcid.get(fragment.mcid);
    if (list) list.push(fragment);
    else fragmentsByMcid.set(fragment.mcid, [fragment]);
  }

  const xobjectsByMcid = new Map<number, XObjectMcidPlacement[]>();
  for (let i = 0; i < contentXObjects.length; i += 1) {
    if (i % 128 === 0) await runtime.checkpoint(`page ${page.pageNumber} MCID image grouping`);
    const xobject = contentXObjects[i];
    if (xobject.mcid === undefined) continue;
    const list = xobjectsByMcid.get(xobject.mcid);
    const placement = { name: xobject.name, imageId: imageIdsByPlacement.get(imagePlacementKey(xobject)) };
    if (list) list.push(placement);
    else xobjectsByMcid.set(xobject.mcid, [placement]);
  }

  const pageMcids = new Set<number>();
  for (const fragment of contentFragments) if (fragment.mcid !== undefined) pageMcids.add(fragment.mcid);
  for (const xobject of contentXObjects) if (xobject.mcid !== undefined) pageMcids.add(xobject.mcid);

  const structResolution = await runtime.timeAsync("structure-reconstruction", async () => resolvePageStructure(ctx.structTree, page.pageNumber, pageMcids), page.pageNumber);
  warnings.push(...structResolution.warnings);

  const resolveLinkForNode = async (node: PageStructureNode) => {
    for (const entry of node.entries) {
      await runtime.checkpoint(`page ${page.pageNumber} link/action resolution`);
      if (entry.kind !== "objRef" || !entry.ref) continue;
      const annot = await doc.resolve(entry.ref);
      if (!isDict(annot)) continue;
      const target = await resolveLinkTarget(doc, annot, ctx.pageRefToNumber, ctx.namedDestsRoot);
      if (target) return target;
    }
    return undefined;
  };

  const blockCtx = createBlockBuildContext({
    pageNumber: page.pageNumber,
    ids: ctx.ids,
    fragmentsByMcid,
    xobjectsByMcid,
    resolveLinkForNode,
    thresholds: DEFAULT_GEOMETRY_THRESHOLDS,
  });

  let blocks;
  if (structResolution.isTagged) {
    blocks = await runtime.timeAsync("structure-reconstruction", () => buildTaggedPageBlocks(structResolution.nodes, blockCtx), page.pageNumber);
    const looseFragments = contentFragments.filter(
      (fragment) => fragment.mcid === undefined || structResolution.orphanedMcids.has(fragment.mcid),
    );
    if (looseFragments.length > 0) {
      blocks = blocks.concat(buildGeometryFallbackBlocks(looseFragments, blockCtx));
    }
  } else {
    blocks = buildGeometryFallbackBlocks(contentFragments, blockCtx);
  }

  warnings.push(...blockCtx.warnings);

  return {
    pageNumber: page.pageNumber,
    width: page.effectiveWidth,
    height: page.effectiveHeight,
    blocks,
    warnings,
  };
}

export function getDocumentAssets(ctx: DocumentParseContext): DocumentAsset[] {
  return [...ctx.imageAssetCache.values()];
}

export function appendImageTimings(timings: ParseTimings, ctx: DocumentParseContext): ParseTimings {
  const imageTimings = ctx.imageTimings;
  return {
    ...timings,
    imageBytes: imageTimings.imageBytes,
    jpegPassThroughMs: imageTimings.jpegPassThroughMs,
    flateImageDecodeMs: imageTimings.flateImageDecodeMs,
    pngEncodeMs: imageTimings.pngEncodeMs,
    phases: [
      ...timings.phases,
      { phase: "image-jpeg-pass-through", durationMs: imageTimings.jpegPassThroughMs },
      { phase: "image-flate-decode", durationMs: imageTimings.flateImageDecodeMs },
      { phase: "image-png-encode", durationMs: imageTimings.pngEncodeMs },
    ],
  };
}
