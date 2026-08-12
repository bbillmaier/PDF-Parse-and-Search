/**
 * Tagged-table block construction (TKT-013): walks a `Table` page-structure
 * node's `TR`/`TH`/`TD` (optionally grouped under `THead`/`TBody`/`TFoot`)
 * children into the public `TableBlock` model, preserving row/header/data
 * cell relationships and declared `/ColSpan`/`/RowSpan`. Split out from
 * `blocks.ts` per the design's folder layout; the two modules call back
 * into each other (`buildTableBlock` here needs general block-building for
 * cell contents, and `blocks.ts` needs `buildTableBlock` for the `Table`
 * role) — safe for a pair of modules that only export function
 * declarations, which ES modules resolve regardless of import order.
 */

import type { TableBlock, TableCell, TableRow } from "../types.ts";
import type { PageStructureEntry, PageStructureNode } from "./tagged.ts";
import { buildBlocksFromEntries, warn, type BlockBuildContext } from "./blocks.ts";

const ROW_CONTAINER_ROLES = new Set(["THead", "TBody", "TFoot"]);

async function buildTableCell(cellNode: PageStructureNode, ctx: BlockBuildContext, forceHeader: boolean): Promise<TableCell> {
  const blocks = await buildBlocksFromEntries(cellNode.entries, ctx);
  return {
    id: ctx.ids.next(forceHeader || cellNode.role === "TH" ? "th" : "td"),
    pageNumber: ctx.pageNumber,
    blocks,
    isHeader: forceHeader || cellNode.role === "TH",
    colSpan: cellNode.colSpan && cellNode.colSpan > 0 ? cellNode.colSpan : 1,
    rowSpan: cellNode.rowSpan && cellNode.rowSpan > 0 ? cellNode.rowSpan : 1,
  };
}

async function buildTableRow(rowNode: PageStructureNode, ctx: BlockBuildContext, forceHeader: boolean): Promise<TableRow> {
  const cells: TableCell[] = [];
  for (const entry of rowNode.entries) {
    if (entry.kind !== "element") continue;
    const cellNode = entry.node;
    if (cellNode.role !== "TH" && cellNode.role !== "TD") {
      warn(ctx, `Table row on page ${ctx.pageNumber} contains a non-TH/TD child (role ${cellNode.rawRole}); it was skipped.`);
      continue;
    }
    cells.push(await buildTableCell(cellNode, ctx, forceHeader));
  }
  return { cells };
}

async function buildRowsFromEntries(entries: PageStructureEntry[], ctx: BlockBuildContext, forceHeader: boolean): Promise<TableRow[]> {
  const rows: TableRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "element" && entry.node.role === "TR") {
      rows.push(await buildTableRow(entry.node, ctx, forceHeader));
    } else if (entry.kind === "element") {
      warn(ctx, `Table section on page ${ctx.pageNumber} contains a non-TR child (role ${entry.node.rawRole}); it was skipped.`);
    }
  }
  return rows;
}

export async function buildTableBlock(node: PageStructureNode, ctx: BlockBuildContext): Promise<TableBlock> {
  const rows: TableRow[] = [];
  for (const entry of node.entries) {
    if (entry.kind !== "element") continue;
    const child = entry.node;
    if (ROW_CONTAINER_ROLES.has(child.role)) {
      rows.push(...(await buildRowsFromEntries(child.entries, ctx, child.role === "THead")));
      continue;
    }
    if (child.role === "TR") {
      rows.push(await buildTableRow(child, ctx, false));
      continue;
    }
    warn(ctx, `Table on page ${ctx.pageNumber} contains a non-TR/THead/TBody/TFoot child (role ${child.rawRole}); it was skipped.`);
  }
  return { type: "table", id: ctx.ids.next("table"), pageNumber: ctx.pageNumber, rows };
}
