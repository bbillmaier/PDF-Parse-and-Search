import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";
import { DocumentLifecycle, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { termsFromQuery } from "../../src/document-library.ts";
import type { DocumentSearchRecord, SearchableBlockType } from "../../src/pdf-content-extractor/index.ts";

/**
 * Fake database that mirrors the real PostgreSQL predicate: a row is a
 * candidate when every query term is present *somewhere* in its combined
 * heading + content text (the same text the generated `search_vector`
 * indexes), but `snippetSource` -- like the real `content` column -- is the
 * block's own text only. This lets a block whose own text is missing a term
 * (matched only through its ambient section heading) surface as a genuine
 * partial-coverage candidate, exactly as it would against real Postgres.
 */
class FakeBlockDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  records: DocumentSearchRecord[] = [];

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
    const terms = termsFromQuery(query);
    const rows: SearchResultRow[] = [];
    for (const record of this.records) {
      const document = this.documents.get(record.documentId);
      if (!document) continue;
      const combined = `${record.heading} ${record.text}`.toLowerCase();
      if (!terms.every((term) => combined.includes(term))) continue;
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

  // TKT-033/TKT-034: not exercised by these TKT-031 ranking fixtures (real
  // prefix/partial/english semantics are covered by the PostgreSQL-backed
  // integration tests) -- just needs to satisfy the interface.
  async searchByTsQuery(): Promise<SearchResultRow[]> {
    return [];
  }

  async searchEnglish(): Promise<SearchResultRow[]> {
    return [];
  }

  // TKT-035: not exercised by these TKT-031 ranking fixtures (real
  // vocabulary/typo semantics are covered by
  // test/unit/lifecycle-typo-search.test.ts and the PostgreSQL-backed
  // integration tests) -- an empty vocabulary means the typo-correction
  // stage always cleanly no-ops here.
  async vocabularyCandidates(): Promise<string[]> {
    return [];
  }

  async vocabularyHasTerm(): Promise<boolean> {
    return false;
  }

  // TKT-036: not exercised by these ranking fixtures -- title override is
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
}

function record(overrides: Partial<DocumentSearchRecord> & { blockId: string; text: string; blockType: SearchableBlockType }): DocumentSearchRecord {
  return {
    documentId: "doc-1",
    documentTitle: "Ranking Fixture",
    sectionId: overrides.blockId,
    heading: "",
    headingPath: [],
    pageNumber: 1,
    ...overrides,
  };
}

async function makeLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-ranking-"));
  const database = new FakeBlockDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "ranking-test");
  await database.insertDocument({} as pg.PoolClient, {
    id: "doc-1",
    title: "Ranking Fixture",
    originalFilename: "doc-1.pdf",
    pdfStoragePath: "doc-1/original.pdf",
    semanticStoragePath: "doc-1/semantic-document.json",
    assetsStoragePath: "doc-1/assets",
    contentSha256: "a".repeat(64),
    extractorVersion: "ranking-test",
    pageCount: 1,
  });
  return { root, database, lifecycle };
}

const huge =
  "beacon reading noted. ".repeat(40) +
  "unrelated filler text goes on for a while before anything else. ".repeat(60) +
  "calibration was mentioned separately much later in the same block.";

describe("DocumentLifecycle.search ranking integration (TKT-031)", () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("ranks a heading match above an equivalent body-only match end to end", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "h-1", blockType: "heading", text: "Hydraulic Calibration", heading: "Hydraulic Calibration" }),
        record({ blockId: "p-1", blockType: "paragraph", text: "Hydraulic Calibration" }),
      ]);
      const results = await lifecycle.search("hydraulic calibration", 10);
      expect(results.map((result) => result.blockId)).toEqual(["h-1", "p-1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ranks a complete phrase match above a scattered/reversed match end to end", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-phrase", blockType: "paragraph", text: "Engine inspection completed successfully." }),
        record({
          blockId: "p-scattered",
          blockType: "paragraph",
          text: "Inspection happened long after the engine was replaced entirely with a new unit.",
        }),
      ]);
      const results = await lifecycle.search("engine inspection", 10);
      expect(results.map((result) => result.blockId)).toEqual(["p-phrase", "p-scattered"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ranks a result covering all query terms above a partial result whose own text is missing one", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-full", blockType: "paragraph", text: "Hydraulic calibration for code ZX-77 completed." }),
        // Passes PostgreSQL's combined tsvector predicate only because ZX-77
        // is in the ambient section heading, not in this block's own text --
        // exactly like a real table/section where one term lives in the
        // heading and the rest live in the body.
        record({
          blockId: "p-partial",
          blockType: "paragraph",
          heading: "ZX-77 Overview Section",
          text: "Hydraulic system overview only, unrelated to calibration codes.",
        }),
      ]);
      const results = await lifecycle.search("hydraulic calibration ZX-77", 10);
      expect(results.map((result) => result.blockId)).toEqual(["p-full", "p-partial"]);
      expect(results[0].scoreComponents?.coverageRatio).toBe(1);
      expect(results[1].scoreComponents?.coverageRatio).toBeLessThan(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ranks a concise strong match above a large paragraph that only repeats the terms", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-concise", blockType: "paragraph", text: "Beacon calibration confirmed nominal." }),
        record({ blockId: "p-huge", blockType: "paragraph", text: huge }),
      ]);
      const results = await lifecycle.search("beacon calibration", 10);
      expect(results.map((result) => result.blockId)).toEqual(["p-concise", "p-huge"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("produces identical ordering and scores across repeated searches of unchanged data", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "h-1", blockType: "heading", text: "Hydraulic Calibration", heading: "Hydraulic Calibration" }),
        record({ blockId: "p-1", blockType: "paragraph", text: "Hydraulic Calibration" }),
        record({ blockId: "p-2", blockType: "table-cell", text: "Hydraulic Calibration" }),
      ]);
      const first = await lifecycle.search("hydraulic calibration", 10);
      const second = await lifecycle.search("hydraulic calibration", 10);
      const third = await lifecycle.search("hydraulic calibration", 10);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves snippet, grouping, and navigation fields alongside the new ranking", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", sectionId: "sec-1", blockType: "paragraph", pageNumber: 3, text: "Beacon reading logged once." }),
        record({ blockId: "p-2", sectionId: "sec-1", blockType: "paragraph", pageNumber: 3, text: "Beacon reading logged twice." }),
      ]);
      const results = await lifecycle.search("beacon", 10);
      expect(results).toHaveLength(1);
      const [grouped] = results;
      expect(grouped.pageNumber).toBe(3);
      expect(typeof grouped.snippet).toBe("string");
      expect(grouped.snippet.length).toBeGreaterThan(0);
      expect(grouped.matches.length).toBeGreaterThan(0);
      expect(grouped.additionalMatches).toHaveLength(1);
      expect(grouped.additionalMatches[0].blockId).not.toBe(grouped.blockId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes score diagnostics only outside production", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", blockType: "paragraph", text: "Hydraulic Calibration" }),
      ]);
      process.env.NODE_ENV = "development";
      const dev = await lifecycle.search("hydraulic", 10);
      expect(dev[0].scoreComponents).toBeDefined();

      process.env.NODE_ENV = "production";
      const prod = await lifecycle.search("hydraulic", 10);
      expect(prod[0].scoreComponents).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps hostile query text safely parameterized (no crash, no injected behavior)", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", blockType: "paragraph", text: "Hydraulic Calibration" }),
      ]);
      const results = await lifecycle.search("'; DROP TABLE documents; --", 10);
      expect(results).toEqual([]);
      expect((await lifecycle.listDocuments()).map((doc) => doc.id)).toEqual(["doc-1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
