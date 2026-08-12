/**
 * Cross-reference *stream* parsing (TKT-007): `/Type /XRef` streams using
 * `/W` and `/Index`, decoded via the TKT-006 filter pipeline. This module
 * only builds the xref entry table for one stream section; merging it with
 * other sections (traditional or streamed, following `/Prev`) is
 * `document.ts`'s job.
 */

import { PdfParseError } from "../errors.ts";
import type { SafetyLimits } from "../types.ts";
import { NOOP_PARSE_RUNTIME, type ParseRuntime } from "../runtime.ts";
import { dictGet, isArrayValue, isDict, type PdfValue } from "./objects.ts";
import { parseIndirectObjectAt, extractRawStreamRange } from "./objects.ts";
import { decodeStream } from "./streams.ts";
import type { XrefEntry } from "./xref.ts";

export interface XrefStreamSection {
  entries: Map<number, XrefEntry>;
  trailer: Map<string, PdfValue>;
  prevOffset?: number;
}

type StreamLimits = Pick<
  SafetyLimits,
  "maxNestingDepth" | "maxTokenLength" | "maxDecodedStreamBytes" | "maxCompressionRatio" | "maxObjectCount"
>;

function expectIntArray(value: PdfValue | undefined, key: string): number[] {
  if (!value || !isArrayValue(value)) {
    throw new PdfParseError("corrupt-structure", `Xref stream dictionary is missing a valid /${key} array.`);
  }
  return value.items.map((item) => {
    if (typeof item !== "number" || !Number.isInteger(item)) {
      throw new PdfParseError("corrupt-structure", `/${key} array must contain only integers.`);
    }
    return item;
  });
}

function readBE(bytes: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i += 1) value = value * 256 + bytes[offset + i];
  return value;
}

/**
 * Parses the xref stream object located at `offset` (an "N G obj << ... >>
 * stream ... endstream" object whose dictionary has `/Type /XRef`).
 *
 * Because this can run during document bootstrap — before any xref table
 * exists — an indirect `/Length` cannot be resolved and forces the raw
 * stream's fallback `endstream` scan instead (see
 * `objects.ts#extractRawStreamRange`), which is why xref streams are
 * required by the PDF spec to use a *direct* `/Length`.
 */
export async function parseXrefStreamSectionAt(
  bytes: Uint8Array,
  offset: number,
  limits: StreamLimits,
  runtime: ParseRuntime = NOOP_PARSE_RUNTIME,
): Promise<XrefStreamSection> {
  const parsed = parseIndirectObjectAt(bytes, offset, limits);
  if (parsed.streamDataStart === undefined || !isDict(parsed.value)) {
    throw new PdfParseError("corrupt-structure", "Expected a stream object for the xref stream section.", `offset=${offset}`);
  }
  const dict = parsed.value;
  const typeVal = dictGet(dict, "Type");
  if (!(typeVal && typeof typeVal === "object" && "kind" in typeVal && typeVal.kind === "name" && typeVal.name === "XRef")) {
    throw new PdfParseError("corrupt-structure", "Expected /Type /XRef on the cross-reference stream.", `offset=${offset}`);
  }

  const lengthVal = dictGet(dict, "Length");
  const directLength = typeof lengthVal === "number" ? lengthVal : undefined;
  const range = extractRawStreamRange(bytes, parsed.streamDataStart, directLength, limits);
  const rawStreamBytes = bytes.subarray(range.start, range.end);

  const decoded = await decodeStream(dict, rawStreamBytes, limits, (v) => v, runtime);

  const w = expectIntArray(dictGet(dict, "W"), "W");
  if (w.length !== 3 || w.some((n) => n < 0)) {
    throw new PdfParseError("corrupt-structure", "/W must be an array of exactly 3 non-negative integers.", `offset=${offset}`);
  }
  const [w1, w2, w3] = w as [number, number, number];

  const sizeVal = dictGet(dict, "Size");
  const size = typeof sizeVal === "number" ? sizeVal : undefined;
  const indexVal = dictGet(dict, "Index");
  const indexPairsFlat = indexVal !== undefined ? expectIntArray(indexVal, "Index") : size !== undefined ? [0, size] : undefined;
  if (!indexPairsFlat || indexPairsFlat.length % 2 !== 0) {
    throw new PdfParseError("corrupt-structure", "Invalid or missing /Index (and no /Size fallback).", `offset=${offset}`);
  }
  const indexPairs: [number, number][] = [];
  for (let i = 0; i < indexPairsFlat.length; i += 2) {
    if (i % 128 === 0) await runtime.checkpoint("xref stream /Index parsing");
    indexPairs.push([indexPairsFlat[i], indexPairsFlat[i + 1]]);
  }

  let totalDeclared = 0;
  for (const [, count] of indexPairs) totalDeclared += count;
  if (totalDeclared > limits.maxObjectCount) {
    throw new PdfParseError(
      "limit-exceeded",
      `Xref stream declares more objects than the configured maxObjectCount (${limits.maxObjectCount}).`,
      `context=document offset=${offset} limit=maxObjectCount`,
    );
  }

  const entrySize = w1 + w2 + w3;
  const entries = new Map<number, XrefEntry>();
  let pos = 0;
  for (const [startNum, count] of indexPairs) {
    for (let i = 0; i < count; i += 1) {
      if (i % 1024 === 0) await runtime.checkpoint("xref stream entry decoding");
      if (pos + entrySize > decoded.bytes.byteLength) {
        throw new PdfParseError("corrupt-structure", "Xref stream data is truncated relative to /Index and /W.", `offset=${offset}`);
      }
      const type = w1 === 0 ? 1 : readBE(decoded.bytes, pos, w1);
      pos += w1;
      const field2 = readBE(decoded.bytes, pos, w2);
      pos += w2;
      const field3 = w3 === 0 ? 0 : readBE(decoded.bytes, pos, w3);
      pos += w3;

      const objNum = startNum + i;
      if (type === 0) {
        entries.set(objNum, { type: "free" });
      } else if (type === 1) {
        entries.set(objNum, { type: "offset", offset: field2, gen: field3, source: { kind: "stream", sectionOffset: offset } });
      } else if (type === 2) {
        entries.set(objNum, {
          type: "compressed",
          streamObjNum: field2,
          indexInStream: field3,
          source: { kind: "stream", sectionOffset: offset },
        });
      } else {
        throw new PdfParseError("corrupt-structure", `Unknown xref stream entry type ${type}.`, `offset=${offset} objNum=${objNum}`);
      }
    }
  }

  const prevVal = dictGet(dict, "Prev");
  return {
    entries,
    trailer: dict.map,
    prevOffset: typeof prevVal === "number" ? prevVal : undefined,
  };
}
