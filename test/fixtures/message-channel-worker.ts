/**
 * Adapts a real Node `MessageChannel` pair to the library's `WorkerHandle` /
 * `WorkerGlobalScope` interfaces. Using a real `MessageChannel` (rather than
 * a synchronous in-memory fake) means protocol tests exercise genuine
 * structured-clone + transfer-list semantics, including real ArrayBuffer
 * detachment, instead of merely asserting mock call arguments.
 */

import type { WorkerGlobalScope, WorkerHandle } from "../../src/pdf-content-extractor/protocol.ts";

export interface ChannelWorkerPair {
  client: WorkerHandle;
  workerScope: WorkerGlobalScope;
  /** Simulates an uncaught worker failure (e.g. a thrown error outside the protocol's try/catch). */
  dispatchWorkerError(message: string): void;
  close(): void;
}

export function createChannelWorkerPair(): ChannelWorkerPair {
  const channel = new MessageChannel();
  const { port1, port2 } = channel;
  port1.start();
  port2.start();

  const client: WorkerHandle = {
    postMessage(message, transfer) {
      port1.postMessage(message, transfer ?? []);
    },
    addEventListener(type: "message" | "error", listener: (event: never) => void) {
      port1.addEventListener(type, listener as EventListener);
    },
    removeEventListener(type: "message" | "error", listener: (event: never) => void) {
      port1.removeEventListener(type, listener as EventListener);
    },
    terminate() {
      port1.close();
      port2.close();
    },
  };

  const workerScope: WorkerGlobalScope = {
    postMessage(message, transfer) {
      port2.postMessage(message, transfer ?? []);
    },
    addEventListener(type: "message", listener: (event: MessageEvent) => void) {
      port2.addEventListener(type, listener as EventListener);
    },
  };

  function dispatchWorkerError(message: string): void {
    port1.dispatchEvent(new ErrorEvent("error", { message }));
  }

  return {
    client,
    workerScope,
    dispatchWorkerError,
    close() {
      port1.close();
      port2.close();
    },
  };
}
