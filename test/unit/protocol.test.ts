import { describe, expect, it } from "vitest";
import { createPdfParser } from "../../src/pdf-content-extractor/client.ts";
import { PdfParseCancelledError, PdfParseError } from "../../src/pdf-content-extractor/errors.ts";
import { PROTOCOL_VERSION, type ParseResponseMessage } from "../../src/pdf-content-extractor/protocol.ts";
import { createChannelWorkerPair } from "../fixtures/message-channel-worker.ts";
import { createWorkerHandler } from "../../src/pdf-content-extractor/worker.ts";
import { makeByteFixture } from "../fixtures/byte-fixtures.ts";
import { PdfBuilder } from "../fixtures/pdf-builder.ts";

/** An empty, otherwise-valid placeholder ParsedDocument for hand-built protocol responses. */
function emptyDocument(inputBytes: number) {
  return {
    metadata: { pageCount: 0 },
    pages: [],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes },
  };
}

/** Waits for the client's outgoing "parse" request and returns its requestId, without a worker attached. */
function captureRequestId(pair: ReturnType<typeof createChannelWorkerPair>): Promise<string> {
  return new Promise((resolve) => {
    pair.workerScope.addEventListener("message", (event) => {
      const message = event.data as { kind: string; requestId: string };
      if (message.kind === "parse") resolve(message.requestId);
    });
  });
}

function createConnectedParser() {
  const pair = createChannelWorkerPair();
  createWorkerHandler(pair.workerScope);
  const parser = createPdfParser({ workerFactory: () => pair.client });
  return { parser, pair };
}

function minimalPdfBuffer(): ArrayBuffer {
  const pdf = new PdfBuilder();
  pdf.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  pdf.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  pdf.addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>");
  const bytes = pdf.finalizeTraditional([1, 2, 3], "/Root 1 0 R");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("createPdfParser protocol", () => {
  it("delivers a ParsedDocument and named progress phases", async () => {
    const { parser } = createConnectedParser();
    const phases: string[] = [];

    const input = minimalPdfBuffer();
    const inputBytes = input.byteLength;
    const result = await parser.parse(input, {
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(new Set(phases)).toEqual(new Set(["initializing", "reading-input", "parsing", "finalizing"]));
    expect(result.metadata.pageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.warnings.every((warning) => warning.code !== "not-implemented")).toBe(true);
    expect(result.timings.inputBytes).toBe(inputBytes);
    expect(result.timings.phases.length).toBeGreaterThanOrEqual(4);

    parser.dispose();
  });

  it("transfers the input ArrayBuffer instead of cloning it", async () => {
    const { parser } = createConnectedParser();
    const buffer = minimalPdfBuffer();

    await parser.parse(buffer);
    // A real MessageChannel transfer detaches the buffer on the sending
    // side; a structured-clone duplication would leave it readable.
    expect(buffer.byteLength).toBe(0);

    parser.dispose();
  });

  it("accepts a Blob input and reads it via arrayBuffer()", async () => {
    const { parser } = createConnectedParser();
    const blob = new Blob([minimalPdfBuffer()]);

    const result = await parser.parse(blob);
    expect(result.timings.inputBytes).toBe(blob.size);

    parser.dispose();
  });

  it("isolates two sequential requests from each other", async () => {
    const { parser } = createConnectedParser();

    const firstInput = minimalPdfBuffer();
    const secondInput = minimalPdfBuffer();
    const firstBytes = firstInput.byteLength;
    const secondBytes = secondInput.byteLength;
    const first = await parser.parse(firstInput);
    const second = await parser.parse(secondInput);

    expect(first.timings.inputBytes).toBe(firstBytes);
    expect(second.timings.inputBytes).toBe(secondBytes);

    parser.dispose();
  });

  it("serializes worker crashes into a stable public error type", async () => {
    const { parser, pair } = createConnectedParser();
    let resolveFirstProgress: (() => void) | undefined;
    const firstProgress = new Promise<void>((resolve) => {
      resolveFirstProgress = resolve;
    });

    const pending = parser.parse(minimalPdfBuffer(), {
      onProgress: () => resolveFirstProgress?.(),
    });

    // Wait until the request is genuinely in flight (registered client-side
    // and acknowledged by the worker) before simulating a crash, so the
    // crash cannot race ahead of request registration.
    await firstProgress;
    pair.dispatchWorkerError("simulated worker crash");

    await expect(pending).rejects.toBeInstanceOf(PdfParseError);
    await expect(pending).rejects.toMatchObject({ code: "worker-failure" });
  });
});

// These tests drive the client against a hand-built worker side (no
// createWorkerHandler attached) so every response message kind in the
// protocol union can be exercised directly, including ones the current
// placeholder worker implementation never emits on its own ("page") or
// only emits under races ("cancelled").
describe("client handling of each protocol response kind", () => {
  it("dispatches page messages to onPage before the result settles the promise", async () => {
    const pair = createChannelWorkerPair();
    const parser = createPdfParser({ workerFactory: () => pair.client });
    const requestIdPromise = captureRequestId(pair);
    const pageNumbers: number[] = [];

    const pending = parser.parse(makeByteFixture(4), {
      onPage: (page) => pageNumbers.push(page.pageNumber),
    });
    const requestId = await requestIdPromise;

    const pageMessage: ParseResponseMessage = {
      version: PROTOCOL_VERSION,
      kind: "page",
      requestId,
      page: { pageNumber: 1, width: 612, height: 792, blocks: [], warnings: [] },
    };
    pair.workerScope.postMessage(pageMessage);

    const resultMessage: ParseResponseMessage = {
      version: PROTOCOL_VERSION,
      kind: "result",
      requestId,
      document: emptyDocument(4),
    };
    pair.workerScope.postMessage(resultMessage);

    await pending;
    expect(pageNumbers).toEqual([1]);
  });

  it("rejects with the worker's structured protocol error", async () => {
    const pair = createChannelWorkerPair();
    const parser = createPdfParser({ workerFactory: () => pair.client });
    const requestIdPromise = captureRequestId(pair);

    const pending = parser.parse(makeByteFixture(4));
    const requestId = await requestIdPromise;

    const errorMessage: ParseResponseMessage = {
      version: PROTOCOL_VERSION,
      kind: "error",
      requestId,
      error: { code: "corrupt-structure", message: "bad xref" },
    };
    pair.workerScope.postMessage(errorMessage);

    await expect(pending).rejects.toBeInstanceOf(PdfParseError);
    await expect(pending).rejects.toMatchObject({ code: "corrupt-structure", message: "bad xref" });
  });

  it("rejects with PdfParseCancelledError on an explicit protocol cancelled message", async () => {
    const pair = createChannelWorkerPair();
    const parser = createPdfParser({ workerFactory: () => pair.client });
    const requestIdPromise = captureRequestId(pair);

    const pending = parser.parse(makeByteFixture(4));
    const requestId = await requestIdPromise;

    const cancelledMessage: ParseResponseMessage = { version: PROTOCOL_VERSION, kind: "cancelled", requestId };
    pair.workerScope.postMessage(cancelledMessage);

    await expect(pending).rejects.toBeInstanceOf(PdfParseCancelledError);
  });

  it("ignores a message for a requestId it never issued", async () => {
    const pair = createChannelWorkerPair();
    const parser = createPdfParser({ workerFactory: () => pair.client });
    const requestIdPromise = captureRequestId(pair);

    const pending = parser.parse(makeByteFixture(4));
    const requestId = await requestIdPromise;

    const strayMessage: ParseResponseMessage = {
      version: PROTOCOL_VERSION,
      kind: "cancelled",
      requestId: "not-a-real-request-id",
    };
    pair.workerScope.postMessage(strayMessage);

    const resultMessage: ParseResponseMessage = {
      version: PROTOCOL_VERSION,
      kind: "result",
      requestId,
      document: emptyDocument(4),
    };
    pair.workerScope.postMessage(resultMessage);

    await expect(pending).resolves.toMatchObject({ metadata: { pageCount: 0 } });
  });
});
