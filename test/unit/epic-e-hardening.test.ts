import { describe, expect, it } from "vitest";
import { createPdfParser } from "../../src/pdf-content-extractor/client.ts";
import { PdfParseCancelledError, PdfParseError } from "../../src/pdf-content-extractor/errors.ts";
import type { WorkerHandle, WorkerGlobalScope } from "../../src/pdf-content-extractor/protocol.ts";
import { createWorkerHandler } from "../../src/pdf-content-extractor/worker.ts";
import { ByteCursor } from "../../src/pdf-content-extractor/parser/bytes.ts";
import { Lexer } from "../../src/pdf-content-extractor/parser/lexer.ts";
import { parseValue } from "../../src/pdf-content-extractor/parser/objects.ts";
import { openPdfDocument } from "../../src/pdf-content-extractor/parser/document.ts";
import { interpretPageContent } from "../../src/pdf-content-extractor/content/interpreter.ts";
import { renderDocumentToHtml, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";
import { PdfBuilder } from "../fixtures/pdf-builder.ts";
import { createChannelWorkerPair } from "../fixtures/message-channel-worker.ts";

function minimalPdf(): Uint8Array {
  const builder = new PdfBuilder();
  builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");
  return new Uint8Array(builder.finalizeTraditional([1, 2], "/Size 3 /Root 1 0 R"));
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("Epic E malformed-input and security hardening", () => {
  it("reports limit failures with the applicable limit and document context", async () => {
    await expect(openPdfDocument(minimalPdf(), { maxInputBytes: 8 })).rejects.toMatchObject({
      code: "limit-exceeded",
      detail: "context=document limit=maxInputBytes",
    });
  });

  it("runs deterministic syntax mutations to bounded typed failures", () => {
    const mutations = [
      "[[[[[0]]]]]",
      "<< /A << /B << /C 1 >> >> >>",
      "(unterminated",
      "<abcx>",
      `/${"a".repeat(128)}`,
    ];

    for (const source of mutations) {
      const bytes = new Uint8Array(Buffer.from(source, "latin1"));
      const lexer = new Lexer(new ByteCursor(bytes, 0, bytes.length), { maxTokenLength: 16 });
      expect(() => parseValue(lexer, { maxNestingDepth: 2 })).toThrow(PdfParseError);
    }
  });

  it("runs deterministic malformed stream-boundary mutations within the configured scan limit", async () => {
    const variants = [
      "<< /Length 99 >>\nstream\nabc\nendobj",
      "<< /Length -1 >>\nstream\nabc",
      "<< /Length 99 >>\nstream\nabc\nalmostendstream",
    ];

    for (const body of variants) {
      const builder = new PdfBuilder();
      builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
      builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");
      builder.addObject(3, body);
      const doc = await openPdfDocument(new Uint8Array(builder.finalizeTraditional([1, 2, 3], "/Size 4 /Root 1 0 R")), {
        maxDecodedStreamBytes: 16,
      });
      await expect(doc.resolve({ kind: "ref", num: 3, gen: 0 })).rejects.toThrow(PdfParseError);
    }
  });

  it("cancels the content-operation matrix with a typed cancellation error", () => {
    const bytes = new Uint8Array(Buffer.from("BT /F1 12 Tf (a) Tj (b) Tj ET", "latin1"));
    let count = 0;
    expect(() => interpretPageContent(bytes, 7, {
      limits: { maxContentOperationsPerPage: 1000, maxNestingDepth: 8, maxTokenLength: 1024 },
      isCancelled: () => {
        count += 1;
        return count > 2;
      },
    })).toThrow(PdfParseError);
  });

  it("allows a fresh parser after a worker failure", async () => {
    let errorListener: ((event: ErrorEvent) => void) | undefined;
    const failingWorker: WorkerHandle = {
      postMessage() {
        errorListener?.(new ErrorEvent("error", { message: "synthetic worker crash" }));
      },
      addEventListener(type, listener) {
        if (type === "error") errorListener = listener as (event: ErrorEvent) => void;
      },
      removeEventListener() {},
      terminate() {},
    };

    let calls = 0;
    const parser = createPdfParser({
      workerFactory: () => {
        calls += 1;
        if (calls === 1) return failingWorker;
        const pair = createChannelWorkerPair();
        createWorkerHandler(pair.workerScope as WorkerGlobalScope);
        return pair.client;
      },
    });

    await expect(parser.parse(toOwnedArrayBuffer(minimalPdf()))).rejects.toMatchObject({ code: "worker-failure" });
    await expect(parser.parse(toOwnedArrayBuffer(minimalPdf()))).resolves.toMatchObject({ metadata: { pageCount: 0 } });
    parser.dispose();
  });

  it("does not turn extracted text, actions, embedded files, or unsafe URLs into executable renderer output", () => {
    const document: ParsedDocument = {
      metadata: { pageCount: 1 },
      pages: [{
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [{
          type: "paragraph",
          id: "p",
          pageNumber: 1,
          text: [
            { text: "<script>alert(1)</script>" },
            { text: " launch", link: { kind: "external", href: "javascript:app.launchURL('https://x')" } },
            { text: " file", link: { kind: "external", href: "file:///C:/secret" } },
          ],
        }],
      }],
      outline: [{ title: "ignored action", level: 1, target: { kind: "external", href: "javascript:alert(1)" }, children: [] }],
      assets: [],
      warnings: [],
      timings: { totalMs: 0, phases: [], inputBytes: 0 },
    };

    const html = renderDocumentToHtml(document);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file://");
  });

  it("surfaces cancellation from worker parsing as PdfParseCancelledError", async () => {
    const pair = createChannelWorkerPair();
    createWorkerHandler(pair.workerScope);
    const parser = createPdfParser({ workerFactory: () => pair.client });
    const controller = new AbortController();
    const pending = parser.parse(toOwnedArrayBuffer(minimalPdf()), {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase === "initializing") controller.abort();
      },
    });
    await expect(pending).rejects.toBeInstanceOf(PdfParseCancelledError);
    parser.dispose();
  });
});
