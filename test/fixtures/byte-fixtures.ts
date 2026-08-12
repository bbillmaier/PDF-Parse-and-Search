/**
 * Small, purpose-built byte fixtures for protocol-level tests. These are
 * not PDF bytes — Epic A ships no PDF parsing — they exist so tests can
 * exercise transfer/detachment semantics and phase timings without reading
 * from disk.
 */

/** Builds a deterministic ArrayBuffer of the given size, filled with an incrementing byte pattern. */
export function makeByteFixture(byteLength: number): ArrayBuffer {
  const buffer = new ArrayBuffer(byteLength);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < byteLength; i += 1) {
    view[i] = i % 256;
  }
  return buffer;
}

/** A tiny, human-inspectable fixture: 16 bytes, easy to eyeball in a failing assertion. */
export const TINY_BYTE_FIXTURE = makeByteFixture(16);
