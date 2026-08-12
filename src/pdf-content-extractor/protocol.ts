/**
 * Versioned message protocol between the main-thread client and the parser
 * worker. Every message carries `version` so a client and worker built from
 * different library copies fail predictably instead of misinterpreting each
 * other's payloads.
 */

import type { ParseProgress, DocumentPage, ParsedDocument, SafetyLimits } from "./types.ts";
import type { SerializedParseError } from "./errors.ts";

export const PROTOCOL_VERSION = 1;

/** Serializable subset of `ParseOptions` sent to the worker (no callbacks). */
export interface WorkerParseOptions {
  preserveImages?: boolean;
  limits?: Partial<SafetyLimits>;
}

export type ParseRequestMessage =
  | {
      version: typeof PROTOCOL_VERSION;
      kind: "parse";
      requestId: string;
      input: ArrayBuffer;
      fileName?: string;
      options: WorkerParseOptions;
    }
  | {
      version: typeof PROTOCOL_VERSION;
      kind: "cancel";
      requestId: string;
    };

export type ParseResponseMessage =
  | { version: typeof PROTOCOL_VERSION; kind: "progress"; requestId: string; progress: ParseProgress }
  | { version: typeof PROTOCOL_VERSION; kind: "page"; requestId: string; page: DocumentPage }
  | { version: typeof PROTOCOL_VERSION; kind: "result"; requestId: string; document: ParsedDocument }
  | { version: typeof PROTOCOL_VERSION; kind: "error"; requestId: string; error: SerializedParseError }
  | { version: typeof PROTOCOL_VERSION; kind: "cancelled"; requestId: string };

/**
 * Minimal surface of the DOM `Worker` type that the client depends on.
 * Defined locally (rather than reusing `lib.dom`'s `Worker`) so tests can
 * satisfy it with an in-memory fake without constructing a real worker.
 */
export interface WorkerHandle {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

/**
 * Minimal surface of a dedicated worker's global scope that `worker.ts`
 * depends on. Satisfied by `self` inside a real worker, and by a fake scope
 * object in tests.
 */
export interface WorkerGlobalScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
