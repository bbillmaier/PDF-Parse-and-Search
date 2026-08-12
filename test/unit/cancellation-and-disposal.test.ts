import { describe, expect, it } from "vitest";
import { createPdfParser } from "../../src/pdf-content-extractor/client.ts";
import { PdfParseCancelledError, PdfParseDisposedError } from "../../src/pdf-content-extractor/errors.ts";
import { createChannelWorkerPair } from "../fixtures/message-channel-worker.ts";
import { createWorkerHandler } from "../../src/pdf-content-extractor/worker.ts";
import { makeByteFixture } from "../fixtures/byte-fixtures.ts";

function createConnectedParser() {
  const pair = createChannelWorkerPair();
  createWorkerHandler(pair.workerScope);
  const parser = createPdfParser({ workerFactory: () => pair.client });
  return { parser, pair };
}

describe("cancellation", () => {
  it("rejects promptly with a typed cancellation error via AbortSignal", async () => {
    const { parser } = createConnectedParser();
    const controller = new AbortController();

    const pending = parser.parse(makeByteFixture(4), { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(PdfParseCancelledError);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const { parser } = createConnectedParser();
    const controller = new AbortController();
    controller.abort();

    await expect(
      parser.parse(makeByteFixture(4), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(PdfParseCancelledError);
  });

  it("ignores worker messages that arrive after cancellation settled the request", async () => {
    const { parser } = createConnectedParser();
    const controller = new AbortController();
    const phases: string[] = [];
    let resolveFirstProgress: (() => void) | undefined;
    const firstProgress = new Promise<void>((resolve) => {
      resolveFirstProgress = resolve;
    });

    const pending = parser.parse(makeByteFixture(4), {
      signal: controller.signal,
      onProgress: (progress) => {
        phases.push(progress.phase);
        resolveFirstProgress?.();
      },
    });

    // The worker (placeholder implementation) finishes all remaining phases
    // and posts its result synchronously in response to the single "parse"
    // message; those responses are already queued as separate port events
    // by the time this microtask runs. Aborting here proves later-arriving
    // events for this requestId are dropped rather than re-settling it.
    await firstProgress;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(PdfParseCancelledError);
    // Let any queued (and now-ignored) worker messages drain.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(phases).toEqual(["initializing"]);
  });
});

describe("disposal", () => {
  it("rejects pending work and future calls with a typed disposed error", async () => {
    const { parser } = createConnectedParser();
    const pending = parser.parse(makeByteFixture(4));

    parser.dispose();

    await expect(pending).rejects.toBeInstanceOf(PdfParseDisposedError);
    await expect(parser.parse(makeByteFixture(4))).rejects.toBeInstanceOf(PdfParseDisposedError);
  });

  it("is safe to call more than once", () => {
    const { parser } = createConnectedParser();
    parser.dispose();
    expect(() => parser.dispose()).not.toThrow();
  });

  it("ignores worker messages that arrive after disposal settled the request", async () => {
    const { parser } = createConnectedParser();
    const phases: string[] = [];
    let resolveFirstProgress: (() => void) | undefined;
    const firstProgress = new Promise<void>((resolve) => {
      resolveFirstProgress = resolve;
    });

    const pending = parser.parse(makeByteFixture(4), {
      onProgress: (progress) => {
        phases.push(progress.phase);
        resolveFirstProgress?.();
      },
    });

    await firstProgress;
    parser.dispose();

    await expect(pending).rejects.toBeInstanceOf(PdfParseDisposedError);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(phases).toEqual(["initializing"]);
  });
});
