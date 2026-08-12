import { PdfParseCancelledError } from "./errors.ts";
import type { PhaseTiming, TimingPhase } from "./types.ts";

export interface ParseRuntime {
  isCancelled(): boolean;
  checkpoint(context?: string): Promise<void>;
  timeAsync<T>(phase: TimingPhase, work: () => Promise<T>, pageNumber?: number): Promise<T>;
  addTiming(phase: TimingPhase, durationMs: number, pageNumber?: number): void;
}

export class TimingCollector {
  readonly phases: PhaseTiming[] = [];

  add(phase: TimingPhase, durationMs: number, pageNumber?: number): void {
    this.phases.push(pageNumber === undefined ? { phase, durationMs } : { phase, durationMs, pageNumber });
  }
}

export function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createParseRuntime(
  isCancelled: () => boolean,
  timings: TimingCollector,
  yieldEveryCheckpoints = 32,
): ParseRuntime {
  let checkpointCount = 0;
  return {
    isCancelled,
    async checkpoint(context) {
      if (isCancelled()) throw new PdfParseCancelledError(context ? `The parse request was cancelled during ${context}.` : undefined);
      checkpointCount += 1;
      if (checkpointCount % yieldEveryCheckpoints === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (isCancelled()) throw new PdfParseCancelledError(context ? `The parse request was cancelled during ${context}.` : undefined);
      }
    },
    async timeAsync(phase, work, pageNumber) {
      const started = now();
      try {
        return await work();
      } finally {
        timings.add(phase, now() - started, pageNumber);
      }
    },
    addTiming(phase, durationMs, pageNumber) {
      timings.add(phase, durationMs, pageNumber);
    },
  };
}

export const NOOP_PARSE_RUNTIME: ParseRuntime = {
  isCancelled: () => false,
  async checkpoint() {},
  async timeAsync(_phase, work) {
    return work();
  },
  addTiming() {},
};
