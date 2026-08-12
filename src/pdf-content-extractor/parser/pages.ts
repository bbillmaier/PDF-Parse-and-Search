/**
 * Catalog and page-tree traversal (TKT-008): enumerates pages in stable
 * document order, applies inherited `/MediaBox`, `/CropBox`, `/Rotate`, and
 * `/Resources`, and resolves each page's `/Contents` reference(s) without
 * decoding them. Output here is an internal `PageDescriptor` — not the
 * public `DocumentPage` type, which Epic C populates with real semantic
 * blocks once content interpretation exists.
 */

import { PdfParseError } from "../errors.ts";
import type { ParseWarning, SafetyLimits } from "../types.ts";
import { NOOP_PARSE_RUNTIME, type ParseRuntime } from "../runtime.ts";
import type { PdfDocument } from "./document.ts";
import { dictGet, isArrayValue, isDict, isRef, type PdfDict, type PdfRef, type PdfValue } from "./objects.ts";

export type Rectangle = [number, number, number, number];

export interface PageDescriptor {
  /** 1-based, in stable document (pre-order /Kids) order. */
  pageNumber: number;
  ref: PdfRef;
  mediaBox: Rectangle;
  cropBox: Rectangle;
  /** Normalized to one of 0/90/180/270. */
  rotate: number;
  effectiveWidth: number;
  effectiveHeight: number;
  resources: PdfDict | undefined;
  /** Refs (usually) to the page's content stream(s), left undecoded. */
  contentRefs: PdfValue[];
  warnings: ParseWarning[];
}

export interface PageTreeResult {
  pages: PageDescriptor[];
  warnings: ParseWarning[];
  declaredRootCount?: number;
}

const DEFAULT_MEDIA_BOX: Rectangle = [0, 0, 612, 792];

interface InheritedAttrs {
  mediaBox?: Rectangle;
  cropBox?: Rectangle;
  rotate?: number;
  resources?: PdfDict;
}

function refKey(ref: PdfRef): string {
  return `${ref.num}:${ref.gen}`;
}

async function resolveRectangle(doc: PdfDocument, value: PdfValue | undefined): Promise<Rectangle | undefined> {
  const resolved = await doc.resolve(value);
  if (!isArrayValue(resolved) || resolved.items.length !== 4) return undefined;
  const nums: number[] = [];
  for (const item of resolved.items) {
    const r = await doc.resolve(item);
    if (typeof r !== "number") return undefined;
    nums.push(r);
  }
  const [a, b, c, d] = nums;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

function normalizeRotate(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return normalized;
}

async function resolveContentRefs(doc: PdfDocument, contentsVal: PdfValue | undefined): Promise<PdfValue[]> {
  if (contentsVal === undefined || contentsVal === null) return [];
  if (isRef(contentsVal)) {
    const resolved = await doc.resolve(contentsVal);
    if (isArrayValue(resolved)) return resolved.items;
    return [contentsVal];
  }
  if (isArrayValue(contentsVal)) return contentsVal.items;
  return [contentsVal];
}

/**
 * Walks the catalog's `/Pages` tree in pre-order (stable document order),
 * applying inherited attributes and producing one `PageDescriptor` per leaf
 * `/Page` node. Cycles, excessive depth, duplicate leaves, and `/Count`
 * mismatches are reported as warnings rather than aborting the whole parse.
 */
export async function traversePageTree(
  doc: PdfDocument,
  limits: Pick<SafetyLimits, "maxPageTreeDepth" | "maxObjectCount">,
  onProgress?: (pagesCompleted: number) => void,
  runtime: ParseRuntime = doc.runtime ?? NOOP_PARSE_RUNTIME,
): Promise<PageTreeResult> {
  const rootRef = doc.trailer.get("Root");
  const catalog = await doc.resolve(rootRef);
  if (!isDict(catalog)) {
    throw new PdfParseError("corrupt-structure", "Catalog (/Root) did not resolve to a dictionary.");
  }
  const pagesRef = dictGet(catalog, "Pages");
  const pagesRoot = await doc.resolve(pagesRef);
  if (!isDict(pagesRoot)) {
    throw new PdfParseError("corrupt-structure", "/Pages root did not resolve to a dictionary.");
  }

  const declaredCountVal = dictGet(pagesRoot, "Count");
  const declaredRootCount = typeof declaredCountVal === "number" ? declaredCountVal : undefined;

  const warnings: ParseWarning[] = [];
  const pages: PageDescriptor[] = [];
  const seenLeafKeys = new Set<string>();

  interface StackFrame {
    ref: PdfRef | undefined;
    node: PdfDict;
    inherited: InheritedAttrs;
    depth: number;
    ancestors: Set<string>;
  }

  const rootInherited: InheritedAttrs = {};
  const rootAncestors = new Set<string>();
  if (isRef(pagesRef)) rootAncestors.add(refKey(pagesRef));

  const stack: StackFrame[] = [
    { ref: isRef(pagesRef) ? pagesRef : undefined, node: pagesRoot, inherited: rootInherited, depth: 0, ancestors: rootAncestors },
  ];

  let visitedNodeCount = 0;

  while (stack.length > 0) {
    await runtime.checkpoint("page-tree traversal");
    const frame = stack.pop()!;
    visitedNodeCount += 1;
    if (visitedNodeCount > limits.maxObjectCount) {
      throw new PdfParseError(
        "limit-exceeded",
        `Page-tree traversal exceeded the configured maxObjectCount (${limits.maxObjectCount}).`,
        "context=document pageTree limit=maxObjectCount",
      );
    }

    const ownMediaBox = await resolveRectangle(doc, dictGet(frame.node, "MediaBox"));
    const ownCropBox = await resolveRectangle(doc, dictGet(frame.node, "CropBox"));
    const ownRotateRaw = await doc.resolve(dictGet(frame.node, "Rotate"));
    const ownRotate = normalizeRotate(typeof ownRotateRaw === "number" ? ownRotateRaw : undefined);
    const ownResourcesVal = await doc.resolve(dictGet(frame.node, "Resources"));
    const ownResources = isDict(ownResourcesVal) ? ownResourcesVal : undefined;

    const effectiveInherited: InheritedAttrs = {
      mediaBox: ownMediaBox ?? frame.inherited.mediaBox,
      cropBox: ownCropBox ?? frame.inherited.cropBox,
      rotate: ownRotate ?? frame.inherited.rotate,
      resources: ownResources ?? frame.inherited.resources,
    };

    const kidsVal = await doc.resolve(dictGet(frame.node, "Kids"));

    if (isArrayValue(kidsVal)) {
      // Intermediate /Pages node.
      if (frame.depth >= limits.maxPageTreeDepth) {
        warnings.push({
          code: "limit-exceeded-locally",
          message: `Page tree exceeded the configured maxPageTreeDepth (${limits.maxPageTreeDepth}); subtree skipped.`,
        });
        continue;
      }

      const children: StackFrame[] = [];
      for (let i = 0; i < kidsVal.items.length; i += 1) {
        if (i % 64 === 0) await runtime.checkpoint("page-tree /Kids traversal");
        const kidVal = kidsVal.items[i];
        if (!isRef(kidVal)) {
          warnings.push({ code: "structure-inconsistency", message: "Skipped a /Kids entry that is not an indirect reference." });
          continue;
        }
        const key = refKey(kidVal);
        if (frame.ancestors.has(key)) {
          warnings.push({ code: "limit-exceeded-locally", message: `Page-tree cycle detected at object ${kidVal.num}; subtree skipped.` });
          continue;
        }
        const kidNode = await doc.resolve(kidVal);
        if (!isDict(kidNode)) {
          warnings.push({ code: "structure-inconsistency", message: `Skipped /Kids entry ${kidVal.num}: did not resolve to a dictionary.` });
          continue;
        }
        const nextAncestors = new Set(frame.ancestors);
        nextAncestors.add(key);
        children.push({ ref: kidVal, node: kidNode, inherited: effectiveInherited, depth: frame.depth + 1, ancestors: nextAncestors });
      }
      // Push in reverse so the stack (LIFO) pops them back in original document order.
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
      continue;
    }

    // Leaf /Page node (or a node with no /Kids, treated as a leaf defensively).
    if (!frame.ref) {
      warnings.push({ code: "structure-inconsistency", message: "Encountered a page leaf with no indirect reference; skipped." });
      continue;
    }
    const leafKey = refKey(frame.ref);
    if (seenLeafKeys.has(leafKey)) {
      warnings.push({ code: "limit-exceeded-locally", message: `Duplicate page reference for object ${frame.ref.num}; skipped.` });
      continue;
    }
    seenLeafKeys.add(leafKey);

    const mediaBox = effectiveInherited.mediaBox ?? DEFAULT_MEDIA_BOX;
    const cropBox = effectiveInherited.cropBox ?? mediaBox;
    const rotate = effectiveInherited.rotate ?? 0;
    const rawWidth = mediaBox[2] - mediaBox[0];
    const rawHeight = mediaBox[3] - mediaBox[1];
    const swapped = rotate === 90 || rotate === 270;

    const contentsVal = dictGet(frame.node, "Contents");
    const contentRefs = await resolveContentRefs(doc, contentsVal);

    const pageWarnings: ParseWarning[] = [];
    if (!effectiveInherited.mediaBox) {
      pageWarnings.push({ code: "structure-inconsistency", message: "No /MediaBox found on page or ancestors; used the US Letter default.", pageNumber: pages.length + 1 });
    }

    pages.push({
      pageNumber: pages.length + 1,
      ref: frame.ref,
      mediaBox,
      cropBox,
      rotate,
      effectiveWidth: swapped ? rawHeight : rawWidth,
      effectiveHeight: swapped ? rawWidth : rawHeight,
      resources: effectiveInherited.resources,
      contentRefs,
      warnings: pageWarnings,
    });
    onProgress?.(pages.length);
  }

  if (declaredRootCount !== undefined && declaredRootCount !== pages.length) {
    warnings.push({
      code: "structure-inconsistency",
      message: `Root /Pages /Count (${declaredRootCount}) does not match the number of pages actually traversed (${pages.length}).`,
    });
  }

  return { pages, warnings, declaredRootCount };
}
