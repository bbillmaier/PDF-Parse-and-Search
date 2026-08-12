/**
 * Benchmark harness (TKT-003). Run with `npm run bench` (executes via
 * `vite-node` so it can import the library's TypeScript sources directly,
 * the same way `npm run dev`/`vitest` already do via Vite).
 *
 * Epic A ships no PDF parsing, so "decoded byte totals" and "time to first
 * page" are reported as honest proxies (input bytes transferred, and time
 * to the first worker response) rather than real decode/page metrics —
 * those become meaningful once Epic B/C land. What this harness DOES
 * measure for real: end-to-end protocol round-trip time over a genuine
 * transferable-buffer message channel, and whether a synthetic CPU-heavy
 * task on another OS thread keeps this process's event loop responsive.
 *
 * Note on "worker startup": this harness drives the worker protocol
 * in-process over a real `MessageChannel` (see
 * `test/fixtures/message-channel-worker.ts`) rather than spawning a real
 * browser dedicated Worker, which Node cannot host. It measures genuine
 * structured-clone/transfer and message-dispatch overhead, but not OS
 * thread-spawn cost — that number can only come from the browser demo
 * (a later ticket).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createPdfParser } from "../../src/pdf-content-extractor/client.ts";
import { createWorkerHandler } from "../../src/pdf-content-extractor/worker.ts";
import { createChannelWorkerPair } from "../fixtures/message-channel-worker.ts";
import { checkSampleAvailability } from "../fixtures/sample-corpus.ts";
import { startResponsivenessProbe } from "../fixtures/responsiveness-probe.ts";
import type { PhaseTiming } from "../../src/pdf-content-extractor/types.ts";

interface DocumentBenchResult {
  document: string;
  available: boolean;
  inputBytes?: number;
  clientSetupMs?: number;
  timeToFirstMessageMs?: number;
  timeToFirstPageMs?: number;
  totalMs?: number;
  largeBufferBytes?: number;
  transferredAssetBytes?: number;
  phaseTimings?: PhaseTiming[];
}

interface RepeatedDocumentBenchResult extends DocumentBenchResult {
  runs?: DocumentBenchResult[];
  runCount?: number;
  meanTotalMs?: number;
  maxTotalMs?: number;
  meanTimeToFirstPageMs?: number;
}

async function benchDocument(name: string, bytes: Uint8Array): Promise<DocumentBenchResult> {
  const setupStart = performance.now();
  const pair = createChannelWorkerPair();
  createWorkerHandler(pair.workerScope);
  const parser = createPdfParser({ workerFactory: () => pair.client });
  const clientSetupMs = performance.now() - setupStart;

  let timeToFirstMessageMs: number | undefined;
  let timeToFirstPageMs: number | undefined;
  const requestStart = performance.now();

  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const document = await parser.parse(arrayBuffer, {
    onProgress: () => {
      if (timeToFirstMessageMs === undefined) {
        timeToFirstMessageMs = performance.now() - requestStart;
      }
    },
    onPage: () => {
      if (timeToFirstPageMs === undefined) {
        timeToFirstPageMs = performance.now() - requestStart;
      }
    },
  });

  const totalMs = performance.now() - requestStart;
  parser.dispose();

  return {
    document: name,
    available: true,
    inputBytes: document.timings.inputBytes,
    clientSetupMs,
    timeToFirstMessageMs,
    timeToFirstPageMs,
    totalMs,
    largeBufferBytes: document.timings.largeBufferBytes,
    transferredAssetBytes: document.timings.transferredAssetBytes,
    phaseTimings: document.timings.phases,
  };
}

async function benchDocumentRepeated(name: string, bytes: Uint8Array, runCount: number): Promise<RepeatedDocumentBenchResult> {
  const runs: DocumentBenchResult[] = [];
  for (let i = 0; i < runCount; i += 1) {
    runs.push(await benchDocument(name, bytes));
  }
  const totals = runs.map((run) => run.totalMs ?? 0);
  const firstPages = runs.map((run) => run.timeToFirstPageMs ?? 0).filter((value) => value > 0);
  const last = runs[runs.length - 1];
  return {
    ...last,
    runs,
    runCount,
    meanTotalMs: totals.reduce((sum, value) => sum + value, 0) / totals.length,
    maxTotalMs: Math.max(...totals),
    meanTimeToFirstPageMs: firstPages.length > 0 ? firstPages.reduce((sum, value) => sum + value, 0) / firstPages.length : undefined,
  };
}

const CPU_BURN_WORKER_URL = fileURLToPath(new URL("../fixtures/cpu-burn-worker.mjs", import.meta.url));

async function benchResponsiveness(durationMs: number) {
  const probe = startResponsivenessProbe(4);
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(CPU_BURN_WORKER_URL, { workerData: { durationMs } });
    worker.once("message", () => {
      void worker.terminate().then(() => resolve());
    });
    worker.once("error", reject);
  });
  return probe.stop();
}

async function main() {
  const availability = checkSampleAvailability();
  const documentResults: RepeatedDocumentBenchResult[] = [];
  const runCount = Math.max(1, Number.parseInt(process.env.PDF_BENCH_RUNS ?? "3", 10) || 3);

  for (const entry of availability) {
    if (!entry.available) {
      documentResults.push({ document: entry.fixture.fileName, available: false });
      continue;
    }
    const bytes = readFileSync(entry.fixture.path);
    documentResults.push(await benchDocumentRepeated(entry.fixture.fileName, bytes, runCount));
  }

  const responsiveness = await benchResponsiveness(150);

  const report = {
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
    },
    generatedAt: new Date().toISOString(),
    runCount,
    documents: documentResults,
    mainThreadResponsiveness: {
      syntheticWorkerTaskMs: 150,
      ...responsiveness,
    },
  };

  const outPath = fileURLToPath(new URL("./results.json", import.meta.url));
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\nRuntime: node ${report.runtime.node} on ${report.runtime.platform}/${report.runtime.arch}`);
  console.log(`\nDocument corpus benchmark (${runCount} run(s), real parser worker handler):`);
  for (const result of documentResults) {
    if (!result.available) {
      console.log(`  ${result.document}: BLOCKER — canonical sample file not found`);
      continue;
    }
    console.log(
      `  ${result.document}: inputBytes=${result.inputBytes} clientSetupMs=${result.clientSetupMs?.toFixed(2)} ` +
        `timeToFirstMessageMs=${result.timeToFirstMessageMs?.toFixed(2)} timeToFirstPageMs=${result.timeToFirstPageMs?.toFixed(2)} ` +
        `totalMs=${result.totalMs?.toFixed(2)} meanTotalMs=${result.meanTotalMs?.toFixed(2)} maxTotalMs=${result.maxTotalMs?.toFixed(2)} ` +
        `largeBufferBytes=${result.largeBufferBytes} transferredAssetBytes=${result.transferredAssetBytes}`,
    );
    for (const phase of result.phaseTimings ?? []) {
      console.log(`    phase ${phase.phase}: ${phase.durationMs.toFixed(3)}ms`);
    }
  }

  console.log("\nMain-thread responsiveness during a 150ms synthetic worker CPU task:");
  console.log(
    `  samples=${responsiveness.sampleCount} maxDriftMs=${responsiveness.maxDriftMs.toFixed(2)} ` +
      `meanDriftMs=${responsiveness.meanDriftMs.toFixed(2)}`,
  );

  console.log(`\nMachine-readable report written to ${outPath}`);

  const missing = documentResults.filter((result) => !result.available);
  if (missing.length > 0) {
    console.log(`\nBLOCKERS: ${missing.length} canonical sample file(s) missing; see above.`);
    process.exitCode = 1;
  }

  const baselinePath = fileURLToPath(new URL("./results.baseline.json", import.meta.url));
  const compareToBaseline = process.env.PDF_BENCH_COMPARE_BASELINE === "1";
  if (compareToBaseline && existsSync(baselinePath)) {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { documents?: RepeatedDocumentBenchResult[] };
    const failures: string[] = [];
    for (const result of documentResults) {
      if (!result.available) continue;
      const base = baseline.documents?.find((entry) => entry.document === result.document && entry.available);
      if (!base?.maxTotalMs || !result.maxTotalMs) continue;
      const threshold = base.maxTotalMs * 1.75;
      if (result.maxTotalMs > threshold) {
        failures.push(`${result.document} maxTotalMs ${result.maxTotalMs.toFixed(2)}ms exceeded baseline threshold ${threshold.toFixed(2)}ms`);
      }
    }
    if (failures.length > 0) {
      console.error("\nPERFORMANCE REGRESSION:");
      for (const failure of failures) console.error(`  ${failure}`);
      process.exitCode = 1;
    }
  } else {
    console.log("\nPerformance budget note: representative hardware/browser targets are still open inputs; set PDF_BENCH_COMPARE_BASELINE=1 after recording test/bench/results.baseline.json to enforce current-machine regression thresholds.");
  }
}

await main();
