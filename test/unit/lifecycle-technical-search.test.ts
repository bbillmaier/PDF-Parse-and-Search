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
 * TKT-034 lifecycle-level orchestration tests for the complementary
 * English-vector fallback stage, run against a fast in-memory fake (no real
 * PostgreSQL) so they exercise DocumentLifecycle's stage ordering, threshold
 * gating, and match-class tagging on every `npm run test:unit` run. The
 * fake's `searchEnglish` is a crude suffix-stripping approximation of
 * PostgreSQL's English stemmer -- good enough to prove the lifecycle wires
 * the stage correctly, not a model of real stemming, which is covered
 * end-to-end against real PostgreSQL in
 * test/integration/search-technical-vectors.integration.test.ts. Prefix and
 * partial semantics are already covered by
 * test/unit/lifecycle-prefix-fallback.test.ts, so this file's fake keeps
 * `searchByTsQuery` trivial to isolate the stage under test.
 */
class EnglishFakeDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  records: DocumentSearchRecord[] = [];
  searchEnglishCalls = 0;
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
    const { positive, excluded } = parseQueryWords(query);
    return this.matchingRows((words) => positive.every((term) => words.includes(term)) && excluded.every((term) => !words.includes(term)), limit);
  }

  // Not the subject of this file -- kept trivial (see file-level comment).
  async searchByTsQuery(): Promise<SearchResultRow[]> {
    this.searchByTsQueryCalls += 1;
    return [];
  }

  async searchEnglish(query: string, limit: number): Promise<SearchResultRow[]> {
    this.searchEnglishCalls += 1;
    const { positive, excluded } = parseQueryWords(query);
    const positiveStems = positive.map(crudeStem);
    const excludedStems = excluded.map(crudeStem);
    return this.matchingRows((words) => {
      const wordStems = words.map(crudeStem);
      return positiveStems.every((stem) => wordStems.includes(stem)) && excludedStems.every((stem) => !wordStems.includes(stem));
    }, limit);
  }

  // TKT-035: not the subject of this file (see file-level comment) -- an
  // empty vocabulary means the typo-correction stage always cleanly no-ops
  // here; real vocabulary/typo semantics are covered by
  // test/unit/lifecycle-typo-search.test.ts and the PostgreSQL-backed
  // integration tests.
  async vocabularyCandidates(): Promise<string[]> {
    return [];
  }

  async vocabularyHasTerm(): Promise<boolean> {
    return false;
  }

  // TKT-036: not exercised by these technical-vector fixtures -- title
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
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Splits already-normalized query text (src/search-query.ts's safe,
 *  space-joined output: plain words, "-excluded" words, literal "OR") into
 *  positive and excluded word lists. Good enough for this fake's fixtures,
 *  which never use quoted phrases or OR. */
function parseQueryWords(query: string): { positive: string[]; excluded: string[] } {
  const positive: string[] = [];
  const excluded: string[] = [];
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("-")) excluded.push(token.slice(1));
    else if (token !== "or") positive.push(token);
  }
  return { positive, excluded };
}

function crudeStem(word: string): string {
  return word.replace(/(ing|ions|ion|ed|s)$/, "");
}

function record(overrides: Partial<DocumentSearchRecord> & { blockId: string; text: string }): DocumentSearchRecord {
  return {
    documentId: "doc-1",
    documentTitle: "Stemmed Fixture",
    sectionId: overrides.blockId,
    heading: "",
    headingPath: [],
    pageNumber: 1,
    blockType: "paragraph",
    ...overrides,
  };
}

async function makeLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-technical-search-"));
  const database = new EnglishFakeDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "technical-search-test");
  await database.insertDocument({} as pg.PoolClient, {
    id: "doc-1",
    title: "Stemmed Fixture",
    originalFilename: "doc-1.pdf",
    pdfStoragePath: "doc-1/original.pdf",
    semanticStoragePath: "doc-1/semantic-document.json",
    assetsStoragePath: "doc-1/assets",
    contentSha256: "d".repeat(64),
    extractorVersion: "technical-search-test",
    pageCount: 1,
  });
  return { root, database, lifecycle };
}

describe("DocumentLifecycle complementary English-vector stage (TKT-034)", () => {
  it("reaches a word-form match unreachable by direct matching, tagged 'stemmed', ranked below the direct match", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-direct", sectionId: "sec-direct", text: "Component inspection filed on schedule." }),
        // No literal "inspection" here -- only reachable by relating
        // "inspected" to the query term through the English-vector stage.
        record({ blockId: "p-stem-only", sectionId: "sec-stem", text: "Component inspected yesterday during maintenance." }),
      ]);

      const detailed = await lifecycle.searchDetailed("inspection", 10, 5);
      const ids = detailed.results.map((r) => r.blockId);
      expect(ids).toEqual(["p-direct", "p-stem-only"]);
      expect(detailed.results.map((r) => r.matchClass)).toEqual(["direct", "stemmed"]);
      expect(detailed.strategy).toBe("stemmed");
      expect(database.searchEnglishCalls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never runs the English-vector stage once direct results alone reach the useful-result threshold", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", sectionId: "sec-1", text: "Beacon reading one." }),
        record({ blockId: "p-2", sectionId: "sec-2", text: "Beacon reading two." }),
        record({ blockId: "p-3", sectionId: "sec-3", text: "Beacon reading three." }),
      ]);
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5);
      expect(detailed.results).toHaveLength(3);
      expect(detailed.strategy).toBe("strict");
      expect(database.searchEnglishCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps excluded terms excluded through the English-vector stage", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-keep", sectionId: "sec-keep", text: "Engine inspected today, fully nominal." }),
        record({ blockId: "p-drop", sectionId: "sec-drop", text: "Engine inspected today with a fuel leak." }),
      ]);
      // Neither row has literal "inspection", so both are only reachable
      // through the stemmed stage -- the exclusion must still hold there.
      const detailed = await lifecycle.searchDetailed("inspection -leak", 10, 5);
      const ids = detailed.results.map((r) => r.blockId);
      expect(ids).toContain("p-keep");
      expect(ids).not.toContain("p-drop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("(search) the array-returning entry point matches searchDetailed's stemmed results", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [record({ blockId: "p-1", text: "Component inspected yesterday." })]);
      const detailed = await lifecycle.searchDetailed("inspection", 10, 5);
      const plain = await lifecycle.search("inspection", 10, 5);
      expect(plain).toEqual(detailed.results);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
