import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";
import { DocumentLifecycle, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import type { DocumentSearchRecord } from "../../src/pdf-content-extractor/index.ts";
import type { SearchFilters } from "../../src/search-filters.ts";

/**
 * TKT-037 lifecycle-level orchestration tests for search filters, run
 * against a fast in-memory fake (no real PostgreSQL) so they exercise
 * DocumentLifecycle's filter validation and threading through every query
 * strategy on every `npm run test:unit` run. The fake applies filters itself
 * (mirroring the real SQL predicate in server/database.ts closely enough to
 * prove *composition*, not to replace the real-SQL coverage in
 * test/integration/search-filters.integration.test.ts). Every DocumentDatabase
 * method the fallback ladder can reach (search/searchByTsQuery/searchEnglish)
 * applies the same filter function, so a filter's effect on any one of them
 * proves it works for every strategy that funnels through it.
 */
class FilterFakeDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  records: DocumentSearchRecord[] = [];
  vocabulary = new Set<string>();
  calls: { method: string; filters?: SearchFilters }[] = [];

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

  private matchesFilters(record: DocumentSearchRecord, filters?: SearchFilters): boolean {
    if (!filters) return true;
    if (filters.documentId !== undefined && record.documentId !== filters.documentId) return false;
    if (filters.page !== undefined && record.pageNumber !== filters.page) return false;
    if (filters.pageRange !== undefined && (record.pageNumber < filters.pageRange.start || record.pageNumber > filters.pageRange.end)) return false;
    if (filters.sectionId !== undefined && record.sectionId !== filters.sectionId) return false;
    if (filters.blockType !== undefined && record.blockType !== filters.blockType) return false;
    return true;
  }

  private toRow(record: DocumentSearchRecord): SearchResultRow {
    const document = this.documents.get(record.documentId)!;
    return {
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
    };
  }

  async search(query: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]> {
    this.calls.push({ method: "search", filters });
    const terms = query.toLowerCase().split(/\s+/).filter((word) => word !== "or" && !word.startsWith("-"));
    const rows = this.records
      .filter((record) => this.matchesFilters(record, filters))
      .filter((record) => terms.every((term) => `${record.heading} ${record.text}`.toLowerCase().includes(term)))
      .map((record) => this.toRow(record));
    return rows.slice(0, limit);
  }

  async searchByTsQuery(_tsQuery: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]> {
    this.calls.push({ method: "searchByTsQuery", filters });
    return this.records
      .filter((record) => this.matchesFilters(record, filters))
      .map((record) => this.toRow(record))
      .slice(0, limit);
  }

  async searchEnglish(_query: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]> {
    this.calls.push({ method: "searchEnglish", filters });
    return this.records
      .filter((record) => this.matchesFilters(record, filters))
      .map((record) => this.toRow(record))
      .slice(0, limit);
  }

  async vocabularyCandidates(): Promise<string[]> {
    return [];
  }

  async vocabularyHasTerm(term: string): Promise<boolean> {
    return this.vocabulary.has(term);
  }

  async updateDocumentTitle(): Promise<boolean> {
    return false;
  }

  async reindexDocumentVocabulary(): Promise<{ blocksSeen: number; blocksUpdated: number; vocabularyTermsWritten: number; suggestionsWritten: number }> {
    return { blocksSeen: 0, blocksUpdated: 0, vocabularyTermsWritten: 0, suggestionsWritten: 0 };
  }

  async suggest(): Promise<{ documentId: string; type: "title" | "heading" | "technical"; text: string }[]> {
    return [];
  }
}

function record(overrides: Partial<DocumentSearchRecord> & Pick<DocumentSearchRecord, "blockId" | "text">): DocumentSearchRecord {
  return {
    documentId: "doc-1",
    documentTitle: "Filter Fixture",
    sectionId: overrides.blockId,
    heading: "",
    headingPath: [],
    pageNumber: 1,
    blockType: "paragraph",
    ...overrides,
  };
}

async function makeLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-filter-search-"));
  const database = new FilterFakeDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "filter-test");
  for (const id of ["doc-1", "doc-2"]) {
    await database.insertDocument({} as pg.PoolClient, {
      id,
      title: id === "doc-1" ? "Hydraulic Manual" : "Electrical Manual",
      originalFilename: `${id}.pdf`,
      pdfStoragePath: `${id}/original.pdf`,
      semanticStoragePath: `${id}/semantic-document.json`,
      assetsStoragePath: `${id}/assets`,
      contentSha256: id === "doc-1" ? "a".repeat(64) : "b".repeat(64),
      extractorVersion: "filter-test",
      pageCount: 5,
    });
  }
  return { root, database, lifecycle };
}

describe("DocumentLifecycle search filters (TKT-037)", () => {
  it("filters strict search results by documentId", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", text: "Beacon reading noted." }),
        record({ blockId: "p-2", text: "Beacon reading noted.", documentId: "doc-2", sectionId: "p-2" }),
      ]);
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5, { documentId: "doc-1" });
      expect(detailed.results.map((r) => r.documentId)).toEqual(["doc-1"]);
      expect(detailed.filters).toEqual({ documentId: "doc-1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters by a single page", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", text: "Beacon page one.", pageNumber: 1 }),
        record({ blockId: "p-2", text: "Beacon page two.", pageNumber: 2, sectionId: "p-2" }),
      ]);
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5, { page: "2" });
      expect(detailed.results.map((r) => r.blockId)).toEqual(["p-2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters by a bounded page range", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", text: "Beacon page one.", pageNumber: 1, sectionId: "p-1" }),
        record({ blockId: "p-2", text: "Beacon page three.", pageNumber: 3, sectionId: "p-2" }),
        record({ blockId: "p-3", text: "Beacon page five.", pageNumber: 5, sectionId: "p-3" }),
      ]);
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5, { pageStart: "2", pageEnd: "4" });
      expect(detailed.results.map((r) => r.blockId)).toEqual(["p-2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters by sectionId", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", text: "Beacon one.", sectionId: "sec-a" }),
        record({ blockId: "p-2", text: "Beacon two.", sectionId: "sec-b" }),
      ]);
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5, { sectionId: "sec-b" });
      expect(detailed.results.map((r) => r.blockId)).toEqual(["p-2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters by semantic block type", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "h-1", text: "Beacon heading.", blockType: "heading" }),
        record({ blockId: "p-1", text: "Beacon paragraph.", blockType: "paragraph", sectionId: "h-1" }),
      ]);
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5, { blockType: "heading" });
      expect(detailed.results.map((r) => r.blockId)).toEqual(["h-1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("composes a filter with every query strategy: strict, prefix, and partial fallback", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", text: "Inspection completed today.", documentId: "doc-1", sectionId: "p-1" }),
        record({ blockId: "p-2", text: "Inspection completed today.", documentId: "doc-2", sectionId: "p-2" }),
      ]);
      // The fake's searchByTsQuery/searchEnglish are simplistic (no real
      // tsquery/stemming semantics), so this only proves *filters reach*
      // every strategy call, not the strategy's own matching logic -- that
      // is covered against real PostgreSQL in
      // test/integration/search-filters.integration.test.ts.
      await lifecycle.searchDetailed("inspection", 10, 5, { documentId: "doc-1" });
      for (const call of database.calls) {
        expect(call.filters).toEqual({ documentId: "doc-1" });
      }
      expect(database.calls.some((c) => c.method === "search")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid filter with a ValidationError before any query runs", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await expect(lifecycle.searchDetailed("beacon", 10, 5, { blockType: "document-title" })).rejects.toThrow();
      await expect(lifecycle.searchDetailed("beacon", 10, 5, { page: "-1" })).rejects.toThrow();
      await expect(lifecycle.searchDetailed("beacon", 10, 5, { documentId: "'; DROP TABLE documents; --" })).rejects.toThrow();
      expect(database.calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("echoes an empty filters object when no filter is supplied", async () => {
    const { root, lifecycle } = await makeLifecycle();
    try {
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5);
      expect(detailed.filters).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty results with echoed filters for an empty query, without validating filters against the database", async () => {
    const { root, lifecycle } = await makeLifecycle();
    try {
      const detailed = await lifecycle.searchDetailed("", 10, 5, { documentId: "doc-1" });
      expect(detailed).toEqual({ results: [], strategy: "strict", filters: { documentId: "doc-1" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
