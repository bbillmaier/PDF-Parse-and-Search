/**
 * TKT-009 — content-stream operator interpreter unit tests. Covers
 * graphics-state save/restore, matrix concatenation, text-state operators,
 * TJ numeric adjustments, marked-content/artifact tracking, Do events,
 * unknown-operator diagnostics, and operation-count/nesting limits.
 *
 * A fixed, deterministic `measureText` stub is used throughout so matrix
 * chaining across multiple show-text calls is exactly predictable without
 * depending on TKT-010's real font widths.
 */
import { describe, expect, it } from "vitest";
import {
  interpretPageContent,
  resolvePageContentBytes,
  type MeasureTextFn,
  type TextShowFragment,
} from "../../../src/pdf-content-extractor/content/interpreter.ts";
import { DEFAULT_SAFETY_LIMITS } from "../../../src/pdf-content-extractor/parser/limits.ts";
import { PdfParseError } from "../../../src/pdf-content-extractor/errors.ts";
import { openPdfDocument } from "../../../src/pdf-content-extractor/parser/document.ts";
import { traversePageTree } from "../../../src/pdf-content-extractor/parser/pages.ts";
import { PdfBuilder } from "../../fixtures/pdf-builder.ts";

function bytesOf(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

/** Every byte advances by exactly 1 unscaled text-space unit per point of font size (ignores Tc/Tw/Tz for readability of expected values, except where a test opts in). */
const unitMeasure: MeasureTextFn = (_font, bytes, state) => bytes.length * state.fontSize;

function run(content: string, measureText: MeasureTextFn = unitMeasure) {
  return interpretPageContent(bytesOf(content), 1, { limits: DEFAULT_SAFETY_LIMITS, measureText });
}

function textOf(fragment: TextShowFragment): string {
  return Buffer.from(fragment.bytes).toString("latin1");
}

describe("graphics state: q/Q and cm", () => {
  it("concatenates cm into the CTM and restores it on Q", () => {
    const result = run("q 2 0 0 2 10 10 cm BT /F1 1 Tf 0 0 Td (A) Tj ET Q BT /F1 1 Tf 0 0 Td (B) Tj ET");
    expect(result.fragments).toHaveLength(2);
    // Inside q/Q: CTM = [2 0 0 2 10 10], Tm = identity -> effective matrix e/f = (10,10).
    expect(result.fragments[0].matrix).toEqual([2, 0, 0, 2, 10, 10]);
    // After Q: CTM restored to identity.
    expect(result.fragments[1].matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("nests q/Q correctly with multiple levels", () => {
    const result = run(
      "q 1 0 0 1 5 0 cm q 1 0 0 1 0 5 cm BT /F1 1 Tf 0 0 Td (A) Tj ET Q BT /F1 1 Tf 0 0 Td (B) Tj ET Q",
    );
    expect(result.fragments[0].matrix).toEqual([1, 0, 0, 1, 5, 5]);
    expect(result.fragments[1].matrix).toEqual([1, 0, 0, 1, 5, 0]);
  });

  it("warns but does not throw on an unmatched Q", () => {
    const result = run("Q BT /F1 1 Tf 0 0 Td (A) Tj ET");
    expect(result.warnings.some((w) => w.message.includes("Q operator"))).toBe(true);
    expect(result.fragments).toHaveLength(1);
  });

  it("warns about unmatched q at end of stream", () => {
    const result = run("q q BT /F1 1 Tf 0 0 Td (A) Tj ET");
    expect(result.warnings.some((w) => w.message.includes("unmatched 'q'"))).toBe(true);
  });
});

describe("text state: Tm, Td, TD, T*", () => {
  it("Tm sets an absolute text matrix", () => {
    const result = run("BT /F1 12 Tf 1 0 0 1 100 200 Tm (A) Tj ET");
    expect(result.fragments[0].matrix).toEqual([1, 0, 0, 1, 100, 200]);
  });

  it("Td translates relative to the current line matrix", () => {
    const result = run("BT /F1 1 Tf 10 20 Td (A) Tj 5 5 Td (B) Tj ET");
    expect(result.fragments[0].matrix).toEqual([1, 0, 0, 1, 10, 20]);
    // Second Td is relative to the line matrix (10,20), not to the advanced text matrix.
    expect(result.fragments[1].matrix).toEqual([1, 0, 0, 1, 15, 25]);
  });

  it("TD sets leading from -ty and behaves like Td", () => {
    const result = run("BT /F1 1 Tf 0 -14 TD (A) Tj T* (B) Tj ET");
    expect(result.fragments[0].matrix).toEqual([1, 0, 0, 1, 0, -14]);
    // T* moves by (0, -leading) = (0, -14) from the line matrix.
    expect(result.fragments[1].matrix).toEqual([1, 0, 0, 1, 0, -28]);
  });

  it("chains the text matrix across successive Tj calls using the glyph-advance hook", () => {
    const result = run("BT /F1 10 Tf 0 0 Td (AB) Tj (C) Tj ET");
    // unitMeasure: "AB" advances by 2*10 = 20 text-space units.
    expect(result.fragments[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(result.fragments[1].matrix).toEqual([1, 0, 0, 1, 20, 0]);
  });

  it("exposes endMatrix as the position right after this fragment's glyphs", () => {
    const result = run("BT /F1 10 Tf 0 0 Td (AB) Tj (C) Tj ET");
    // The first fragment's endMatrix is exactly where the second fragment starts (no Td between them).
    expect(result.fragments[0].endMatrix).toEqual(result.fragments[1].matrix);
    expect(result.fragments[1].endMatrix).toEqual([1, 0, 0, 1, 30, 0]);
  });
});

describe("TJ numeric adjustments", () => {
  it("applies a positive TJ adjustment as a leftward (negative) shift", () => {
    const result = run("BT /F1 10 Tf 0 0 Td [(A) -250 (B)] TJ ET");
    expect(result.fragments).toHaveLength(2);
    expect(result.fragments[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
    // "A" advances by 1*10=10, then -(-250)/1000*10*1 = 2.5 kerning push -> 12.5.
    expect(result.fragments[1].matrix[4]).toBeCloseTo(12.5, 10);
  });

  it("scales the TJ adjustment by horizontal scaling (Tz)", () => {
    const result = run("BT /F1 10 Tf 50 Tz 0 0 Td [(A) -1000 (B)] TJ ET");
    // Th = 0.5; "A" advances by 1*10*? our unitMeasure ignores Tz, so 10; adjustment = -(-1000)/1000*10*0.5 = 5.
    expect(result.fragments[1].matrix[4]).toBeCloseTo(15, 10);
  });

  it("does not treat TJ string fragments as separate words with inserted spaces", () => {
    const result = run("BT /F1 10 Tf 0 0 Td [(Hel) (lo)] TJ ET");
    expect(result.fragments.map(textOf)).toEqual(["Hel", "lo"]);
  });
});

describe("Tc, Tw, Tz, TL, Ts affect the measureText hook inputs", () => {
  it("passes charSpacing/wordSpacing/horizontalScaling/fontSize to the measurer", () => {
    const seen: unknown[] = [];
    const spy: MeasureTextFn = (_font, bytes, state) => {
      seen.push({ ...state });
      return bytes.length * state.fontSize;
    };
    run("BT /F1 12 Tf 2 Tc 3 Tw 50 Tz 0 0 Td (A B) Tj ET", spy);
    expect(seen).toEqual([{ fontSize: 12, charSpacing: 2, wordSpacing: 3, horizontalScaling: 0.5 }]);
  });

  it("Ts (text rise) is attached to fragments without affecting position", () => {
    const result = run("BT /F1 12 Tf 3 Ts 0 0 Td (A) Tj ET");
    expect(result.fragments[0].rise).toBe(3);
    expect(result.fragments[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("' and \" operators", () => {
  it("' performs T* then Tj", () => {
    const result = run("BT /F1 1 Tf 10 TL 0 0 Td (A) Tj (B) ' ET");
    expect(result.fragments[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(result.fragments[1].matrix).toEqual([1, 0, 0, 1, 0, -10]);
  });

  it('" sets word/char spacing then performs T* and Tj', () => {
    const seen: unknown[] = [];
    const spy: MeasureTextFn = (_font, _bytes, state) => {
      seen.push({ charSpacing: state.charSpacing, wordSpacing: state.wordSpacing });
      return 0;
    };
    run('BT /F1 1 Tf 10 TL 1 2 (A) " ET', spy);
    expect(seen).toEqual([{ charSpacing: 2, wordSpacing: 1 }]);
  });
});

describe("marked content: BDC/BMC/EMC, MCID, artifacts", () => {
  it("attaches MCID from an inline BDC properties dictionary", () => {
    const result = run("/P <</MCID 7>> BDC BT /F1 1 Tf 0 0 Td (A) Tj ET EMC");
    expect(result.fragments[0].mcid).toBe(7);
    expect(result.fragments[0].tags).toEqual(["P"]);
  });

  it("resolves MCID via a named Properties resource when provided", () => {
    const result = interpretPageContent(bytesOf("/P /MC0 BDC BT /F1 1 Tf 0 0 Td (A) Tj ET EMC"), 1, {
      limits: DEFAULT_SAFETY_LIMITS,
      measureText: unitMeasure,
      resolveMarkedContentProperties: (name) => (name === "MC0" ? { mcid: 4 } : undefined),
    });
    expect(result.fragments[0].mcid).toBe(4);
  });

  it("marks descendants of an Artifact span as artifact even when nested", () => {
    const result = run(
      "/Artifact BMC /Span <</MCID 1>> BDC BT /F1 1 Tf 0 0 Td (A) Tj ET EMC EMC",
    );
    expect(result.fragments[0].artifact).toBe(true);
    expect(result.fragments[0].tags).toEqual(["Artifact", "Span"]);
  });

  it("does not mark ordinary tagged content as artifact", () => {
    const result = run("/P <</MCID 0>> BDC BT /F1 1 Tf 0 0 Td (A) Tj ET EMC");
    expect(result.fragments[0].artifact).toBe(false);
  });

  it("warns on an unmatched EMC", () => {
    const result = run("EMC BT /F1 1 Tf 0 0 Td (A) Tj ET");
    expect(result.warnings.some((w) => w.message.includes("EMC"))).toBe(true);
  });

  it("attaches the active CTM and marked-content context to Do events", () => {
    const result = run("q 2 0 0 2 0 0 cm /Figure BMC /Im0 Do EMC Q");
    expect(result.xobjects).toHaveLength(1);
    expect(result.xobjects[0].name).toBe("Im0");
    expect(result.xobjects[0].matrix).toEqual([2, 0, 0, 2, 0, 0]);
    expect(result.xobjects[0].tags).toEqual(["Figure"]);
  });
});

describe("unknown operators", () => {
  it("records syntactically valid unknown operators without throwing", () => {
    const result = run("1 0 0 RG 0 0 100 100 re f");
    expect(result.warnings).toHaveLength(0);
    expect(result.unknownOperators.map((op) => op.operator)).toEqual(["RG", "re", "f"]);
    expect(result.unknownOperators[0].operandCount).toBe(3);
  });

  it("records an inline image as a skipped unknown operator", () => {
    const result = run("BI /W 1 /H 1 ID \xff EI");
    expect(result.unknownOperators.map((op) => op.operator)).toEqual(["BI"]);
  });
});

describe("safety limits", () => {
  it("throws when the operation count exceeds maxContentOperationsPerPage", () => {
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxContentOperationsPerPage: 3 };
    const bytes = bytesOf("q Q q Q q Q");
    expect(() => interpretPageContent(bytes, 1, { limits, measureText: unitMeasure })).toThrow(PdfParseError);
  });

  it("throws when q nesting exceeds maxNestingDepth", () => {
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxNestingDepth: 2 };
    const bytes = bytesOf("q q q");
    expect(() => interpretPageContent(bytes, 1, { limits, measureText: unitMeasure })).toThrow(PdfParseError);
  });

  it("throws when marked-content nesting exceeds maxNestingDepth", () => {
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxNestingDepth: 2 };
    const bytes = bytesOf("/A BMC /B BMC /C BMC");
    expect(() => interpretPageContent(bytes, 1, { limits, measureText: unitMeasure })).toThrow(PdfParseError);
  });
});

describe("resolvePageContentBytes", () => {
  async function buildOnePagePdf(): Promise<Uint8Array> {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    builder.addObject(
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 5 0 R] /Resources << >> >>",
    );
    builder.addStreamObject(4, "<<", bytesOf("BT /F1 12 Tf (Hi) Tj ET"));
    builder.addObject(5, "42"); // not a stream: exercises the skip-with-warning path
    const buffer = builder.finalizeTraditional([1, 2, 3, 4, 5], "/Size 6 /Root 1 0 R");
    return new Uint8Array(buffer);
  }

  it("concatenates decoded content streams and skips non-stream /Contents entries with a warning", async () => {
    const bytes = await buildOnePagePdf();
    const doc = await openPdfDocument(bytes);
    const { pages } = await traversePageTree(doc, doc.limits);
    expect(pages).toHaveLength(1);

    const result = await resolvePageContentBytes(doc, pages[0]);
    expect(Buffer.from(result.bytes).toString("latin1")).toContain("BT /F1 12 Tf (Hi) Tj ET");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe("structure-inconsistency");
  });

  it("returns an empty buffer and no warnings for a page with no content refs", async () => {
    const bytes = await buildOnePagePdf();
    const doc = await openPdfDocument(bytes);
    const { pages } = await traversePageTree(doc, doc.limits);
    const emptyPage = { ...pages[0], contentRefs: [] };
    const result = await resolvePageContentBytes(doc, emptyPage);
    expect(result.bytes.byteLength).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });
});
