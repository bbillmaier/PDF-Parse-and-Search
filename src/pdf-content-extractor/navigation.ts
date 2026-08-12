import type { DocumentBlock, ParsedDocument, TableCell } from "./types.ts";

const SAFE_ID = /^[a-z][a-z0-9-]*$/;

export interface HtmlDestination {
  anchor: string;
}

export interface PdfPageDestination {
  pageNumber: number;
  fragment: string;
}

export function isSafeSemanticId(id: string): boolean {
  return SAFE_ID.test(id);
}

export function assertSafeSemanticId(id: string, label = "semantic id"): string {
  if (!isSafeSemanticId(id)) throw new Error(`Invalid ${label}: ${id}`);
  return id;
}

export function htmlDestinationForBlock(block: DocumentBlock | TableCell): HtmlDestination {
  return { anchor: `#${assertSafeSemanticId(block.id, "block id")}` };
}

export function pdfPageDestinationForPage(pageNumber: number): PdfPageDestination {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error(`Invalid PDF page number: ${pageNumber}`);
  return { pageNumber, fragment: `#page=${pageNumber}` };
}

export function collectSemanticIds(document: ParsedDocument): string[] {
  const ids: string[] = [];
  const visitBlock = (block: DocumentBlock): void => {
    ids.push(block.id);
    if (block.type === "list") {
      for (const item of block.items) {
        ids.push(item.id);
        for (const child of item.blocks) visitBlock(child);
      }
    } else if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          ids.push(cell.id);
          for (const child of cell.blocks) visitBlock(child);
        }
      }
    }
  };
  for (const page of document.pages) for (const block of page.blocks) visitBlock(block);
  return ids;
}
