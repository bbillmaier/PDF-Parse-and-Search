import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { DocumentSearchRecord, ParsedDocument } from "../src/pdf-content-extractor/index.ts";
import { ConflictError, DocumentLifecycle, ValidationError, type ImportDocumentInput } from "./lifecycle.ts";
import type { LoadedDocument } from "./storage.ts";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export interface ImportDocumentRequestBody {
  documentId: string;
  title: string;
  originalFilename: string;
  originalPdfBase64: string;
  semanticDocument: ParsedDocument;
  assets: { name: string; bytesBase64: string }[];
  searchRecords: DocumentSearchRecord[];
}

export interface DocumentApiOptions {
  lifecycle: DocumentLifecycle;
  isAuthenticated?: (request: IncomingMessage) => boolean;
  allowedOrigins?: readonly string[];
  onUnexpectedError?: (error: unknown, request: IncomingMessage) => void;
}

export function createDocumentApiServer(options: DocumentApiOptions) {
  return createServer((request, response) => {
    void handleRequest(request, response, options);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: DocumentApiOptions): Promise<void> {
  try {
    const corsAllowed = applyCorsHeaders(request, response, options.allowedOrigins ?? []);
    if (request.method === "OPTIONS") {
      if (!corsAllowed) {
        writeJson(response, 403, { error: "Origin is not allowed." });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (options.isAuthenticated && !options.isAuthenticated(request)) {
      writeJson(response, 401, { error: "Authentication required." });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/documents") {
      writeJson(response, 200, { documents: await options.lifecycle.listDocuments() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/documents/import") {
      const body = await readJson<ImportDocumentRequestBody>(request);
      const result = await options.lifecycle.importDocument(toImportInput(body));
      writeJson(response, 201, result);
      return;
    }
    const documentMatch = /^\/api\/documents\/([a-z][a-z0-9-]{0,127})$/.exec(url.pathname);
    if (documentMatch && request.method === "GET") {
      const result = await options.lifecycle.loadDocument(documentMatch[1]);
      writeJson(response, 200, {
        document: result.document,
        stored: serializeLoadedDocument(result.stored),
      });
      return;
    }
    if (documentMatch && request.method === "DELETE") {
      const result = await options.lifecycle.deleteDocument(documentMatch[1]);
      writeJson(response, result.databaseDeleted ? 200 : 404, result);
      return;
    }
    const titleMatch = /^\/api\/documents\/([a-z][a-z0-9-]{0,127})\/title$/.exec(url.pathname);
    if (titleMatch && request.method === "PATCH") {
      const body = await readJson<{ title?: unknown }>(request);
      if (typeof body.title !== "string") {
        writeJson(response, 400, { error: "title is required." });
        return;
      }
      // TKT-036: explicit host/admin override -- updates documents.title and
      // rebuilds the document's search vocabulary without reparsing the PDF
      // or re-uploading the original file. `found: false` (no document
      // matched) reports as 404, mirroring DELETE's not-found handling;
      // ConflictError (a conflicting title) is caught below like import's.
      const result = await options.lifecycle.overrideTitle(titleMatch[1], body.title);
      writeJson(response, result.found ? 200 : 404, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/search") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const perDocumentLimitParam = url.searchParams.get("perDocumentLimit");
      const perDocumentLimit = perDocumentLimitParam === null ? undefined : Number(perDocumentLimitParam);
      // TKT-037: raw filter query params -- validated inside
      // DocumentLifecycle.searchDetailed via parseSearchFilters, exactly
      // like `q` itself is validated via parseSearchQuery. This handler only
      // extracts the raw strings; it never interprets or trusts them.
      const rawFilters = {
        documentId: url.searchParams.get("documentId"),
        page: url.searchParams.get("page"),
        pageStart: url.searchParams.get("pageStart"),
        pageEnd: url.searchParams.get("pageEnd"),
        sectionId: url.searchParams.get("sectionId"),
        blockType: url.searchParams.get("blockType"),
      };
      // TKT-033: `strategy` reports the broadest match stage (strict/prefix/
      // partial/...) behind the returned results, so the UI can explain when
      // a search was broadened beyond a strict match. TKT-035 adds
      // `synonymExpansions` (development diagnostics only), and
      // `correctedQuery`/`spellingCorrections` (always present when a typo
      // correction actually produced the results shown). TKT-037 adds
      // `filters` -- the validated filters actually applied, always present.
      const { results, strategy, synonymExpansions, correctedQuery, spellingCorrections, filters } = await options.lifecycle.searchDetailed(
        url.searchParams.get("q") ?? "",
        Number.isFinite(limit) ? limit : 20,
        perDocumentLimit !== undefined && Number.isFinite(perDocumentLimit) ? perDocumentLimit : undefined,
        rawFilters,
      );
      writeJson(response, 200, { results, strategy, synonymExpansions, correctedQuery, spellingCorrections, filters });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/search/suggestions") {
      // TKT-037: bounded indexed prefix suggestions -- plain text only, the
      // host/reference UI owns escaping and presentation. A too-short or
      // too-long prefix safely returns an empty list (see
      // DocumentLifecycle.suggest / parseSuggestionPrefix) rather than a 400,
      // since a suggestion request firing while a user is still typing a
      // short prefix is an expected, non-erroneous case.
      const { suggestions } = await options.lifecycle.suggest(url.searchParams.get("prefix") ?? "");
      writeJson(response, 200, { suggestions });
      return;
    }
    writeJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof ConflictError) {
      writeJson(response, 409, { error: error.message });
    } else if (error instanceof ValidationError || error instanceof SyntaxError) {
      writeJson(response, 400, { error: error.message });
    } else {
      options.onUnexpectedError?.(error, request);
      writeJson(response, 500, { error: "Internal server error." });
    }
  }
}

function applyCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
): boolean {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "Content-Type");
  response.setHeader("access-control-max-age", "600");
  return true;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_IMPORT_BYTES) throw new ValidationError("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function toImportInput(body: ImportDocumentRequestBody): ImportDocumentInput {
  return {
    documentId: body.documentId,
    title: body.title,
    originalFilename: body.originalFilename,
    originalPdf: Buffer.from(body.originalPdfBase64, "base64"),
    semanticDocument: body.semanticDocument,
    assets: body.assets.map((asset) => ({ name: asset.name, bytes: Buffer.from(asset.bytesBase64, "base64") })),
    searchRecords: body.searchRecords,
  };
}

function serializeLoadedDocument(stored: LoadedDocument): Omit<LoadedDocument, "originalPdf" | "assets"> & {
  originalPdfBase64: string;
  assets: { name: string; bytesBase64: string }[];
} {
  return {
    documentId: stored.documentId,
    title: stored.title,
    originalFilename: stored.originalFilename,
    pdfStoragePath: stored.pdfStoragePath,
    semanticStoragePath: stored.semanticStoragePath,
    assetNames: stored.assetNames,
    semanticDocument: stored.semanticDocument,
    originalPdfBase64: Buffer.from(stored.originalPdf).toString("base64"),
    assets: stored.assets.map((asset) => ({ name: asset.name, bytesBase64: Buffer.from(asset.bytes).toString("base64") })),
  };
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
