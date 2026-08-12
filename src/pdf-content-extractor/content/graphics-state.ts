/**
 * 2D affine matrix helpers for content-stream interpretation (TKT-009).
 *
 * A PDF matrix `[a b c d e f]` represents the 3x3 row-vector matrix:
 *
 * ```
 * | a b 0 |
 * | c d 0 |
 * | e f 1 |
 * ```
 *
 * A point `(x, y)` transforms to `(a*x + c*y + e, b*x + d*y + f)`. Matrix
 * concatenation (as used by the `cm` operator and by `Td`/`Tm` against the
 * text line matrix) follows the PDF spec's row-vector convention: applying
 * `m1` then `m2` is `multiply(m1, m2)`, not the reverse.
 */

export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export interface Point {
  x: number;
  y: number;
}

export function applyMatrix(m: Matrix, point: Point): Point {
  const [a, b, c, d, e, f] = m;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

/** Graphics-state parameters saved/restored by `q`/`Q` (spec table 52), excluding path/color state not needed for text extraction. */
export interface GraphicsState {
  ctm: Matrix;
  charSpacing: number;
  wordSpacing: number;
  /** Th, as a fraction (1 = 100%), not the raw percentage operand of `Tz`. */
  horizontalScaling: number;
  leading: number;
  font: string | undefined;
  fontSize: number;
  rise: number;
}

export function initialGraphicsState(initialCtm: Matrix = IDENTITY_MATRIX): GraphicsState {
  return {
    ctm: initialCtm,
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScaling: 1,
    leading: 0,
    font: undefined,
    fontSize: 0,
    rise: 0,
  };
}

export function cloneGraphicsState(state: GraphicsState): GraphicsState {
  return { ...state };
}
