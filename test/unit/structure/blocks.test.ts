/**
 * TKT-013 — semantic block construction unit tests: heading levels and
 * stable IDs, list nesting/labels, tagged table rows/cells/spans, figure
 * captions/alt text, link attachment, container flattening, and the
 * untagged geometry-fallback heading heuristic.
 */
import { describe, expect, it } from "vitest";
import {
  buildGeometryFallbackBlocks,
  buildTaggedPageBlocks,
  createBlockBuildContext,
  IdGenerator,
  slugify,
  type BlockBuildContext,
  type XObjectMcidPlacement,
} from "../../../src/pdf-content-extractor/structure/blocks.ts";
import type { PageStructureEntry, PageStructureNode } from "../../../src/pdf-content-extractor/structure/tagged.ts";
import type { NormalizedFragment } from "../../../src/pdf-content-extractor/structure/geometry.ts";
import type { HeadingBlock, LinkTarget, ListBlock, ParagraphBlock, TableBlock, FigureBlock } from "../../../src/pdf-content-extractor/types.ts";

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

function node(overrides: Partial<PageStructureNode> & { role: string }): PageStructureNode {
  return {
    rawRole: overrides.role,
    alt: undefined,
    actualText: undefined,
    lang: undefined,
    title: undefined,
    colSpan: undefined,
    rowSpan: undefined,
    entries: [],
    ...overrides,
  };
}

function mcidEntry(mcid: number): PageStructureEntry {
  return { kind: "mcid", mcid };
}
function elementEntry(n: PageStructureNode): PageStructureEntry {
  return { kind: "element", node: n };
}

function makeContext(
  fragmentsByMcid: Map<number, NormalizedFragment[]>,
  overrides: Partial<{
    xobjectsByMcid: Map<number, XObjectMcidPlacement[]>;
    resolveLinkForNode: (node: PageStructureNode) => Promise<LinkTarget | undefined>;
  }> = {},
): BlockBuildContext {
  return createBlockBuildContext({
    pageNumber: 1,
    ids: new IdGenerator(),
    fragmentsByMcid,
    xobjectsByMcid: overrides.xobjectsByMcid ?? new Map(),
    resolveLinkForNode: overrides.resolveLinkForNode ?? (async () => undefined),
  });
}

describe("headings", () => {
  it("maps H1-H6 to their numeric level and generates a structural id", async () => {
    const fragments = new Map([[0, [frag({ text: "Introduction", mcid: 0 })]]]);
    const ctx = makeContext(fragments);
    const h1 = node({ role: "H1", entries: [mcidEntry(0)] });
    const [block] = await buildTaggedPageBlocks([h1], ctx);
    expect(block.type).toBe("heading");
    const heading = block as HeadingBlock;
    expect(heading.level).toBe(1);
    expect(heading.id).toBe("h-1");
    expect(heading.text.map((r) => r.text).join("")).toBe("Introduction");
  });

  it("drops a heading with no decodable text and warns instead of emitting an empty block", async () => {
    const ctx = makeContext(new Map());
    const h1 = node({ role: "H1", entries: [] });
    const blocks = await buildTaggedPageBlocks([h1], ctx);
    expect(blocks).toEqual([]);
    expect(ctx.warnings.some((w) => w.message.includes("had no decodable text"))).toBe(true);
  });

  it("approximates a generic /H heading as level 2 with a warning", async () => {
    const fragments = new Map([[0, [frag({ text: "Generic", mcid: 0 })]]]);
    const ctx = makeContext(fragments);
    const h = node({ role: "H", entries: [mcidEntry(0)] });
    const [block] = await buildTaggedPageBlocks([h], ctx);
    expect((block as HeadingBlock).level).toBe(2);
    expect(ctx.warnings.some((w) => w.message.includes("approximated as level 2"))).toBe(true);
  });

  it("emits identical heading text with deterministic structural ids", async () => {
    const fragments = new Map([
      [0, [frag({ text: "Overview", mcid: 0 })]],
      [1, [frag({ text: "Overview", mcid: 1 })]],
    ]);
    const ctx = makeContext(fragments);
    const nodes = [node({ role: "H2", entries: [mcidEntry(0)] }), node({ role: "H2", entries: [mcidEntry(1)] })];
    const blocks = await buildTaggedPageBlocks(nodes, ctx);
    expect(blocks.map((b) => b.id)).toEqual(["h-1", "h-2"]);
  });
});

describe("paragraphs and containers", () => {
  it("joins multiple MCIDs on one P element using geometry", async () => {
    const fragments = new Map([
      [0, [frag({ text: "Hello", mcid: 0, x: 0, endX: 30 })]],
      [1, [frag({ text: "World", mcid: 1, x: 34, endX: 60 })]],
    ]);
    const ctx = makeContext(fragments);
    const p = node({ role: "P", entries: [mcidEntry(0), mcidEntry(1)] });
    const [block] = await buildTaggedPageBlocks([p], ctx);
    expect((block as ParagraphBlock).text.map((r) => r.text).join("")).toBe("Hello World");
  });

  it("flattens a container role (Div) into its content without a wrapper block", async () => {
    const fragments = new Map([[0, [frag({ text: "Inside a div", mcid: 0 })]]]);
    const ctx = makeContext(fragments);
    const div = node({ role: "Div", entries: [elementEntry(node({ role: "P", entries: [mcidEntry(0)] }))] });
    const blocks = await buildTaggedPageBlocks([div], ctx);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  it("flattens a nested block role found inside inline text and warns", async () => {
    const fragments = new Map([
      [0, [frag({ text: "Before ", mcid: 0 })]],
      [1, [frag({ text: "Nested heading", mcid: 1 })]],
    ]);
    const ctx = makeContext(fragments);
    const span = node({ role: "Span", entries: [elementEntry(node({ role: "H3", entries: [mcidEntry(1)] }))] });
    const p = node({ role: "P", entries: [mcidEntry(0), elementEntry(span)] });
    const blocks = await buildTaggedPageBlocks([p], ctx);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect((blocks[0] as ParagraphBlock).text.map((r) => r.text).join("")).toContain("Nested heading");
    expect(ctx.warnings.some((w) => w.message.includes("flattened to plain text"))).toBe(true);
  });

  it("splits distinct numbered paragraphs that a malformed tag groups into one P element", async () => {
    const fragments = new Map([
      [0, [frag({ text: "4. Turn-off Engine", mcid: 0, y: 20 })]],
      [1, [frag({ text: "5. Do Walk-Around Inspection", mcid: 1, y: 60 })]],
    ]);
    const ctx = makeContext(fragments);
    const p = node({ role: "P", entries: [mcidEntry(0), mcidEntry(1)] });
    const blocks = await buildTaggedPageBlocks([p], ctx);
    expect(blocks.map((block) => (block as ParagraphBlock).text[0].text)).toEqual([
      "4. Turn-off Engine",
      "5. Do Walk-Around Inspection",
    ]);
  });

  it("reconstructs a TOC item jointly across sibling MCIDs so split page-number digits stay together", async () => {
    const fragments = new Map([
      [0, [frag({ text: "Attachment 4", mcid: 0, x: 72, endX: 140, y: 20 })]],
      [1, [frag({ text: "3", mcid: 1, x: 526, endX: 532, y: 20 })]],
      [2, [frag({ text: "1", mcid: 2, x: 532, endX: 538, y: 20 })]],
    ]);
    const ctx = makeContext(fragments);
    const toci = node({
      role: "TOCI",
      entries: [elementEntry(node({ role: "Reference", entries: [mcidEntry(0), mcidEntry(1)] })), mcidEntry(2)],
    });
    const [block] = await buildTaggedPageBlocks([toci], ctx);
    expect((block as ParagraphBlock).text[0].text).toBe("Attachment 4 31");
  });
});

describe("links", () => {
  it("attaches a resolved link target to the wrapped text run", async () => {
    const fragments = new Map([[0, [frag({ text: "click here", mcid: 0 })]]]);
    const target: LinkTarget = { kind: "external", href: "https://example.com" };
    const ctx = makeContext(fragments, { resolveLinkForNode: async () => target });
    const p = node({ role: "P", entries: [elementEntry(node({ role: "Link", entries: [mcidEntry(0)] }))] });
    const [block] = await buildTaggedPageBlocks([p], ctx);
    const run = (block as ParagraphBlock).text.find((r) => r.text.includes("click here"));
    expect(run?.link).toEqual(target);
  });

  it("leaves text unlinked when the link target cannot be resolved", async () => {
    const fragments = new Map([[0, [frag({ text: "plain", mcid: 0 })]]]);
    const ctx = makeContext(fragments, { resolveLinkForNode: async () => undefined });
    const p = node({ role: "P", entries: [elementEntry(node({ role: "Link", entries: [mcidEntry(0)] }))] });
    const [block] = await buildTaggedPageBlocks([p], ctx);
    expect((block as ParagraphBlock).text.every((r) => r.link === undefined)).toBe(true);
  });
});

describe("lists", () => {
  // `_labelText`/`_bodyText` document what each mcid's fragment text is at call sites; the fragments map (built separately per test) is what actually drives the text.
  function labeledLi(mcidLabel: number, _labelText: string, mcidBody: number, _bodyText: string): PageStructureNode {
    return node({
      role: "LI",
      entries: [
        elementEntry(node({ role: "Lbl", entries: [mcidEntry(mcidLabel)] })),
        elementEntry(node({ role: "LBody", entries: [elementEntry(node({ role: "P", entries: [mcidEntry(mcidBody)] }))] })),
      ],
    });
  }

  it("prepends the label to the item body and preserves item structure", async () => {
    const fragments = new Map([
      [0, [frag({ text: "1.", mcid: 0 })]],
      [1, [frag({ text: "First item", mcid: 1 })]],
    ]);
    const ctx = makeContext(fragments);
    const list = node({ role: "L", entries: [elementEntry(labeledLi(0, "1.", 1, "First item"))] });
    const [block] = await buildTaggedPageBlocks([list], ctx);
    const listBlock = block as ListBlock;
    expect(listBlock.items).toHaveLength(1);
    const [item] = listBlock.items;
    expect(item.blocks).toHaveLength(1);
    expect((item.blocks[0] as ParagraphBlock).text.map((r) => r.text).join("")).toBe("1. First item");
  });

  it("detects an ordered list from a numeric/lettered label pattern", async () => {
    const fragments = new Map([
      [0, [frag({ text: "1.", mcid: 0 })]],
      [1, [frag({ text: "Item one", mcid: 1 })]],
    ]);
    const ctx = makeContext(fragments);
    const list = node({ role: "L", entries: [elementEntry(labeledLi(0, "1.", 1, "Item one"))] });
    const [block] = await buildTaggedPageBlocks([list], ctx);
    expect((block as ListBlock).ordered).toBe(true);
  });

  it("treats a bullet-glyph label as unordered", async () => {
    const fragments = new Map([
      [0, [frag({ text: "•", mcid: 0 })]],
      [1, [frag({ text: "Bulleted item", mcid: 1 })]],
    ]);
    const ctx = makeContext(fragments);
    const list = node({ role: "L", entries: [elementEntry(labeledLi(0, "•", 1, "Bulleted item"))] });
    const [block] = await buildTaggedPageBlocks([list], ctx);
    expect((block as ListBlock).ordered).toBe(false);
  });

  it("preserves nested list structure inside a list item's body", async () => {
    const fragments = new Map([
      [0, [frag({ text: "Outer", mcid: 0 })]],
      [1, [frag({ text: "1.", mcid: 1 })]],
      [2, [frag({ text: "Inner", mcid: 2 })]],
    ]);
    const ctx = makeContext(fragments);
    const innerList = node({ role: "L", entries: [elementEntry(labeledLi(1, "1.", 2, "Inner"))] });
    const outerLi = node({
      role: "LI",
      entries: [elementEntry(node({ role: "LBody", entries: [mcidEntry(0), elementEntry(innerList)] }))],
    });
    const outerList = node({ role: "L", entries: [elementEntry(outerLi)] });
    const [block] = await buildTaggedPageBlocks([outerList], ctx);
    const outerListBlock = block as ListBlock;
    expect(outerListBlock.items[0].blocks.map((b) => b.type)).toEqual(["paragraph", "list"]);
  });

  it("removes a leading literal lowercase o marker from an unlabeled tagged LI body", async () => {
    const fragments = new Map([[0, [frag({ text: "o Nested item", mcid: 0 })]]]);
    const ctx = makeContext(fragments);
    const li = node({
      role: "LI",
      entries: [elementEntry(node({ role: "LBody", entries: [elementEntry(node({ role: "P", entries: [mcidEntry(0)] }))] }))],
    });
    const list = node({ role: "L", entries: [elementEntry(li)] });
    const [block] = await buildTaggedPageBlocks([list], ctx);

    const paragraph = (block as ListBlock).items[0].blocks[0] as ParagraphBlock;
    expect(paragraph.text.map((run) => run.text).join("")).toBe("Nested item");
  });

  it("preserves a leading lowercase o when the tagged LI has an explicit label", async () => {
    const fragments = new Map([
      [0, [frag({ text: "\u2022", mcid: 0 })]],
      [1, [frag({ text: "o Ordinary word", mcid: 1 })]],
    ]);
    const ctx = makeContext(fragments);
    const list = node({ role: "L", entries: [elementEntry(labeledLi(0, "\u2022", 1, "o Ordinary word"))] });
    const [block] = await buildTaggedPageBlocks([list], ctx);

    const paragraph = (block as ListBlock).items[0].blocks[0] as ParagraphBlock;
    expect(paragraph.text.map((run) => run.text).join("")).toBe("\u2022 o Ordinary word");
  });

  it("does not remove a leading lowercase o from ordinary prose outside a tagged list item", async () => {
    const fragments = new Map([[0, [frag({ text: "o Ordinary prose", mcid: 0 })]]]);
    const ctx = makeContext(fragments);
    const p = node({ role: "P", entries: [mcidEntry(0)] });
    const [block] = await buildTaggedPageBlocks([p], ctx);

    expect((block as ParagraphBlock).text.map((run) => run.text).join("")).toBe("o Ordinary prose");
  });

  it("collapses Word-style nested singleton section numbering while retaining its visible label", async () => {
    const fragments = new Map([[0, [frag({ text: "1.2.3.", mcid: 0 })]], [1, [frag({ text: "Numbered paragraph", mcid: 1 })]]]);
    const ctx = makeContext(fragments);
    const inner = node({ role: "L", entries: [elementEntry(labeledLi(0, "1.2.3.", 1, "Numbered paragraph"))] });
    const outer = node({
      role: "L",
      entries: [elementEntry(node({ role: "LI", entries: [elementEntry(node({ role: "LBody", entries: [elementEntry(inner)] }))] }))],
    });
    const [block] = await buildTaggedPageBlocks([outer], ctx);
    expect(block.type).toBe("paragraph");
    expect((block as ParagraphBlock).text.map((run) => run.text).join("")).toBe("1.2.3. Numbered paragraph");
  });
});

describe("tables", () => {
  it("preserves rows, header vs data cells, and declared spans", async () => {
    const fragments = new Map([
      [0, [frag({ text: "Name", mcid: 0 })]],
      [1, [frag({ text: "Age", mcid: 1 })]],
      [2, [frag({ text: "Ann", mcid: 2 })]],
      [3, [frag({ text: "34", mcid: 3 })]],
    ]);
    const ctx = makeContext(fragments);
    const headerRow = node({
      role: "TR",
      entries: [
        elementEntry(node({ role: "TH", entries: [mcidEntry(0)] })),
        elementEntry(node({ role: "TH", entries: [mcidEntry(1)], colSpan: 2 })),
      ],
    });
    const dataRow = node({
      role: "TR",
      entries: [elementEntry(node({ role: "TD", entries: [mcidEntry(2)] })), elementEntry(node({ role: "TD", entries: [mcidEntry(3)] }))],
    });
    const thead = node({ role: "THead", entries: [elementEntry(headerRow)] });
    const tbody = node({ role: "TBody", entries: [elementEntry(dataRow)] });
    const table = node({ role: "Table", entries: [elementEntry(thead), elementEntry(tbody)] });

    const [block] = await buildTaggedPageBlocks([table], ctx);
    const tableBlock = block as TableBlock;
    expect(tableBlock.rows).toHaveLength(2);
    expect(tableBlock.rows[0].cells.map((c) => c.isHeader)).toEqual([true, true]);
    expect(tableBlock.rows[0].cells[1].colSpan).toBe(2);
    expect(tableBlock.rows[1].cells.map((c) => c.isHeader)).toEqual([false, false]);
    expect((tableBlock.rows[1].cells[0].blocks[0] as ParagraphBlock).text[0].text).toBe("Ann");
  });

  it("skips and warns on a non-TR/TH/TD child instead of failing the whole table", async () => {
    const fragments = new Map([[0, [frag({ text: "cell", mcid: 0 })]]]);
    const ctx = makeContext(fragments);
    const badRow = node({ role: "TR", entries: [elementEntry(node({ role: "P", entries: [mcidEntry(0)] }))] });
    const table = node({ role: "Table", entries: [elementEntry(badRow)] });
    const [block] = await buildTaggedPageBlocks([table], ctx);
    expect((block as TableBlock).rows[0].cells).toHaveLength(0);
    expect(ctx.warnings.some((w) => w.message.includes("non-TH/TD"))).toBe(true);
  });
});

describe("figures", () => {
  it("matches a figure to a placed XObject by shared MCID and preserves alt text and caption", async () => {
    const fragments = new Map([[1, [frag({ text: "Figure 1. A chart.", mcid: 1 })]]]);
    const xobjectsByMcid = new Map([[0, [{ name: "Im0" }]]]);
    const ctx = makeContext(fragments, { xobjectsByMcid });
    const figure = node({
      role: "Figure",
      alt: "A bar chart",
      entries: [mcidEntry(0), elementEntry(node({ role: "Caption", entries: [mcidEntry(1)] }))],
    });
    const [block] = await buildTaggedPageBlocks([figure], ctx);
    const figureBlock = block as FigureBlock;
    expect(figureBlock.imageId).toBe("p1-xobj-Im0");
    expect(figureBlock.altText).toBe("A bar chart");
    expect(figureBlock.caption?.map((r) => r.text).join("")).toBe("Figure 1. A chart.");
  });

  it("falls back to a placeholder image id with an unsupported-image warning when no XObject matches", async () => {
    const ctx = makeContext(new Map());
    const figure = node({ role: "Figure", entries: [] });
    const [block] = await buildTaggedPageBlocks([figure], ctx);
    const figureBlock = block as FigureBlock;
    expect(figureBlock.imageId).toMatch(/^fig-placeholder/);
    expect(ctx.warnings.some((w) => w.code === "unsupported-image")).toBe(true);
  });
});

describe("geometry fallback (untagged pages)", () => {
  it("guesses a heading from a standalone large-font line and builds paragraphs for the rest", () => {
    const ctx = makeContext(new Map());
    const fragments: NormalizedFragment[] = [
      frag({ text: "Big Title", x: 0, endX: 60, y: 20, fontSize: 24 }),
      frag({ text: "Body text line one.", x: 0, endX: 100, y: 50, fontSize: 12 }),
      frag({ text: "Body text line two.", x: 0, endX: 100, y: 64, fontSize: 12 }),
    ];
    const blocks = buildGeometryFallbackBlocks(fragments, ctx);
    expect(blocks[0].type).toBe("heading");
    expect((blocks[0] as HeadingBlock).level).toBe(1);
    expect(blocks[1].type).toBe("paragraph");
    expect(ctx.warnings.some((w) => w.code === "ambiguous-reading-order")).toBe(true);
  });

  it("does not misclassify a normal single-line paragraph as a heading", () => {
    const ctx = makeContext(new Map());
    const fragments: NormalizedFragment[] = [
      frag({ text: "Just one normal line.", x: 0, endX: 90, y: 50, fontSize: 12 }),
    ];
    const blocks = buildGeometryFallbackBlocks(fragments, ctx);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });
});

describe("IdGenerator / slugify", () => {
  it("slugifies to lowercase, hyphenated, ASCII-only text", () => {
    expect(slugify("Section 3: Overview & Scope")).toBe("section-3-overview-scope");
  });

  it("normalizes empty or malformed seeds deterministically with a bare-prefix + suffix scheme", () => {
    const ids = new IdGenerator();
    expect(ids.next("p", "!!!")).toBe("p-1");
    expect(ids.next("p", "???")).toBe("p-2");
    expect(ids.next("p")).toBe("p-3");
  });

  it("does not change ids when text changes at the same structural position", () => {
    const idsA = new IdGenerator();
    const idsB = new IdGenerator();
    expect([idsA.next("h", "Before"), idsA.next("p", "Old text"), idsA.next("p", "After")]).toEqual([
      idsB.next("h", "Before"),
      idsB.next("p", "Corrected text"),
      idsB.next("p", "After"),
    ]);
  });
});
