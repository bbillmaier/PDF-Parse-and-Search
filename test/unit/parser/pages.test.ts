/**
 * TKT-008 — page-tree traversal unit tests: inherited attributes, content
 * reference resolution, and malformed page-tree handling (cycles, depth,
 * duplicate leaves, /Count mismatches).
 */
import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../../src/pdf-content-extractor/parser/document.ts";
import { traversePageTree } from "../../../src/pdf-content-extractor/parser/pages.ts";
import { isRef } from "../../../src/pdf-content-extractor/parser/objects.ts";
import { DEFAULT_SAFETY_LIMITS } from "../../../src/pdf-content-extractor/parser/limits.ts";
import { PdfBuilder } from "../../fixtures/pdf-builder.ts";

async function openWithBuilder(build: (b: PdfBuilder) => void, trailerBody: string, objNums: number[]) {
  const builder = new PdfBuilder();
  build(builder);
  const file = builder.finalizeTraditional(objNums, trailerBody);
  return openPdfDocument(new Uint8Array(file));
}

describe("traversePageTree — inheritance and basic traversal", () => {
  it("enumerates pages in document order and applies inherited MediaBox/Resources", async () => {
    const doc = await openWithBuilder(
      (b) => {
        b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
        b.addObject(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 200 300] /Resources << /Font << >> >> >>");
        b.addObject(3, "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>");
        b.addObject(4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Rotate 90 >>");
        b.addStreamObject(5, "<< /Type /Stream", new Uint8Array(Buffer.from("BT ET")));
      },
      "/Size 6 /Root 1 0 R",
      [1, 2, 3, 4, 5],
    );

    const result = await traversePageTree(doc, DEFAULT_SAFETY_LIMITS);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].pageNumber).toBe(1);
    expect(result.pages[0].mediaBox).toEqual([0, 0, 200, 300]);
    expect(result.pages[0].resources).toBeDefined();
    expect(result.pages[0].contentRefs).toHaveLength(1);
    expect(isRef(result.pages[0].contentRefs[0])).toBe(true);

    expect(result.pages[1].pageNumber).toBe(2);
    expect(result.pages[1].mediaBox).toEqual([0, 0, 100, 100]);
    expect(result.pages[1].rotate).toBe(90);
    expect(result.pages[1].effectiveWidth).toBe(100); // square box, swap is a no-op here
    // Resources inherited from the /Pages parent since page 4 doesn't declare its own.
    expect(result.pages[1].resources).toBeDefined();

    expect(result.declaredRootCount).toBe(2);
    expect(result.warnings.some((w) => w.code === "structure-inconsistency")).toBe(false);
  });

  it("swaps effective width/height for 90/270 rotation", async () => {
    const doc = await openWithBuilder(
      (b) => {
        b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
        b.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 400] /Rotate 90 >>");
        b.addObject(3, "<< /Type /Page /Parent 2 0 R >>");
      },
      "/Size 4 /Root 1 0 R",
      [1, 2, 3],
    );
    const result = await traversePageTree(doc, DEFAULT_SAFETY_LIMITS);
    expect(result.pages[0].effectiveWidth).toBe(400);
    expect(result.pages[0].effectiveHeight).toBe(200);
  });

  it("resolves /Contents as an array of refs", async () => {
    const doc = await openWithBuilder(
      (b) => {
        b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
        b.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 10 10] >>");
        b.addObject(3, "<< /Type /Page /Parent 2 0 R /Contents [4 0 R 5 0 R] >>");
        b.addStreamObject(4, "<< /Type /Stream", new Uint8Array(Buffer.from("a")));
        b.addStreamObject(5, "<< /Type /Stream", new Uint8Array(Buffer.from("b")));
      },
      "/Size 6 /Root 1 0 R",
      [1, 2, 3, 4, 5],
    );
    const result = await traversePageTree(doc, DEFAULT_SAFETY_LIMITS);
    expect(result.pages[0].contentRefs).toHaveLength(2);
  });

  it("falls back to the default MediaBox and warns when none is inherited", async () => {
    const doc = await openWithBuilder(
      (b) => {
        b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
        b.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        b.addObject(3, "<< /Type /Page /Parent 2 0 R >>");
      },
      "/Size 4 /Root 1 0 R",
      [1, 2, 3],
    );
    const result = await traversePageTree(doc, DEFAULT_SAFETY_LIMITS);
    expect(result.pages[0].mediaBox).toEqual([0, 0, 612, 792]);
    expect(result.pages[0].warnings.some((w) => w.code === "structure-inconsistency")).toBe(true);
  });
});

describe("traversePageTree — malformed page trees", () => {
  it("detects a page-tree cycle and does not hang", async () => {
    const doc = await openWithBuilder(
      (b) => {
        b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
        // 2's Kids includes 3, and 3's Kids includes 2 back — a cycle.
        b.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        b.addObject(3, "<< /Type /Pages /Kids [2 0 R] /Count 1 >>");
      },
      "/Size 4 /Root 1 0 R",
      [1, 2, 3],
    );
    const result = await traversePageTree(doc, DEFAULT_SAFETY_LIMITS);
    expect(result.pages).toHaveLength(0);
    expect(result.warnings.some((w) => w.message.includes("cycle"))).toBe(true);
  });

  it("bounds traversal depth instead of recursing forever on a deeply nested tree", async () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const depth = 10;
    // Build a chain: 2 -> 3 -> 4 -> ... -> (depth+1), each a /Pages node with one child, ending in a /Page leaf.
    const leafNum = depth + 2;
    builder.addObject(leafNum, `<< /Type /Page /Parent ${depth + 1} 0 R >>`);
    for (let i = depth + 1; i >= 2; i -= 1) {
      const child = i === depth + 1 ? leafNum : i + 1;
      builder.addObject(i, `<< /Type /Pages /Kids [${child} 0 R] /Count 1 >>`);
    }
    const objNums = [1, ...Array.from({ length: depth + 1 }, (_, i) => i + 2)];
    const file = builder.finalizeTraditional(objNums, "/Size 100 /Root 1 0 R");
    const doc = await openPdfDocument(new Uint8Array(file));

    const limits = { ...DEFAULT_SAFETY_LIMITS, maxPageTreeDepth: 3 };
    const result = await traversePageTree(doc, limits);
    expect(result.pages).toHaveLength(0);
    expect(result.warnings.some((w) => w.message.includes("maxPageTreeDepth"))).toBe(true);
  });

  it("skips a duplicate page reference appearing twice in /Kids", async () => {
    const doc = await openWithBuilder(
      (b) => {
        b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
        b.addObject(2, "<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 >>");
        b.addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>");
      },
      "/Size 4 /Root 1 0 R",
      [1, 2, 3],
    );
    const result = await traversePageTree(doc, DEFAULT_SAFETY_LIMITS);
    expect(result.pages).toHaveLength(1);
    expect(result.warnings.some((w) => w.message.includes("Duplicate page reference"))).toBe(true);
  });

  it("warns when the root /Count does not match the actual traversed page count", async () => {
    const doc = await openWithBuilder(
      (b) => {
        b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
        b.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 5 >>"); // lies: declares 5, has 1
        b.addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>");
      },
      "/Size 4 /Root 1 0 R",
      [1, 2, 3],
    );
    const result = await traversePageTree(doc, DEFAULT_SAFETY_LIMITS);
    expect(result.pages).toHaveLength(1);
    expect(result.declaredRootCount).toBe(5);
    expect(result.warnings.some((w) => w.code === "structure-inconsistency" && w.message.includes("/Count"))).toBe(true);
  });
});
