/**
 * Font-dictionary resolution and text decoding (TKT-010): ties together
 * `/ToUnicode` CMap parsing, WinAnsi/`/Differences` encoding, and simple/CID
 * width tables into one `ResolvedFont`, caches decoders by indirect
 * reference, and decodes TKT-009's raw `TextShowFragment` events into
 * Unicode text ready for TKT-011's geometry reconstruction.
 */

import type { ParseWarning } from "../types.ts";
import type { PdfDocument } from "../parser/document.ts";
import {
  dictGet,
  isArrayValue,
  isDict,
  isName,
  isRef,
  isStream,
  type PdfDict,
  type PdfRef,
  type PdfValue,
} from "../parser/objects.ts";
import type { PageDescriptor } from "../parser/pages.ts";
import type { Matrix } from "../content/graphics-state.ts";
import type { TextShowFragment } from "../content/interpreter.ts";
import { parseToUnicodeCMap } from "./cmap.ts";
import {
  type EncodingDifference,
  resolveSimpleFontEncoding,
} from "./encodings.ts";
import {
  computeStringAdvance,
  DEFAULT_MISSING_WIDTH_PER_MILLE,
  parseCidWidths,
  parseSimpleFontWidths,
  splitCodes,
  widthForCid,
  widthForSimpleCode,
  type CidFontWidths,
  type SimpleFontWidths,
  type TextAdvanceState,
} from "./metrics.ts";

export interface ResolvedFont {
  key: string;
  subtype: string;
  /** PDF `/BaseFont`, normalized by removing a six-letter subset prefix such as `ABCDEE+`. */
  normalizedBaseFontName: string | undefined;
  isWingdingsDerived: boolean;
  isCID: boolean;
  /** Byte width of one character code when splitting a shown string. */
  codeByteLength: number;
  toUnicode: Map<number, string> | undefined;
  /** Simple-font (non-CID) fallback table: `simpleEncoding[code]`. `undefined` for CID fonts. */
  simpleEncoding: (string | undefined)[] | undefined;
  widths: SimpleFontWidths | CidFontWidths;
  isCidWidths: boolean;
}

function decodeCode(font: ResolvedFont, code: number): { text: string; unknown: boolean } {
  const fromCMap = font.toUnicode?.get(code);
  if (fromCMap !== undefined) return { text: normalizeDecodedGlyphText(font, fromCMap), unknown: false };
  const fromEncoding = font.simpleEncoding?.[code];
  if (fromEncoding !== undefined) return { text: normalizeDecodedGlyphText(font, fromEncoding), unknown: false };
  return { text: "\uFFFD", unknown: true };
}

export function normalizeSubsetFontName(name: string): string {
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name;
}

function isWingdingsDerivedFontName(name: string | undefined): boolean {
  return name !== undefined && normalizeSubsetFontName(name).toLowerCase().startsWith("wingdings");
}

function normalizeDecodedGlyphText(font: ResolvedFont, text: string): string {
  if (!font.isWingdingsDerived) return text;
  return text.replace(/\uF0A7/g, "\u25AA").replace(/\uF0A8/g, "\u2610");
}

async function resolveBaseFontName(doc: PdfDocument, fontDict: PdfDict): Promise<string | undefined> {
  const baseFontVal = await doc.resolve(dictGet(fontDict, "BaseFont"));
  return isName(baseFontVal) ? normalizeSubsetFontName(baseFontVal.name) : undefined;
}

export function glyphWidthOf(font: ResolvedFont, code: number): number {
  return font.isCidWidths
    ? widthForCid(font.widths as CidFontWidths, code)
    : widthForSimpleCode(font.widths as SimpleFontWidths, code);
}

/** The spec 9.4.3 advance for showing `bytes` with `font`, for use as a content-interpreter `measureText` hook. */
export function computeStringAdvanceForFont(font: ResolvedFont, bytes: Uint8Array, state: TextAdvanceState): number {
  const codes = splitCodes(bytes, font.codeByteLength);
  return computeStringAdvance(codes, font.codeByteLength, (code) => glyphWidthOf(font, code), state);
}

// ---------------------------------------------------------------------------
// Font-dictionary resolution
// ---------------------------------------------------------------------------

async function resolveToUnicode(
  doc: PdfDocument,
  fontDict: PdfDict,
  warnings: ParseWarning[],
  pageNumber: number | undefined,
  resourceName: string | undefined,
): Promise<{ map: Map<number, string> | undefined; codeByteLength: number | undefined }> {
  const toUnicodeVal = await doc.resolve(dictGet(fontDict, "ToUnicode"));
  if (!isStream(toUnicodeVal)) return { map: undefined, codeByteLength: undefined };
  try {
    const bytes = await doc.getDecodedStreamBytes(toUnicodeVal);
    const parsed = parseToUnicodeCMap(bytes, doc.limits, doc.runtime.isCancelled);
    for (const message of parsed.warnings) {
      warnings.push({ code: "unsupported-feature", message: `/ToUnicode: ${message}`, pageNumber });
    }
    return { map: parsed.toUnicode, codeByteLength: parsed.codeByteLength };
  } catch (error) {
    warnings.push({
      code: "unsupported-feature",
      message: `Failed to parse /ToUnicode CMap${resourceName ? ` for font /${resourceName}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      pageNumber,
    });
    return { map: undefined, codeByteLength: undefined };
  }
}

async function resolveSimpleFontEncodingFromDict(
  doc: PdfDocument,
  fontDict: PdfDict,
  warnings: ParseWarning[],
  pageNumber: number | undefined,
  resourceName: string | undefined,
): Promise<(string | undefined)[]> {
  const encodingVal = await doc.resolve(dictGet(fontDict, "Encoding"));
  let baseEncodingName: string | undefined;
  const differences: EncodingDifference[] = [];

  if (isName(encodingVal)) {
    baseEncodingName = encodingVal.name;
  } else if (isDict(encodingVal)) {
    const baseVal = await doc.resolve(dictGet(encodingVal, "BaseEncoding"));
    if (isName(baseVal)) baseEncodingName = baseVal.name;
    const diffsVal = await doc.resolve(dictGet(encodingVal, "Differences"));
    if (isArrayValue(diffsVal)) {
      let current = 0;
      for (const item of diffsVal.items) {
        const resolved = await doc.resolve(item);
        if (typeof resolved === "number") {
          current = resolved;
        } else if (isName(resolved)) {
          differences.push({ code: current, name: resolved.name });
          current += 1;
        }
      }
    }
  }

  const resolved = resolveSimpleFontEncoding(baseEncodingName, differences);
  if (resolved.unsupportedBaseEncoding) {
    warnings.push({
      code: "unsupported-feature",
      message: `Unsupported base encoding /${resolved.unsupportedBaseEncoding}${resourceName ? ` for font /${resourceName}` : ""}; falling back to WinAnsiEncoding.`,
      pageNumber,
    });
  }
  return resolved.table;
}

async function resolveSimpleFontWidths(doc: PdfDocument, fontDict: PdfDict): Promise<SimpleFontWidths> {
  const firstCharVal = await doc.resolve(dictGet(fontDict, "FirstChar"));
  const widthsVal = await doc.resolve(dictGet(fontDict, "Widths"));
  const descriptorVal = await doc.resolve(dictGet(fontDict, "FontDescriptor"));

  let missingWidth = DEFAULT_MISSING_WIDTH_PER_MILLE;
  if (isDict(descriptorVal)) {
    const mw = await doc.resolve(dictGet(descriptorVal, "MissingWidth"));
    if (typeof mw === "number") missingWidth = mw;
  }

  if (typeof firstCharVal === "number" && isArrayValue(widthsVal)) {
    const nums: number[] = [];
    for (const item of widthsVal.items) {
      const resolved = await doc.resolve(item);
      nums.push(typeof resolved === "number" ? resolved : missingWidth);
    }
    return parseSimpleFontWidths(firstCharVal, nums, missingWidth);
  }
  return parseSimpleFontWidths(0, [], missingWidth);
}

async function normalizeCidWidthItems(doc: PdfDocument, items: PdfValue[]): Promise<(number | number[])[]> {
  const out: (number | number[])[] = [];
  for (const item of items) {
    const resolved = await doc.resolve(item);
    if (typeof resolved === "number") {
      out.push(resolved);
    } else if (isArrayValue(resolved)) {
      const nums: number[] = [];
      for (const sub of resolved.items) {
        const r = await doc.resolve(sub);
        if (typeof r === "number") nums.push(r);
      }
      out.push(nums);
    }
  }
  return out;
}

async function resolveType0Font(
  doc: PdfDocument,
  fontDict: PdfDict,
  normalizedBaseFontName: string | undefined,
  toUnicode: Map<number, string> | undefined,
  toUnicodeCodeByteLength: number | undefined,
  warnings: ParseWarning[],
  pageNumber: number | undefined,
  resourceName: string | undefined,
): Promise<ResolvedFont> {
  const encodingVal = await doc.resolve(dictGet(fontDict, "Encoding"));
  let codeByteLength = toUnicodeCodeByteLength ?? 2;

  if (isName(encodingVal)) {
    if (encodingVal.name !== "Identity-H" && encodingVal.name !== "Identity-V") {
      warnings.push({
        code: "unsupported-feature",
        message: `Unsupported Type0 /Encoding /${encodingVal.name}${resourceName ? ` for font /${resourceName}` : ""}; treating character codes as Identity (2-byte) CIDs.`,
        pageNumber,
      });
    }
    codeByteLength = 2;
  } else if (isStream(encodingVal)) {
    warnings.push({
      code: "unsupported-feature",
      message: `Embedded Type0 /Encoding CMap streams are not supported${resourceName ? ` (font /${resourceName})` : ""}; treating character codes as Identity (2-byte) CIDs.`,
      pageNumber,
    });
    codeByteLength = 2;
  }

  let widths: CidFontWidths = { defaultWidth: 1000, entries: new Map() };
  const descendantsVal = await doc.resolve(dictGet(fontDict, "DescendantFonts"));
  if (isArrayValue(descendantsVal) && descendantsVal.items.length > 0) {
    const descendantVal = await doc.resolve(descendantsVal.items[0]);
    if (isDict(descendantVal)) {
      const dwVal = await doc.resolve(dictGet(descendantVal, "DW"));
      const defaultWidth = typeof dwVal === "number" ? dwVal : 1000;
      const wVal = await doc.resolve(dictGet(descendantVal, "W"));
      const items = isArrayValue(wVal) ? await normalizeCidWidthItems(doc, wVal.items) : [];
      widths = parseCidWidths(items, defaultWidth);
    }
  }

  if (!toUnicode) {
    warnings.push({
      code: "unknown-glyph",
      message: `Type0 font${resourceName ? ` /${resourceName}` : ""} has no /ToUnicode CMap; its text cannot be reliably decoded to Unicode.`,
      pageNumber,
    });
  }

  return {
    key: "",
    subtype: "Type0",
    normalizedBaseFontName,
    isWingdingsDerived: isWingdingsDerivedFontName(normalizedBaseFontName),
    isCID: true,
    codeByteLength,
    toUnicode,
    simpleEncoding: undefined,
    widths,
    isCidWidths: true,
  };
}

export async function resolveFontDict(
  doc: PdfDocument,
  fontDict: PdfDict,
  warnings: ParseWarning[],
  pageNumber: number | undefined,
  resourceName: string | undefined,
): Promise<ResolvedFont> {
  const subtypeVal = await doc.resolve(dictGet(fontDict, "Subtype"));
  const subtype = isName(subtypeVal) ? subtypeVal.name : "Unknown";
  const normalizedBaseFontName = await resolveBaseFontName(doc, fontDict);
  const { map: toUnicode, codeByteLength: toUnicodeCodeByteLength } = await resolveToUnicode(
    doc,
    fontDict,
    warnings,
    pageNumber,
    resourceName,
  );

  if (subtype === "Type0") {
    return resolveType0Font(doc, fontDict, normalizedBaseFontName, toUnicode, toUnicodeCodeByteLength, warnings, pageNumber, resourceName);
  }

  const simpleEncoding = await resolveSimpleFontEncodingFromDict(doc, fontDict, warnings, pageNumber, resourceName);
  const widths = await resolveSimpleFontWidths(doc, fontDict);
  return {
    key: "",
    subtype,
    normalizedBaseFontName,
    isWingdingsDerived: isWingdingsDerivedFontName(normalizedBaseFontName),
    isCID: false,
    codeByteLength: 1,
    toUnicode,
    simpleEncoding,
    widths,
    isCidWidths: false,
  };
}

// ---------------------------------------------------------------------------
// Cache and page-resource resolution
// ---------------------------------------------------------------------------

/** Caches resolved fonts by indirect reference so a font shared across pages is decoded exactly once per parse. */
export class FontCache {
  private readonly cache = new Map<string, Promise<ResolvedFont>>();

  async getFont(
    doc: PdfDocument,
    ref: PdfRef | undefined,
    fontDict: PdfDict,
    warnings: ParseWarning[],
    pageNumber: number | undefined,
    resourceName: string | undefined,
  ): Promise<ResolvedFont> {
    const key = ref ? `${ref.num}:${ref.gen}` : undefined;
    if (key) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    const promise = resolveFontDict(doc, fontDict, warnings, pageNumber, resourceName).then((font) => ({
      ...font,
      key: key ?? `inline:${resourceName ?? "?"}`,
    }));
    if (key) this.cache.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.cache.size;
  }
}

export async function resolvePageFonts(
  doc: PdfDocument,
  page: PageDescriptor,
  fontCache: FontCache,
  warnings: ParseWarning[],
): Promise<Map<string, ResolvedFont>> {
  const result = new Map<string, ResolvedFont>();
  if (!page.resources) return result;
  const fontsDictVal = await doc.resolve(dictGet(page.resources, "Font"));
  if (!isDict(fontsDictVal)) return result;

  for (const [name, value] of fontsDictVal.map) {
    const ref = isRef(value) ? value : undefined;
    const resolved = await doc.resolve(value);
    if (!isDict(resolved)) continue;
    try {
      const font = await fontCache.getFont(doc, ref, resolved, warnings, page.pageNumber, name);
      result.set(name, font);
    } catch (error) {
      warnings.push({
        code: "unsupported-feature",
        message: `Failed to resolve font resource /${name}: ${error instanceof Error ? error.message : String(error)}`,
        pageNumber: page.pageNumber,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Decoding TKT-009 raw text-showing events into Unicode fragments
// ---------------------------------------------------------------------------

export interface DecodedTextFragment {
  pageNumber: number;
  text: string;
  matrix: Matrix;
  /** Matrix at the position immediately after this fragment's glyphs; TKT-011 uses this (rather than re-deriving widths) to measure the fragment's on-page extent. */
  endMatrix: Matrix;
  fontSize: number;
  rise: number;
  mcid: number | undefined;
  tags: string[];
  artifact: boolean;
  sourceOffset: number;
  unknownGlyphCount: number;
}

function decodeFragment(
  fragment: TextShowFragment,
  fonts: Map<string, ResolvedFont>,
  warnings: ParseWarning[],
): DecodedTextFragment {
  const font = fragment.fontResourceName ? fonts.get(fragment.fontResourceName) : undefined;
  if (!font) {
    if (fragment.fontResourceName) {
      warnings.push({
        code: "unsupported-feature",
        message: `Text on page ${fragment.pageNumber} referenced unresolved font resource /${fragment.fontResourceName}.`,
        pageNumber: fragment.pageNumber,
      });
    }
    return {
      pageNumber: fragment.pageNumber,
      text: "\uFFFD".repeat(Math.max(0, fragment.bytes.length)),
      matrix: fragment.matrix,
      endMatrix: fragment.endMatrix,
      fontSize: fragment.fontSize,
      rise: fragment.rise,
      mcid: fragment.mcid,
      tags: fragment.tags,
      artifact: fragment.artifact,
      sourceOffset: fragment.sourceOffset,
      unknownGlyphCount: fragment.bytes.length,
    };
  }

  const codes = splitCodes(fragment.bytes, font.codeByteLength);
  let text = "";
  let unknownGlyphCount = 0;
  for (const code of codes) {
    const decoded = decodeCode(font, code);
    text += decoded.text;
    if (decoded.unknown) unknownGlyphCount += 1;
  }
  if (unknownGlyphCount > 0) {
    warnings.push({
      code: "unknown-glyph",
      message: `${unknownGlyphCount} unknown glyph(s) on page ${fragment.pageNumber}${fragment.fontResourceName ? ` (font /${fragment.fontResourceName})` : ""}.`,
      pageNumber: fragment.pageNumber,
    });
  }

  return {
    pageNumber: fragment.pageNumber,
    text,
    matrix: fragment.matrix,
    endMatrix: fragment.endMatrix,
    fontSize: fragment.fontSize,
    rise: fragment.rise,
    mcid: fragment.mcid,
    tags: fragment.tags,
    artifact: fragment.artifact,
    sourceOffset: fragment.sourceOffset,
    unknownGlyphCount,
  };
}

export function decodePageText(
  fragments: TextShowFragment[],
  fonts: Map<string, ResolvedFont>,
  warnings: ParseWarning[],
): DecodedTextFragment[] {
  return fragments.map((fragment) => decodeFragment(fragment, fonts, warnings));
}
