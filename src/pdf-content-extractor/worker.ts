/**
 * Dedicated worker entry point. `createWorkerHandler` contains all message
 * handling logic and takes an explicit scope so it can be exercised in
 * tests without a real worker thread; the bottom of this module wires it up
 * to `self` when the file is actually loaded as a worker script.
 *
 * The worker owns the real parse pipeline so object resolution, content
 * interpretation, image extraction, and PNG/JPEG asset handling stay off the
 * browser main thread.
 */

import type { ParsedDocument, ParsePhase, ParseProgress } from "./types.ts";
import type { SerializedParseError } from "./errors.ts";
import { PdfParseCancelledError, PdfParseError } from "./errors.ts";
import { createParseRuntime, now, TimingCollector } from "./runtime.ts";
import {
  PROTOCOL_VERSION,
  type ParseRequestMessage,
  type ParseResponseMessage,
  type WorkerGlobalScope,
} from "./protocol.ts";
import { openPdfDocument } from "./parser/document.ts";
import { traversePageTree } from "./parser/pages.ts";
import {
  appendImageTimings,
  createDocumentParseContext,
  getDocumentAssets,
  parseDocumentOutline,
  parsePage,
  resolveDocumentMetadata,
} from "./pipeline.ts";

function postProgress(scope: WorkerGlobalScope, requestId: string, progress: ParseProgress): void {
  const message: ParseResponseMessage = {
    version: PROTOCOL_VERSION,
    kind: "progress",
    requestId,
    progress,
  };
  scope.postMessage(message);
}

function serializeError(error: unknown): SerializedParseError {
  if (error instanceof PdfParseError) return error.toSerialized();
  return {
    code: "internal-error",
    message: error instanceof Error ? error.message : "Unknown worker failure.",
  };
}

/** Tracks requestIds cancelled before their (placeholder) work finished. */
function createHandler(scope: WorkerGlobalScope) {
  const cancelledRequestIds = new Set<string>();

  async function handleParse(message: Extract<ParseRequestMessage, { kind: "parse" }>): Promise<void> {
    const { requestId } = message;
    const started = now();
    const timings = new TimingCollector();
    const runtime = createParseRuntime(() => cancelledRequestIds.has(requestId), timings);

    function checkCancelled(): boolean {
      return cancelledRequestIds.has(requestId);
    }

    function markPhase(phase: ParsePhase, progress: Omit<ParseProgress, "phase"> = {}): () => void {
      const phaseStart = now();
      postProgress(scope, requestId, { phase, ...progress });
      return () => timings.add(phase, now() - phaseStart);
    }

    try {
      const inputBytes = message.input.byteLength;
      let endPhase = markPhase("initializing", { message: "Opening PDF document" });
      const doc = await runtime.timeAsync("xref-object-resolution", () => openPdfDocument(new Uint8Array(message.input), message.options.limits, runtime));
      endPhase();
      await runtime.checkpoint("document initialization");

      endPhase = markPhase("reading-input", { message: "Traversing page tree" });
      const pageTree = await runtime.timeAsync("page-tree", () => traversePageTree(doc, doc.limits, (pagesCompleted) => {
        postProgress(scope, requestId, { phase: "reading-input", pagesCompleted, message: "Discovered pages" });
      }, runtime));
      const pages = pageTree.pages;
      const ctx = await createDocumentParseContext(doc, pages);
      endPhase();
      await runtime.checkpoint("page-tree and document context");

      endPhase = markPhase("parsing", { pagesCompleted: 0, totalPages: pages.length, message: "Parsing page content" });
      const documentPages = [];
      for (const page of pages) {
        await runtime.checkpoint(`page ${page.pageNumber} parsing`);
        const parsedPage = await parsePage(doc, page, ctx, { preserveImages: message.options.preserveImages !== false });
        documentPages.push(parsedPage);
        const pageMessage: ParseResponseMessage = {
          version: PROTOCOL_VERSION,
          kind: "page",
          requestId,
          page: parsedPage,
        };
        scope.postMessage(pageMessage);
        timings.add("message-transfer", 0, page.pageNumber);
        postProgress(scope, requestId, {
          phase: "parsing",
          pagesCompleted: documentPages.length,
          totalPages: pages.length,
          message: "Parsed page content",
        });
      }
      endPhase();
      await runtime.checkpoint("page parsing");

      endPhase = markPhase("finalizing", { pagesCompleted: documentPages.length, totalPages: pages.length, message: "Building document result" });
      const assets = getDocumentAssets(ctx);
      const metadata = await resolveDocumentMetadata(doc, pages.length);
      const outline = await parseDocumentOutline(doc, ctx);
      endPhase();
      const transferredAssetBytes = assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
      const parseTimings = appendImageTimings({
        totalMs: now() - started,
        phases: timings.phases,
        inputBytes,
        largeBufferBytes: inputBytes + transferredAssetBytes,
        transferredAssetBytes,
      }, ctx);
      const document: ParsedDocument = {
        metadata,
        pages: documentPages,
        outline,
        assets,
        warnings: [...pageTree.warnings, ...(ctx.structTree?.warnings ?? []), ...documentPages.flatMap((page) => page.warnings)],
        timings: { ...parseTimings, totalMs: now() - started },
      };

      const transfer: Transferable[] = document.assets.map((asset) => asset.bytes.buffer as ArrayBuffer);
      const resultMessage: ParseResponseMessage = {
        version: PROTOCOL_VERSION,
        kind: "result",
        requestId,
        document,
      };
      scope.postMessage(resultMessage, transfer);
    } catch (error) {
      if (error instanceof PdfParseCancelledError || (error instanceof PdfParseError && error.code === "cancelled") || checkCancelled()) {
        finishCancelled(requestId);
        return;
      }
      const errorMessage: ParseResponseMessage = {
        version: PROTOCOL_VERSION,
        kind: "error",
        requestId,
        error: serializeError(error),
      };
      scope.postMessage(errorMessage);
    } finally {
      cancelledRequestIds.delete(requestId);
    }
  }

  function finishCancelled(requestId: string): void {
    const message: ParseResponseMessage = {
      version: PROTOCOL_VERSION,
      kind: "cancelled",
      requestId,
    };
    scope.postMessage(message);
  }

  scope.addEventListener("message", (event) => {
    const message = event.data as ParseRequestMessage;
    if (!message || message.version !== PROTOCOL_VERSION) return;

    if (message.kind === "cancel") {
      cancelledRequestIds.add(message.requestId);
      return;
    }

    if (message.kind === "parse") {
      void handleParse(message);
    }
  });
}

export const createWorkerHandler = createHandler;

function isDedicatedWorkerScope(value: unknown): value is WorkerGlobalScope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { postMessage?: unknown }).postMessage === "function" &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function" &&
    typeof (value as { document?: unknown }).document === "undefined" &&
    typeof (value as { window?: unknown }).window === "undefined"
  );
}

if (typeof self !== "undefined" && isDedicatedWorkerScope(self)) {
  createWorkerHandler(self);
}
