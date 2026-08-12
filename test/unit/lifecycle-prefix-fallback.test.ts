import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";
import { DocumentLifecycle, MIN_USEFUL_RESULTS, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import type { DocumentSearchRecord } from "../../src/pdf-content-extractor/index.ts";

/**
 * TKT-033 lifecycle-level fallback-ladder tests.
 *
 * These run against a fast in-memory fake, not real PostgreSQL, so they
 * exercise DocumentLifecycle's orchestration (threshold checks, stage
 * ordering, dedup/match-class assignment, exclusion propagation) on every
 * `npm run test:unit` run without a database. The fake's `searchByTsQuery`
 * interprets the *exact* small `tsquery` grammar src/search-query.ts emits
 * (`&`, `|`, `!`, `<->`, and the `:*` prefix suffix) against word-tokenized
 * document text -- word-boundary matching, not substring matching, so it
 * behaves like PostgreSQL's `simple` tsvector (no stemming: "inspect" does
 * NOT match "inspection" except through an explicit `:*` prefix clause).
 * The real GIN-indexed PostgreSQL behavior for the same scenarios is
 * separately verified end-to-end in
 * test/integration/search-prefix-fallback.integration.test.ts.
 */
class TsQueryFakeDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  records: DocumentSearchRecord[] = [];
  searchByTsQueryCalls = 0;

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return work({} as pg.PoolClient);
  }

  async insertDocument(_client: pg.PoolClient, input: DocumentRowInput): Promise<void> {
    this.documents.set(input.id, { ...input, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
  }

  async insertSearchRecords(_client: pg.PoolClient, records: DocumentSearchRecord[]): Promise<void> {
    this.records.push(...records);
  }

  async listDocuments(): Promise<DocumentRow[]> {
    return [...this.documents.values()];
  }

  async getDocument(id: string): Promise<DocumentRow | undefined> {
    return this.documents.get(id);
  }

  async deleteDocument(id: string): Promise<boolean> {
    const deleted = this.documents.delete(id);
    this.records = this.records.filter((record) => record.documentId !== id);
    return deleted;
  }

  async search(query: string, limit: number): Promise<SearchResultRow[]> {
    return this.matchingRows((words) => websearchLikeMatches(query, words), limit);
  }

  async searchByTsQuery(tsQuery: string, limit: number): Promise<SearchResultRow[]> {
    this.searchByTsQueryCalls += 1;
    return this.matchingRows((words) => evaluateTsQuery(tsQuery, words), limit);
  }

  // TKT-034: this file's subject is prefix/partial orchestration (TKT-033),
  // not English stemming -- the complementary vector's own semantics are
  // covered by test/unit/lifecycle-technical-search.test.ts and the
  // PostgreSQL-backed integration tests. Returning no rows keeps those
  // scenarios' `strategy`/threshold assertions independent of this stage.
  async searchEnglish(): Promise<SearchResultRow[]> {
    return [];
  }

  // TKT-035: this file's subject is prefix/partial orchestration (TKT-033),
  // not synonym/typo semantics -- those are covered by
  // test/unit/lifecycle-synonym-search.test.ts,
  // test/unit/lifecycle-typo-search.test.ts, and the PostgreSQL-backed
  // integration tests. An empty vocabulary means the typo-correction stage
  // always cleanly no-ops here.
  async vocabularyCandidates(): Promise<string[]> {
    return [];
  }

  async vocabularyHasTerm(): Promise<boolean> {
    return false;
  }

  // TKT-036: not exercised by these prefix/fallback fixtures -- title
  // override is covered by test/unit/server-api.test.ts and the
  // PostgreSQL-backed integration tests.
  async updateDocumentTitle(): Promise<boolean> {
    return false;
  }

  async reindexDocumentVocabulary(): Promise<{ blocksSeen: number; blocksUpdated: number; vocabularyTermsWritten: number; suggestionsWritten: number }> {
    return { blocksSeen: 0, blocksUpdated: 0, vocabularyTermsWritten: 0, suggestionsWritten: 0 };
  }

  // TKT-037: not exercised by these fixtures beyond satisfying the
  // interface -- real suggestion semantics are covered by the
  // PostgreSQL-backed integration tests.
  async suggest(): Promise<{ documentId: string; type: "title" | "heading" | "technical"; text: string }[]> {
    return [];
  }

  private matchingRows(predicate: (words: string[]) => boolean, limit: number): SearchResultRow[] {
    const rows: SearchResultRow[] = [];
    for (const record of this.records) {
      const document = this.documents.get(record.documentId);
      if (!document) continue;
      const words = wordsOf(`${record.heading} ${record.text}`);
      if (!predicate(words)) continue;
      rows.push({
        documentId: record.documentId,
        documentTitle: document.title,
        blockId: record.blockId,
        sectionId: record.sectionId,
        heading: record.heading,
        headingPath: record.headingPath,
        pageNumber: record.pageNumber,
        blockType: record.blockType,
        snippetSource: record.text,
        rank: 1,
      });
    }
    return rows.slice(0, limit);
  }
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
}

/** Minimal reinterpretation of the small subset of websearch_to_tsquery
 *  syntax this file's fixtures use: space-separated AND terms, "word"
 *  quoted phrases (contiguous), and -excluded terms. Sufficient for these
 *  orchestration tests -- OR is exercised at the query-builder unit level
 *  and the PostgreSQL integration level instead, not here. */
function websearchLikeMatches(query: string, words: string[]): boolean {
  const tokenRe = /"([^"]*)"|(-)?(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(query)) !== null) {
    if (match[1] !== undefined) {
      if (!hasPhrase(words, match[1].split(/\s+/).filter(Boolean))) return false;
      continue;
    }
    const word = match[3];
    if (match[2] === "-") {
      if (words.includes(word)) return false;
    } else {
      if (!words.includes(word)) return false;
    }
  }
  return true;
}

function hasPhrase(words: string[], phraseWords: string[]): boolean {
  if (phraseWords.length === 0) return true;
  for (let i = 0; i + phraseWords.length <= words.length; i += 1) {
    if (phraseWords.every((word, offset) => words[i + offset] === word)) return true;
  }
  return false;
}

/** Recursive-descent evaluator for exactly the `tsquery` grammar
 *  src/search-query.ts's buildPrefixTsQuery/buildPartialFallbackTsQuery
 *  emit: `&` (AND), `|` (OR, standard lower precedence than AND), `!`
 *  (NOT), parens, `<->`-joined adjacency phrase groups, and a `:*` prefix
 *  suffix. */
function evaluateTsQuery(query: string, words: string[]): boolean {
  let pos = 0;
  const skipSpaces = () => {
    while (query[pos] === " ") pos += 1;
  };
  const parseOr = (): boolean => {
    let result = parseAnd();
    skipSpaces();
    while (query[pos] === "|") {
      pos += 1;
      skipSpaces();
      result = parseAnd() || result;
      skipSpaces();
    }
    return result;
  };
  const parseAnd = (): boolean => {
    let result = parseAtom();
    skipSpaces();
    while (query[pos] === "&") {
      pos += 1;
      skipSpaces();
      result = parseAtom() && result;
      skipSpaces();
    }
    return result;
  };
  const parseAtom = (): boolean => {
    skipSpaces();
    if (query[pos] === "!") {
      pos += 1;
      return !parseAtom();
    }
    if (query[pos] === "(") {
      pos += 1;
      const inner = parseOr();
      skipSpaces();
      if (query[pos] === ")") pos += 1;
      return inner;
    }
    const start = pos;
    while (pos < query.length && !"&|!() ".includes(query[pos])) pos += 1;
    const token = query.slice(start, pos);
    if (token.includes("<->")) return hasPhrase(words, token.split("<->"));
    if (token.endsWith(":*")) {
      const root = token.slice(0, -2);
      return words.some((word) => word.startsWith(root));
    }
    return words.includes(token);
  };
  skipSpaces();
  return parseOr();
}

function record(overrides: Partial<DocumentSearchRecord> & { blockId: string; text: string }): DocumentSearchRecord {
  return {
    documentId: "doc-1",
    documentTitle: "Fallback Fixture",
    sectionId: overrides.blockId,
    heading: "",
    headingPath: [],
    pageNumber: 1,
    blockType: "paragraph",
    ...overrides,
  };
}

async function makeLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-fallback-"));
  const database = new TsQueryFakeDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "fallback-test");
  await database.insertDocument({} as pg.PoolClient, {
    id: "doc-1",
    title: "Fallback Fixture",
    originalFilename: "doc-1.pdf",
    pdfStoragePath: "doc-1/original.pdf",
    semanticStoragePath: "doc-1/semantic-document.json",
    assetsStoragePath: "doc-1/assets",
    contentSha256: "c".repeat(64),
    extractorVersion: "fallback-test",
    pageCount: 1,
  });
  return { root, database, lifecycle };
}

describe("DocumentLifecycle fallback ladder (TKT-033)", () => {
  it("finds 'inspection' content from 'inspect' only through the prefix stage, not the strict stage", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", text: "Routine inspection completed on schedule." }),
      ]);
      // "inspect" is not a literal word in the fixture (no stemming, per the
      // `simple` tsvector this fake mirrors) -- the row is reachable only by
      // widening the final term into a prefix match.
      expect(websearchLikeMatches("inspect", wordsOf("Routine inspection completed on schedule."))).toBe(false);

      const detailed = await lifecycle.searchDetailed("inspect", 10, 5);
      expect(detailed.results.map((r) => r.blockId)).toEqual(["p-1"]);
      expect(detailed.results[0].matchClass).toBe("prefix");
      expect(detailed.strategy).toBe("prefix");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ranks strict above prefix above partial fallback, and reports the broadest strategy actually shown", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-direct", sectionId: "sec-direct", text: "Engine inspect log noted." }),
        record({ blockId: "p-prefix-only", sectionId: "sec-prefix", text: "Engine inspection filed." }),
        record({ blockId: "p-partial-only", sectionId: "sec-partial", text: "Engine bay maintenance log." }),
      ]);
      const detailed = await lifecycle.searchDetailed("engine inspect", 10, 5);
      expect(detailed.results.map((r) => r.blockId)).toEqual(["p-direct", "p-prefix-only", "p-partial-only"]);
      expect(detailed.results.map((r) => r.matchClass)).toEqual(["direct", "prefix", "partial"]);
      expect(detailed.strategy).toBe("partial");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns useful high-coverage partial results for a multiword query with no complete strict match", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        // Contains "hydraulic" only -- 1 of 2 distinct query terms.
        record({ blockId: "p-hydraulic", sectionId: "sec-h", text: "Hydraulic system overview." }),
        // Contains "calibration" only -- the other of the 2 distinct terms.
        record({ blockId: "p-calibration", sectionId: "sec-c", text: "Calibration schedule posted." }),
      ]);
      const detailed = await lifecycle.searchDetailed("hydraulic calibration", 10, 5);
      const ids = detailed.results.map((r) => r.blockId);
      expect(ids).toEqual(expect.arrayContaining(["p-hydraulic", "p-calibration"]));
      expect(detailed.results.every((r) => r.matchClass === "partial")).toBe(true);
      expect(detailed.strategy).toBe("partial");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps excluded terms excluded through every broadening stage", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-keep", sectionId: "sec-keep", text: "Engine bay inspected today." }),
        record({ blockId: "p-drop", sectionId: "sec-drop", text: "Engine aircraft bay inspected today." }),
      ]);
      const detailed = await lifecycle.searchDetailed("engine -aircraft", 10, 5);
      const ids = detailed.results.map((r) => r.blockId);
      expect(ids).not.toContain("p-drop");
      expect(ids).toContain("p-keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never lets partial fallback silently satisfy a quoted phrase with scattered, non-adjacent words", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-adjacent", sectionId: "sec-adjacent", text: "Engine inspection beacon logged." }),
        // Contains "engine" and "inspection" as separate, non-adjacent words
        // and no "beacon" at all -- must never satisfy the quoted phrase or
        // the "beacon" term through any stage.
        record({ blockId: "p-scattered", sectionId: "sec-scattered", text: "Engine overhaul finished; inspection followed separately." }),
        record({ blockId: "p-beacon-only", sectionId: "sec-beacon", text: "Beacon calibration only, mentioned here." }),
      ]);
      const detailed = await lifecycle.searchDetailed('"engine inspection" beacon', 10, 5);
      const ids = detailed.results.map((r) => r.blockId);
      expect(ids).not.toContain("p-scattered");
      expect(ids).toEqual(expect.arrayContaining(["p-adjacent", "p-beacon-only"]));
      expect(detailed.results.find((r) => r.blockId === "p-adjacent")?.matchClass).toBe("direct");
      expect(detailed.results.find((r) => r.blockId === "p-beacon-only")?.matchClass).toBe("partial");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never runs the broadening stages once strict alone reaches the useful-result threshold", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", sectionId: "sec-1", blockType: "paragraph", text: "Beacon reading one." }),
        record({ blockId: "p-2", sectionId: "sec-2", blockType: "paragraph", text: "Beacon reading two." }),
        record({ blockId: "p-3", sectionId: "sec-3", blockType: "paragraph", text: "Beacon reading three." }),
      ]);
      expect(MIN_USEFUL_RESULTS).toBeLessThanOrEqual(3);
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5);
      expect(detailed.results).toHaveLength(3);
      expect(detailed.strategy).toBe("strict");
      expect(database.searchByTsQueryCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not force broadening just to exceed a caller-requested result limit smaller than the threshold", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", sectionId: "sec-1", text: "Beacon reading only one match here." }),
      ]);
      const detailed = await lifecycle.searchDetailed("beacon", 1, 1);
      expect(detailed.results).toHaveLength(1);
      expect(detailed.strategy).toBe("strict");
      expect(database.searchByTsQueryCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("(search) the array-returning entry point matches searchDetailed's results", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", text: "Routine inspection completed." }),
      ]);
      const detailed = await lifecycle.searchDetailed("inspect", 10, 5);
      const plain = await lifecycle.search("inspect", 10, 5);
      expect(plain).toEqual(detailed.results);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
