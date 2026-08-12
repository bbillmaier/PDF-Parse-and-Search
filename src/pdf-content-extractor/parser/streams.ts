/**
 * Stream-filter pipeline (TKT-006): `FlateDecode` via the browser/Node-native
 * `DecompressionStream` Web API (no third-party inflate implementation) and
 * PNG/TIFF predictor reversal. Filters outside this contract produce a typed
 * `unsupported-feature` error rather than silently passing raw bytes through.
 *
 * `DecompressionStream` is a standard Web Platform API available in modern
 * browsers (including dedicated Workers) and in Node — it is feature-detected
 * at call time rather than assuming a specific oldest-supported-browser
 * baseline, which docs/DESIGN.md section 19 leaves as an open decision.
 */

import { PdfParseError } from "../errors.ts";
import type { ParseWarning } from "../types.ts";
import type { SafetyLimits } from "../types.ts";
import { NOOP_PARSE_RUNTIME, type ParseRuntime } from "../runtime.ts";
import { concatBytes } from "./bytes.ts";
import { dictGet, isArrayValue, isDict, isName, type PdfDict, type PdfValue } from "./objects.ts";

export interface FilterDiagnostic {
  filterName: string;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
}

export interface DecodedStream {
  bytes: Uint8Array;
  diagnostics: FilterDiagnostic[];
  warnings: ParseWarning[];
}

type ValueResolver = (value: PdfValue) => PdfValue;

const SUPPORTED_FLATE_NAMES = new Set(["FlateDecode", "Fl"]);

function namesOf(filterValue: PdfValue | undefined, resolve: ValueResolver): string[] {
  const resolved = filterValue === undefined ? undefined : resolve(filterValue);
  if (resolved === undefined || resolved === null) return [];
  if (isName(resolved)) return [resolved.name];
  if (isArrayValue(resolved)) {
    return resolved.items.map((item) => {
      const r = resolve(item);
      if (!isName(r)) {
        throw new PdfParseError("corrupt-structure", "Non-name entry in /Filter array.");
      }
      return r.name;
    });
  }
  throw new PdfParseError("corrupt-structure", "/Filter must be a name or an array of names.");
}

function parmsOf(parmsValue: PdfValue | undefined, count: number, resolve: ValueResolver): (PdfDict | undefined)[] {
  const resolved = parmsValue === undefined ? undefined : resolve(parmsValue);
  if (resolved === undefined || resolved === null) return new Array(count).fill(undefined);
  if (isDict(resolved)) {
    const out = new Array<PdfDict | undefined>(count).fill(undefined);
    out[0] = resolved;
    return out;
  }
  if (isArrayValue(resolved)) {
    return resolved.items.map((item) => {
      const r = resolve(item);
      return isDict(r) ? r : undefined;
    });
  }
  return new Array(count).fill(undefined);
}

/**
 * Runs `dict`'s `/Filter` (+ `/DecodeParms`) pipeline over `rawBytes`. `resolve`
 * is used to follow indirect references inside `/Filter`/`/DecodeParms` — pass
 * the identity function when those are known to be direct (e.g. bootstrap
 * xref-stream parsing, before any xref table exists).
 */
export async function decodeStream(
  dict: PdfDict,
  rawBytes: Uint8Array,
  limits: Pick<SafetyLimits, "maxDecodedStreamBytes" | "maxCompressionRatio">,
  resolve: ValueResolver = (v) => v,
  runtime: ParseRuntime = NOOP_PARSE_RUNTIME,
): Promise<DecodedStream> {
  const filterNames = namesOf(dictGet(dict, "Filter"), resolve);
  const parms = parmsOf(dictGet(dict, "DecodeParms") ?? dictGet(dict, "DP"), filterNames.length, resolve);

  let current = rawBytes;
  const diagnostics: FilterDiagnostic[] = [];
  const warnings: ParseWarning[] = [];

  for (let i = 0; i < filterNames.length; i += 1) {
    await runtime.checkpoint("stream filter pipeline");
    const name = filterNames[i];
    const start = performanceNow();
    const inputBytes = current.byteLength;

    if (SUPPORTED_FLATE_NAMES.has(name)) {
      current = await flateDecode(current, limits, runtime);
      current = await applyPredictorIfPresent(current, parms[i], limits, runtime);
    } else {
      throw new PdfParseError(
        "unsupported-feature",
        `Unsupported stream filter: ${name}`,
        `filter=${name}`,
      );
    }

    diagnostics.push({
      filterName: name,
      inputBytes,
      outputBytes: current.byteLength,
      durationMs: performanceNow() - start,
    });
  }

  return { bytes: current, diagnostics, warnings };
}

function performanceNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// FlateDecode
// ---------------------------------------------------------------------------

function assertDecompressionStreamSupported(): void {
  if (typeof DecompressionStream !== "function") {
    throw new PdfParseError(
      "unsupported-feature",
      "This runtime does not support the native DecompressionStream API required for FlateDecode.",
      "DecompressionStream unavailable",
    );
  }
}

function readableFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function flateDecode(
  input: Uint8Array,
  limits: Pick<SafetyLimits, "maxDecodedStreamBytes" | "maxCompressionRatio">,
  runtime: ParseRuntime = NOOP_PARSE_RUNTIME,
): Promise<Uint8Array> {
  assertDecompressionStreamSupported();
  if (input.byteLength === 0) return new Uint8Array(0);

  // `DecompressionStream.writable` is typed as `WritableStream<BufferSource>` in lib.dom.d.ts,
  // which TypeScript's structural checker does not accept as a `WritableStream<Uint8Array>` for
  // `pipeThrough` even though writing a `Uint8Array` into it is exactly the intended usage.
  const transform = new DecompressionStream("deflate") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const decompressed = readableFromBytes(input).pipeThrough(transform);
  const reader = decompressed.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      await runtime.checkpoint("FlateDecode");
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxDecodedStreamBytes) {
        throw new PdfParseError(
          "limit-exceeded",
          `Decoded stream exceeded the configured maxDecodedStreamBytes (${limits.maxDecodedStreamBytes}).`,
          "context=stream limit=maxDecodedStreamBytes",
        );
      }
      const ratio = total / Math.max(1, input.byteLength);
      if (ratio > limits.maxCompressionRatio) {
        throw new PdfParseError(
          "limit-exceeded",
          `Stream compression ratio exceeded the configured maxCompressionRatio (${limits.maxCompressionRatio}).`,
          "context=stream limit=maxCompressionRatio",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof PdfParseError) throw error;
    throw new PdfParseError(
      "corrupt-structure",
      "FlateDecode failed: the stream is truncated or not valid zlib/deflate data.",
      error instanceof Error ? error.message : String(error),
    );
  }

  return concatBytes(chunks, total);
}

// ---------------------------------------------------------------------------
// Predictors (PNG per-row filter types 0-4, and the TIFF horizontal predictor)
// ---------------------------------------------------------------------------

function numberOrDefault(value: PdfValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

async function applyPredictorIfPresent(
  data: Uint8Array,
  parms: PdfDict | undefined,
  limits: Pick<SafetyLimits, "maxDecodedStreamBytes">,
  runtime: ParseRuntime,
): Promise<Uint8Array> {
  if (!parms) return data;
  const predictor = numberOrDefault(dictGet(parms, "Predictor"), 1);
  if (predictor === 1) return data;

  const colors = numberOrDefault(dictGet(parms, "Colors"), 1);
  const bitsPerComponent = numberOrDefault(dictGet(parms, "BitsPerComponent"), 8);
  const columns = numberOrDefault(dictGet(parms, "Columns"), 1);
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowBytes = Math.ceil((colors * bitsPerComponent * columns) / 8);

  if (predictor === 2) {
    if (bitsPerComponent !== 8) {
      throw new PdfParseError(
        "unsupported-feature",
        `TIFF predictor is only supported for 8-bit components (got ${bitsPerComponent}).`,
      );
    }
    return applyTiffPredictor8(data, colors, rowBytes, limits, runtime);
  }
  if (predictor >= 10 && predictor <= 15) {
    return applyPngPredictor(data, bytesPerPixel, rowBytes, limits, runtime);
  }
  throw new PdfParseError("unsupported-feature", `Unsupported /Predictor value: ${predictor}`);
}

async function applyTiffPredictor8(
  data: Uint8Array,
  colors: number,
  rowBytes: number,
  limits: Pick<SafetyLimits, "maxDecodedStreamBytes">,
  runtime: ParseRuntime,
): Promise<Uint8Array> {
  if (rowBytes <= 0 || data.byteLength % rowBytes !== 0) {
    throw new PdfParseError("corrupt-structure", "TIFF predictor input length is not a multiple of the row length.");
  }
  if (data.byteLength > limits.maxDecodedStreamBytes) {
    throw new PdfParseError("limit-exceeded", "Predictor output would exceed maxDecodedStreamBytes.");
  }
  const out = Uint8Array.from(data);
  const rows = out.byteLength / rowBytes;
  for (let r = 0; r < rows; r += 1) {
    if (r % 256 === 0) await runtime.checkpoint("TIFF predictor");
    const rowStart = r * rowBytes;
    for (let i = colors; i < rowBytes; i += 1) {
      out[rowStart + i] = (out[rowStart + i] + out[rowStart + i - colors]) & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

async function applyPngPredictor(
  data: Uint8Array,
  bytesPerPixel: number,
  rowBytes: number,
  limits: Pick<SafetyLimits, "maxDecodedStreamBytes">,
  runtime: ParseRuntime,
): Promise<Uint8Array> {
  const stride = rowBytes + 1;
  if (stride <= 1 || data.byteLength % stride !== 0) {
    throw new PdfParseError("corrupt-structure", "PNG predictor input length is not a multiple of (row length + 1).");
  }
  const rows = data.byteLength / stride;
  const outLength = rows * rowBytes;
  if (outLength > limits.maxDecodedStreamBytes) {
    throw new PdfParseError("limit-exceeded", "Predictor output would exceed maxDecodedStreamBytes.");
  }
  const out = new Uint8Array(outLength);
  let prevRow = new Uint8Array(rowBytes);

  for (let r = 0; r < rows; r += 1) {
    if (r % 256 === 0) await runtime.checkpoint("PNG predictor");
    const inOff = r * stride;
    const filterType = data[inOff];
    const outOff = r * rowBytes;
    const curRow = out.subarray(outOff, outOff + rowBytes);
    const rawRow = data.subarray(inOff + 1, inOff + 1 + rowBytes);

    for (let i = 0; i < rowBytes; i += 1) {
      const a = i >= bytesPerPixel ? curRow[i - bytesPerPixel] : 0;
      const b = prevRow[i];
      const c = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0;
      let predicted: number;
      switch (filterType) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = a;
          break;
        case 2:
          predicted = b;
          break;
        case 3:
          predicted = Math.floor((a + b) / 2);
          break;
        case 4:
          predicted = paeth(a, b, c);
          break;
        default:
          throw new PdfParseError("unsupported-feature", `Unsupported PNG predictor filter-type byte: ${filterType}`);
      }
      curRow[i] = (rawRow[i] + predicted) & 0xff;
    }
    prevRow = curRow;
  }

  return out;
}
