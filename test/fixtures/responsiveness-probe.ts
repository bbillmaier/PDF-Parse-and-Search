/**
 * Main-thread responsiveness probe. Measures `setInterval` drift as a proxy
 * for event-loop/main-thread blocking: if something monopolizes the thread
 * this probe is running on, scheduled ticks arrive late and `driftMs` grows.
 *
 * Uses only `setInterval`/`clearInterval` and `performance.now()`, both
 * available in browsers and Node, so it is directly reusable by the demo
 * application (a future ticket) without modification.
 */

export interface ResponsivenessReport {
  sampleCount: number;
  maxDriftMs: number;
  meanDriftMs: number;
}

export interface ResponsivenessProbeHandle {
  stop(): ResponsivenessReport;
}

function now(): number {
  return performance.now();
}

export function startResponsivenessProbe(sampleIntervalMs = 4): ResponsivenessProbeHandle {
  const drifts: number[] = [];
  let last = now();

  const timer = setInterval(() => {
    const current = now();
    const drift = Math.max(0, current - last - sampleIntervalMs);
    drifts.push(drift);
    last = current;
  }, sampleIntervalMs);

  return {
    stop(): ResponsivenessReport {
      clearInterval(timer);
      const sampleCount = drifts.length;
      const maxDriftMs = sampleCount ? Math.max(...drifts) : 0;
      const meanDriftMs = sampleCount ? drifts.reduce((sum, value) => sum + value, 0) / sampleCount : 0;
      return { sampleCount, maxDriftMs, meanDriftMs };
    },
  };
}
