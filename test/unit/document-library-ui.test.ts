import { describe, expect, it } from "vitest";
import {
  buildMatchSnippet,
  groupAndCapSearchResults,
  highlightedSnippetParts,
  LatestRequestGuard,
  slugifyDocumentId,
  termsFromQuery,
  type SearchResultCandidate,
  type SearchScoreComponents,
} from "../../src/document-library.ts";

const baseScoreComponents: SearchScoreComponents = {
  blockType: "paragraph",
  structuralWeight: 40,
  matchClass: "direct",
  matchClassMultiplier: 1,
  distinctTermsMatched: 1,
  distinctTermsTotal: 1,
  coverageRatio: 1,
  coverageBonus: 20,
  exactPhraseMatch: true,
  phraseBonus: 30,
  orderedNearMatch: false,
  orderedNearBonus: 0,
  contentLength: 10,
  lengthNormalizationFactor: 1,
  rawScore: 90,
  finalScore: 90,
};

describe("document library UI helpers", () => {
  it("creates stable safe document ids from filenames and hashes", () => {
    expect(slugifyDocumentId("99 Training Document.pdf", "abcdef0123456789")).toBe("document-99-training-document-abcdef012345");
    expect(slugifyDocumentId("AFQTP 24-3 B192.pdf", "1234567890abcdef")).toBe("afqtp-24-3-b192-1234567890ab");
  });

  it("splits highlighted snippets as text parts instead of trusted HTML", () => {
    const { snippet, matches } = buildMatchSnippet("<img src=x onerror=alert(1)> Hydraulic code ZX-99", termsFromQuery("hydraulic ZX-99"));
    const parts = highlightedSnippetParts(snippet, matches);
    expect(parts.some((part) => part.text.includes("<img"))).toBe(true);
    expect(parts.filter((part) => part.highlighted).map((part) => part.text.toLowerCase())).toEqual(["hydraulic", "zx-99"]);
  });

  it("normalizes query terms for keyboard-submitted and debounced searches", () => {
    expect(termsFromQuery(" Hydraulic hydraulic ZX-99 ")).toEqual(["hydraulic", "zx-99"]);
  });

  it("never returns an entire multi-thousand-character paragraph as the default snippet", () => {
    const huge = `${"filler word ".repeat(1000)}the calibration constant is ZX-99 here${" more filler".repeat(1000)}`;
    const { snippet, matches } = buildMatchSnippet(huge, ["zx-99"]);
    expect(snippet.length).toBeLessThan(400);
    expect(matches.length).toBe(1);
    expect(snippet.slice(matches[0].start, matches[0].end).toLowerCase()).toBe("zx-99");
  });

  it("centers the snippet on the occurrence with the most nearby matches", () => {
    const text = "alpha once. ".repeat(1) + "beta beta beta beta beta in one place. " + "alpha ".repeat(1) + "filler text ".repeat(50);
    const { matches } = buildMatchSnippet(text, ["beta"]);
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it("normalizes display whitespace without mutating the caller's source string", () => {
    const source = "line one\n\n  line   two\tcode ZX-99";
    const { snippet } = buildMatchSnippet(source, ["zx-99"]);
    expect(snippet).not.toContain("\n");
    expect(snippet).not.toContain("\t");
    expect(source).toContain("\n\n  line");
  });

  it("groups adjacent same-section matches under a primary result without hiding them", () => {
    const candidates: SearchResultCandidate[] = [
      candidate({ documentId: "doc-a", sectionId: "sec-1", blockId: "p-1", rank: 1 }),
      candidate({ documentId: "doc-a", sectionId: "sec-1", blockId: "p-2", rank: 2 }),
      candidate({ documentId: "doc-a", sectionId: "sec-2", blockId: "p-3", rank: 1.5 }),
    ];
    const grouped = groupAndCapSearchResults(candidates, { perDocumentCap: 10, totalLimit: 10 });
    expect(grouped).toHaveLength(2);
    const sectionOne = grouped.find((item) => item.sectionId === "sec-1")!;
    expect(sectionOne.blockId).toBe("p-2");
    expect(sectionOne.additionalMatches.map((match) => match.blockId)).toEqual(["p-1"]);
    expect(grouped.some((item) => item.sectionId === "sec-2")).toBe(true);
  });

  it("does not group materially different matches across block types in the same section", () => {
    const candidates: SearchResultCandidate[] = [
      candidate({ documentId: "doc-a", sectionId: "sec-1", blockId: "p-1", blockType: "paragraph", rank: 2 }),
      candidate({ documentId: "doc-a", sectionId: "sec-1", blockId: "li-1", blockType: "list-item", rank: 1 }),
      candidate({ documentId: "doc-a", sectionId: "sec-1", blockId: "tc-1", blockType: "table-cell", rank: 1 }),
    ];
    const grouped = groupAndCapSearchResults(candidates, { perDocumentCap: 10, totalLimit: 10 });
    expect(grouped).toHaveLength(3);
    expect(grouped.map((item) => item.blockType).sort()).toEqual(["list-item", "paragraph", "table-cell"]);
    expect(grouped.every((item) => item.additionalMatches.length === 0)).toBe(true);
  });

  it("carries score diagnostics through grouping for both the primary and additional matches", () => {
    const candidates: SearchResultCandidate[] = [
      candidate({
        documentId: "doc-a",
        sectionId: "sec-1",
        blockId: "p-1",
        rank: 1,
        scoreComponents: { ...baseScoreComponents, finalScore: 1 },
      }),
      candidate({
        documentId: "doc-a",
        sectionId: "sec-1",
        blockId: "p-2",
        rank: 2,
        scoreComponents: { ...baseScoreComponents, finalScore: 2 },
      }),
    ];
    const [grouped] = groupAndCapSearchResults(candidates, { perDocumentCap: 10, totalLimit: 10 });
    expect(grouped.scoreComponents?.finalScore).toBe(2);
    expect(grouped.additionalMatches[0].scoreComponents?.finalScore).toBe(1);
  });

  it("does not let one document consume every visible result when other documents match", () => {
    const candidates: SearchResultCandidate[] = [
      ...Array.from({ length: 8 }, (_, index) => candidate({ documentId: "big-doc", sectionId: `sec-${index}`, blockId: `p-${index}`, rank: 10 - index })),
      candidate({ documentId: "other-doc", sectionId: "sec-x", blockId: "p-x", rank: 1 }),
    ];
    const capped = groupAndCapSearchResults(candidates, { perDocumentCap: 3, totalLimit: 5 });
    expect(capped.filter((item) => item.documentId === "big-doc")).toHaveLength(3);
    expect(capped.some((item) => item.documentId === "other-doc")).toBe(true);
  });

  it("(TKT-033) always ranks a direct match above a higher-scoring prefix match, and a prefix match above a higher-scoring partial match", () => {
    const candidates: SearchResultCandidate[] = [
      // Deliberately gives the broader match classes the *higher* raw rank
      // to prove tier ordering wins over score, not just usually agrees with it.
      candidate({ documentId: "doc-a", sectionId: "sec-partial", blockId: "p-partial", rank: 500, matchClass: "partial" }),
      candidate({ documentId: "doc-a", sectionId: "sec-prefix", blockId: "p-prefix", rank: 200, matchClass: "prefix" }),
      candidate({ documentId: "doc-a", sectionId: "sec-direct", blockId: "p-direct", rank: 10, matchClass: "direct" }),
    ];
    const results = groupAndCapSearchResults(candidates, { perDocumentCap: 10, totalLimit: 10 });
    expect(results.map((item) => item.blockId)).toEqual(["p-direct", "p-prefix", "p-partial"]);
  });

  it("(TKT-034) always ranks direct and prefix above a higher-scoring stemmed match, and stemmed above a higher-scoring partial match", () => {
    const candidates: SearchResultCandidate[] = [
      // Deliberately gives the broader match classes the *higher* raw rank
      // to prove tier ordering wins over score, not just usually agrees with it.
      candidate({ documentId: "doc-a", sectionId: "sec-partial", blockId: "p-partial", rank: 900, matchClass: "partial" }),
      candidate({ documentId: "doc-a", sectionId: "sec-stemmed", blockId: "p-stemmed", rank: 500, matchClass: "stemmed" }),
      candidate({ documentId: "doc-a", sectionId: "sec-prefix", blockId: "p-prefix", rank: 200, matchClass: "prefix" }),
      candidate({ documentId: "doc-a", sectionId: "sec-direct", blockId: "p-direct", rank: 10, matchClass: "direct" }),
    ];
    const results = groupAndCapSearchResults(candidates, { perDocumentCap: 10, totalLimit: 10 });
    expect(results.map((item) => item.blockId)).toEqual(["p-direct", "p-prefix", "p-stemmed", "p-partial"]);
  });

  it("(TKT-033) treats a missing matchClass as direct for tier ordering (pre-TKT-033 fixtures keep working)", () => {
    const candidates: SearchResultCandidate[] = [
      candidate({ documentId: "doc-a", sectionId: "sec-partial", blockId: "p-partial", rank: 500, matchClass: "partial" }),
      candidate({ documentId: "doc-a", sectionId: "sec-none", blockId: "p-none", rank: 1 }),
    ];
    const results = groupAndCapSearchResults(candidates, { perDocumentCap: 10, totalLimit: 10 });
    expect(results.map((item) => item.blockId)).toEqual(["p-none", "p-partial"]);
  });
});

describe("LatestRequestGuard (TKT-033 stale search-request guard)", () => {
  it("treats the most recently started request as current", () => {
    const guard = new LatestRequestGuard();
    const first = guard.begin();
    expect(guard.isCurrent(first)).toBe(true);
  });

  it("invalidates an earlier request once a newer one has begun", () => {
    const guard = new LatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("keeps only the very latest request current across many out-of-order completions", () => {
    const guard = new LatestRequestGuard();
    const ids = [guard.begin(), guard.begin(), guard.begin(), guard.begin()];
    // Simulate responses landing out of order (e.g. request 2 answers after request 4).
    const currentByArrival = [ids[1], ids[3], ids[0], ids[2]].map((id) => guard.isCurrent(id));
    expect(currentByArrival).toEqual([false, true, false, false]);
  });

  it("never lets an already-superseded id read as current again", () => {
    const guard = new LatestRequestGuard();
    const first = guard.begin();
    guard.begin();
    guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
  });
});

function candidate(overrides: Partial<SearchResultCandidate>): SearchResultCandidate {
  return {
    documentId: "doc",
    documentTitle: "Doc",
    blockId: "block",
    sectionId: "section",
    heading: "Heading",
    headingPath: [],
    pageNumber: 1,
    blockType: "paragraph",
    snippet: "snippet",
    matches: [],
    rank: 1,
    ...overrides,
  };
}
