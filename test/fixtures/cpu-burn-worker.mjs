// Plain JS worker_threads entry (no TS transform needed) that busy-loops
// synchronously for `workerData.durationMs`, proving real OS-thread
// offloading when driven alongside a main-thread responsiveness probe.
import { parentPort, workerData } from "node:worker_threads";

const durationMs = workerData?.durationMs ?? 150;
const start = Date.now();
while (Date.now() - start < durationMs) {
  // Deliberate synchronous busy loop confined to this worker thread.
}
parentPort?.postMessage({ done: true, elapsedMs: Date.now() - start });
