/**
 * Simple-font text encodings (TKT-010): WinAnsiEncoding (PDF spec Annex D),
 * a practical subset of StandardEncoding, and `/Differences` array
 * resolution via a glyph-name-to-Unicode table. This module is pure data
 * plus lookup functions — it has no dependency on the PDF object model, the
 * content interpreter, or any other parser module.
 */

const ASCII_NAMES: Record<number, string> = {
  0x20: "space",
  0x21: "exclam",
  0x22: "quotedbl",
  0x23: "numbersign",
  0x24: "dollar",
  0x25: "percent",
  0x26: "ampersand",
  0x27: "quotesingle",
  0x28: "parenleft",
  0x29: "parenright",
  0x2a: "asterisk",
  0x2b: "plus",
  0x2c: "comma",
  0x2d: "hyphen",
  0x2e: "period",
  0x2f: "slash",
  0x3a: "colon",
  0x3b: "semicolon",
  0x3c: "less",
  0x3d: "equal",
  0x3e: "greater",
  0x3f: "question",
  0x40: "at",
  0x5b: "bracketleft",
  0x5c: "backslash",
  0x5d: "bracketright",
  0x5e: "asciicircum",
  0x5f: "underscore",
  0x60: "grave",
  0x7b: "braceleft",
  0x7c: "bar",
  0x7d: "braceright",
  0x7e: "asciitilde",
};
for (let d = 0; d <= 9; d += 1) ASCII_NAMES[0x30 + d] = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][d];
for (let i = 0; i < 26; i += 1) {
  ASCII_NAMES[0x41 + i] = String.fromCharCode(0x41 + i); // A..Z (also valid AGL names)
  ASCII_NAMES[0x61 + i] = String.fromCharCode(0x61 + i); // a..z
}

/** WinAnsiEncoding glyph names for the non-mechanical codes 0x80-0xFF (PDF spec Annex D.2). Undefined codes are omitted. */
const WIN_ANSI_UPPER_NAMES: Record<number, string> = {
  0x80: "Euro",
  0x82: "quotesinglbase",
  0x83: "florin",
  0x84: "quotedblbase",
  0x85: "ellipsis",
  0x86: "dagger",
  0x87: "daggerdbl",
  0x88: "circumflex",
  0x89: "perthousand",
  0x8a: "Scaron",
  0x8b: "guilsinglleft",
  0x8c: "OE",
  0x8e: "Zcaron",
  0x91: "quoteleft",
  0x92: "quoteright",
  0x93: "quotedblleft",
  0x94: "quotedblright",
  0x95: "bullet",
  0x96: "endash",
  0x97: "emdash",
  0x98: "tilde",
  0x99: "trademark",
  0x9a: "scaron",
  0x9b: "guilsinglright",
  0x9c: "oe",
  0x9e: "zcaron",
  0x9f: "Ydieresis",
  0xa0: "space",
  0xa1: "exclamdown",
  0xa2: "cent",
  0xa3: "sterling",
  0xa4: "currency",
  0xa5: "yen",
  0xa6: "brokenbar",
  0xa7: "section",
  0xa8: "dieresis",
  0xa9: "copyright",
  0xaa: "ordfeminine",
  0xab: "guillemotleft",
  0xac: "logicalnot",
  0xad: "hyphen",
  0xae: "registered",
  0xaf: "macron",
  0xb0: "degree",
  0xb1: "plusminus",
  0xb2: "twosuperior",
  0xb3: "threesuperior",
  0xb4: "acute",
  0xb5: "mu",
  0xb6: "paragraph",
  0xb7: "periodcentered",
  0xb8: "cedilla",
  0xb9: "onesuperior",
  0xba: "ordmasculine",
  0xbb: "guillemotright",
  0xbc: "onequarter",
  0xbd: "onehalf",
  0xbe: "threequarters",
  0xbf: "questiondown",
  0xc0: "Agrave",
  0xc1: "Aacute",
  0xc2: "Acircumflex",
  0xc3: "Atilde",
  0xc4: "Adieresis",
  0xc5: "Aring",
  0xc6: "AE",
  0xc7: "Ccedilla",
  0xc8: "Egrave",
  0xc9: "Eacute",
  0xca: "Ecircumflex",
  0xcb: "Edieresis",
  0xcc: "Igrave",
  0xcd: "Iacute",
  0xce: "Icircumflex",
  0xcf: "Idieresis",
  0xd0: "Eth",
  0xd1: "Ntilde",
  0xd2: "Ograve",
  0xd3: "Oacute",
  0xd4: "Ocircumflex",
  0xd5: "Otilde",
  0xd6: "Odieresis",
  0xd7: "multiply",
  0xd8: "Oslash",
  0xd9: "Ugrave",
  0xda: "Uacute",
  0xdb: "Ucircumflex",
  0xdc: "Udieresis",
  0xdd: "Yacute",
  0xde: "Thorn",
  0xdf: "germandbls",
  0xe0: "agrave",
  0xe1: "aacute",
  0xe2: "acircumflex",
  0xe3: "atilde",
  0xe4: "adieresis",
  0xe5: "aring",
  0xe6: "ae",
  0xe7: "ccedilla",
  0xe8: "egrave",
  0xe9: "eacute",
  0xea: "ecircumflex",
  0xeb: "edieresis",
  0xec: "igrave",
  0xed: "iacute",
  0xee: "icircumflex",
  0xef: "idieresis",
  0xf0: "eth",
  0xf1: "ntilde",
  0xf2: "ograve",
  0xf3: "oacute",
  0xf4: "ocircumflex",
  0xf5: "otilde",
  0xf6: "odieresis",
  0xf7: "divide",
  0xf8: "oslash",
  0xf9: "ugrave",
  0xfa: "uacute",
  0xfb: "ucircumflex",
  0xfc: "udieresis",
  0xfd: "yacute",
  0xfe: "thorn",
  0xff: "ydieresis",
};

/** `codeToGlyphName[code]` gives the WinAnsiEncoding glyph name for `code`, or `undefined` if unassigned. */
const WIN_ANSI_GLYPH_NAMES: (string | undefined)[] = new Array(256);
for (const [codeStr, name] of Object.entries(ASCII_NAMES)) WIN_ANSI_GLYPH_NAMES[Number(codeStr)] = name;
for (const [codeStr, name] of Object.entries(WIN_ANSI_UPPER_NAMES)) WIN_ANSI_GLYPH_NAMES[Number(codeStr)] = name;

/**
 * Glyph name -> Unicode text, built as the single source of truth from the
 * WinAnsi table above (every WinAnsi glyph name is a valid Adobe Glyph List
 * name), plus a handful of extra AGL aliases `/Differences` arrays commonly
 * use that WinAnsi itself does not assign a code point to.
 */
export const GLYPH_NAME_TO_UNICODE: Map<string, string> = new Map();

const EXTRA_GLYPH_NAMES: Record<string, string> = {
  fi: "ﬁ",
  fl: "ﬂ",
  quotedbl: '"',
  nbspace: " ",
  middot: "·",
  minus: "−",
  dotlessi: "ı",
  fraction: "⁄",
  Lslash: "Ł",
  lslash: "ł",
  breve: "˘",
  caron: "ˇ",
  dotaccent: "˙",
  hungarumlaut: "˝",
  ogonek: "˛",
  ring: "˚",
  emsp: " ",
  ensp: " ",
  thinspace: " ",
};

function buildGlyphNameTable(): void {
  const winAnsi = buildWinAnsiTable();
  for (let code = 0; code < 256; code += 1) {
    const name = WIN_ANSI_GLYPH_NAMES[code];
    const unicode = winAnsi[code];
    if (name !== undefined && unicode !== undefined) GLYPH_NAME_TO_UNICODE.set(name, unicode);
  }
  for (const [name, unicode] of Object.entries(EXTRA_GLYPH_NAMES)) {
    if (!GLYPH_NAME_TO_UNICODE.has(name)) GLYPH_NAME_TO_UNICODE.set(name, unicode);
  }
}

/** Resolves an Adobe Glyph List-style name to Unicode text: `uniXXXX`/`uXXXX` code-point escapes, then the name table. */
export function glyphNameToUnicode(name: string): string | undefined {
  const known = GLYPH_NAME_TO_UNICODE.get(name);
  if (known !== undefined) return known;
  const uniMatch = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uniMatch) return String.fromCodePoint(Number.parseInt(uniMatch[1], 16));
  const uMatch = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uMatch) return String.fromCodePoint(Number.parseInt(uMatch[1], 16));
  return undefined;
}

function buildWinAnsiTable(): (string | undefined)[] {
  const table: (string | undefined)[] = new Array(256);
  for (let code = 0x20; code <= 0x7e; code += 1) table[code] = String.fromCharCode(code);
  table[0xad] = "-"; // WinAnsiEncoding maps 0xAD ("hyphen") to a plain hyphen, not U+00AD soft hyphen.
  table[0xa0] = " ";
  for (let code = 0x80; code <= 0xff; code += 1) {
    if (table[code] !== undefined) continue;
    const name = WIN_ANSI_UPPER_NAMES[code];
    if (name === undefined) continue;
    // Codes in this range whose name matches their own Latin-1 code point (the common case).
    table[code] = String.fromCharCode(code);
  }
  // A few WinAnsi codes are genuinely outside Latin-1 (the CP1252 "special" row); override explicitly.
  const NON_LATIN1: Record<number, number> = {
    0x80: 0x20ac,
    0x82: 0x201a,
    0x83: 0x0192,
    0x84: 0x201e,
    0x85: 0x2026,
    0x86: 0x2020,
    0x87: 0x2021,
    0x88: 0x02c6,
    0x89: 0x2030,
    0x8a: 0x0160,
    0x8b: 0x2039,
    0x8c: 0x0152,
    0x8e: 0x017d,
    0x91: 0x2018,
    0x92: 0x2019,
    0x93: 0x201c,
    0x94: 0x201d,
    0x95: 0x2022,
    0x96: 0x2013,
    0x97: 0x2014,
    0x98: 0x02dc,
    0x99: 0x2122,
    0x9a: 0x0161,
    0x9b: 0x203a,
    0x9c: 0x0153,
    0x9e: 0x017e,
    0x9f: 0x0178,
  };
  for (const [codeStr, codepoint] of Object.entries(NON_LATIN1)) {
    table[Number(codeStr)] = String.fromCodePoint(codepoint);
  }
  return table;
}

/** `WIN_ANSI_ENCODING[code]` is the Unicode text WinAnsiEncoding assigns to byte `code`, or `undefined`. */
export const WIN_ANSI_ENCODING: (string | undefined)[] = buildWinAnsiTable();

buildGlyphNameTable();

/**
 * PDFDocEncoding (PDF spec Annex D.3), used to decode "text strings" that
 * lack a UTF-16BE BOM (document info, outline titles, structure `/Alt`,
 * `/ActualText`, `/T`, `/Lang`, ...). It shares WinAnsiEncoding's mechanical
 * ASCII range and Latin-1 upper range, but its 0x18-0x1F and 0x80-0x9F rows
 * assign *different* glyphs than WinAnsiEncoding/CP1252 — code 0x84 is
 * "emdash" here, not "quotedblbase" as in WinAnsi, for example. Approximating
 * PDFDocEncoding with WinAnsiEncoding (as an earlier version of this table
 * did) silently corrupts exactly the punctuation this range exists for.
 */
const PDF_DOC_ENCODING_NAMES: Record<number, string> = {
  0x18: "breve",
  0x19: "caron",
  0x1a: "circumflex",
  0x1b: "dotaccent",
  0x1c: "hungarumlaut",
  0x1d: "ogonek",
  0x1e: "ring",
  0x1f: "tilde",
  0x80: "bullet",
  0x81: "dagger",
  0x82: "daggerdbl",
  0x83: "ellipsis",
  0x84: "emdash",
  0x85: "endash",
  0x86: "florin",
  0x87: "fraction",
  0x88: "guilsinglleft",
  0x89: "guilsinglright",
  0x8a: "minus",
  0x8b: "perthousand",
  0x8c: "quotedblbase",
  0x8d: "quotedblleft",
  0x8e: "quotedblright",
  0x8f: "quoteleft",
  0x90: "quoteright",
  0x91: "quotesinglbase",
  0x92: "trademark",
  0x93: "fi",
  0x94: "fl",
  0x95: "Lslash",
  0x96: "OE",
  0x97: "Scaron",
  0x98: "Ydieresis",
  0x99: "Zcaron",
  0x9a: "dotlessi",
  0x9b: "lslash",
  0x9c: "oe",
  0x9d: "scaron",
  0x9e: "zcaron",
  0xa0: "Euro",
};

export const PDF_DOC_ENCODING: (string | undefined)[] = (() => {
  const table: (string | undefined)[] = new Array(256);
  for (let code = 0x20; code <= 0x7e; code += 1) table[code] = String.fromCharCode(code);
  for (const [codeStr, name] of Object.entries(PDF_DOC_ENCODING_NAMES)) {
    table[Number(codeStr)] = glyphNameToUnicode(name);
  }
  for (let code = 0xa1; code <= 0xff; code += 1) table[code] = String.fromCharCode(code);
  return table;
})();

/**
 * Practical subset of Adobe StandardEncoding: shares WinAnsi's mechanical
 * ASCII range with two well-known quirks (0x27/0x60 map to curly quotes,
 * not straight ones) and leaves the upper half undefined. Producers that
 * genuinely rely on StandardEncoding's distinct upper-128 glyph set are
 * expected to ship a `/ToUnicode` CMap or `/Differences`; anything this
 * table can't resolve becomes an explicit unknown-glyph marker.
 */
export const STANDARD_ENCODING: (string | undefined)[] = (() => {
  const table = WIN_ANSI_ENCODING.slice(0, 128);
  table[0x27] = "’"; // quoteright
  table[0x60] = "‘"; // quoteleft
  return table;
})();

export type BaseEncodingName = "WinAnsiEncoding" | "StandardEncoding" | "MacRomanEncoding" | "MacExpertEncoding";

export interface EncodingDifference {
  code: number;
  name: string;
}

export interface ResolvedSimpleEncoding {
  /** `table[code]` is the Unicode text for that byte code, or `undefined` if unmapped. */
  table: (string | undefined)[];
  unsupportedBaseEncoding?: string;
}

/**
 * Builds a full 256-entry code -> Unicode table from a declared base
 * encoding name plus a `/Differences` array (spec 9.6.6). Unknown base
 * encoding names fall back to WinAnsiEncoding (the common case for the
 * target document family) and are reported via `unsupportedBaseEncoding`.
 */
export function resolveSimpleFontEncoding(
  baseEncodingName: string | undefined,
  differences: EncodingDifference[],
): ResolvedSimpleEncoding {
  let base: (string | undefined)[];
  let unsupportedBaseEncoding: string | undefined;

  switch (baseEncodingName) {
    case undefined:
    case "WinAnsiEncoding":
      base = WIN_ANSI_ENCODING.slice();
      break;
    case "StandardEncoding":
      base = STANDARD_ENCODING.concat(new Array(128).fill(undefined));
      break;
    default:
      base = WIN_ANSI_ENCODING.slice();
      unsupportedBaseEncoding = baseEncodingName;
  }

  for (const { code, name } of differences) {
    if (code < 0 || code > 255) continue;
    base[code] = glyphNameToUnicode(name) ?? base[code];
  }

  return { table: base, unsupportedBaseEncoding };
}
