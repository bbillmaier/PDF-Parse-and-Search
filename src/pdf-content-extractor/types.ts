/**
 * Public data contracts for the PDF content extractor.
 *
 * Buffer and asset ownership: every `Uint8Array` exposed on a public type
 * (for example `DocumentImage.bytes`) is transferred to the caller when the
 * containing `ParsedDocument` is delivered. The worker does not retain a
 * reference to it afterwards and the host application owns its lifetime,
 * including revoking any object URLs created from it. See the library
 * README for the full ownership and cleanup contract.
 *
 * This module has no runtime dependency on React, Vite, or any bundler
 * global. It only uses browser/worker-portable types (DOM lib) so it can be
 * copied into another TypeScript application unmodified.
 */

// ---------------------------------------------------------------------------
// Links and inline text
// ---------------------------------------------------------------------------

export type LinkTarget =
  | { kind: "internal"; pageNumber: number }
  | { kind: "external"; href: string };

export interface TextRun {
  text: string;
  link?: LinkTarget;
}

// ---------------------------------------------------------------------------
// Semantic blocks
// ---------------------------------------------------------------------------

export interface BlockBase {
  id: string;
  sectionId?: string;
  pageNumber: number;
}

export interface HeadingBlock extends BlockBase {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: TextRun[];
}

export interface ParagraphBlock extends BlockBase {
  type: "paragraph";
  text: TextRun[];
}

export interface ListItem {
  id: string;
  blocks: DocumentBlock[];
}

export interface ListBlock extends BlockBase {
  type: "list";
  ordered: boolean;
  items: ListItem[];
}

export interface TableCell {
  id: string;
  sectionId?: string;
  pageNumber: number;
  blocks: DocumentBlock[];
  isHeader: boolean;
  colSpan: number;
  rowSpan: number;
}

export interface TableRow {
  cells: TableCell[];
}

export interface TableBlock extends BlockBase {
  type: "table";
  rows: TableRow[];
}

export interface FigureBlock extends BlockBase {
  type: "figure";
  imageId: string;
  caption?: TextRun[];
  altText?: string;
  /** True when the structure/caption was retained but no supported image bytes could be produced. */
  unsupported?: boolean;
}

export interface UnknownBlock extends BlockBase {
  type: "unknown";
  reason: string;
}

export type DocumentBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | FigureBlock
  | UnknownBlock;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface DocumentImage {
  id: string;
  pageNumber: number;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
  bytes: Uint8Array;
  placements: ImagePlacement[];
  altText?: string;
  caption?: DocumentBlock[];
}

export type DocumentAsset = DocumentImage;

export interface ImagePlacement {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  matrix: [number, number, number, number, number, number];
  xObjectName: string;
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export interface OutlineItem {
  title: string;
  level: number;
  target?: LinkTarget;
  children: OutlineItem[];
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export type ParseWarningCode =
  | "not-implemented"
  | "unsupported-feature"
  | "unknown-glyph"
  | "unsupported-image"
  | "ambiguous-reading-order"
  | "limit-exceeded-locally"
  /** A locally recoverable structural inconsistency (e.g. a page-tree /Count mismatch or a missing inheritable attribute). */
  | "structure-inconsistency";

export interface ParseWarning {
  code: ParseWarningCode;
  message: string;
  pageNumber?: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Pages and document
// ---------------------------------------------------------------------------

export interface DocumentPage {
  pageNumber: number;
  width: number;
  height: number;
  blocks: DocumentBlock[];
  warnings: ParseWarning[];
}

/**
 * TKT-036: provenance of the selected `DocumentMetadata.displayTitle`, in
 * descending selection priority -- see docs/DESIGN.md section 21.7 and
 * src/title-selection.ts (host-shared selection logic; kept out of this
 * portable extractor, which has no concept of boilerplate rejection or host
 * overrides, only this data contract).
 */
export type TitleSource = "host" | "pdf-metadata" | "first-page-heading" | "filename";

export interface DocumentMetadata {
  id?: string;
  pageCount: number;
  /** Raw PDF `/Info` dictionary Title, exactly as extracted -- evidence only,
   *  never overwritten by title selection or a host override. May itself be
   *  boilerplate or absent; see `displayTitle` for the selected library
   *  title. */
  title?: string;
  producer?: string;
  /** TKT-036: the selected display/library title -- what document listings,
   *  search results, and navigation should show. Set by host-shared
   *  selection logic (src/title-selection.ts), never computed inside this
   *  extractor. */
  displayTitle?: string;
  /** TKT-036: which selection tier produced `displayTitle`. */
  titleSource?: TitleSource;
  /** TKT-036: bounded confidence in `displayTitle`, in the closed interval
   *  [0, 1]. 1 for an explicit host override; lower for weaker inferred
   *  candidates. */
  titleConfidence?: number;
}

export type SearchableBlockType = "heading" | "paragraph" | "list-item" | "table-cell" | "figure-caption";

export interface DocumentSearchRecord {
  documentId: string;
  documentTitle: string;
  sectionId: string;
  blockId: string;
  heading: string;
  headingPath: string[];
  pageNumber: number;
  blockType: SearchableBlockType;
  text: string;
  tableHeader?: string;
  rowHeader?: string;
}

// ---------------------------------------------------------------------------
// Progress and timings
// ---------------------------------------------------------------------------

export type ParsePhase =
  | "initializing"
  | "reading-input"
  | "parsing"
  | "finalizing";

export type TimingPhase =
  | ParsePhase
  | "worker-startup"
  | "xref-object-resolution"
  | "page-tree"
  | "font-decoding"
  | "page-content-decode"
  | "page-content-interpret"
  | "structure-reconstruction"
  | "image-extraction"
  | "message-transfer"
  | "rendering"
  | "image-jpeg-pass-through"
  | "image-flate-decode"
  | "image-png-encode";

export interface ParseProgress {
  phase: ParsePhase;
  pagesCompleted?: number;
  totalPages?: number;
  message?: string;
}

export interface PhaseTiming {
  phase: TimingPhase;
  durationMs: number;
  pageNumber?: number;
}

export interface ParseTimings {
  totalMs: number;
  phases: PhaseTiming[];
  inputBytes: number;
  imageBytes?: number;
  largeBufferBytes?: number;
  transferredAssetBytes?: number;
  jpegPassThroughMs?: number;
  flateImageDecodeMs?: number;
  pngEncodeMs?: number;
}

export interface ParsedDocument {
  metadata: DocumentMetadata;
  pages: DocumentPage[];
  outline: OutlineItem[];
  assets: DocumentAsset[];
  warnings: ParseWarning[];
  timings: ParseTimings;
}

// ---------------------------------------------------------------------------
// Safety limits and parse options
// ---------------------------------------------------------------------------

export interface SafetyLimits {
  maxInputBytes: number;
  maxObjectCount: number;
  maxObjectStreamExpansionBytes: number;
  maxDecodedStreamBytes: number;
  maxCompressionRatio: number;
  maxReferenceDepth: number;
  maxPageTreeDepth: number;
  maxContentOperationsPerPage: number;
  maxImageDimensionPx: number;
  maxImagePixelCount: number;
  maxCMapBytes: number;
  maxCMapMappingCount: number;
  /** Maximum array/dictionary nesting depth the low-level value parser will descend into. */
  maxNestingDepth: number;
  /** Maximum byte length of a single lexer token (number, name, keyword, literal/hex string). */
  maxTokenLength: number;
}

export interface ParseOptions {
  preserveImages?: boolean;
  onPage?: (page: DocumentPage) => void;
  onProgress?: (progress: ParseProgress) => void;
  signal?: AbortSignal;
  limits?: Partial<SafetyLimits>;
}
