/**
 * Content-stream operator interpreter (TKT-009). Converts a decoded page
 * content stream into ordered, positioned raw text-showing events and
 * placed-XObject events, tracking the graphics state (CTM, `q`/`Q`), text
 * state, and marked-content context (`BDC`/`BMC`/`EMC`, MCIDs, artifacts).
 *
 * Unicode decoding is intentionally out of scope here (TKT-010): text
 * events carry undecoded string bytes. Computing the exact horizontal
 * advance of a shown string requires a font's glyph widths, which this
 * module also does not own — callers inject a `measureText` function
 * (TKT-010 supplies the real one; the built-in default is a documented
 * placeholder heuristic used when none is given, e.g. in this module's own
 * unit tests).
 */

import { PdfParseError } from "../errors.ts";
import type { ParseWarning, SafetyLimits } from "../types.ts";
import { concatBytes } from "../parser/bytes.ts";
import type { PdfDocument } from "../parser/document.ts";
import {
  dictGet,
  isArrayValue,
  isDict,
  isName,
  isPdfString,
  isStream,
  type PdfDict,
  type PdfValue,
} from "../parser/objects.ts";
import type { PageDescriptor } from "../parser/pages.ts";
import {
  cloneGraphicsState,
  initialGraphicsState,
  multiply,
  translate,
  type GraphicsState,
  type Matrix,
} from "./graphics-state.ts";
import { ContentTokenizer, type OperatorToken } from "./lexer.ts";
import { initialTextObjectState, type TextObjectState, type TextShowingParameters } from "./text-state.ts";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface TextShowFragment {
  kind: "text";
  pageNumber: number;
  /** Raw, undecoded string bytes for this single show-text operand. */
  bytes: Uint8Array;
  /** Current `/Tf` resource name (e.g. "F1"), or `undefined` if text is shown with no font selected. */
  fontResourceName: string | undefined;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  /** Th, as a fraction (1 = 100%). */
  horizontalScaling: number;
  leading: number;
  rise: number;
  /** Effective text-rendering matrix (`Tm x CTM`) at the glyph origin, before this operand advances it. */
  matrix: Matrix;
  /** Effective matrix at the position immediately after this operand's glyphs (same computation as `matrix`, using the text matrix post-advance) — the geometry layer (TKT-011) uses `matrix`/`endMatrix` translation to measure this fragment's on-page extent without recomputing glyph widths. */
  endMatrix: Matrix;
  mcid: number | undefined;
  /** Marked-content tag stack, outermost first (e.g. `["Div", "P"]`). */
  tags: string[];
  artifact: boolean;
  sourceOffset: number;
}

export interface XObjectPlacement {
  kind: "xobject";
  pageNumber: number;
  /** `/XObject` resource name (e.g. "Im1" or "Fm1"), resolved against page resources by the caller. */
  name: string;
  /** CTM at the time `Do` was invoked. */
  matrix: Matrix;
  mcid: number | undefined;
  tags: string[];
  artifact: boolean;
  sourceOffset: number;
}

export interface UnknownOperatorDiagnostic {
  pageNumber: number;
  operator: string;
  operandCount: number;
  sourceOffset: number;
}

export interface ContentInterpretResult {
  fragments: TextShowFragment[];
  xobjects: XObjectPlacement[];
  unknownOperators: UnknownOperatorDiagnostic[];
  warnings: ParseWarning[];
}

// ---------------------------------------------------------------------------
// Injectable hooks
// ---------------------------------------------------------------------------

/**
 * Returns the total horizontal text-space advance (already scaled by font
 * size, char/word spacing, and horizontal scaling — spec 9.4.3) produced by
 * showing `bytes` under the given font resource. TKT-010 supplies the real,
 * font-aware implementation; `DEFAULT_MEASURE_TEXT` below is a documented
 * fallback used only when no measurer is supplied.
 */
export type MeasureTextFn = (
  fontResourceName: string | undefined,
  bytes: Uint8Array,
  state: TextShowingParameters,
) => number;

/** Resolves a `BDC` properties operand (a `/Properties` resource name) to its MCID, when declared out of line. */
export type ResolveMarkedContentPropertiesFn = (name: string) => { mcid?: number } | undefined;

const DEFAULT_GLYPH_WIDTH_PER_MILLE = 500;

/** Placeholder glyph-width model: every byte is treated as one code at a fixed average width. */
export const DEFAULT_MEASURE_TEXT: MeasureTextFn = (_font, bytes, state) => {
  let tx = 0;
  for (const b of bytes) {
    const glyphWidth = (DEFAULT_GLYPH_WIDTH_PER_MILLE / 1000) * state.fontSize;
    const wordSpacing = b === 0x20 ? state.wordSpacing : 0;
    tx += (glyphWidth + state.charSpacing + wordSpacing) * state.horizontalScaling;
  }
  return tx;
};

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

export interface InterpretPageContentOptions {
  limits: Pick<SafetyLimits, "maxContentOperationsPerPage" | "maxNestingDepth" | "maxTokenLength">;
  measureText?: MeasureTextFn;
  resolveMarkedContentProperties?: ResolveMarkedContentPropertiesFn;
  /** Initial CTM (e.g. a page-rotation matrix pre-applied by the caller). Defaults to identity. */
  initialCtm?: Matrix;
  isCancelled?: () => boolean;
}

interface MarkedContentFrame {
  tag: string;
  mcid: number | undefined;
  artifactSelf: boolean;
}

export function interpretPageContent(
  bytes: Uint8Array,
  pageNumber: number,
  options: InterpretPageContentOptions,
): ContentInterpretResult {
  const { limits } = options;
  const measureText = options.measureText ?? DEFAULT_MEASURE_TEXT;
  const resolveProperties = options.resolveMarkedContentProperties;

  const fragments: TextShowFragment[] = [];
  const xobjects: XObjectPlacement[] = [];
  const unknownOperators: UnknownOperatorDiagnostic[] = [];
  const warnings: ParseWarning[] = [];

  let gs: GraphicsState = initialGraphicsState(options.initialCtm);
  const gsStack: GraphicsState[] = [];
  let text: TextObjectState | undefined;
  const mcStack: MarkedContentFrame[] = [];
  let opCount = 0;

  function warn(message: string): void {
    warnings.push({ code: "structure-inconsistency", message, pageNumber });
  }

  function checkOpCount(): void {
    if (options.isCancelled?.()) {
      throw new PdfParseError("cancelled", "The parse request was cancelled during page content interpretation.", `page=${pageNumber}`);
    }
    opCount += 1;
    if (opCount > limits.maxContentOperationsPerPage) {
      throw new PdfParseError(
        "limit-exceeded",
        `Page content exceeded the configured maxContentOperationsPerPage (${limits.maxContentOperationsPerPage}).`,
        `page=${pageNumber}`,
      );
    }
  }

  function currentMcid(): number | undefined {
    for (let i = mcStack.length - 1; i >= 0; i -= 1) {
      if (mcStack[i].mcid !== undefined) return mcStack[i].mcid;
    }
    return undefined;
  }

  function currentTags(): string[] {
    return mcStack.map((frame) => frame.tag);
  }

  function currentArtifact(): boolean {
    return mcStack.some((frame) => frame.artifactSelf);
  }

  function numberOperand(operands: PdfValue[], index: number): number | undefined {
    const v = operands[index];
    return typeof v === "number" ? v : undefined;
  }
  function nameOperand(operands: PdfValue[], index: number): string | undefined {
    const v = operands[index];
    return isName(v) ? v.name : undefined;
  }
  function stringOperand(operands: PdfValue[], index: number): Uint8Array | undefined {
    const v = operands[index];
    return isPdfString(v) ? v.bytes : undefined;
  }

  // Returns a definite `TextObjectState`, resetting (with a warning) if a
  // text-object operator was used outside `BT`/`ET`. Callers bind the result
  // to a local `const` rather than re-reading the outer `text` variable,
  // since TypeScript cannot keep a `let` narrowed to non-`undefined` across
  // the intervening calls (e.g. `measureText`) that follow in this module.
  function requireTextState(context: string): TextObjectState {
    if (!text) {
      warn(`${context} used outside a BT/ET block; treating text state as reset.`);
      text = initialTextObjectState();
    }
    return text;
  }

  function showString(operandBytes: Uint8Array, sourceOffset: number): void {
    const t = requireTextState("Text-showing operator");
    const matrix = multiply(t.textMatrix, gs.ctm);
    const tx = measureText(gs.font, operandBytes, {
      fontSize: gs.fontSize,
      charSpacing: gs.charSpacing,
      wordSpacing: gs.wordSpacing,
      horizontalScaling: gs.horizontalScaling,
    });
    const advancedTextMatrix = multiply(translate(tx, 0), t.textMatrix);
    const endMatrix = multiply(advancedTextMatrix, gs.ctm);
    fragments.push({
      kind: "text",
      pageNumber,
      bytes: operandBytes,
      fontResourceName: gs.font,
      fontSize: gs.fontSize,
      charSpacing: gs.charSpacing,
      wordSpacing: gs.wordSpacing,
      horizontalScaling: gs.horizontalScaling,
      leading: gs.leading,
      rise: gs.rise,
      matrix,
      endMatrix,
      mcid: currentMcid(),
      tags: currentTags(),
      artifact: currentArtifact(),
      sourceOffset,
    });
    t.textMatrix = advancedTextMatrix;
  }

  function doTd(tx: number, ty: number): void {
    const t = requireTextState("Td/TD");
    t.lineMatrix = multiply(translate(tx, ty), t.lineMatrix);
    t.textMatrix = t.lineMatrix;
  }

  function extractMcidFromDict(dict: PdfDict): number | undefined {
    const v = dictGet(dict, "MCID");
    return typeof v === "number" ? v : undefined;
  }

  function handleBDC(operands: PdfValue[], sourceOffset: number): void {
    const tag = nameOperand(operands, 0);
    if (tag === undefined) {
      warn(`BDC at offset ${sourceOffset} is missing a valid tag name operand.`);
      return;
    }
    let mcid: number | undefined;
    const propsValue = operands[1];
    if (isDict(propsValue)) {
      mcid = extractMcidFromDict(propsValue);
    } else if (isName(propsValue) && resolveProperties) {
      mcid = resolveProperties(propsValue.name)?.mcid;
    }
    pushMarkedContent(tag, mcid);
  }

  function pushMarkedContent(tag: string, mcid: number | undefined): void {
    if (mcStack.length >= limits.maxNestingDepth) {
      throw new PdfParseError(
        "limit-exceeded",
        `Marked-content nesting exceeded the configured maxNestingDepth (${limits.maxNestingDepth}).`,
        `page=${pageNumber}`,
      );
    }
    mcStack.push({ tag, mcid, artifactSelf: tag === "Artifact" });
  }

  const tokenizer = new ContentTokenizer(bytes, limits);
  for (;;) {
    const token = tokenizer.next();
    if (token === null) break;
    checkOpCount();

    if (token.kind === "inline-image") {
      unknownOperators.push({ pageNumber, operator: "BI", operandCount: 0, sourceOffset: token.offset });
      if (!token.terminated) {
        warn("Inline image (BI/ID/EI) was not properly terminated; remaining content stream bytes were skipped.");
      }
      continue;
    }

    dispatch(token);
  }

  function dispatch(token: OperatorToken): void {
    const { operator, operands, offset } = token;
    switch (operator) {
      case "q":
        if (gsStack.length >= limits.maxNestingDepth) {
          throw new PdfParseError(
            "limit-exceeded",
            `Graphics-state nesting exceeded the configured maxNestingDepth (${limits.maxNestingDepth}).`,
            `page=${pageNumber}`,
          );
        }
        gsStack.push(cloneGraphicsState(gs));
        return;
      case "Q":
        if (gsStack.length === 0) {
          warn("Q operator with no matching q; ignored.");
          return;
        }
        gs = gsStack.pop()!;
        return;
      case "cm": {
        const nums = [0, 1, 2, 3, 4, 5].map((i) => numberOperand(operands, i));
        if (nums.some((n) => n === undefined)) {
          warn(`cm at offset ${offset} did not have 6 numeric operands.`);
          return;
        }
        const m = nums as number[];
        gs.ctm = multiply([m[0], m[1], m[2], m[3], m[4], m[5]], gs.ctm);
        return;
      }
      case "BT":
        if (text) warn("Nested BT encountered; resetting text object state.");
        text = initialTextObjectState();
        return;
      case "ET":
        if (!text) warn("ET with no matching BT; ignored.");
        text = undefined;
        return;
      case "Tf": {
        const font = nameOperand(operands, 0);
        const size = numberOperand(operands, 1);
        if (font === undefined || size === undefined) {
          warn(`Tf at offset ${offset} had invalid operands.`);
          return;
        }
        gs.font = font;
        gs.fontSize = size;
        return;
      }
      case "Tc": {
        const v = numberOperand(operands, 0);
        if (v === undefined) return warn(`Tc at offset ${offset} had a non-numeric operand.`);
        gs.charSpacing = v;
        return;
      }
      case "Tw": {
        const v = numberOperand(operands, 0);
        if (v === undefined) return warn(`Tw at offset ${offset} had a non-numeric operand.`);
        gs.wordSpacing = v;
        return;
      }
      case "Tz": {
        const v = numberOperand(operands, 0);
        if (v === undefined) return warn(`Tz at offset ${offset} had a non-numeric operand.`);
        gs.horizontalScaling = v / 100;
        return;
      }
      case "TL": {
        const v = numberOperand(operands, 0);
        if (v === undefined) return warn(`TL at offset ${offset} had a non-numeric operand.`);
        gs.leading = v;
        return;
      }
      case "Ts": {
        const v = numberOperand(operands, 0);
        if (v === undefined) return warn(`Ts at offset ${offset} had a non-numeric operand.`);
        gs.rise = v;
        return;
      }
      case "Td": {
        const tx = numberOperand(operands, 0);
        const ty = numberOperand(operands, 1);
        if (tx === undefined || ty === undefined) return warn(`Td at offset ${offset} had invalid operands.`);
        doTd(tx, ty);
        return;
      }
      case "TD": {
        const tx = numberOperand(operands, 0);
        const ty = numberOperand(operands, 1);
        if (tx === undefined || ty === undefined) return warn(`TD at offset ${offset} had invalid operands.`);
        gs.leading = -ty;
        doTd(tx, ty);
        return;
      }
      case "T*":
        doTd(0, -gs.leading);
        return;
      case "Tm": {
        const nums = [0, 1, 2, 3, 4, 5].map((i) => numberOperand(operands, i));
        if (nums.some((n) => n === undefined)) return warn(`Tm at offset ${offset} did not have 6 numeric operands.`);
        const m = nums as number[];
        const matrix: Matrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
        text = { textMatrix: matrix, lineMatrix: matrix };
        return;
      }
      case "Tj": {
        const s = stringOperand(operands, 0);
        if (s === undefined) return warn(`Tj at offset ${offset} did not have a string operand.`);
        showString(s, offset);
        return;
      }
      case "TJ": {
        const arr = operands[0];
        if (!isArrayValue(arr)) return warn(`TJ at offset ${offset} did not have an array operand.`);
        for (const item of arr.items) {
          if (isPdfString(item)) {
            showString(item.bytes, offset);
          } else if (typeof item === "number") {
            const tx = (-item / 1000) * gs.fontSize * gs.horizontalScaling;
            const t = requireTextState("TJ numeric adjustment");
            t.textMatrix = multiply(translate(tx, 0), t.textMatrix);
          }
        }
        return;
      }
      case "'": {
        const s = stringOperand(operands, 0);
        if (s === undefined) return warn(`' at offset ${offset} did not have a string operand.`);
        doTd(0, -gs.leading);
        showString(s, offset);
        return;
      }
      case '"': {
        const aw = numberOperand(operands, 0);
        const ac = numberOperand(operands, 1);
        const s = stringOperand(operands, 2);
        if (aw === undefined || ac === undefined || s === undefined) {
          return warn(`" at offset ${offset} had invalid operands.`);
        }
        gs.wordSpacing = aw;
        gs.charSpacing = ac;
        doTd(0, -gs.leading);
        showString(s, offset);
        return;
      }
      case "BDC":
        handleBDC(operands, offset);
        return;
      case "BMC": {
        const tag = nameOperand(operands, 0);
        if (tag === undefined) return warn(`BMC at offset ${offset} is missing a valid tag name operand.`);
        pushMarkedContent(tag, undefined);
        return;
      }
      case "EMC":
        if (mcStack.length === 0) {
          warn("EMC with no matching BDC/BMC; ignored.");
          return;
        }
        mcStack.pop();
        return;
      case "Do": {
        const name = nameOperand(operands, 0);
        if (name === undefined) return warn(`Do at offset ${offset} did not have a name operand.`);
        xobjects.push({
          kind: "xobject",
          pageNumber,
          name,
          matrix: gs.ctm,
          mcid: currentMcid(),
          tags: currentTags(),
          artifact: currentArtifact(),
          sourceOffset: offset,
        });
        return;
      }
      default:
        // Every operator this interpreter implements has an explicit case above and
        // returns before reaching here, so anything landing in `default` is genuinely
        // unrecognized (path-painting, color, shading, compatibility operators, ...).
        unknownOperators.push({ pageNumber, operator, operandCount: operands.length, sourceOffset: offset });
    }
  }

  if (gsStack.length > 0) warn(`${gsStack.length} unmatched 'q' operator(s) at end of content stream.`);
  if (mcStack.length > 0) warn(`${mcStack.length} unmatched 'BDC'/'BMC' operator(s) at end of content stream.`);

  return { fragments, xobjects, unknownOperators, warnings };
}

// ---------------------------------------------------------------------------
// Page content-stream resolution
// ---------------------------------------------------------------------------

export interface PageContentBytesResult {
  bytes: Uint8Array;
  warnings: ParseWarning[];
}

const STREAM_SEPARATOR = new Uint8Array([0x0a]);

/**
 * Resolves and decodes every content-stream reference for a page (spec
 * 7.8.2 treats multiple `/Contents` array entries as one logical stream)
 * and concatenates them with a separating newline so tokens never merge
 * across a stream boundary.
 */
export async function resolvePageContentBytes(
  doc: PdfDocument,
  page: PageDescriptor,
): Promise<PageContentBytesResult> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const warnings: ParseWarning[] = [];

  for (const ref of page.contentRefs) {
    const resolved = await doc.resolve(ref);
    if (!isStream(resolved)) {
      warnings.push({
        code: "structure-inconsistency",
        message: "A page /Contents entry did not resolve to a stream; it was skipped.",
        pageNumber: page.pageNumber,
      });
      continue;
    }
    const decoded = await doc.getDecodedStreamBytes(resolved);
    chunks.push(decoded);
    total += decoded.byteLength;
    chunks.push(STREAM_SEPARATOR);
    total += STREAM_SEPARATOR.byteLength;
  }

  return { bytes: concatBytes(chunks, total), warnings };
}
