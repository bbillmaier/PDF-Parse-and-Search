/**
 * Text-object-only state (TKT-009): the text matrix `Tm` and text line
 * matrix `Tlm`. These are distinct from `GraphicsState` — they are reset by
 * `BT`, not saved/restored by `q`/`Q` (PDF spec 9.4.1), and are only
 * meaningful between a `BT`/`ET` pair.
 */

import { IDENTITY_MATRIX, type Matrix } from "./graphics-state.ts";

export interface TextObjectState {
  textMatrix: Matrix;
  lineMatrix: Matrix;
}

export function initialTextObjectState(): TextObjectState {
  return { textMatrix: IDENTITY_MATRIX, lineMatrix: IDENTITY_MATRIX };
}

/** Read-only snapshot of the text-showing parameters a glyph-width provider needs (PDF spec 9.4.3). */
export interface TextShowingParameters {
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  /** Th, as a fraction (1 = 100%). */
  horizontalScaling: number;
}
