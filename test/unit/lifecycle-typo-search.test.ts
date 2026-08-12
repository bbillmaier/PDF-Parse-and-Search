import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";
import { DocumentLifecycle, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { groupAndCapSearchResults, type SearchResultCandidate } from "../../src/document-library.ts";
import { MAX_CANDIDATES_EXAMINED_PER_TERM, MAX_TERMS_CORRECTED_PER_QUERY } from "../../src/search-typo.ts";
import type { DocumentSearchRecord } from "../../src/pdf-content-extractor/index.ts";

/**
 * TKT-035 lifecycle-level orchestration tests for the bounded, vocabulary-
 * based typo-correction stage, run against a fast in-memory fake (no real
 * PostgreSQL) so they exercise DocumentLifecycle's threshold gating,
 * candidate filtering, and total-work bounds on every `npm run test:unit`
 * run. The fake's `searchByTsQuery`/`searchEnglish` always return no rows
 * (this file's subject is the last-resort typo stage, not prefix/stemmed/
 * synonym broadening -- those have their own dedicated test files), so any
 * query this file exercises that a real corpus's prefix/partial passes
 * might otherwise also reach instead only ever reaches the typo stage,
 * keeping these tests unambiguous about which stage produced a result. Real
 * vocabulary population from indexed titles/headings/technical identifiers
 * is exercised end-to-end against real PostgreSQL in
 * test/integration/search-synonyms-typos.integration.test.ts; this fake's
 * `vocabulary` is a plain, directly-seeded `Set<string>` so orchestration
 * (not vocabulary *construction*) is what is under test here.
 */
class TypoFakeDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  records: DocumentSearchRecord[] = [];
  vocabulary = new Set<string>();
  vocabularyHasTermCalls: string[] = [];
  vocabularyCandidateCalls: { prefix: string; minLength: number; maxLength: number; limit: number }[] = [];
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
    const terms = query.toLowerCase().split(/\s+/).filter((word) => word !== "or" && !word.startsWith("-"));
    const excluded = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.startsWith("-"))
      .map((word) => word.slice(1));
    const rows: SearchResultRow[] = [];
    for (const record of this.records) {
      const document = this.documents.get(record.documentId);
      if (!document) continue;
      const combined = `${record.heading} ${record.text}`.toLowerCase();
      if (!terms.every((term) => combined.includes(term))) continue;
      if (excluded.some((term) => combined.includes(term))) continue;
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

  // This file's subject is the last-resort typo stage -- every broadening
  // stage in between (prefix/synonym/partial) always reports no rows here,
  // so a query only ever reaches the typo stage through the documented
  // "still empty/weak after everything else" gate, never by coincidence.
  async searchByTsQuery(): Promise<SearchResultRow[]> {
    this.searchByTsQueryCalls += 1;
    return [];
  }

  async searchEnglish(): Promise<SearchResultRow[]> {
    return [];
  }

  async vocabularyCandidates(prefix: string, minLength: number, maxLength: number, limit: number): Promise<string[]> {
    this.vocabularyCandidateCalls.push({ prefix, minLength, maxLength, limit });
    return [...this.vocabulary].filter((term) => term.startsWith(prefix) && term.length >= minLength && term.length <= maxLength).slice(0, limit);
  }

  async vocabularyHasTerm(term: string): Promise<boolean> {
    this.vocabularyHasTermCalls.push(term);
    return this.vocabulary.has(term);
  }

  // TKT-036: not exercised by these typo-correction fixtures -- title
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

function record(overrides: Partial<DocumentSearchRecord> & { blockId: string; text: string }): DocumentSearchRecord {
  return {
    documentId: "doc-1",
    documentTitle: "Typo Fixture",
    sectionId: overrides.blockId,
    heading: "",
    headingPath: [],
    pageNumber: 1,
    blockType: "paragraph",
    ...overrides,
  };
}

async function makeLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-typo-search-"));
  const database = new TypoFakeDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "typo-test");
  await database.insertDocument({} as pg.PoolClient, {
    id: "doc-1",
    title: "Typo Fixture",
    originalFilename: "doc-1.pdf",
    pdfStoragePath: "doc-1/original.pdf",
    semanticStoragePath: "doc-1/semantic-document.json",
    assetsStoragePath: "doc-1/assets",
    contentSha256: "f".repeat(64),
    extractorVersion: "typo-test",
    pageCount: 1,
  });
  return { root, database, lifecycle };
}

describe("DocumentLifecycle bounded typo correction (TKT-035)", () => {
  it("'inspeciton' suggests and searches 'inspection' after an unsuccessful direct search", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.vocabulary.add("inspection");
      await database.insertSearchRecords({} as pg.PoolClient, [record({ blockId: "p-1", text: "Routine inspection completed on schedule." })]);

      const detailed = await lifecycle.searchDetailed("inspeciton", 10, 5);
      expect(detailed.results.map((r) => r.blockId)).toEqual(["p-1"]);
      expect(detailed.results[0].matchClass).toBe("corrected");
      expect(detailed.strategy).toBe("corrected");
      expect(detailed.correctedQuery).toBe("inspection");
      expect(detailed.spellingCorrections).toEqual([{ originalTerm: "inspeciton", correctedTerm: "inspection", distance: 2, alternatives: [] }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not invoke typo fallback for a successful, correctly spelled query", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.vocabulary.add("beacon");
      await database.insertSearchRecords({} as pg.PoolClient, [
        record({ blockId: "p-1", sectionId: "sec-1", text: "Beacon reading one." }),
        record({ blockId: "p-2", sectionId: "sec-2", text: "Beacon reading two." }),
        record({ blockId: "p-3", sectionId: "sec-3", text: "Beacon reading three." }),
      ]);
      const detailed = await lifecycle.searchDetailed("beacon", 10, 5);
      expect(detailed.results).toHaveLength(3);
      expect(detailed.strategy).toBe("strict");
      expect(detailed.correctedQuery).toBeUndefined();
      expect(database.vocabularyHasTermCalls).toHaveLength(0);
      expect(database.vocabularyCandidateCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not manufacture a correction for an irrelevant term with no close vocabulary neighbor", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.vocabulary.add("inspection");
      database.vocabulary.add("hydraulic");
      await database.insertSearchRecords({} as pg.PoolClient, [record({ blockId: "p-1", text: "Routine inspection completed." })]);

      const detailed = await lifecycle.searchDetailed("zzzxyzabc", 10, 5);
      expect(detailed.results).toHaveLength(0);
      expect(detailed.correctedQuery).toBeUndefined();
      expect(detailed.spellingCorrections).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters candidates by prefix and length before edit distance -- a same-distance word with a different prefix is never suggested", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.vocabulary.add("inspection");
      // Same rough edit distance to "inspeciton" but a different leading
      // prefix -- must be excluded by the prefix filter regardless.
      database.vocabulary.add("zzspeciton");
      await database.insertSearchRecords({} as pg.PoolClient, [record({ blockId: "p-1", text: "Routine inspection completed." })]);

      const detailed = await lifecycle.searchDetailed("inspeciton", 10, 5);
      expect(detailed.spellingCorrections?.[0].correctedTerm).toBe("inspection");
      expect(detailed.spellingCorrections?.[0].alternatives).not.toContain("zzspeciton");
      const call = database.vocabularyCandidateCalls[0];
      expect(call.prefix).toBe("in");
      expect(call.minLength).toBeLessThanOrEqual("inspeciton".length);
      expect(call.maxLength).toBeGreaterThanOrEqual("inspeciton".length);
      expect(call.limit).toBe(MAX_CANDIDATES_EXAMINED_PER_TERM);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds total fallback work to MAX_TERMS_CORRECTED_PER_QUERY query terms", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      // Four misspelled-looking terms, none in the vocabulary -- only the
      // first MAX_TERMS_CORRECTED_PER_QUERY are ever even checked.
      await lifecycle.searchDetailed("alfaterm bravoterm charlieterm deltaterm", 10, 5);
      expect(database.vocabularyHasTermCalls.length).toBeLessThanOrEqual(MAX_TERMS_CORRECTED_PER_QUERY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never attempts to correct a word inside a quoted phrase or an excluded term", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.vocabulary.add("extra");
      await lifecycle.searchDetailed('"engine inspeciton" -aircrapht extra', 10, 5);
      expect(database.vocabularyHasTermCalls).not.toContain("inspeciton");
      expect(database.vocabularyHasTermCalls).not.toContain("aircrapht");
      expect(database.vocabularyHasTermCalls).toContain("extra");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never treats an already-known vocabulary word as a typo", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.vocabulary.add("beacon");
      await lifecycle.searchDetailed("beacon", 10, 5);
      // vocabularyHasTerm is checked (to decide it is not a typo) but no
      // candidate lookup ever follows for an already-known word.
      expect(database.vocabularyHasTermCalls).toContain("beacon");
      expect(database.vocabularyCandidateCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Corrected-match ranking guarantee (TKT-035)", () => {
  function candidate(overrides: Partial<SearchResultCandidate> & Pick<SearchResultCandidate, "blockId" | "matchClass" | "rank">): SearchResultCandidate {
    return {
      documentId: "doc-1",
      documentTitle: "Ranking Fixture",
      sectionId: overrides.blockId,
      heading: "",
      headingPath: [],
      pageNumber: 1,
      blockType: "paragraph",
      snippet: "text",
      matches: [],
      ...overrides,
    };
  }

  it("ranks a corrected-term match below direct, prefix, and synonym matches regardless of numeric score", () => {
    const results = groupAndCapSearchResults(
      [
        // Deliberately inverted scores: "corrected" scores highest, but
        // MATCH_CLASS_TIER (src/document-library.ts) must still place it last.
        candidate({ blockId: "p-corrected", sectionId: "sec-corrected", matchClass: "corrected", rank: 999 }),
        candidate({ blockId: "p-partial", sectionId: "sec-partial", matchClass: "partial", rank: 50 }),
        candidate({ blockId: "p-synonym", sectionId: "sec-synonym", matchClass: "synonym", rank: 40 }),
        candidate({ blockId: "p-prefix", sectionId: "sec-prefix", matchClass: "prefix", rank: 30 }),
        candidate({ blockId: "p-direct", sectionId: "sec-direct", matchClass: "direct", rank: 1 }),
      ],
      { perDocumentCap: 10, totalLimit: 10 },
    );
    expect(results.map((r) => r.blockId)).toEqual(["p-direct", "p-prefix", "p-synonym", "p-partial", "p-corrected"]);
  });
});
