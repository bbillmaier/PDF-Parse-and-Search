/**
 * Main-thread client for the PDF content extractor. Owns the dedicated
 * worker's lifecycle and translates the typed protocol into the public
 * `ParseOptions` callback shape.
 *
 * Buffer ownership: the `ArrayBuffer` behind a `File`/`Blob`/`ArrayBuffer`
 * input is transferred to the worker on `parse()` and must not be reused by
 * the caller afterwards.
 */

import type { ParseOptions, ParsedDocument } from "./types.ts";
import { PdfParseError, PdfParseCancelledError, PdfParseDisposedError } from "./errors.ts";
import {
  PROTOCOL_VERSION,
  type ParseRequestMessage,
  type ParseResponseMessage,
  type WorkerHandle,
} from "./protocol.ts";

export type { WorkerHandle } from "./protocol.ts";
export type WorkerFactory = () => WorkerHandle;

export interface PdfParser {
  parse(input: File | Blob | ArrayBuffer, options?: ParseOptions): Promise<ParsedDocument>;
  dispose(): void;
}

export interface CreatePdfParserConfig {
  /** Overrides worker construction. Intended for tests; production callers should omit it. */
  workerFactory?: WorkerFactory;
}

interface PendingRequest {
  settled: boolean;
  resolve: (document: ParsedDocument) => void;
  reject: (error: Error) => void;
  onProgress?: ParseOptions["onProgress"];
  onPage?: ParseOptions["onPage"];
  signal?: AbortSignal;
  abortListener?: () => void;
}

function defaultWorkerFactory(): WorkerHandle {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return worker as unknown as WorkerHandle;
}

export function createPdfParser(config: CreatePdfParserConfig = {}): PdfParser {
  const workerFactory = config.workerFactory ?? defaultWorkerFactory;
  const pending = new Map<string, PendingRequest>();

  let worker: WorkerHandle | null = null;
  let disposed = false;

  function settle(requestId: string, entry: PendingRequest, action: () => void): void {
    entry.settled = true;
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener("abort", entry.abortListener);
    }
    pending.delete(requestId);
    action();
  }

  function handleMessage(event: MessageEvent): void {
    const message = event.data as ParseResponseMessage;
    if (!message || message.version !== PROTOCOL_VERSION) return;

    const entry = pending.get(message.requestId);
    if (!entry || entry.settled) return;

    switch (message.kind) {
      case "progress":
        entry.onProgress?.(message.progress);
        return;
      case "page":
        entry.onPage?.(message.page);
        return;
      case "result":
        settle(message.requestId, entry, () => entry.resolve(message.document));
        return;
      case "error":
        settle(message.requestId, entry, () => entry.reject(PdfParseError.fromSerialized(message.error)));
        return;
      case "cancelled":
        settle(message.requestId, entry, () => entry.reject(new PdfParseCancelledError()));
        return;
    }
  }

  function handleWorkerError(event: ErrorEvent): void {
    const failure = new PdfParseError(
      "worker-failure",
      event.message || "The parser worker failed unexpectedly.",
    );
    for (const [requestId, entry] of pending) {
      if (!entry.settled) settle(requestId, entry, () => entry.reject(failure));
    }
    teardownWorker();
  }

  function teardownWorker(): void {
    if (!worker) return;
    worker.removeEventListener("message", handleMessage);
    worker.removeEventListener("error", handleWorkerError);
    worker.terminate();
    worker = null;
  }

  function ensureWorker(): WorkerHandle {
    if (worker) return worker;
    const created = workerFactory();
    created.addEventListener("message", handleMessage);
    created.addEventListener("error", handleWorkerError);
    worker = created;
    return created;
  }

  async function resolveArrayBuffer(input: File | Blob | ArrayBuffer): Promise<ArrayBuffer> {
    if (input instanceof ArrayBuffer) return input;
    return input.arrayBuffer();
  }

  return {
    async parse(input, options = {}) {
      if (disposed) throw new PdfParseDisposedError();

      const buffer = await resolveArrayBuffer(input);
      if (disposed) throw new PdfParseDisposedError();

      const requestId = crypto.randomUUID();
      const activeWorker = ensureWorker();

      return new Promise<ParsedDocument>((resolve, reject) => {
        const entry: PendingRequest = {
          settled: false,
          resolve,
          reject,
          onProgress: options.onProgress,
          onPage: options.onPage,
          signal: options.signal,
        };

        if (options.signal) {
          if (options.signal.aborted) {
            entry.settled = true;
            reject(new PdfParseCancelledError());
            return;
          }
          const abortListener = () => {
            if (entry.settled) return;
            settle(requestId, entry, () => entry.reject(new PdfParseCancelledError()));
            const cancelMessage: ParseRequestMessage = {
              version: PROTOCOL_VERSION,
              kind: "cancel",
              requestId,
            };
            activeWorker.postMessage(cancelMessage);
          };
          entry.abortListener = abortListener;
          options.signal.addEventListener("abort", abortListener);
        }

        pending.set(requestId, entry);

        const requestMessage: ParseRequestMessage = {
          version: PROTOCOL_VERSION,
          kind: "parse",
          requestId,
          input: buffer,
          fileName: input instanceof File ? input.name : undefined,
          options: {
            preserveImages: options.preserveImages,
            limits: options.limits,
          },
        };

        activeWorker.postMessage(requestMessage, [buffer]);
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      const disposedError = new PdfParseDisposedError();
      for (const [requestId, entry] of pending) {
        if (!entry.settled) settle(requestId, entry, () => entry.reject(disposedError));
      }
      teardownWorker();
    },
  };
}
