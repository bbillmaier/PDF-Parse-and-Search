/**
 * TKT-011 — geometric line/paragraph reconstruction unit tests: rotation
 * normalization, baseline grouping, space inference from precise
 * start/end gaps, column-gap separation, and paragraph detection.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOMETRY_THRESHOLDS,
  groupIntoLines,
  groupLinesIntoParagraphs,
  joinFragmentsText,
  normalizeFragment,
  reconstructReadingOrder,
  rotatePoint,
  type NormalizedFragment,
  type PageGeometryContext,
} from "../../../src/pdf-content-extractor/structure/geometry.ts";
import type { DecodedTextFragment } from "../../../src/pdf-content-extractor/fonts/resolve.ts";

const PAGE: PageGeometryContext = { mediaBox: [0, 0, 200, 100], rotate: 0 };

describe("rotatePoint", () => {
  it("flips Y only for rotate=0 (top-left origin, y-down)", () => {
    expect(rotatePoint(0, 0, PAGE)).toEqual({ x: 0, y: 100 });
    expect(rotatePoint(200, 100, PAGE)).toEqual({ x: 200, y: 0 });
  });

  it("rotates 90 degrees clockwise", () => {
    const ctx: PageGeometryContext = { mediaBox: [0, 0, 200, 100], rotate: 90 };
    // Unrotated bottom-left (PDF origin) maps to the displayed top-left.
    expect(rotatePoint(0, 0, ctx)).toEqual({ x: 0, y: 0 });
    // Unrotated top-left (0, height) maps to the displayed top-right.
    expect(rotatePoint(0, 100, ctx)).toEqual({ x: 100, y: 0 });
  });

  it("rotates 180 degrees", () => {
    const ctx: PageGeometryContext = { mediaBox: [0, 0, 200, 100], rotate: 180 };
    expect(rotatePoint(0, 0, ctx)).toEqual({ x: 200, y: 0 });
    expect(rotatePoint(200, 100, ctx)).toEqual({ x: 0, y: 100 });
  });

  it("rotates 270 degrees clockwise", () => {
    const ctx: PageGeometryContext = { mediaBox: [0, 0, 200, 100], rotate: 270 };
    expect(rotatePoint(0, 0, ctx)).toEqual({ x: 100, y: 200 });
  });

  it("offsets by a non-zero MediaBox origin", () => {
    const ctx: PageGeometryContext = { mediaBox: [10, 20, 210, 120], rotate: 0 };
    expect(rotatePoint(10, 20, ctx)).toEqual({ x: 0, y: 100 });
  });
});

function decodedFragment(overrides: Partial<DecodedTextFragment>): DecodedTextFragment {
  return {
    pageNumber: 1,
    text: "",
    matrix: [12, 0, 0, 12, 0, 0],
    endMatrix: [12, 0, 0, 12, 0, 0],
    fontSize: 12,
    rise: 0,
    mcid: undefined,
    tags: [],
    artifact: false,
    sourceOffset: 0,
    unknownGlyphCount: 0,
    ...overrides,
  };
}

describe("normalizeFragment", () => {
  it("derives fontSize from the matrix scale and start/end points from matrix/endMatrix", () => {
    const fragment = decodedFragment({
      text: "Hi",
      matrix: [1, 0, 0, 1, 50, 40],
      endMatrix: [1, 0, 0, 1, 62, 40],
      fontSize: 12,
    });
    const normalized = normalizeFragment(fragment, PAGE);
    expect(normalized.x).toBe(50);
    expect(normalized.y).toBe(60); // 100 - 40
    expect(normalized.endX).toBe(62);
    expect(normalized.fontSize).toBe(12); // matrix scale is 1
    expect(normalized.rotationDeg).toBeCloseTo(0, 6);
  });

  it("flags a vertically-drawn fragment with a non-zero rotationDeg", () => {
    const fragment = decodedFragment({
      text: "V",
      matrix: [1, 0, 0, 1, 50, 10],
      endMatrix: [1, 0, 0, 1, 50, 30], // straight up in PDF space -> straight up in normalized space too
    });
    const normalized = normalizeFragment(fragment, PAGE);
    expect(Math.abs(normalized.rotationDeg)).toBeGreaterThan(45);
  });
});

function frag(overrides: Partial<NormalizedFragment>): NormalizedFragment {
  return {
    pageNumber: 1,
    text: "x",
    x: 0,
    y: 0,
    endX: 0,
    endY: 0,
    fontSize: 12,
    rotationDeg: 0,
    mcid: undefined,
    tags: [],
    artifact: false,
    sourceOffset: 0,
    unknownGlyphCount: 0,
    ...overrides,
  };
}

describe("joinFragmentsText: space inference", () => {
  it("does not insert a space for a tight kerning gap (fragmented Tj/TJ strings)", () => {
    const text = joinFragmentsText(
      [frag({ text: "Hel", x: 0, endX: 20 }), frag({ text: "lo", x: 20.4, endX: 32 })],
      DEFAULT_GEOMETRY_THRESHOLDS,
    );
    expect(text).toBe("Hello");
  });

  it("inserts a space for a word-sized gap", () => {
    const text = joinFragmentsText(
      [frag({ text: "Hello", x: 0, endX: 30, fontSize: 12 }), frag({ text: "World", x: 34, endX: 60, fontSize: 12 })],
      DEFAULT_GEOMETRY_THRESHOLDS,
    );
    expect(text).toBe("Hello World");
  });

  it("does not double a space already present in the decoded text", () => {
    const text = joinFragmentsText(
      [frag({ text: "Hello ", x: 0, endX: 32, fontSize: 12 }), frag({ text: "World", x: 34, endX: 60, fontSize: 12 })],
      DEFAULT_GEOMETRY_THRESHOLDS,
    );
    expect(text).toBe("Hello World");
  });
});

describe("groupIntoLines", () => {
  it("groups fragments with close baselines into one line, sorted left-to-right", () => {
    const lines = groupIntoLines([
      frag({ text: "World", x: 40, endX: 70, y: 100.2 }),
      frag({ text: "Hello", x: 0, endX: 30, y: 100 }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Hello World");
  });

  it("does not merge fragments on different baselines into one line", () => {
    const lines = groupIntoLines([frag({ text: "Line one", y: 100 }), frag({ text: "Line two", y: 120 })]);
    expect(lines).toHaveLength(2);
  });

  it("splits a same-baseline run with a column-sized gap into separate lines", () => {
    const lines = groupIntoLines([
      frag({ text: "LeftCol", x: 0, endX: 30, y: 100, fontSize: 10 }),
      frag({ text: "RightCol", x: 300, endX: 330, y: 100, fontSize: 10 }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(["LeftCol", "RightCol"]);
  });

  it("orders split same-baseline runs left-to-right despite tiny baseline differences", () => {
    const lines = groupIntoLines([
      frag({ text: "31", x: 500, endX: 512, y: 100, fontSize: 10 }),
      frag({ text: "Attachment 4", x: 40, endX: 110, y: 100.2, fontSize: 10 }),
    ]);
    expect(lines.map((l) => l.text)).toEqual(["Attachment 4", "31"]);
  });

  it("groups out-of-stream-order fragments onto the correct line by baseline proximity", () => {
    const lines = groupIntoLines([
      frag({ text: "second", x: 0, endX: 20, y: 130 }),
      frag({ text: "first", x: 0, endX: 20, y: 100 }),
    ]);
    expect(lines.map((l) => l.text)).toEqual(["first", "second"]); // top-to-bottom regardless of input order
  });

  it("keeps a non-horizontal fragment in its own line rather than merging it", () => {
    const lines = groupIntoLines([
      frag({ text: "normal", x: 0, endX: 20, y: 100 }),
      frag({ text: "sideways", x: 5, endX: 5, y: 100, rotationDeg: 90 }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.confidence < 1)).toBe(true);
  });

  it("skips fragments with empty decoded text", () => {
    const lines = groupIntoLines([frag({ text: "" }), frag({ text: "kept" })]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("kept");
  });
});

describe("groupLinesIntoParagraphs", () => {
  it("keeps normally-spaced consecutive lines in one paragraph", () => {
    const lines = groupIntoLines([
      frag({ text: "Line one", x: 0, endX: 30, y: 100, fontSize: 12 }),
      frag({ text: "Line two", x: 0, endX: 30, y: 114, fontSize: 12 }),
      frag({ text: "Line three", x: 0, endX: 30, y: 128, fontSize: 12 }),
    ]);
    const paragraphs = groupLinesIntoParagraphs(lines);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toHaveLength(3);
  });

  it("starts a new paragraph after an enlarged vertical gap", () => {
    const lines = groupIntoLines([
      frag({ text: "Para one line one", x: 0, endX: 30, y: 100, fontSize: 12 }),
      frag({ text: "Para one line two", x: 0, endX: 30, y: 114, fontSize: 12 }),
      frag({ text: "Para two line one", x: 0, endX: 30, y: 150, fontSize: 12 }), // big gap
    ]);
    const paragraphs = groupLinesIntoParagraphs(lines);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toHaveLength(2);
    expect(paragraphs[1]).toHaveLength(1);
  });

  it("starts a new paragraph on an indentation change at normal line spacing", () => {
    const lines = groupIntoLines([
      frag({ text: "Left margin line", x: 0, endX: 30, y: 100, fontSize: 12 }),
      frag({ text: "Indented new para", x: 40, endX: 70, y: 114, fontSize: 12 }),
    ]);
    const paragraphs = groupLinesIntoParagraphs(lines);
    expect(paragraphs).toHaveLength(2);
  });
});

describe("reconstructReadingOrder", () => {
  it("produces readable paragraphs in top-to-bottom order for an untagged page", () => {
    const fragments: NormalizedFragment[] = [
      frag({ text: "Title", x: 0, endX: 30, y: 20, fontSize: 18 }),
      frag({ text: "First paragraph line one.", x: 0, endX: 100, y: 50, fontSize: 12 }),
      frag({ text: "First paragraph line two.", x: 0, endX: 100, y: 64, fontSize: 12 }),
      frag({ text: "Second paragraph starts here.", x: 0, endX: 100, y: 100, fontSize: 12 }),
    ];
    const result = reconstructReadingOrder(fragments);
    expect(result.paragraphs.map((p) => p.map((l) => l.text))).toEqual([
      ["Title"],
      ["First paragraph line one.", "First paragraph line two."],
      ["Second paragraph starts here."],
    ]);
  });

  it("reports a warning when a non-horizontal fragment forces a low-confidence line", () => {
    const result = reconstructReadingOrder([
      frag({ text: "normal", x: 0, endX: 20, y: 100 }),
      frag({ text: "sideways", x: 5, endX: 5, y: 100, rotationDeg: 90 }),
    ]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
