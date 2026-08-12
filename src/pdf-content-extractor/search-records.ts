import type {
  DocumentBlock,
  DocumentSearchRecord,
  ParsedDocument,
  SearchableBlockType,
  TableBlock,
  TableCell,
  TextRun,
} from "./types.ts";
import { assertSafeSemanticId } from "./navigation.ts";

export interface GenerateSearchRecordsOptions {
  documentId?: string;
  documentTitle?: string;
}

function textFromRuns(runs: TextRun[] | undefined): string {
  return runs?.map((run) => run.text).join("").replace(/\s+/g, " ").trim() ?? "";
}

function textFromBlock(block: DocumentBlock): string {
  if (block.type === "heading" || block.type === "paragraph") return textFromRuns(block.text);
  if (block.type === "figure") return textFromRuns(block.caption);
  if (block.type === "list") return block.items.flatMap((item) => item.blocks.map(textFromBlock)).join(" ").replace(/\s+/g, " ").trim();
  if (block.type === "table") {
    return block.rows
      .flatMap((row) => row.cells.flatMap((cell) => cell.blocks.map(textFromBlock)))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function textFromCell(cell: TableCell): string {
  return cell.blocks.map(textFromBlock).join(" ").replace(/\s+/g, " ").trim();
}

function makeRecord(params: {
  documentId: string;
  documentTitle: string;
  sectionId: string;
  blockId: string;
  heading: string;
  headingPath: string[];
  pageNumber: number;
  blockType: SearchableBlockType;
  text: string;
  tableHeader?: string;
  rowHeader?: string;
}): DocumentSearchRecord | undefined {
  const text = params.text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return {
    documentId: assertSafeSemanticId(params.documentId, "document id"),
    documentTitle: params.documentTitle,
    sectionId: assertSafeSemanticId(params.sectionId, "section id"),
    blockId: assertSafeSemanticId(params.blockId, "block id"),
    heading: params.heading,
    headingPath: params.headingPath,
    pageNumber: params.pageNumber,
    blockType: params.blockType,
    text,
    ...(params.tableHeader ? { tableHeader: params.tableHeader } : {}),
    ...(params.rowHeader ? { rowHeader: params.rowHeader } : {}),
  };
}

function currentHeadingPath(stack: { level: number; text: string; id: string }[]): string[] {
  return stack.map((entry) => entry.text).filter(Boolean);
}

function currentSectionId(stack: { id: string }[], fallback: string): string {
  return stack.length > 0 ? stack[stack.length - 1].id : fallback;
}

function visitTable(
  table: TableBlock,
  base: Omit<DocumentSearchRecord, "blockId" | "blockType" | "text" | "pageNumber">,
  records: DocumentSearchRecord[],
): void {
  const columnHeaders = table.rows[0]?.cells.map(textFromCell) ?? [];
  for (const row of table.rows) {
    const rowHeader = row.cells.find((cell) => cell.isHeader);
    const rowHeaderText = rowHeader ? textFromCell(rowHeader) : "";
    row.cells.forEach((cell, columnIndex) => {
      const record = makeRecord({
        ...base,
        blockId: cell.id,
        pageNumber: cell.pageNumber,
        blockType: "table-cell",
        text: textFromCell(cell),
        tableHeader: columnHeaders[columnIndex],
        rowHeader: rowHeaderText && rowHeader !== cell ? rowHeaderText : undefined,
      });
      if (record) records.push(record);
    });
  }
}

export function generateDocumentSearchRecords(document: ParsedDocument, options: GenerateSearchRecordsOptions = {}): DocumentSearchRecord[] {
  const documentId = options.documentId ?? document.metadata.id;
  if (!documentId) throw new Error("A document id is required to generate search records.");
  // TKT-036: `metadata.title` is raw PDF evidence and may itself be
  // boilerplate or absent -- `displayTitle` (the selected library title) is
  // preferred whenever the caller does not pass an explicit title.
  const documentTitle = options.documentTitle ?? document.metadata.displayTitle ?? document.metadata.title ?? "Untitled document";
  const records: DocumentSearchRecord[] = [];
  const headingStack: { level: number; text: string; id: string }[] = [];

  const visitBlock = (block: DocumentBlock, fallbackSectionId: string): void => {
    if (block.type === "heading") {
      const headingText = textFromRuns(block.text);
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= block.level) headingStack.pop();
      headingStack.push({ level: block.level, text: headingText, id: block.sectionId ?? block.id });
      const record = makeRecord({
        documentId,
        documentTitle,
        sectionId: block.sectionId ?? block.id,
        blockId: block.id,
        heading: headingText,
        headingPath: currentHeadingPath(headingStack),
        pageNumber: block.pageNumber,
        blockType: "heading",
        text: headingText,
      });
      if (record) records.push(record);
      return;
    }

    const sectionId = block.sectionId ?? currentSectionId(headingStack, fallbackSectionId);
    const headingPath = currentHeadingPath(headingStack);
    const heading = headingPath[headingPath.length - 1] ?? "";
    if (block.type === "paragraph") {
      const record = makeRecord({ documentId, documentTitle, sectionId, blockId: block.id, heading, headingPath, pageNumber: block.pageNumber, blockType: "paragraph", text: textFromRuns(block.text) });
      if (record) records.push(record);
    } else if (block.type === "list") {
      for (const item of block.items) {
        const itemText = item.blocks.map(textFromBlock).join(" ").replace(/\s+/g, " ").trim();
        const record = makeRecord({ documentId, documentTitle, sectionId, blockId: item.id, heading, headingPath, pageNumber: block.pageNumber, blockType: "list-item", text: itemText });
        if (record) records.push(record);
        for (const child of item.blocks) if (child.type === "list") visitBlock(child, sectionId);
      }
    } else if (block.type === "table") {
      visitTable(block, { documentId, documentTitle, sectionId, heading, headingPath }, records);
    } else if (block.type === "figure") {
      const record = makeRecord({ documentId, documentTitle, sectionId, blockId: block.id, heading, headingPath, pageNumber: block.pageNumber, blockType: "figure-caption", text: textFromRuns(block.caption) });
      if (record) records.push(record);
    }
  };

  for (const page of document.pages) {
    const fallbackSectionId = `page-${page.pageNumber}`;
    for (const block of page.blocks) visitBlock(block, fallbackSectionId);
  }
  return records;
}
