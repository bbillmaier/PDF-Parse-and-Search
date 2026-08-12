/**
 * Document outline (bookmarks) and safe link-target resolution (TKT-013).
 * The `/Outlines` bookmark tree is independent of the tagged-structure
 * `/StructTreeRoot` walked by `structure/tagged.ts`; this module resolves
 * both it and the `/Dest`/`/A` targets used by in-text `Link` structure
 * elements, through the same destination/action logic so both surfaces
 * agree on what counts as a safe link.
 *
 * Only `GoTo` (internal) and `URI` actions with an allowlisted protocol
 * become a `LinkTarget`. Every other action type (`GoToR`, `Launch`,
 * `JavaScript`, `SubmitForm`, named actions, ...) resolves to `undefined` —
 * the text is preserved, it just never becomes an active public link. This
 * mirrors the design's non-goal of executing PDF actions/scripts.
 */

import type { LinkTarget, OutlineItem } from "../types.ts";
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
import { decodePdfTextString } from "./tagged.ts";

const SAFE_EXTERNAL_PROTOCOLS = ["http://", "https://", "mailto:"];

/** Allowlists external link protocols; returns `undefined` for anything else (e.g. `javascript:`, `data:`, `file:`). */
export function sanitizeExternalHref(href: string): string | undefined {
  const trimmed = href.trim();
  const lower = trimmed.toLowerCase();
  return SAFE_EXTERNAL_PROTOCOLS.some((protocol) => lower.startsWith(protocol)) ? trimmed : undefined;
}

function refKeyOf(ref: PdfRef): string {
  return `${ref.num}:${ref.gen}`;
}

// ---------------------------------------------------------------------------
// Named-destination (/Names /Dests) tree lookup
// ---------------------------------------------------------------------------

async function lookupNameTree(
  doc: PdfDocument,
  nodeValue: PdfValue | undefined,
  name: string,
  depth: number,
  visited: Set<string>,
): Promise<PdfValue | undefined> {
  if (depth > 64) return undefined;
  const node = await doc.resolve(nodeValue);
  if (!isDict(node)) return undefined;

  const namesVal = await doc.resolve(dictGet(node, "Names"));
  if (isArrayValue(namesVal)) {
    for (let i = 0; i + 1 < namesVal.items.length; i += 2) {
      const keyVal = await doc.resolve(namesVal.items[i]);
      const key = isPdfString(keyVal) ? decodePdfTextString(keyVal.bytes) : isName(keyVal) ? keyVal.name : undefined;
      if (key === name) return namesVal.items[i + 1];
    }
    return undefined;
  }

  const kidsVal = await doc.resolve(dictGet(node, "Kids"));
  if (isArrayValue(kidsVal)) {
    for (const kid of kidsVal.items) {
      if (isRef(kid)) {
        const key = refKeyOf(kid);
        if (visited.has(key)) continue;
        visited.add(key);
      }
      const found = await lookupNameTree(doc, kid, name, depth + 1, visited);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Destinations and actions
// ---------------------------------------------------------------------------

/** Resolves a `/Dest` value (an explicit `[pageRef ...]` array, or a name/string looked up in `/Names /Dests`) to an internal `LinkTarget`. */
export async function resolveDestination(
  doc: PdfDocument,
  destValue: PdfValue | undefined,
  pageRefToNumber: Map<string, number>,
  namedDestsRoot: PdfValue | undefined,
  depth = 0,
): Promise<LinkTarget | undefined> {
  if (depth > 8 || destValue === undefined) return undefined;
  let resolved = await doc.resolve(destValue);

  if (isDict(resolved)) {
    resolved = await doc.resolve(dictGet(resolved, "D"));
  }

  if (isPdfString(resolved) || isName(resolved)) {
    const name = isPdfString(resolved) ? decodePdfTextString(resolved.bytes) : resolved.name;
    const looked = await lookupNameTree(doc, namedDestsRoot, name, 0, new Set());
    if (looked === undefined) return undefined;
    return resolveDestination(doc, looked, pageRefToNumber, namedDestsRoot, depth + 1);
  }

  if (isArrayValue(resolved) && resolved.items.length > 0) {
    const first = resolved.items[0];
    if (isRef(first)) {
      const pageNumber = pageRefToNumber.get(refKeyOf(first));
      if (pageNumber !== undefined) return { kind: "internal", pageNumber };
    } else if (typeof first === "number" && Number.isInteger(first) && first >= 0) {
      return { kind: "internal", pageNumber: first + 1 };
    }
  }
  return undefined;
}

/** Resolves an `/A` action dictionary to a safe `LinkTarget`, or `undefined` for any action type this library does not expose as an active link. */
export async function resolveAction(
  doc: PdfDocument,
  actionValue: PdfValue | undefined,
  pageRefToNumber: Map<string, number>,
  namedDestsRoot: PdfValue | undefined,
): Promise<LinkTarget | undefined> {
  const action = await doc.resolve(actionValue);
  if (!isDict(action)) return undefined;
  const sVal = await doc.resolve(dictGet(action, "S"));
  const subtype = isName(sVal) ? sVal.name : undefined;

  if (subtype === "URI") {
    const uriVal = await doc.resolve(dictGet(action, "URI"));
    if (!isPdfString(uriVal)) return undefined;
    const href = sanitizeExternalHref(decodePdfTextString(uriVal.bytes));
    return href ? { kind: "external", href } : undefined;
  }
  if (subtype === "GoTo") {
    return resolveDestination(doc, dictGet(action, "D"), pageRefToNumber, namedDestsRoot);
  }
  return undefined;
}

/** Resolves the target of anything carrying `/Dest` and/or `/A` (an annotation or an outline item), preferring `/Dest`. */
export async function resolveLinkTarget(
  doc: PdfDocument,
  container: PdfDict,
  pageRefToNumber: Map<string, number>,
  namedDestsRoot: PdfValue | undefined,
): Promise<LinkTarget | undefined> {
  const destVal = dictGet(container, "Dest");
  if (destVal !== undefined) {
    const target = await resolveDestination(doc, destVal, pageRefToNumber, namedDestsRoot);
    if (target) return target;
  }
  const aVal = dictGet(container, "A");
  if (aVal !== undefined) {
    return resolveAction(doc, aVal, pageRefToNumber, namedDestsRoot);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// /Outlines (bookmark) tree
// ---------------------------------------------------------------------------

export interface ResolveOutlineOptions {
  /** Safety bound on total outline nodes visited (protects against a pathological or cyclic tree). */
  maxNodes?: number;
}

export async function resolveOutline(
  doc: PdfDocument,
  pageRefToNumber: Map<string, number>,
  options: ResolveOutlineOptions = {},
): Promise<OutlineItem[]> {
  const catalog = await doc.resolve(doc.trailer.get("Root"));
  if (!isDict(catalog)) return [];
  const outlinesVal = await doc.resolve(dictGet(catalog, "Outlines"));
  if (!isDict(outlinesVal)) return [];

  const namesVal = await doc.resolve(dictGet(catalog, "Names"));
  const namedDestsRoot = isDict(namesVal) ? dictGet(namesVal, "Dests") : undefined;

  const maxNodes = options.maxNodes ?? 20_000;
  const visited = new Set<string>();
  let visitedCount = 0;

  const walkSiblings = async (firstValue: PdfValue | undefined, level: number): Promise<OutlineItem[]> => {
    const items: OutlineItem[] = [];
    let currentValue = firstValue;

    while (currentValue !== undefined && currentValue !== null) {
      if (isRef(currentValue)) {
        const key = refKeyOf(currentValue);
        if (visited.has(key)) break;
        visited.add(key);
      }
      visitedCount += 1;
      if (visitedCount > maxNodes) break;

      const node = await doc.resolve(currentValue);
      if (!isDict(node)) break;

      const titleVal = await doc.resolve(dictGet(node, "Title"));
      const title = isPdfString(titleVal) ? decodePdfTextString(titleVal.bytes) : "";
      const target = await resolveLinkTarget(doc, node, pageRefToNumber, namedDestsRoot);
      const children = await walkSiblings(dictGet(node, "First"), level + 1);

      items.push({ title, level, target, children });
      currentValue = dictGet(node, "Next");
    }
    return items;
  };

  return walkSiblings(dictGet(outlinesVal, "First"), 1);
}
