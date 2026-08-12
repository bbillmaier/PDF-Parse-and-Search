import { describe, expect, it } from "vitest";
import {
  narrowBlock,
  sampleBlocks,
  sampleFigureBlock,
  sampleHeadingBlock,
  sampleListBlock,
  sampleParagraphBlock,
  sampleTableBlock,
  sampleUnknownBlock,
} from "../../src/pdf-content-extractor/__typecheck__/block-union.fixture.ts";

describe("DocumentBlock union fixture", () => {
  it("constructs and narrows every block variant", () => {
    expect(sampleBlocks).toHaveLength(6);
    expect(narrowBlock(sampleHeadingBlock)).toBe("heading:1:Document title");
    expect(narrowBlock(sampleParagraphBlock)).toBe("paragraph:1");
    expect(narrowBlock(sampleListBlock)).toBe("list:false:1");
    expect(narrowBlock(sampleTableBlock)).toBe("table:1");
    expect(narrowBlock(sampleFigureBlock)).toBe("figure:img-1");
    expect(narrowBlock(sampleUnknownBlock)).toBe("unknown:Unrecognized structure role.");
  });

  it("covers every discriminant exactly once", () => {
    const discriminants = sampleBlocks.map((block) => block.type).sort();
    expect(discriminants).toEqual(["figure", "heading", "list", "paragraph", "table", "unknown"]);
  });
});
