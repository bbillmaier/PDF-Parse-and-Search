/**
 * Public export surface of the `pdf-content-extractor` library.
 *
 * This is the only module a host application should import from. Everything
 * reachable from here has no dependency on React, Vite, or any other
 * bundler/framework global — see `types.ts` for the buffer/asset ownership
 * contract and `README.md` for the copy-folder integration guide.
 */

export type {
  // Document model
  ParsedDocument,
  DocumentMetadata,
  TitleSource,
  DocumentPage,
  // Blocks
  DocumentBlock,
  BlockBase,
  HeadingBlock,
  ParagraphBlock,
  ListBlock,
  ListItem,
  TableBlock,
  TableRow,
  TableCell,
  FigureBlock,
  UnknownBlock,
  SearchableBlockType,
  DocumentSearchRecord,
  // Text and links
  TextRun,
  LinkTarget,
  // Outline
  OutlineItem,
  // Assets
  DocumentAsset,
  DocumentImage,
  ImagePlacement,
  // Warnings
  ParseWarning,
  ParseWarningCode,
  // Progress and timings
  ParsePhase,
  ParseProgress,
  PhaseTiming,
  ParseTimings,
  // Options and limits
  ParseOptions,
  SafetyLimits,
} from "./types.ts";

export type { ParseErrorCode, SerializedParseError } from "./errors.ts";
export { PdfParseError, PdfParseCancelledError, PdfParseDisposedError } from "./errors.ts";

export type { PdfParser, WorkerFactory, WorkerHandle, CreatePdfParserConfig } from "./client.ts";
export { createPdfParser } from "./client.ts";

export type { HtmlRendererOptions, HtmlRendererClassHooks, RenderedHtml } from "./renderers/html.ts";
export { createObjectUrlResolver, renderDocumentToDisposableHtml, renderDocumentToHtml } from "./renderers/html.ts";

export type { HtmlDestination, PdfPageDestination } from "./navigation.ts";
export { collectSemanticIds, htmlDestinationForBlock, isSafeSemanticId, pdfPageDestinationForPage } from "./navigation.ts";

export type { GenerateSearchRecordsOptions } from "./search-records.ts";
export { generateDocumentSearchRecords } from "./search-records.ts";
