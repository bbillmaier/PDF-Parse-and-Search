import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";
import { DocumentLifecycle, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { generateDocumentSearchRecords, type DocumentSearchRecord, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

class MemoryDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  records: DocumentSearchRecord[] = [];
  failInserts = false;

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const beforeDocs = new Map(this.documents);
    const beforeRecords = [...this.records];
    try {
      return await work({} as pg.PoolClient);
    } catch (error) {
      this.documents = beforeDocs;
      this.records = beforeRecords;
      throw error;
    }
  }

  async insertDocument(_client: pg.PoolClient, input: DocumentRowInput): Promise<void> {
    if (this.failInserts) throw new Error("injected database failure");
    for (const existing of this.documents.values()) {
      if (existing.title === input.title || existing.contentSha256 === input.contentSha256) {
        const error = new Error("duplicate") as Error & { code: string };
        error.code = "23505";
        throw error;
      }
    }
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
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const blockResults = this.records
      .filter((record) => terms.every((term) => `${record.heading} ${record.text} ${record.documentTitle}`.toLowerCase().includes(term)))
      .map((record) => ({
        documentId: record.documentId,
        documentTitle: record.documentTitle,
        blockId: record.blockId,
        sectionId: record.sectionId,
        heading: record.heading,
        headingPath: record.headingPath,
        pageNumber: record.pageNumber,
        blockType: record.blockType,
        snippetSource: record.text,
        rank: record.blockType === "heading" ? 2 : 1,
      }));
    const titleResults = [...this.documents.values()]
      .filter((document) => terms.every((term) => document.title.toLowerCase().includes(term)))
      .map((document) => ({
        documentId: document.id,
        documentTitle: document.title,
        blockId: document.id,
        sectionId: document.id,
        heading: document.title,
        headingPath: [],
        pageNumber: 1,
        blockType: "document-title" as const,
        snippetSource: document.title,
        rank: 3,
      }));
    return [...titleResults, ...blockResults]
      .sort((a, b) => b.rank - a.rank || a.documentTitle.localeCompare(b.documentTitle) || a.pageNumber - b.pageNumber)
      .slice(0, limit);
  }

  // TKT-033/TKT-034: not exercised by these fixtures beyond satisfying the
  // interface -- real prefix/partial/english semantics are covered by the
  // PostgreSQL-backed integration tests.
  async searchByTsQuery(): Promise<SearchResultRow[]> {
    return [];
  }

  async searchEnglish(): Promise<SearchResultRow[]> {
    return [];
  }

  // TKT-035: not exercised by these fixtures beyond satisfying the
  // interface -- real vocabulary/typo semantics are covered by
  // test/unit/lifecycle-typo-search.test.ts and the PostgreSQL-backed
  // integration tests.
  async vocabularyCandidates(): Promise<string[]> {
    return [];
  }

  async vocabularyHasTerm(): Promise<boolean> {
    return false;
  }

  // TKT-036: mirrors insertDocument's duplicate-title detection (same
  // `code: "23505"` shape server/lifecycle.ts checks for) but as an update
  // rather than an insert; returns `false` (not found) instead of throwing
  // when the id does not exist, matching PgDocumentDatabase.
  async updateDocumentTitle(_client: pg.PoolClient, documentId: string, title: string): Promise<boolean> {
    const existing = this.documents.get(documentId);
    if (!existing) return false;
    for (const [otherId, other] of this.documents) {
      if (otherId !== documentId && other.title === title) {
        const error = new Error("duplicate") as Error & { code: string };
        error.code = "23505";
        throw error;
      }
    }
    this.documents.set(documentId, { ...existing, title, updatedAt: new Date().toISOString() });
    // TKT-036: this in-memory double keeps documentTitle on already-inserted
    // search records in sync with the title update, the same effect
    // PgDocumentDatabase gets for free from its title JOIN at query time
    // (document_search_blocks itself never stores a title column).
    this.records = this.records.map((record) => (record.documentId === documentId ? { ...record, documentTitle: title } : record));
    return true;
  }

  // TKT-036: not exercised by these fixtures beyond satisfying the
  // interface -- real vocabulary-rebuild semantics are covered by the
  // PostgreSQL-backed integration tests.
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

function semanticDocument(id: string, title: string, code: string, page = 2): ParsedDocument {
  return {
    metadata: { id, pageCount: Math.max(page, 3), title },
    pages: [
      {
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [{ type: "heading", id: "h-1", sectionId: "h-1", pageNumber: 1, level: 1, text: [{ text: title }] }],
      },
      {
        pageNumber: page,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [
          { type: "paragraph", id: "p-1", sectionId: "h-1", pageNumber: page, text: [{ text: `Body-only calibration prose includes ${code}.` }] },
          { type: "list", id: "l-1", sectionId: "h-1", pageNumber: page, ordered: false, items: [{ id: "li-1", blocks: [{ type: "paragraph", id: "p-2", sectionId: "h-1", pageNumber: page, text: [{ text: `Checklist item torque value ${code}.` }] }] }] },
          { type: "table", id: "t-1", sectionId: "h-1", pageNumber: page, rows: [{ cells: [{ id: "tc-1", sectionId: "h-1", pageNumber: page, isHeader: true, colSpan: 1, rowSpan: 1, blocks: [{ type: "paragraph", id: "p-3", pageNumber: page, text: [{ text: "Technical Code" }] }] }, { id: "tc-2", sectionId: "h-1", pageNumber: page, isHeader: false, colSpan: 1, rowSpan: 1, blocks: [{ type: "paragraph", id: "p-4", pageNumber: page, text: [{ text: code }] }] }] }] },
        ],
      },
    ],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

async function makeLifecycle(hooks: ConstructorParameters<typeof DocumentStorage>[1] = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-epic-g-"));
  const database = new MemoryDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root, hooks), database, "epic-g-test");
  return { root, database, lifecycle };
}

async function importDoc(lifecycle: DocumentLifecycle, doc: ParsedDocument, pdfBytes = new Uint8Array([37, 80, 68, 70])) {
  await lifecycle.importDocument({
    documentId: doc.metadata.id ?? "doc-1",
    title: doc.metadata.title ?? "Untitled",
    originalFilename: `${doc.metadata.id}.pdf`,
    originalPdf: pdfBytes,
    semanticDocument: doc,
    assets: [],
    searchRecords: generateDocumentSearchRecords(doc),
  });
}

describe("Epic G lifecycle, search, navigation, and scale coverage", () => {
  it("imports, searches headings/body/list/table codes, navigates, and deletes cleanly", async () => {
    const { root, lifecycle } = await makeLifecycle();
    try {
      const doc = semanticDocument("doc-g", "Hydraulic Training Manual", "ZX-99", 2);
      await importDoc(lifecycle, doc);
      expect((await lifecycle.search("Hydraulic Training", 10))[0]).toMatchObject({ blockType: "document-title", pageNumber: 1 });
      expect((await lifecycle.search("Hydraulic Training", 10)).some((result) => result.blockType === "heading")).toBe(true);
      expect((await lifecycle.search("calibration ZX-99", 10))[0]).toMatchObject({ blockId: "p-1", pageNumber: 2, sectionId: "h-1" });
      expect((await lifecycle.search("Checklist torque", 10))[0]).toMatchObject({ blockId: "li-1", blockType: "list-item" });
      expect((await lifecycle.search("ZX-99", 10)).some((result) => result.blockType === "table-cell")).toBe(true);
      const loaded = await lifecycle.loadDocument("doc-g");
      expect(loaded.stored.semanticDocument.pages[1].blocks[0]).toMatchObject({ id: "p-1", pageNumber: 2 });
      expect(await lifecycle.deleteDocument("doc-g")).toMatchObject({ databaseDeleted: true, storageDeleted: true });
      expect(await lifecycle.search("ZX-99", 10)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicates and leaves no visible partial import after filesystem or database failures", async () => {
    const { root, lifecycle, database } = await makeLifecycle();
    try {
      const doc = semanticDocument("doc-g", "Duplicate Manual", "AA-11");
      await importDoc(lifecycle, doc);
      await expect(importDoc(lifecycle, semanticDocument("doc-g-2", "Duplicate Manual", "BB-22"))).rejects.toThrow(/already exists/);
      database.failInserts = true;
      await expect(importDoc(lifecycle, semanticDocument("doc-fail", "Failure Manual", "CC-33"))).rejects.toThrow(/database failure/);
      expect((await lifecycle.listDocuments()).map((row) => row.id)).toEqual(["doc-g"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports stale and missing stored files as controlled load/delete failures", async () => {
    const { root, lifecycle } = await makeLifecycle({
      beforePublish: (documentId) => {
        if (documentId === "write-fail") throw new Error("interrupted filesystem write");
      },
    });
    try {
      await expect(importDoc(lifecycle, semanticDocument("write-fail", "Write Failure", "DD-44"))).rejects.toThrow(/interrupted filesystem write/);
      const doc = semanticDocument("missing-file", "Missing File", "EE-55");
      await importDoc(lifecycle, doc);
      await rm(path.join(root, "missing-file", "original.pdf"), { force: true });
      await expect(lifecycle.loadDocument("missing-file")).rejects.toThrow();
      expect(await lifecycle.deleteDocument("missing-file")).toMatchObject({ databaseDeleted: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexes deterministic thousands-document data and records timings", async () => {
    const { root, lifecycle } = await makeLifecycle();
    const start = performance.now();
    try {
      for (let i = 0; i < 1_000; i += 1) {
        await importDoc(lifecycle, semanticDocument(`scale-${i}`, `Scale Manual ${i}`, `SC-${i}`), new Uint8Array([37, 80, 68, 70, i & 255, (i >> 8) & 255]));
      }
      const importMs = performance.now() - start;
      const queryStart = performance.now();
      const results = await lifecycle.search("SC-777", 5);
      const queryMs = performance.now() - queryStart;
      expect(results[0]).toMatchObject({ documentId: "scale-777", pageNumber: 2 });
      expect({ importMs, queryMs, documents: 1_000, database: "in-memory deterministic regression" }).toMatchObject({ documents: 1_000 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("overrides a title without reparsing the PDF, preserving raw metadata and reindexing search", async () => {
    const { root, lifecycle } = await makeLifecycle();
    try {
      const doc = semanticDocument("doc-g", "BY ORDER OF THE", "ZX-99", 2);
      await importDoc(lifecycle, doc);

      const result = await lifecycle.overrideTitle("doc-g", "  Hydraulic Training Manual  ");
      expect(result.found).toBe(true);
      expect(result.document?.title).toBe("Hydraulic Training Manual");
      expect(result.storageSynced).toBe(true);
      expect(result.partialFailure).toBeUndefined();

      // Search/listing reflect the override immediately.
      expect((await lifecycle.listDocuments())[0].title).toBe("Hydraulic Training Manual");
      expect((await lifecycle.search("Hydraulic Training", 10))[0]).toMatchObject({ blockType: "document-title" });

      // The stored semantic JSON's raw PDF metadata title is untouched; the
      // selected display title is recorded separately with source "host".
      const loaded = await lifecycle.loadDocument("doc-g");
      expect(loaded.stored.semanticDocument.metadata.title).toBe("BY ORDER OF THE");
      expect(loaded.stored.semanticDocument.metadata.displayTitle).toBe("Hydraulic Training Manual");
      expect(loaded.stored.semanticDocument.metadata.titleSource).toBe("host");
      expect(loaded.stored.semanticDocument.metadata.titleConfidence).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns found: false for an override on an unknown document id", async () => {
    const { root, lifecycle } = await makeLifecycle();
    try {
      const result = await lifecycle.overrideTitle("does-not-exist", "New Title");
      expect(result).toEqual({ found: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting title override and leaves the database, storage, and search unchanged", async () => {
    const { root, lifecycle } = await makeLifecycle();
    try {
      await importDoc(lifecycle, semanticDocument("doc-a", "Manual A", "AA-11"), new Uint8Array([37, 80, 68, 70, 1]));
      await importDoc(lifecycle, semanticDocument("doc-b", "Manual B", "BB-22"), new Uint8Array([37, 80, 68, 70, 2]));

      await expect(lifecycle.overrideTitle("doc-b", "Manual A")).rejects.toThrow(/already exists/);

      // Nothing changed: no partial database or storage state from the
      // rejected override.
      const rows = await lifecycle.listDocuments();
      expect(rows.find((row) => row.id === "doc-b")?.title).toBe("Manual B");
      const loaded = await lifecycle.loadDocument("doc-b");
      expect(loaded.stored.semanticDocument.metadata.displayTitle).toBeUndefined();
      expect((await lifecycle.search("Manual B", 10))[0]).toMatchObject({ blockType: "document-title" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
