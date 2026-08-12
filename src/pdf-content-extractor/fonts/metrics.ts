/**
 * Glyph-width tables and advance computation (TKT-010): simple-font
 * `/Widths` arrays, CID-font `/W` arrays (spec 9.7.4.3), character-code
 * splitting, and the spec 9.4.3 text-showing advance formula. Pure data and
 * math — no dependency on the PDF object model; callers (`fonts/resolve.ts`)
 * normalize `PdfValue` widths data into the plain arrays/maps this module
 * consumes.
 */

/** Used when a font provides no width for a code at all (neither `/Widths` nor `/MissingWidth`/`/DW`), so text still advances instead of stacking glyphs at one point. */
export const DEFAULT_MISSING_WIDTH_PER_MILLE = 500;

// ---------------------------------------------------------------------------
// Simple-font widths (/FirstChar, /LastChar, /Widths, /MissingWidth)
// ---------------------------------------------------------------------------

export interface SimpleFontWidths {
  firstChar: number;
  /** Per-mille glyph widths, `widths[code - firstChar]`. */
  widths: number[];
  missingWidth: number;
}

export function parseSimpleFontWidths(
  firstChar: number,
  widths: number[],
  missingWidth: number = DEFAULT_MISSING_WIDTH_PER_MILLE,
): SimpleFontWidths {
  return { firstChar, widths, missingWidth };
}

export function widthForSimpleCode(table: SimpleFontWidths, code: number): number {
  const index = code - table.firstChar;
  if (index < 0 || index >= table.widths.length) return table.missingWidth;
  const w = table.widths[index];
  return typeof w === "number" && Number.isFinite(w) ? w : table.missingWidth;
}

// ---------------------------------------------------------------------------
// CID-font widths (/DW, /W)
// ---------------------------------------------------------------------------

export interface CidFontWidths {
  defaultWidth: number;
  entries: Map<number, number>;
}

const MAX_CID_RANGE_EXPANSION = 65536;

/**
 * Parses a `/W` array already normalized to plain JS values: each run is
 * either `[c, [w1, w2, ...]]` (consecutive CIDs starting at `c`) or
 * `[cFirst, cLast, w]` (one width for the whole inclusive range).
 */
export function parseCidWidths(items: (number | number[])[], defaultWidth: number): CidFontWidths {
  const entries = new Map<number, number>();
  let i = 0;
  while (i < items.length) {
    const first = items[i];
    if (typeof first !== "number") {
      i += 1;
      continue;
    }
    const second = items[i + 1];
    if (Array.isArray(second)) {
      let cid = first;
      for (const w of second) {
        entries.set(cid, w);
        cid += 1;
      }
      i += 2;
      continue;
    }
    const third = items[i + 2];
    if (typeof second === "number" && typeof third === "number") {
      const span = Math.max(0, second - first + 1);
      const bounded = Math.min(span, MAX_CID_RANGE_EXPANSION);
      for (let c = first; c < first + bounded; c += 1) entries.set(c, third);
      i += 3;
      continue;
    }
    i += 1;
  }
  return { defaultWidth, entries };
}

export function widthForCid(table: CidFontWidths, cid: number): number {
  return table.entries.get(cid) ?? table.defaultWidth;
}

// ---------------------------------------------------------------------------
// Character-code splitting and the text-showing advance formula
// ---------------------------------------------------------------------------

/** Splits raw string bytes into character codes of `codeByteLength` bytes each (big-endian), per the font's declared code space. */
export function splitCodes(bytes: Uint8Array, codeByteLength: number): number[] {
  const step = Math.max(1, codeByteLength);
  const codes: number[] = [];
  const fullLength = bytes.length - (bytes.length % step);
  for (let i = 0; i < fullLength; i += step) {
    let code = 0;
    for (let j = 0; j < step; j += 1) code = code * 256 + bytes[i + j];
    codes.push(code);
  }
  if (fullLength < bytes.length) {
    // Malformed (non-multiple-of-step) trailing bytes: zero-pad rather than drop them.
    let code = 0;
    for (let i = fullLength; i < bytes.length; i += 1) code = code * 256 + bytes[i];
    codes.push(code);
  }
  return codes;
}

export interface TextAdvanceState {
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  /** Th, as a fraction (1 = 100%). */
  horizontalScaling: number;
}

/**
 * PDF spec 9.4.3's per-glyph displacement formula, summed over `codes`.
 * Word spacing applies only to the single-byte code 32 (never to byte 0x20
 * inside a multi-byte code), per spec 9.3.3.
 */
export function computeStringAdvance(
  codes: number[],
  codeByteLength: number,
  widthOfPerMille: (code: number) => number,
  state: TextAdvanceState,
): number {
  let tx = 0;
  for (const code of codes) {
    const w0 = widthOfPerMille(code) / 1000;
    const wordSpacing = codeByteLength === 1 && code === 0x20 ? state.wordSpacing : 0;
    tx += (w0 * state.fontSize + state.charSpacing + wordSpacing) * state.horizontalScaling;
  }
  return tx;
}
