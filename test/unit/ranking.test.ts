import { describe, expect, it } from "vitest";
import { computeSearchScore, RANKING_WEIGHTS } from "../../server/ranking.ts";
import { termsFromQuery } from "../../src/document-library.ts";
import type { MatchClass } from "../../src/document-library.ts";

describe("computeSearchScore (TKT-031 deterministic multi-signal ranking)", () => {
  it("ranks a heading match above an equivalent body-only match", () => {
    const terms = termsFromQuery("hydraulic calibration");
    const heading = computeSearchScore({ blockType: "heading", content: "Hydraulic Calibration Procedure", terms });
    const body = computeSearchScore({ blockType: "paragraph", content: "Hydraulic Calibration Procedure", terms });
    expect(heading.score).toBeGreaterThan(body.score);
    expect(heading.components.structuralWeight).toBeGreaterThan(body.components.structuralWeight);
  });

  it("ranks a document title and a table-cell match above ordinary body text", () => {
    const terms = termsFromQuery("torque spec");
    const title = computeSearchScore({ blockType: "document-title", content: "Torque Spec Manual", terms });
    const table = computeSearchScore({ blockType: "table-cell", content: "Torque spec value", terms });
    const body = computeSearchScore({ blockType: "paragraph", content: "Torque spec value", terms });
    expect(title.score).toBeGreaterThan(table.score);
    expect(table.score).toBeGreaterThan(body.score);
  });

  it("ranks a complete phrase match above scattered occurrences of the same terms", () => {
    const terms = termsFromQuery("engine inspection");
    const exact = computeSearchScore({
      blockType: "paragraph",
      content: "The engine inspection must be logged before flight.",
      terms,
    });
    const scattered = computeSearchScore({
      blockType: "paragraph",
      content:
        "The engine runs fine after maintenance, and a separate unrelated crew inspection happened much later in the shift.",
      terms,
    });
    expect(exact.components.exactPhraseMatch).toBe(true);
    expect(scattered.components.exactPhraseMatch).toBe(false);
    expect(exact.score).toBeGreaterThan(scattered.score);
  });

  it("ranks ordered-near (in order, nearby, non-contiguous) above out-of-order or far-apart terms", () => {
    const terms = termsFromQuery("engine inspection");
    const near = computeSearchScore({ blockType: "paragraph", content: "engine pre-flight inspection log", terms });
    const reversed = computeSearchScore({
      blockType: "paragraph",
      content: "inspection of the crew preceded the engine start-up",
      terms,
    });
    expect(near.components.orderedNearMatch).toBe(true);
    expect(reversed.components.orderedNearMatch).toBe(false);
    expect(near.score).toBeGreaterThan(reversed.score);
  });

  it("ranks a result covering all distinct query terms above a partial result", () => {
    const terms = termsFromQuery("hydraulic calibration ZX-99");
    const full = computeSearchScore({
      blockType: "paragraph",
      content: "Hydraulic calibration for code ZX-99 completed.",
      terms,
    });
    const partial = computeSearchScore({
      blockType: "paragraph",
      content: "Hydraulic system overview, unrelated to calibration codes.",
      terms,
    });
    expect(full.components.coverageRatio).toBe(1);
    expect(partial.components.coverageRatio).toBeLessThan(1);
    expect(full.score).toBeGreaterThan(partial.score);
  });

  it("ranks a concise strong match above a large paragraph that only repeats the terms", () => {
    const terms = termsFromQuery("beacon calibration");
    const concise = computeSearchScore({
      blockType: "paragraph",
      content: "Beacon calibration confirmed nominal.",
      terms,
    });
    const huge =
      "beacon reading noted. ".repeat(40) +
      "unrelated filler text goes on for a while before anything else. ".repeat(60) +
      "calibration was mentioned separately much later in the same block.";
    const large = computeSearchScore({ blockType: "paragraph", content: huge, terms });
    expect(large.components.contentLength).toBeGreaterThan(RANKING_WEIGHTS.lengthNormalization.pivotLength);
    expect(concise.components.lengthNormalizationFactor).toBe(1);
    expect(large.components.lengthNormalizationFactor).toBeGreaterThan(1);
    expect(concise.score).toBeGreaterThan(large.score);
  });

  it("applies length normalization only beyond the pivot length", () => {
    const terms = termsFromQuery("code");
    const short = computeSearchScore({ blockType: "paragraph", content: "code A-12", terms });
    expect(short.components.lengthNormalizationFactor).toBe(1);
  });

  it("is a pure function: identical input always produces identical output", () => {
    const terms = termsFromQuery("hydraulic pump ZX-99");
    const content = "Hydraulic pump code ZX-99 confirms test indexing across the whole procedure.";
    const first = computeSearchScore({ blockType: "table-cell", content, terms });
    const second = computeSearchScore({ blockType: "table-cell", content: `${content}`, terms: [...terms] });
    expect(second).toEqual(first);
  });

  it("orders match classes so direct always outranks prefix/stemmed/future synonym/partial/corrected classes", () => {
    const terms = termsFromQuery("hydraulic pump");
    const content = "Hydraulic pump inspected and confirmed.";
    const order: MatchClass[] = ["direct", "prefix", "stemmed", "synonym", "partial", "corrected"];
    const scores = order.map((matchClass) => computeSearchScore({ blockType: "paragraph", content, terms, matchClass }).score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it("treats hostile content as plain text and still returns a finite deterministic score", () => {
    const terms = termsFromQuery("drop table");
    const hostile = "<img src=x onerror=alert(1)> '; DROP TABLE documents; --";
    const result = computeSearchScore({ blockType: "paragraph", content: hostile, terms });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.components.distinctTermsMatched).toBe(2);
    expect(computeSearchScore({ blockType: "paragraph", content: hostile, terms })).toEqual(result);
  });

  it("awards the exact-phrase boost to a quoted phrase even when other terms break the whole-query join (TKT-032)", () => {
    // Whole-query join ("engine inspection report") is not contiguous in
    // either text below, so without per-phrase detection neither would earn
    // the phrase boost. The explicitly quoted phrase "engine inspection"
    // still appears contiguously in the first, so it alone should decide it.
    const terms = ["engine", "inspection", "report"];
    const phrases = [["engine", "inspection"]];
    const withPhrase = computeSearchScore({
      blockType: "paragraph",
      content: "Engine inspection completed; full report filed separately.",
      terms,
      phrases,
    });
    const withoutPhrase = computeSearchScore({
      blockType: "paragraph",
      content: "A report noted the engine ran fine after the inspection.",
      terms,
      phrases,
    });
    expect(withPhrase.components.exactPhraseMatch).toBe(true);
    expect(withoutPhrase.components.exactPhraseMatch).toBe(false);
    expect(withPhrase.score).toBeGreaterThan(withoutPhrase.score);
  });

  it("omitting phrases keeps TKT-031's whole-query-join phrase behavior unchanged", () => {
    const terms = termsFromQuery("engine inspection");
    const result = computeSearchScore({ blockType: "paragraph", content: "Engine inspection logged.", terms });
    expect(result.components.exactPhraseMatch).toBe(true);
  });

  it("never matches terms when the query produced none", () => {
    const result = computeSearchScore({ blockType: "paragraph", content: "anything at all", terms: [] });
    expect(result.components.coverageRatio).toBe(0);
    expect(result.components.exactPhraseMatch).toBe(false);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});
