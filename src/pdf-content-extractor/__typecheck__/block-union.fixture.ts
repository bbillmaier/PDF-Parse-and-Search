/**
 * Compile-time usage fixture for `DocumentBlock` (TKT-001).
 *
 * `narrowBlock`'s `switch` has no `default` case, so if a new member is ever
 * added to the `DocumentBlock` union without updating this function, the
 * `assertNever` branch below fails to compile — that is the intended
 * exhaustiveness check. `tsc -b` (the project's existing type-check command)
 * verifies this file on every run because it lives under `src/`.
 */

import type {
  DocumentBlock,
  FigureBlock,
  HeadingBlock,
  ListBlock,
  ParagraphBlock,
  TableBlock,
  UnknownBlock,
} from "../types.ts";

function assertNever(value: never): never {
  throw new Error(`Unhandled DocumentBlock variant: ${JSON.stringify(value)}`);
}

export function narrowBlock(block: DocumentBlock): string {
  switch (block.type) {
    case "heading":
      return `heading:${block.level}:${block.text.map((run) => run.text).join("")}`;
    case "paragraph":
      return `paragraph:${block.text.length}`;
    case "list":
      return `list:${block.ordered}:${block.items.length}`;
    case "table":
      return `table:${block.rows.length}`;
    case "figure":
      return `figure:${block.imageId}`;
    case "unknown":
      return `unknown:${block.reason}`;
    default:
      return assertNever(block);
  }
}

export const sampleHeadingBlock: HeadingBlock = {
  type: "heading",
  id: "h1",
  pageNumber: 1,
  level: 1,
  text: [{ text: "Document title" }],
};

export const sampleParagraphBlock: ParagraphBlock = {
  type: "paragraph",
  id: "p1",
  pageNumber: 1,
  text: [{ text: "Reconstructed content." }],
};

export const sampleListBlock: ListBlock = {
  type: "list",
  id: "l1",
  pageNumber: 1,
  ordered: false,
  items: [{ id: "l1-i1", blocks: [sampleParagraphBlock] }],
};

export const sampleTableBlock: TableBlock = {
  type: "table",
  id: "t1",
  pageNumber: 1,
  rows: [
    {
      cells: [
        { id: "th1", pageNumber: 1, blocks: [sampleHeadingBlock], isHeader: true, colSpan: 1, rowSpan: 1 },
        { id: "td1", pageNumber: 1, blocks: [sampleParagraphBlock], isHeader: false, colSpan: 1, rowSpan: 1 },
      ],
    },
  ],
};

export const sampleFigureBlock: FigureBlock = {
  type: "figure",
  id: "f1",
  pageNumber: 1,
  imageId: "img-1",
  altText: "Example figure",
  caption: [{ text: "Figure 1." }],
};

export const sampleUnknownBlock: UnknownBlock = {
  type: "unknown",
  id: "u1",
  pageNumber: 1,
  reason: "Unrecognized structure role.",
};

export const sampleBlocks: DocumentBlock[] = [
  sampleHeadingBlock,
  sampleParagraphBlock,
  sampleListBlock,
  sampleTableBlock,
  sampleFigureBlock,
  sampleUnknownBlock,
];

export const narrowedSampleBlocks: string[] = sampleBlocks.map(narrowBlock);
