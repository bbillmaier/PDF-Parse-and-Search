/**
 * Document-level object resolution (TKT-005 + TKT-007): walks the `/Prev`
 * xref chain (traditional tables, xref streams, and hybrid-reference files),
 * builds one indexed object table, and resolves indirect objects —
 * including compressed object-stream entries — by lookup rather than by
 * scanning the file. This is the glue layer; syntax lives in `objects.ts`/
 * `lexer.ts`, traditional xref parsing in `xref.ts`, stream decoding in
 * `streams.ts`, and xref-stream parsing in `xref-stream.ts`.
 */

import { PdfParseError } from "../errors.ts";
import type { SafetyLimits } from "../types.ts";
import { NOOP_PARSE_RUNTIME, type ParseRuntime } from "../runtime.ts";
import { ByteCursor } from "./bytes.ts";
import { Lexer } from "./lexer.ts";
import { resolveLimits } from "./limits.ts";
import {
  dictGet,
  isArrayValue,
  isDict,
  isName,
  isStream,
  parseIndirectObjectAt,
  parseValue,
  extractRawStreamRange,
  type PdfDict,
  type PdfRef,
  type PdfStream,
  type PdfValue,
} from "./objects.ts";
import { decodeStream } from "./streams.ts";
import {
  findStartXref,
  parseTraditionalXrefSectionAt,
  validateHeader,
  type HeaderInfo,
  type XrefEntry,
} from "./xref.ts";
import { parseXrefStreamSectionAt } from "./xref-stream.ts";

export type { XrefEntry, XrefSource, XrefSectionKind } from "./xref.ts";
export type { HeaderInfo } from "./xref.ts";

export interface XrefSectionDiagnostic {
  offset: number;
  kind: "table" | "stream";
  note?: string;
}

export interface ObjectResolutionDiagnostic {
  num: number;
  gen: number;
  status: "resolved" | "missing" | "resolved-compressed";
  sectionKind?: "table" | "stream";
  sectionOffset?: number;
}

// ---------------------------------------------------------------------------
// Xref-chain collection
// ---------------------------------------------------------------------------

function peekSectionKind(bytes: Uint8Array, offset: number, limits: SafetyLimits): "table" | "stream" {
  const cursor = new ByteCursor(bytes, offset, bytes.length);
  const lexer = new Lexer(cursor, limits);
  const token = lexer.nextToken();
  if (token.type === "keyword" && token.textValue === "xref") return "table";
  return "stream";
}

function mergeEntries(target: Map<number, XrefEntry>, source: Map<number, XrefEntry>): void {
  for (const [num, entry] of source) {
    if (!target.has(num)) target.set(num, entry);
  }
}

function mergeTrailer(target: Map<string, PdfValue>, source: Map<string, PdfValue>): void {
  for (const [key, value] of source) {
    if (!target.has(key)) target.set(key, value);
  }
}

interface CollectedXref {
  entries: Map<number, XrefEntry>;
  trailer: Map<string, PdfValue>;
  sections: XrefSectionDiagnostic[];
}

async function collectXrefSections(bytes: Uint8Array, startOffset: number, limits: SafetyLimits, runtime: ParseRuntime): Promise<CollectedXref> {
  const entries = new Map<number, XrefEntry>();
  const trailer = new Map<string, PdfValue>();
  const sections: XrefSectionDiagnostic[] = [];
  const visited = new Set<number>();

  let offset: number | undefined = startOffset;
  let depth = 0;

  while (offset !== undefined) {
    await runtime.checkpoint("xref /Prev chain resolution");
    if (visited.has(offset)) {
      sections.push({ offset, kind: "table", note: "cycle detected in /Prev chain; stopping" });
      break;
    }
    if (depth >= limits.maxReferenceDepth) {
      sections.push({ offset, kind: "table", note: "maximum xref /Prev chain depth reached; stopping" });
      break;
    }
    visited.add(offset);
    depth += 1;

    const kind = peekSectionKind(bytes, offset, limits);
    if (kind === "table") {
      const section = parseTraditionalXrefSectionAt(bytes, offset, limits);
      mergeEntries(entries, section.entries);
      mergeTrailer(trailer, section.trailer);
      sections.push({ offset, kind: "table" });

      if (section.xrefStmOffset !== undefined && !visited.has(section.xrefStmOffset)) {
        visited.add(section.xrefStmOffset);
        try {
          const hybrid = await parseXrefStreamSectionAt(bytes, section.xrefStmOffset, limits, runtime);
          mergeEntries(entries, hybrid.entries);
          sections.push({ offset: section.xrefStmOffset, kind: "stream", note: "hybrid /XRefStm" });
        } catch (error) {
          sections.push({
            offset: section.xrefStmOffset,
            kind: "stream",
            note: `hybrid /XRefStm failed to parse: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      offset = section.prevOffset;
    } else {
      const section = await parseXrefStreamSectionAt(bytes, offset, limits, runtime);
      mergeEntries(entries, section.entries);
      mergeTrailer(trailer, section.trailer);
      sections.push({ offset, kind: "stream" });
      offset = section.prevOffset;
    }
  }

  return { entries, trailer, sections };
}

// ---------------------------------------------------------------------------
// PdfDocument
// ---------------------------------------------------------------------------

export class PdfDocument {
  readonly bytes: Uint8Array;
  readonly limits: SafetyLimits;
  readonly header: HeaderInfo;
  readonly trailer: Map<string, PdfValue>;
  readonly xrefSections: XrefSectionDiagnostic[];

  private readonly xref: Map<number, XrefEntry>;
  private readonly objectCache = new Map<number, PdfValue>();
  private readonly objStmCache = new Map<number, Map<number, PdfValue>>();
  private readonly decodedStreamCache = new WeakMap<PdfStream, Uint8Array>();
  private readonly resolutionDiagnostics: ObjectResolutionDiagnostic[] = [];
  /** Object-stream numbers that were actually Flate-decoded (cache misses only) — proves single-decode-per-parse. */
  private readonly objectStreamDecodeLog: number[] = [];
  private resolvedObjectCount = 0;
  private objectStreamExpansionBytes = 0;

  constructor(
    bytes: Uint8Array,
    xref: Map<number, XrefEntry>,
    trailer: Map<string, PdfValue>,
    limits: SafetyLimits,
    header: HeaderInfo,
    xrefSections: XrefSectionDiagnostic[],
    readonly runtime: ParseRuntime = NOOP_PARSE_RUNTIME,
  ) {
    this.bytes = bytes;
    this.xref = xref;
    this.trailer = trailer;
    this.limits = limits;
    this.header = header;
    this.xrefSections = xrefSections;
  }

  getDiagnostics(): {
    header: HeaderInfo;
    xrefSections: XrefSectionDiagnostic[];
    resolutions: ObjectResolutionDiagnostic[];
    objectStreamLoads: number[];
  } {
    return {
      header: this.header,
      xrefSections: this.xrefSections,
      resolutions: this.resolutionDiagnostics.slice(),
      objectStreamLoads: this.objectStreamDecodeLog.slice(),
    };
  }

  getXrefEntry(num: number): XrefEntry | undefined {
    return this.xref.get(num);
  }

  /** Resolves any value: indirect references are looked up and cached; everything else passes through unchanged. */
  async resolve(value: PdfValue | undefined): Promise<PdfValue> {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || !("kind" in value) || value.kind !== "ref") return value;
    const ref = value as PdfRef;

    const cached = this.objectCache.get(ref.num);
    if (cached !== undefined) return cached;

    const entry = this.xref.get(ref.num);
    if (!entry || entry.type === "free") {
      this.resolutionDiagnostics.push({ num: ref.num, gen: ref.gen, status: "missing" });
      return null;
    }

    this.resolvedObjectCount += 1;
    if (this.resolvedObjectCount > this.limits.maxObjectCount) {
      throw new PdfParseError(
        "limit-exceeded",
        `Resolving objects exceeded the configured maxObjectCount (${this.limits.maxObjectCount}).`,
        `context=document object=${ref.num} ${ref.gen} R limit=maxObjectCount`,
      );
    }

    let resolved: PdfValue;
    if (entry.type === "offset") {
      resolved = await this.resolveDirectAt(entry.offset, ref);
      this.resolutionDiagnostics.push({
        num: ref.num,
        gen: ref.gen,
        status: "resolved",
        sectionKind: entry.source.kind,
        sectionOffset: entry.source.sectionOffset,
      });
    } else {
      resolved = await this.resolveCompressed(entry, ref.num);
      this.resolutionDiagnostics.push({
        num: ref.num,
        gen: ref.gen,
        status: "resolved-compressed",
        sectionKind: entry.source.kind,
        sectionOffset: entry.source.sectionOffset,
      });
    }

    this.objectCache.set(ref.num, resolved);
    return resolved;
  }

  private async resolveDirectAt(offset: number, ref: PdfRef): Promise<PdfValue> {
    const parsed = parseIndirectObjectAt(this.bytes, offset, this.limits);
    if (parsed.streamDataStart === undefined) return parsed.value;
    if (!isDict(parsed.value)) {
      throw new PdfParseError("corrupt-structure", `Object ${ref.num} has a stream body but a non-dictionary header.`, `offset=${offset}`);
    }
    const lengthVal = dictGet(parsed.value, "Length");
    const directLength = await this.resolveStreamLength(lengthVal);
    const range = extractRawStreamRange(this.bytes, parsed.streamDataStart, directLength, this.limits);
    return { kind: "stream", dict: parsed.value, start: range.start, end: range.end };
  }

  private async resolveStreamLength(lengthVal: PdfValue | undefined): Promise<number | undefined> {
    if (typeof lengthVal === "number") return lengthVal;
    if (lengthVal && typeof lengthVal === "object" && "kind" in lengthVal && lengthVal.kind === "ref") {
      const resolved = await this.resolve(lengthVal);
      return typeof resolved === "number" ? resolved : undefined;
    }
    return undefined;
  }

  private async resolveCompressed(
    entry: Extract<XrefEntry, { type: "compressed" }>,
    objNum: number,
  ): Promise<PdfValue> {
    const objStm = await this.loadObjectStream(entry.streamObjNum);
    const value = objStm.get(objNum);
    if (value === undefined) {
      throw new PdfParseError(
        "corrupt-structure",
        `Object ${objNum} was not found at its declared index in object stream ${entry.streamObjNum}.`,
      );
    }
    return value;
  }

  private async loadObjectStream(streamObjNum: number): Promise<Map<number, PdfValue>> {
    const cached = this.objStmCache.get(streamObjNum);
    if (cached) return cached;

    const streamValue = await this.resolve({ kind: "ref", num: streamObjNum, gen: 0 });
    if (!isStream(streamValue)) {
      throw new PdfParseError("corrupt-structure", `Object ${streamObjNum} is not a stream (expected /ObjStm).`);
    }
    const typeVal = dictGet(streamValue.dict, "Type");
    if (!isName(typeVal) || typeVal.name !== "ObjStm") {
      throw new PdfParseError("corrupt-structure", `Object ${streamObjNum} does not declare /Type /ObjStm.`);
    }
    const n = dictGet(streamValue.dict, "N");
    const first = dictGet(streamValue.dict, "First");
    if (typeof n !== "number" || typeof first !== "number") {
      throw new PdfParseError("corrupt-structure", `Object stream ${streamObjNum} is missing /N or /First.`);
    }

    const decodedBytes = await this.getDecodedStreamBytes(streamValue);
    this.objectStreamDecodeLog.push(streamObjNum);
    this.objectStreamExpansionBytes += decodedBytes.byteLength;
    if (this.objectStreamExpansionBytes > this.limits.maxObjectStreamExpansionBytes) {
      throw new PdfParseError(
        "limit-exceeded",
        `Cumulative object-stream expansion exceeded the configured maxObjectStreamExpansionBytes (${this.limits.maxObjectStreamExpansionBytes}).`,
        `context=document objectStream=${streamObjNum} limit=maxObjectStreamExpansionBytes`,
      );
    }

    const headerCursor = new ByteCursor(decodedBytes, 0, Math.min(first, decodedBytes.byteLength));
    const headerLexer = new Lexer(headerCursor, this.limits);
    const offsets: { num: number; offset: number }[] = [];
    for (let i = 0; i < n; i += 1) {
      if (i % 128 === 0) await this.runtime.checkpoint(`object stream ${streamObjNum} header`);
      const numTok = headerLexer.nextToken();
      const offTok = headerLexer.nextToken();
      if (numTok.type !== "number" || offTok.type !== "number") {
        throw new PdfParseError("corrupt-structure", `Malformed header in object stream ${streamObjNum}.`);
      }
      offsets.push({ num: numTok.numberValue!, offset: offTok.numberValue! });
    }

    const result = new Map<number, PdfValue>();
    for (let i = 0; i < offsets.length; i += 1) {
      if (i % 64 === 0) await this.runtime.checkpoint(`object stream ${streamObjNum} expansion`);
      const { num, offset } = offsets[i];
      const absStart = first + offset;
      if (absStart < 0 || absStart > decodedBytes.byteLength) {
        throw new PdfParseError("corrupt-structure", `Object ${num} offset in object stream ${streamObjNum} is out of range.`);
      }
      const cursor = new ByteCursor(decodedBytes, absStart, decodedBytes.byteLength);
      const lexer = new Lexer(cursor, this.limits);
      result.set(num, parseValue(lexer, this.limits));
    }

    this.objStmCache.set(streamObjNum, result);
    return result;
  }

  /** Decodes (and caches) a stream's `/Filter` pipeline. Does not decode until asked — resolving a stream object never implies decoding its bytes. */
  async getDecodedStreamBytes(stream: PdfStream): Promise<Uint8Array> {
    const cached = this.decodedStreamCache.get(stream);
    if (cached) return cached;
    const raw = this.bytes.subarray(stream.start, stream.end);
    const dict = await this.materializeFilterConfig(stream.dict);
    const decoded = await decodeStream(dict, raw, this.limits, (v) => v, this.runtime);
    this.decodedStreamCache.set(stream, decoded.bytes);
    return decoded.bytes;
  }

  /** Resolves any indirect references inside `/Filter`/`/DecodeParms` up front so `decodeStream` can stay synchronous. */
  private async materializeFilterConfig(dict: PdfDict): Promise<PdfDict> {
    const filterVal = dictGet(dict, "Filter");
    const parmsVal = dictGet(dict, "DecodeParms") ?? dictGet(dict, "DP");
    if (filterVal === undefined && parmsVal === undefined) return dict;

    const map = new Map(dict.map);
    if (filterVal !== undefined) map.set("Filter", await this.resolveDeep(filterVal));
    if (parmsVal !== undefined) map.set("DecodeParms", await this.resolveDeep(parmsVal));
    return { kind: "dict", map };
  }

  private async resolveDeep(value: PdfValue): Promise<PdfValue> {
    const resolved = await this.resolve(value);
    if (isArrayValue(resolved)) {
      const items: PdfValue[] = [];
      for (let i = 0; i < resolved.items.length; i += 1) {
        if (i % 64 === 0) await this.runtime.checkpoint("deep filter parameter resolution");
        items.push(await this.resolveDeep(resolved.items[i]));
      }
      return { kind: "array", items };
    }
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Document open
// ---------------------------------------------------------------------------

export async function openPdfDocument(bytes: Uint8Array, limitsPartial?: Partial<SafetyLimits>, runtime: ParseRuntime = NOOP_PARSE_RUNTIME): Promise<PdfDocument> {
  const limits = resolveLimits(limitsPartial);
  if (bytes.byteLength > limits.maxInputBytes) {
    throw new PdfParseError(
      "limit-exceeded",
      `Input exceeded the configured maxInputBytes (${limits.maxInputBytes}).`,
      "context=document limit=maxInputBytes",
    );
  }

  const header = validateHeader(bytes);
  const startOffset = findStartXref(bytes, limits);
  await runtime.checkpoint("document header and startxref validation");
  const { entries, trailer, sections } = await collectXrefSections(bytes, startOffset, limits, runtime);

  if (!trailer.has("Root")) {
    throw new PdfParseError("corrupt-structure", "Trailer is missing the required /Root entry.");
  }

  return new PdfDocument(bytes, entries, trailer, limits, header, sections, runtime);
}

export type { PdfDict, PdfRef, PdfStream, PdfValue };
