import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";
import { DocumentLifecycle, ValidationError, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { MAX_QUERY_TERMS } from "../../src/search-query.ts";

/**
 * Counts calls to `search` so tests can prove punctuation-only/empty input
 * never reaches the database (TKT-032), and records the exact string the
 * lifecycle handed to the database so tests can assert on the normalized
 * web-style query text without needing a real PostgreSQL connection.
 */
class CountingDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  searchCalls = 0;
  lastQuery: string | undefined;
  searchByTsQueryCalls = 0;
  lastTsQuery: string | undefined;
  searchEnglishCalls = 0;

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return work({} as pg.PoolClient);
  }

  async insertDocument(_client: pg.PoolClient, input: DocumentRowInput): Promise<void> {
    this.documents.set(input.id, { ...input, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
  }

  async insertSearchRecords(): Promise<void> {}

  async listDocuments(): Promise<DocumentRow[]> {
    return [...this.documents.values()];
  }

  async getDocument(id: string): Promise<DocumentRow | undefined> {
    return this.documents.get(id);
  }

  async deleteDocument(id: string): Promise<boolean> {
    return this.documents.delete(id);
  }

  async search(query: string): Promise<SearchResultRow[]> {
    this.searchCalls += 1;
    this.lastQuery = query;
    return [];
  }

  // TKT-033: this fake never needs to emulate real prefix/partial tsquery
  // semantics -- that is covered by the PostgreSQL-backed integration tests
  // -- it only needs to satisfy the interface and record what was asked,
  // kept in a separate field from `lastQuery` so the TKT-032 assertions
  // above stay unaffected by the fallback ladder also calling this method.
  async searchByTsQuery(tsQuery: string): Promise<SearchResultRow[]> {
    this.searchByTsQueryCalls += 1;
    this.lastTsQuery = tsQuery;
    return [];
  }

  // TKT-034: this fake never needs to emulate real English-stemming
  // semantics -- that is covered by the PostgreSQL-backed integration tests
  // -- it only needs to satisfy the interface and record that it was asked.
  async searchEnglish(): Promise<SearchResultRow[]> {
    this.searchEnglishCalls += 1;
    return [];
  }

  // TKT-035: this fake never needs to emulate real vocabulary/typo
  // semantics -- that is covered by test/unit/lifecycle-typo-search.test.ts
  // and the PostgreSQL-backed integration tests -- an empty vocabulary means
  // the typo-correction stage always cleanly no-ops here.
  async vocabularyCandidates(): Promise<string[]> {
    return [];
  }

  async vocabularyHasTerm(): Promise<boolean> {
    return false;
  }

  // TKT-036: not exercised by these search-syntax fixtures -- title
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
}

async function makeLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-search-syntax-"));
  const database = new CountingDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "search-syntax-test");
  return { root, database, lifecycle };
}

describe("DocumentLifecycle.search query validation (TKT-032)", () => {
  it("returns empty results without querying the database for blank input", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      expect(await lifecycle.search("   ", 10)).toEqual([]);
      expect(database.searchCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects punctuation-only input with a validation error instead of querying the database", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await expect(lifecycle.search("!!!", 10)).rejects.toBeInstanceOf(ValidationError);
      await expect(lifecycle.search("---", 10)).rejects.toThrow(/no searchable words/);
      await expect(lifecycle.search('""', 10)).rejects.toThrow(/no searchable words/);
      expect(database.searchCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an exclusion-only query before hitting the database", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await expect(lifecycle.search("-aircraft", 10)).rejects.toThrow(/only excludes terms/);
      expect(database.searchCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a query with more distinct terms than the bound before hitting the database", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      const words = Array.from({ length: MAX_QUERY_TERMS + 1 }, (_, index) => `word${index}`).join(" ");
      await expect(lifecycle.search(words, 10)).rejects.toThrow(/too many terms/);
      expect(database.searchCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends the normalized web-style query text to the database, not raw user input", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await lifecycle.search('Engine   "inspection Report" -Aircraft or Helicopter', 10);
      expect(database.lastQuery).toBe('engine "inspection report" -aircraft OR helicopter');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps hostile input safely parameterized: it is reduced to plain words, never reaches the database as SQL/tsquery syntax", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await lifecycle.search("'; DROP TABLE documents; --", 10);
      expect(database.lastQuery).toBe("drop table documents");
      expect(database.lastQuery).not.toMatch(/[';]/);
      expect((await lifecycle.listDocuments())).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
