/**
 * Tagged-structure resolution (TKT-012): parses `/StructTreeRoot`, its
 * `/RoleMap`, `/ParentTree`, and the `/K` structure-element tree, then maps
 * marked-content references (`/MCID` and `/OBJR`) to page numbers using the
 * already-traversed `PageDescriptor` list. The primary mechanism for
 * "which structure element owns this page's MCID N" is a depth-first walk
 * of `/K` (which also gives us structure order for free); `/ParentTree` is
 * additionally parsed per the ticket's scope and exposed for
 * `/StructParent`-based object lookups (e.g. an image XObject that declares
 * its own `/StructParent` instead of being wrapped in a marked-content
 * span) — TKT-013 may use it opportunistically for figure association.
 *
 * `/Artifact` is a content-stream marked-content tag, not a structure-tree
 * concept — TKT-009 already tags every fragment/XObject event with
 * `artifact: boolean`, and `partitionArtifacts` below is the single place
 * that filters on it, so exclusion behavior stays centralized.
 */

import type { ParseWarning, SafetyLimits } from "../types.ts";
import type { PdfDocument } from "../parser/document.ts";
import {
  dictGet,
  isArrayValue,
  isDict,
  isName,
  isPdfString,
  isRef,
  type PdfDict,
  type PdfRef,
  type PdfValue,
} from "../parser/objects.ts";
import { PDF_DOC_ENCODING } from "../fonts/encodings.ts";

// ---------------------------------------------------------------------------
// PDF text strings (spec 7.9.2.2) — shared with TKT-013's outline titles.
// ---------------------------------------------------------------------------

/** Decodes a PDF "text string": UTF-16BE with a BOM, or PDFDocEncoding otherwise. */
export function decodePdfTextString(bytes: Uint8Array): string {
  let out = "";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const end = bytes.length - ((bytes.length - 2) % 2);
    for (let i = 2; i < end; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return removeTrailingNuls(out);
  }
  for (const b of bytes) out += PDF_DOC_ENCODING[b] ?? String.fromCharCode(b);
  return removeTrailingNuls(out);
}

function removeTrailingNuls(text: string): string {
  return text.replace(/\u0000+$/g, "");
}

// ---------------------------------------------------------------------------
// Standard structure roles
// ---------------------------------------------------------------------------

/** Standard Tagged-PDF structure types (ISO 32000-1 14.8.4) relevant to this library's target document family. */
export const STANDARD_STRUCTURE_ROLES: ReadonlySet<string> = new Set([
  "Document",
  "Part",
  "Art",
  "Sect",
  "Div",
  "BlockQuote",
  "Caption",
  "TOC",
  "TOCI",
  "Index",
  "NonStruct",
  "Private",
  "P",
  "H",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "L",
  "LI",
  "Lbl",
  "LBody",
  "Table",
  "TR",
  "TH",
  "TD",
  "THead",
  "TBody",
  "TFoot",
  "Span",
  "Quote",
  "Note",
  "Reference",
  "BibEntry",
  "Code",
  "Link",
  "Annot",
  "Figure",
  "Formula",
  "Form",
]);

export function isKnownStructureRole(role: string): boolean {
  return STANDARD_STRUCTURE_ROLES.has(role);
}

// ---------------------------------------------------------------------------
// Structure tree model
// ---------------------------------------------------------------------------

export interface StructElement {
  role: string;
  rawRole: string;
  alt: string | undefined;
  actualText: string | undefined;
  lang: string | undefined;
  title: string | undefined;
  /** From the standard `/A` table attributes (spec 14.8.5.7), when declared on a `TH`/`TD` element. */
  colSpan: number | undefined;
  rowSpan: number | undefined;
  kids: StructKid[];
}

export type StructKid =
  | { kind: "element"; element: StructElement }
  | { kind: "mcid"; pageNumber: number; mcid: number }
  | { kind: "objr"; pageNumber: number; objRef: PdfRef | undefined };

export interface StructTree {
  roots: StructElement[];
  /** Flattened `/ParentTree` number tree: key -> raw value (a single struct-elem ref for a `/StructParent` object, or an array of refs for a page's `/StructParents`). */
  parentTree: Map<number, PdfValue>;
  warnings: ParseWarning[];
}

function refKeyOf(ref: PdfRef): string {
  return `${ref.num}:${ref.gen}`;
}

function textStringOf(value: PdfValue): string | undefined {
  return isPdfString(value) ? decodePdfTextString(value.bytes) : undefined;
}

function normalizeKidsList(value: PdfValue): PdfValue[] {
  if (isArrayValue(value)) return value.items;
  if (value === null || value === undefined) return [];
  return [value];
}

async function resolveRoleMap(doc: PdfDocument, structRoot: PdfValue): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!isDict(structRoot)) return map;
  const roleMapVal = await doc.resolve(dictGet(structRoot, "RoleMap"));
  if (!isDict(roleMapVal)) return map;
  for (const [key, value] of roleMapVal.map) {
    const resolved = await doc.resolve(value);
    if (isName(resolved)) map.set(key, resolved.name);
  }
  return map;
}

function resolveRole(rawRole: string, roleMap: Map<string, string>): string {
  let current = rawRole;
  const seen = new Set<string>();
  while (roleMap.has(current) && !seen.has(current)) {
    seen.add(current);
    current = roleMap.get(current)!;
  }
  return current;
}

function resolvePageNumber(
  ref: PdfRef | undefined,
  pageRefToNumber: Map<string, number>,
  warnings: ParseWarning[],
): number | undefined {
  if (!ref) return undefined;
  const pageNumber = pageRefToNumber.get(refKeyOf(ref));
  if (pageNumber === undefined) {
    warnings.push({
      code: "structure-inconsistency",
      message: `A structure-tree /Pg reference (object ${ref.num}) does not resolve to a page in this document; content skipped.`,
    });
  }
  return pageNumber;
}

async function resolveSpanAttributes(
  doc: PdfDocument,
  node: PdfDict,
): Promise<{ colSpan: number | undefined; rowSpan: number | undefined }> {
  const aVal = await doc.resolve(dictGet(node, "A"));
  const dicts: PdfDict[] = [];
  if (isDict(aVal)) dicts.push(aVal);
  else if (isArrayValue(aVal)) {
    for (const item of aVal.items) {
      const resolved = await doc.resolve(item);
      if (isDict(resolved)) dicts.push(resolved);
    }
  }
  let colSpan: number | undefined;
  let rowSpan: number | undefined;
  for (const dict of dicts) {
    const c = await doc.resolve(dictGet(dict, "ColSpan"));
    const r = await doc.resolve(dictGet(dict, "RowSpan"));
    if (typeof c === "number") colSpan = c;
    if (typeof r === "number") rowSpan = r;
  }
  return { colSpan, rowSpan };
}

async function buildElement(
  doc: PdfDocument,
  kidValue: PdfValue,
  inheritedPageRef: PdfRef | undefined,
  roleMap: Map<string, string>,
  pageRefToNumber: Map<string, number>,
  warnings: ParseWarning[],
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<StructElement | undefined> {
  if (depth > maxDepth) {
    warnings.push({ code: "limit-exceeded-locally", message: "Structure-tree depth exceeded the configured limit; subtree skipped." });
    return undefined;
  }
  if (isRef(kidValue)) {
    const key = refKeyOf(kidValue);
    if (visited.has(key)) {
      warnings.push({ code: "structure-inconsistency", message: `Structure-tree cycle detected at object ${kidValue.num}; subtree skipped.` });
      return undefined;
    }
    visited.add(key);
  }

  const node = await doc.resolve(kidValue);
  if (!isDict(node)) {
    warnings.push({ code: "structure-inconsistency", message: "Skipped a structure-tree element that did not resolve to a dictionary." });
    return undefined;
  }

  const sVal = await doc.resolve(dictGet(node, "S"));
  const rawRole = isName(sVal) ? sVal.name : "";
  if (!rawRole) {
    warnings.push({ code: "structure-inconsistency", message: "A structure element is missing a valid /S role name; treated as Unknown." });
  }
  const role = resolveRole(rawRole || "Unknown", roleMap);

  const ownPgVal = dictGet(node, "Pg");
  const elementPageRef = isRef(ownPgVal) ? ownPgVal : inheritedPageRef;

  const kidsRaw = normalizeKidsList(await doc.resolve(dictGet(node, "K")));
  const seenMcids = new Set<number>();
  const kids: StructKid[] = [];

  for (let i = 0; i < kidsRaw.length; i += 1) {
    if (i % 64 === 0) await doc.runtime.checkpoint("structure-tree kids");
    const child = kidsRaw[i];
    if (typeof child === "number") {
      const pageNumber = resolvePageNumber(elementPageRef, pageRefToNumber, warnings);
      if (pageNumber === undefined) continue;
      if (seenMcids.has(child)) {
        warnings.push({ code: "structure-inconsistency", message: `Duplicate MCID ${child} within one structure element; kept the first occurrence.`, pageNumber });
        continue;
      }
      seenMcids.add(child);
      kids.push({ kind: "mcid", pageNumber, mcid: child });
      continue;
    }

    const resolvedChild = await doc.resolve(child);
    if (!isDict(resolvedChild)) {
      warnings.push({ code: "structure-inconsistency", message: "Skipped an unrecognized structure-tree kid value." });
      continue;
    }

    const typeVal = await doc.resolve(dictGet(resolvedChild, "Type"));
    const typeName = isName(typeVal) ? typeVal.name : undefined;

    if (typeName === "MCR") {
      const mcidVal = await doc.resolve(dictGet(resolvedChild, "MCID"));
      const pgVal = dictGet(resolvedChild, "Pg");
      const pageNumber = resolvePageNumber(isRef(pgVal) ? pgVal : elementPageRef, pageRefToNumber, warnings);
      if (typeof mcidVal !== "number" || pageNumber === undefined) {
        warnings.push({ code: "structure-inconsistency", message: "Skipped an invalid marked-content reference (missing /MCID or unresolved /Pg)." });
        continue;
      }
      if (seenMcids.has(mcidVal)) {
        warnings.push({ code: "structure-inconsistency", message: `Duplicate MCID ${mcidVal} within one structure element; kept the first occurrence.`, pageNumber });
        continue;
      }
      seenMcids.add(mcidVal);
      kids.push({ kind: "mcid", pageNumber, mcid: mcidVal });
      continue;
    }

    if (typeName === "OBJR") {
      const objVal = dictGet(resolvedChild, "Obj");
      const pgVal = dictGet(resolvedChild, "Pg");
      const pageNumber = resolvePageNumber(isRef(pgVal) ? pgVal : elementPageRef, pageRefToNumber, warnings);
      if (pageNumber === undefined) continue;
      kids.push({ kind: "objr", pageNumber, objRef: isRef(objVal) ? objVal : undefined });
      continue;
    }

    const builtChild = await buildElement(doc, child, elementPageRef, roleMap, pageRefToNumber, warnings, visited, depth + 1, maxDepth);
    if (builtChild) kids.push({ kind: "element", element: builtChild });
  }

  const { colSpan, rowSpan } = await resolveSpanAttributes(doc, node);

  return {
    role,
    rawRole: rawRole || "Unknown",
    alt: textStringOf(await doc.resolve(dictGet(node, "Alt"))),
    actualText: textStringOf(await doc.resolve(dictGet(node, "ActualText"))),
    lang: textStringOf(await doc.resolve(dictGet(node, "Lang"))),
    title: textStringOf(await doc.resolve(dictGet(node, "T"))),
    colSpan,
    rowSpan,
    kids,
  };
}

async function parseNumberTree(
  doc: PdfDocument,
  nodeValue: PdfValue | undefined,
  maxDepth: number,
  depth = 0,
  visited: Set<string> = new Set(),
): Promise<Map<number, PdfValue>> {
  const result = new Map<number, PdfValue>();
  if (depth > maxDepth) return result;
  const node = await doc.resolve(nodeValue);
  if (!isDict(node)) return result;

  const numsVal = await doc.resolve(dictGet(node, "Nums"));
  if (isArrayValue(numsVal)) {
    for (let i = 0; i + 1 < numsVal.items.length; i += 2) {
      if (i % 128 === 0) await doc.runtime.checkpoint("parent-tree /Nums parsing");
      const keyVal = await doc.resolve(numsVal.items[i]);
      if (typeof keyVal === "number") result.set(keyVal, numsVal.items[i + 1]);
    }
  }

  const kidsVal = await doc.resolve(dictGet(node, "Kids"));
  if (isArrayValue(kidsVal)) {
    for (let i = 0; i < kidsVal.items.length; i += 1) {
      if (i % 64 === 0) await doc.runtime.checkpoint("parent-tree /Kids parsing");
      const kid = kidsVal.items[i];
      if (isRef(kid)) {
        const key = refKeyOf(kid);
        if (visited.has(key)) continue;
        visited.add(key);
      }
      const sub = await parseNumberTree(doc, kid, maxDepth, depth + 1, visited);
      for (const [k, v] of sub) result.set(k, v);
    }
  }
  return result;
}

/**
 * Parses the document's structure tree. Returns `undefined` for an
 * untagged document (no `/StructTreeRoot`), which is the signal callers use
 * to route every page through TKT-011's geometry fallback.
 */
export async function parseStructTree(
  doc: PdfDocument,
  pageRefToNumber: Map<string, number>,
  limits: Pick<SafetyLimits, "maxReferenceDepth"> = doc.limits,
): Promise<StructTree | undefined> {
  const rootVal = doc.trailer.get("Root");
  const catalog = await doc.resolve(rootVal);
  if (!isDict(catalog)) return undefined;

  const structRootVal = await doc.resolve(dictGet(catalog, "StructTreeRoot"));
  if (!isDict(structRootVal)) return undefined;

  const warnings: ParseWarning[] = [];
  const roleMap = await resolveRoleMap(doc, structRootVal);
  const parentTree = await parseNumberTree(doc, dictGet(structRootVal, "ParentTree"), limits.maxReferenceDepth);

  const topKids = normalizeKidsList(await doc.resolve(dictGet(structRootVal, "K")));
  const visited = new Set<string>();
  const roots: StructElement[] = [];
  for (let i = 0; i < topKids.length; i += 1) {
    if (i % 32 === 0) await doc.runtime.checkpoint("structure-tree root parsing");
    const kid = topKids[i];
    const built = await buildElement(doc, kid, undefined, roleMap, pageRefToNumber, warnings, visited, 0, limits.maxReferenceDepth);
    if (built) roots.push(built);
  }

  return { roots, parentTree, warnings };
}

/** Resolves a single object's own `/StructParent` index (e.g. an image XObject) to its owning structure element, when the document used that association style instead of MCID/OBJR wrapping. */
export function resolveElementForStructParent(tree: StructTree, structParentIndex: number): PdfRef | undefined {
  const value = tree.parentTree.get(structParentIndex);
  return isRef(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Per-page structure view
// ---------------------------------------------------------------------------

export interface PageStructureNode {
  role: string;
  rawRole: string;
  alt: string | undefined;
  actualText: string | undefined;
  lang: string | undefined;
  title: string | undefined;
  colSpan: number | undefined;
  rowSpan: number | undefined;
  entries: PageStructureEntry[];
}

export type PageStructureEntry =
  | { kind: "element"; node: PageStructureNode }
  | { kind: "mcid"; mcid: number }
  | { kind: "objRef"; ref: PdfRef | undefined };

function buildPageNode(element: StructElement, pageNumber: number, claimed: Set<number>, warnings: ParseWarning[]): PageStructureNode | undefined {
  const entries: PageStructureEntry[] = [];
  for (const kid of element.kids) {
    if (kid.kind === "mcid") {
      if (kid.pageNumber !== pageNumber) continue;
      if (claimed.has(kid.mcid)) {
        warnings.push({ code: "structure-inconsistency", message: `MCID ${kid.mcid} is claimed by more than one structure element on page ${pageNumber}; kept the first.`, pageNumber });
        continue;
      }
      claimed.add(kid.mcid);
      entries.push({ kind: "mcid", mcid: kid.mcid });
      continue;
    }
    if (kid.kind === "objr") {
      if (kid.pageNumber !== pageNumber) continue;
      entries.push({ kind: "objRef", ref: kid.objRef });
      continue;
    }
    const child = buildPageNode(kid.element, pageNumber, claimed, warnings);
    if (child) entries.push({ kind: "element", node: child });
  }
  if (entries.length === 0) return undefined;
  return {
    role: element.role,
    rawRole: element.rawRole,
    alt: element.alt,
    actualText: element.actualText,
    lang: element.lang,
    title: element.title,
    colSpan: element.colSpan,
    rowSpan: element.rowSpan,
    entries,
  };
}

export interface TaggedPageResolution {
  /** Top-level structure nodes touching this page, in structure order, pruned to this page's content. */
  nodes: PageStructureNode[];
  /** False when the structure tree exists but claims none of this page's MCIDs — the caller's signal to use the geometry fallback for the whole page. */
  isTagged: boolean;
  /** MCIDs observed in this page's content that no structure element claims. */
  orphanedMcids: Set<number>;
  warnings: ParseWarning[];
}

/**
 * Produces the page-local slice of the structure tree: which structure
 * elements touch `pageNumber`, pruned to their entries on this page, in
 * document structure order. `pageMcids` is every MCID actually observed in
 * this page's extracted content (from TKT-009/010 fragment and XObject
 * events) — used to flag orphaned/invalid MCID references without
 * discarding the underlying content.
 */
export function resolvePageStructure(
  tree: StructTree | undefined,
  pageNumber: number,
  pageMcids: Iterable<number>,
): TaggedPageResolution {
  const warnings: ParseWarning[] = [];
  if (!tree) {
    return { nodes: [], isTagged: false, orphanedMcids: new Set(pageMcids), warnings };
  }

  const claimed = new Set<number>();
  const nodes: PageStructureNode[] = [];
  for (const root of tree.roots) {
    const node = buildPageNode(root, pageNumber, claimed, warnings);
    if (node) nodes.push(node);
  }

  const orphanedMcids = new Set<number>();
  for (const mcid of pageMcids) {
    if (!claimed.has(mcid)) orphanedMcids.add(mcid);
  }
  for (const mcid of orphanedMcids) {
    warnings.push({
      code: "structure-inconsistency",
      message: `MCID ${mcid} on page ${pageNumber} is not claimed by any structure element; its content is retained but unstructured.`,
      pageNumber,
    });
  }

  return { nodes, isTagged: nodes.length > 0, orphanedMcids, warnings };
}

// ---------------------------------------------------------------------------
// Artifact exclusion
// ---------------------------------------------------------------------------

export function partitionArtifacts<T extends { artifact: boolean }>(items: T[]): { content: T[]; artifacts: T[] } {
  const content: T[] = [];
  const artifacts: T[] = [];
  for (const item of items) (item.artifact ? artifacts : content).push(item);
  return { content, artifacts };
}
