import { describe, expect, it } from "vitest";
import {
  boundedEditDistance,
  correctTerm,
  MAX_CANDIDATES_EXAMINED_PER_TERM,
  MAX_CORRECTIONS_PER_TERM,
  MAX_EDIT_DISTANCE,
} from "../../src/search-typo.ts";

describe("boundedEditDistance (TKT-035)", () => {
  it("returns 0 for identical strings", () => {
    expect(boundedEditDistance("inspection", "inspection", 2)).toBe(0);
  });

  it("computes ordinary Levenshtein distance within the bound", () => {
    expect(boundedEditDistance("inspeciton", "inspection", 2)).toBe(2); // transposition = 2 single edits
    expect(boundedEditDistance("kitten", "sitting", 3)).toBe(3);
    expect(boundedEditDistance("test", "tent", 2)).toBe(1);
  });

  it("returns null (not a number) once the true distance exceeds maxDistance", () => {
    expect(boundedEditDistance("abcdef", "uvwxyz", 2)).toBeNull();
  });

  it("rejects immediately by length difference alone, without needing the full table", () => {
    expect(boundedEditDistance("ab", "abcdefgh", 2)).toBeNull();
  });

  it("is symmetric", () => {
    expect(boundedEditDistance("inspeciton", "inspection", 3)).toBe(boundedEditDistance("inspection", "inspeciton", 3));
  });
});

describe("correctTerm (TKT-035)", () => {
  it("finds the expected correction among a small candidate pool", () => {
    const result = correctTerm("inspeciton", ["inspection", "injection", "unrelated"]);
    expect(result?.suggestions[0].candidate).toBe("inspection");
    expect(result?.suggestions[0].distance).toBeLessThanOrEqual(MAX_EDIT_DISTANCE);
  });

  it("returns null when nothing in the candidate pool is within MAX_EDIT_DISTANCE (no arbitrary correction)", () => {
    const result = correctTerm("zzzxyzabc", ["inspection", "hydraulic", "coolant"]);
    expect(result).toBeNull();
  });

  it("never suggests the exact same term as a correction of itself", () => {
    const result = correctTerm("inspection", ["inspection", "inspections"]);
    expect(result?.suggestions.every((s) => s.candidate !== "inspection")).toBe(true);
  });

  it("ranks suggestions best-first (lowest distance, then alphabetical) and caps at MAX_CORRECTIONS_PER_TERM", () => {
    const result = correctTerm("cat", ["bat", "cot", "car", "cats", "dog", "cut", "mat"]);
    expect(result).not.toBeNull();
    expect(result!.suggestions.length).toBeLessThanOrEqual(MAX_CORRECTIONS_PER_TERM);
    for (let i = 1; i < result!.suggestions.length; i += 1) {
      expect(result!.suggestions[i].distance).toBeGreaterThanOrEqual(result!.suggestions[i - 1].distance);
    }
  });

  it("only ever examines up to MAX_CANDIDATES_EXAMINED_PER_TERM candidates", () => {
    const hugePool = Array.from({ length: MAX_CANDIDATES_EXAMINED_PER_TERM + 50 }, (_, i) => `zzterm${i}`);
    // Put the only real match past the examined cap -- it must not be found.
    hugePool.push("inspection");
    const result = correctTerm("inspeciton", hugePool);
    expect(result).toBeNull();
  });
});
