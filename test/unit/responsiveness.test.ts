/**
 * TKT-002 acceptance criterion: "The React main thread remains responsive
 * during a synthetic worker CPU task." Uses a real `node:worker_threads`
 * worker (genuine OS-thread offloading, not a mock) running a busy loop
 * while a `setInterval`-based probe samples this thread; if the busy loop
 * ran here instead of on the worker thread, the probe would show large
 * drift.
 */
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { startResponsivenessProbe } from "../fixtures/responsiveness-probe.ts";

const CPU_BURN_WORKER_URL = fileURLToPath(new URL("../fixtures/cpu-burn-worker.mjs", import.meta.url));

describe("main-thread responsiveness during a synthetic worker CPU task", () => {
  it("keeps this thread's timers close to on-schedule while another thread busy-loops", async () => {
    const durationMs = 150;
    const probe = startResponsivenessProbe(4);

    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(CPU_BURN_WORKER_URL, { workerData: { durationMs } });
      worker.once("message", () => {
        void worker.terminate().then(() => resolve());
      });
      worker.once("error", reject);
    });

    const report = probe.stop();

    expect(report.sampleCount).toBeGreaterThan(10);
    // A blocked main thread would show drift on the order of `durationMs`;
    // real offloading keeps drift close to normal scheduling jitter.
    expect(report.maxDriftMs).toBeLessThan(durationMs / 2);
  });
});
