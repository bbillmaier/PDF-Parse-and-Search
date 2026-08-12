import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";
import { DocumentLifecycle, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import type { DocumentSearchRecord } from "../../src/pdf-content-extractor/index.ts";

/**
 * TKT-035 lifecycle-level orchestration tests for the domain-synonym
 * expansion stage, run against a fast in-memory fake (no real PostgreSQL) so
 * they exercise DocumentLifecycle's stage ordering, threshold gating, and
 * match-class tagging on every `npm run test:unit` run. The fake's
 * `searchByTsQuery` interprets the same small `tsquery` grammar
 * src/search-synonyms.ts emits (`&`, `|`, `!`, `<->`, parens) against
 * word-tokenized text -- the real GIN-indexed PostgreSQL behavior for the
 * same scenarios is separately verified end-to-end in
 * test/integration/search-synonyms-typos.integration.test.ts.
 *
 * `vocabularyHasTerm` always returns `true` here, which makes the TKT-035
 * typo-correction stage (a different fallback stage, not this file's
 * subject) always decline immediately -- see server/lifecycle.ts's
 * `attemptTypoCorrection`: a term already "known" is never treated as a
 * typo. This isolates the synonym-stage assertions below from the
 * typo-correction stage, which has its own dedicated test file.
 */
class SynonymFakeDatabase implements DocumentDatabase {
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

  async searchEnglish(): Promise<SearchResultRow[]> {
    return [];
  }

  async vocabularyCandidates(): Promise<string[]> {
    return [];
  }

  async vocabularyHasTerm(): Promise<boolean> {
    return true;
  }

  // TKT-036: not exercised by these synonym fixtures -- title override is
  // covered by test/unit/server-api.test.ts and the PostgreSQL-backed
  // integration tests.
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

/** Splits on top-level " OR " into AND-groups and matches if any group's
 *  words/phrase/exclusion requirements all hold -- real OR-group semantics
 *  (unlike test/unit/lifecycle-prefix-fallback.test.ts's simpler fake, whose
 *  fixtures never combine OR with the strict pass), needed here so an OR
 *  query's strict pass behaves correctly and this file's OR test does not
 *  need to rely on a broadening stage to prove the point. */
function websearchLikeMatches(query: string, words: string[]): boolean {
  return query.split(" OR ").some((group) => groupMatches(group, words));
}

function groupMatches(group: string, words: string[]): boolean {
  const tokenRe = /"([^"]*)"|(-)?(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(group)) !== null) {
    if (match[1] !== undefined) {
      if (!hasPhrase(words, match[1].split(/\s+/).filter(Boolean))) return false;
      continue;
    }
    const word = match[3];
    if (match[2] === "-") {
      if (words.includes(word)) return false;
    } else if (!words.includes(word)) {
      return false;
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

/** Same small recursive-descent evaluator shape as
 *  test/unit/lifecycle-prefix-fallback.test.ts, for the `tsquery` grammar
 *  src/search-synonyms.ts's buildSynonymTsQuery emits: `&`, `|`, `!`,
 *  parens, and `<->`-joined adjacency phrase groups (no `:*` prefix suffix
 *  -- this stage never prefixes). */
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
    return words.includes(token);
  };
  skipSpaces();
  return parseOr();
}

function record(overrides: Partial<DocumentSearchRecord> & { blockId: string; text: string }): DocumentSearchRecord {
  return {
    documentId: "doc-1",
    documentTitle: "Synonym Fixture",
    sectionId: overrides.blockId,
    heading: "",
    headingPath: [],
    pageNumber: 1,
    blockType: "paragraph",
    ...overrides,
  };
}

async function makeLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-synonym-search-"));
  const database = new SynonymFakeDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "synonym-test");
  await database.insertDocument({} as pg.PoolClient, {
    id: "doc-1",
    title: "Synonym Fixture",
    originalFilename: "doc-1.pdf",
    pdfStoragePath: "doc-1/original.pdf",
    semanticStoragePath: "doc-1/semantic-document.json",
    assetsStoragePath: "doc-1/assets",
    contentSha256: "e".repeat(64),
    extractorVersion: "synonym-test",
    pageCount: 1,
  });
  return { root, database, lifecycle };
}

describe("DocumentLifecycle domain-synonym expansion (TKT-035)", () => {
  it("a configured synonym finds content that only contains the widened term, ranked below a direct match", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-direct", sectionId: "sec-direct", text: "Flu shots are administered every autumn." }),
        // No literal "flu" here -- only reachable by widening the query to
        // the configured synonym "influenza".
        record({ blockId: "p-synonym-only", sectionId: "sec-syn", text: "Influenza cases rose this winter." }),
      ]);
      const detailed = await lifecycle.searchDetailed("flu", 10, 5);
      const ids = detailed.results.map((r) => r.blockId);
      expect(ids).toEqual(["p-direct", "p-synonym-only"]);
      expect(detailed.results.map((r) => r.matchClass)).toEqual(["direct", "synonym"]);
      expect(detailed.strategy).toBe("synonym");
      expect(database.searchByTsQueryCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expand in the reverse direction unless a reverse rule is configured", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        // Contains "flu" but not "influenza" -- must NOT be reachable by
        // searching "influenza", since "influenza" -> "flu" is not configured.
        record({ blockId: "p-flu-only", sectionId: "sec-flu", text: "Flu season peaked in January." }),
      ]);
      const detailed = await lifecycle.searchDetailed("influenza", 10, 5);
      expect(detailed.results.map((r) => r.blockId)).not.toContain("p-flu-only");
      expect(detailed.strategy).not.toBe("synonym");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps excluded terms excluded through the synonym-expansion stage", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-keep", sectionId: "sec-keep", text: "Influenza vaccination completed today." }),
        record({ blockId: "p-drop", sectionId: "sec-drop", text: "Influenza vaccination completed today at the clinic." }),
      ]);
      // Neither row has the literal word "flu" -- both are only reachable
      // through the synonym stage. The exclusion must still hold there.
      const detailed = await lifecycle.searchDetailed("flu -clinic", 10, 5);
      const ids = detailed.results.map((r) => r.blockId);
      expect(ids).toContain("p-keep");
      expect(ids).not.toContain("p-drop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never silently expands a word inside a quoted phrase", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-phrase", sectionId: "sec-phrase", text: "The flu season guidance was updated." }),
        // Only reachable if "flu" inside the quoted phrase were (incorrectly)
        // widened to "influenza" -- must never be found.
        record({ blockId: "p-should-not-match", sectionId: "sec-no", text: "Influenza season guidance changed." }),
      ]);
      const detailed = await lifecycle.searchDetailed('"flu season"', 10, 5);
      const ids = detailed.results.map((r) => r.blockId);
      expect(ids).toContain("p-phrase");
      expect(ids).not.toContain("p-should-not-match");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves explicit OR behavior -- an OR query is answered directly and never sent through the synonym-expansion stage", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-headache", sectionId: "sec-h", text: "Headache reported by staff member." }),
      ]);
      const detailed = await lifecycle.searchDetailed("flu OR headache", 10, 5);
      // websearch_to_tsquery's own OR handling in the strict pass already
      // finds this directly -- it does not need any broadening stage, and in
      // particular the synonym stage must never have run its own extra query
      // for an OR query (see buildSynonymTsQuery's documented decision).
      expect(detailed.results.map((r) => r.blockId)).toEqual(["p-headache"]);
      expect(detailed.results[0].matchClass).toBe("direct");
      expect(detailed.strategy).toBe("strict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never runs the synonym stage once strict results alone reach the useful-result threshold", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", sectionId: "sec-1", text: "Flu reading one." }),
        record({ blockId: "p-2", sectionId: "sec-2", text: "Flu reading two." }),
        record({ blockId: "p-3", sectionId: "sec-3", text: "Flu reading three." }),
      ]);
      const detailed = await lifecycle.searchDetailed("flu", 10, 5);
      expect(detailed.results).toHaveLength(3);
      expect(detailed.strategy).toBe("strict");
      expect(database.searchByTsQueryCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes synonym-expansion diagnostics only in non-production mode, tied to the visible synonym-class result", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    const previousEnv = process.env.NODE_ENV;
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [record({ blockId: "p-synonym-only", text: "Influenza cases logged." })]);

      process.env.NODE_ENV = "development";
      const dev = await lifecycle.searchDetailed("flu", 10, 5);
      expect(dev.synonymExpansions).toEqual([{ term: "flu", expandedTerms: ["influenza"] }]);

      process.env.NODE_ENV = "production";
      const prod = await lifecycle.searchDetailed("flu", 10, 5);
      expect(prod.synonymExpansions).toBeUndefined();
      expect(prod.strategy).toBe("synonym");
    } finally {
      process.env.NODE_ENV = previousEnv;
      await rm(root, { recursive: true, force: true });
    }
  });
});
