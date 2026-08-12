/**
 * TKT-012 — structure-tree, /RoleMap, /ParentTree, and per-page MCID
 * mapping unit tests. Builds a small byte-exact tagged-PDF fixture with
 * headings, a paragraph with multiple MCIDs, a nested list, a custom role
 * resolved through /RoleMap, a missing-/S element, an invalid /Pg
 * reference, and both cross-element and intra-element duplicate MCIDs —
 * matching the ticket's "missing, duplicated, or invalid" fallback scope.
 */
import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../../src/pdf-content-extractor/parser/document.ts";
import { traversePageTree } from "../../../src/pdf-content-extractor/parser/pages.ts";
import { PdfBuilder } from "../../fixtures/pdf-builder.ts";
import {
  decodePdfTextString,
  isKnownStructureRole,
  parseStructTree,
  partitionArtifacts,
  resolveElementForStructParent,
  resolvePageStructure,
  type StructTree,
} from "../../../src/pdf-content-extractor/structure/tagged.ts";

async function buildTaggedFixturePdf(): Promise<Uint8Array> {
  const b = new PdfBuilder();
  b.addObject(1, "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 5 0 R /MarkInfo << /Marked true >> >>");
  b.addObject(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
  b.addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  b.addObject(4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  b.addObject(
    5,
    "<< /Type /StructTreeRoot /K [6 0 R 7 0 R 8 0 R 12 0 R 13 0 R 14 0 R 16 0 R 17 0 R 18 0 R] " +
      "/ParentTree 15 0 R /RoleMap << /CustomHead /H1 >> >>",
  );
  b.addObject(
    6,
    "<< /Type /StructElem /S /H1 /P 5 0 R /Pg 3 0 R /Alt (Alt text) /ActualText (Actual text) " +
      "/Lang (en-US) /T (Heading Title) /K [0] >>",
  );
  b.addObject(7, "<< /Type /StructElem /S /P /Pg 3 0 R /K [1 2] >>");
  b.addObject(8, "<< /Type /StructElem /S /L /Pg 3 0 R /K [9 0 R] >>");
  b.addObject(9, "<< /Type /StructElem /S /LI /Pg 3 0 R /K [10 0 R 11 0 R] >>");
  b.addObject(10, "<< /Type /StructElem /S /Lbl /Pg 3 0 R /K [3] >>");
  b.addObject(11, "<< /Type /StructElem /S /LBody /Pg 3 0 R /K [4] >>");
  b.addObject(12, "<< /Type /StructElem /S /CustomHead /Pg 3 0 R /K [5] >>");
  b.addObject(13, "<< /Type /StructElem /S /P /Pg 3 0 R /K [1] >>"); // duplicate of element 7's MCID 1
  b.addObject(14, "<< /Type /StructElem /S /H1 /Pg 4 0 R /K [0] >>");
  b.addObject(15, "<< /Nums [42 6 0 R] >>");
  b.addObject(16, "<< /Type /StructElem /Pg 3 0 R /K [6] >>"); // missing /S
  b.addObject(17, "<< /Type /StructElem /S /P /Pg 999 0 R /K [7] >>"); // /Pg does not resolve to a page
  b.addObject(18, "<< /Type /StructElem /S /Span /Pg 3 0 R /K [8 8] >>"); // intra-element duplicate MCID
  const buffer = b.finalizeTraditional(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    "/Size 19 /Root 1 0 R",
  );
  return new Uint8Array(buffer);
}

async function openTaggedFixture(): Promise<{ tree: StructTree }> {
  const bytes = await buildTaggedFixturePdf();
  const doc = await openPdfDocument(bytes);
  const { pages } = await traversePageTree(doc, doc.limits);
  const pageRefToNumber = new Map(pages.map((p) => [`${p.ref.num}:${p.ref.gen}`, p.pageNumber]));
  const tree = await parseStructTree(doc, pageRefToNumber);
  if (!tree) throw new Error("expected a parsed structure tree");
  return { tree };
}

describe("parseStructTree", () => {
  it("parses top-level structure elements in document order with attributes decoded", async () => {
    const { tree } = await openTaggedFixture();
    expect(tree.roots).toHaveLength(9);
    const h1 = tree.roots[0];
    expect(h1.role).toBe("H1");
    expect(h1.rawRole).toBe("H1");
    expect(h1.alt).toBe("Alt text");
    expect(h1.actualText).toBe("Actual text");
    expect(h1.lang).toBe("en-US");
    expect(h1.title).toBe("Heading Title");
  });

  it("resolves a custom role through /RoleMap", async () => {
    const { tree } = await openTaggedFixture();
    const custom = tree.roots.find((r) => r.rawRole === "CustomHead");
    expect(custom?.role).toBe("H1");
  });

  it("preserves nested list structure (L -> LI -> Lbl/LBody)", async () => {
    const { tree } = await openTaggedFixture();
    const list = tree.roots.find((r) => r.rawRole === "L")!;
    expect(list.kids).toHaveLength(1);
    const li = list.kids[0];
    if (li.kind !== "element") throw new Error("expected nested element");
    expect(li.element.rawRole).toBe("LI");
    expect(li.element.kids.map((k) => (k.kind === "element" ? k.element.rawRole : k.kind))).toEqual(["Lbl", "LBody"]);
  });

  it("falls back to role Unknown and warns when /S is missing", async () => {
    const { tree } = await openTaggedFixture();
    const noRole = tree.roots.find((r) => r.kids.some((k) => k.kind === "mcid" && k.mcid === 6));
    expect(noRole?.role).toBe("Unknown");
    expect(tree.warnings.some((w) => w.message.includes("missing a valid /S"))).toBe(true);
  });

  it("warns and drops content when /Pg does not resolve to a page in this document", async () => {
    const { tree } = await openTaggedFixture();
    expect(tree.warnings.some((w) => w.message.includes("does not resolve to a page"))).toBe(true);
    const badPageElement = tree.roots.find((r) => r.kids.some((k) => k.kind === "mcid" && k.mcid === 7));
    expect(badPageElement).toBeUndefined(); // MCID 7's owner had no valid page, so the kid was dropped entirely
  });

  it("warns and keeps only the first occurrence of an intra-element duplicate MCID", async () => {
    const { tree } = await openTaggedFixture();
    const span = tree.roots.find((r) => r.rawRole === "Span")!;
    expect(span.kids.filter((k) => k.kind === "mcid")).toHaveLength(1);
    expect(tree.warnings.some((w) => w.message.includes("Duplicate MCID 8"))).toBe(true);
  });

  it("resolves a /StructParent index via the parsed /ParentTree", async () => {
    const { tree } = await openTaggedFixture();
    const ref = resolveElementForStructParent(tree, 42);
    expect(ref).toEqual({ kind: "ref", num: 6, gen: 0 });
  });

  it("returns undefined for an untagged document (no /StructTreeRoot)", async () => {
    const b = new PdfBuilder();
    b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    b.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    b.addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
    const buffer = b.finalizeTraditional([1, 2, 3], "/Size 4 /Root 1 0 R");
    const doc = await openPdfDocument(new Uint8Array(buffer));
    const tree = await parseStructTree(doc, new Map());
    expect(tree).toBeUndefined();
  });
});

describe("resolvePageStructure", () => {
  it("maps page 1's MCIDs to structure order, deduplicated, with cross-element duplicates and orphans flagged", async () => {
    const { tree } = await openTaggedFixture();
    const result = resolvePageStructure(tree, 1, [0, 1, 2, 3, 4, 5, 6, 8, 99]);

    expect(result.isTagged).toBe(true);
    expect(result.nodes.map((n) => n.rawRole)).toEqual(["H1", "P", "L", "CustomHead", "Unknown", "Span"]);

    const paragraph = result.nodes[1];
    expect(paragraph.entries).toEqual([{ kind: "mcid", mcid: 1 }, { kind: "mcid", mcid: 2 }]);

    expect(result.orphanedMcids).toEqual(new Set([99]));
    expect(result.warnings.some((w) => w.message.includes("MCID 99") && w.message.includes("not claimed"))).toBe(true);
    expect(result.warnings.some((w) => w.message.includes("MCID 1 is claimed by more than one")).valueOf()).toBe(true);
  });

  it("scopes structure content to the requested page only", async () => {
    const { tree } = await openTaggedFixture();
    const page2 = resolvePageStructure(tree, 2, [0]);
    expect(page2.nodes).toHaveLength(1);
    expect(page2.nodes[0].rawRole).toBe("H1");
    expect(page2.orphanedMcids.size).toBe(0);
  });

  it("reports isTagged: false and every MCID as orphaned for an untagged tree", () => {
    const result = resolvePageStructure(undefined, 1, [5, 6]);
    expect(result.isTagged).toBe(false);
    expect(result.nodes).toEqual([]);
    expect(result.orphanedMcids).toEqual(new Set([5, 6]));
  });
});

describe("isKnownStructureRole", () => {
  it("recognizes standard roles used by the samples", () => {
    for (const role of ["H1", "P", "L", "LI", "Table", "TR", "TD", "TH", "Figure", "Caption", "Reference", "TOC", "TOCI"]) {
      expect(isKnownStructureRole(role)).toBe(true);
    }
  });

  it("does not recognize an arbitrary custom role", () => {
    expect(isKnownStructureRole("MadeUpVendorRole")).toBe(false);
  });
});

describe("decodePdfTextString", () => {
  it("decodes a UTF-16BE string with its BOM", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]);
    expect(decodePdfTextString(bytes)).toBe("AB");
  });

  it("decodes PDFDocEncoding bytes without a BOM, using PDFDocEncoding's own 0x80-0x9F row (not WinAnsi's)", () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x80]); // "Hello" + PDFDocEncoding bullet (0x80, not WinAnsi's 0x95)
    expect(decodePdfTextString(bytes)).toBe("Hello•");
  });

  it("decodes an em dash at 0x84, which WinAnsiEncoding assigns to a completely different glyph (quotedblbase)", () => {
    const bytes = new Uint8Array([0x41, 0x84, 0x42]); // "A" emdash "B"
    expect(decodePdfTextString(bytes)).toBe("A—B");
  });
  it("removes only trailing NUL code units from decoded text strings", () => {
    const bytes = new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x00]);
    expect(decodePdfTextString(bytes)).toBe("A\u0000B");
  });

  it("removes trailing NUL code units from UTF-16BE text strings", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00]);
    expect(decodePdfTextString(bytes)).toBe("A");
  });
});

describe("partitionArtifacts", () => {
  it("splits artifact and non-artifact items", () => {
    const items = [{ artifact: false, v: 1 }, { artifact: true, v: 2 }, { artifact: false, v: 3 }];
    const { content, artifacts } = partitionArtifacts(items);
    expect(content.map((i) => i.v)).toEqual([1, 3]);
    expect(artifacts.map((i) => i.v)).toEqual([2]);
  });
});
