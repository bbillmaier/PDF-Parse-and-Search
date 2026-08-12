import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentApiServer, type ImportDocumentRequestBody } from "../../server/api.ts";
import { DocumentLifecycle, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import {
  generateDocumentSearchRecords,
  type DocumentSearchRecord,
  type ParsedDocument,
} from "../../src/pdf-content-extractor/index.ts";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";

class MemoryDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  records: DocumentSearchRecord[] = [];

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return work({} as pg.PoolClient);
  }

  async insertDocument(_client: pg.PoolClient, input: DocumentRowInput): Promise<void> {
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
    return this.records
      .filter((record) => terms.every((term) => record.text.toLowerCase().includes(term) || record.heading.toLowerCase().includes(term)))
      .slice(0, limit)
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
        rank: 1,
      }));
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

function semanticDocument(id = "doc-1", title = "API Manual"): ParsedDocument {
  return {
    metadata: { id, pageCount: 1, title },
    pages: [
      {
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [
          { type: "heading", id: "h-1", pageNumber: 1, level: 1, text: [{ text: "Hydraulic Test" }] },
          { type: "paragraph", id: "p-1", pageNumber: 1, text: [{ text: "Hydraulic code A-12 passes." }] },
        ],
      },
    ],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

function importBody(id = "doc-1", title = "API Manual"): ImportDocumentRequestBody {
  const doc = semanticDocument(id, title);
  return {
    documentId: id,
    title,
    originalFilename: `${id}.pdf`,
    originalPdfBase64: Buffer.from([1, 2, 3]).toString("base64"),
    semanticDocument: doc,
    assets: [],
    searchRecords: generateDocumentSearchRecords(doc),
  };
}

async function startApi() {
  const database = new MemoryDatabase();
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-api-"));
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database);
  const server = createDocumentApiServer({ lifecycle, allowedOrigins: ["http://localhost:5173"] });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  return { database, server, url: `http://127.0.0.1:${address.port}` };
}

const servers: Awaited<ReturnType<typeof startApi>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("document API", () => {
  it("answers allowed CORS preflights and rejects unknown origins", async () => {
    const api = await startApi();
    servers.push(api);
    const allowed = await fetch(`${api.url}/api/documents/import`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(allowed.headers.get("access-control-allow-methods")).toContain("POST");
    expect(allowed.headers.get("vary")).toBe("Origin");

    const rejected = await fetch(`${api.url}/api/documents`, {
      method: "OPTIONS",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "GET",
      },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds the allowed-origin header to normal API responses", async () => {
    const api = await startApi();
    servers.push(api);
    const response = await fetch(`${api.url}/api/documents`, {
      headers: { origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("imports, lists, loads, searches, and deletes a document", async () => {
    const api = await startApi();
    servers.push(api);
    const imported = await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(importBody()) });
    expect(imported.status).toBe(201);
    expect((await fetch(`${api.url}/api/documents`)).status).toBe(200);
    const search = await fetch(`${api.url}/api/search?q=Hydraulic%20A-12`);
    expect((await search.json()).results[0].blockId).toBe("p-1");
    const loaded = await fetch(`${api.url}/api/documents/doc-1`);
    expect((await loaded.json()).stored.semanticDocument.metadata.title).toBe("API Manual");
    expect((await fetch(`${api.url}/api/documents/doc-1`, { method: "DELETE" })).status).toBe(200);
    expect(api.database.records).toHaveLength(0);
  });

  it("returns 409 for duplicate title or hash without silent overwrite", async () => {
    const api = await startApi();
    servers.push(api);
    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(importBody("doc-1", "Same")) })).status).toBe(201);
    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(importBody("doc-1", "Same")) })).status).toBe(409);
    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(importBody("doc-2", "Same")) })).status).toBe(409);
  });

  it("overrides a document title via PATCH without reparsing the PDF, and reflects it in listings/search", async () => {
    const api = await startApi();
    servers.push(api);
    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(importBody("doc-1", "API Manual")) })).status).toBe(201);

    const override = await fetch(`${api.url}/api/documents/doc-1/title`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed Manual" }),
    });
    expect(override.status).toBe(200);
    const overrideBody = await override.json();
    expect(overrideBody.found).toBe(true);
    expect(overrideBody.document.title).toBe("Renamed Manual");
    expect(overrideBody.storageSynced).toBe(true);

    const listed = await fetch(`${api.url}/api/documents`);
    expect((await listed.json()).documents[0].title).toBe("Renamed Manual");

    const loaded = await fetch(`${api.url}/api/documents/doc-1`);
    const loadedBody = await loaded.json();
    // Raw PDF metadata is untouched; only the display title fields change.
    expect(loadedBody.stored.semanticDocument.metadata.title).toBe("API Manual");
    expect(loadedBody.stored.semanticDocument.metadata.displayTitle).toBe("Renamed Manual");
    expect(loadedBody.stored.semanticDocument.metadata.titleSource).toBe("host");
  });

  it("returns 404 overriding an unknown document's title and 400 for a missing title body", async () => {
    const api = await startApi();
    servers.push(api);
    const missingDoc = await fetch(`${api.url}/api/documents/does-not-exist/title`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Anything" }),
    });
    expect(missingDoc.status).toBe(404);

    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(importBody("doc-1", "API Manual")) })).status).toBe(201);
    const missingBody = await fetch(`${api.url}/api/documents/doc-1/title`, { method: "PATCH", body: JSON.stringify({}) });
    expect(missingBody.status).toBe(400);
  });

  it("returns 409 for a title override that conflicts with another document's title", async () => {
    const api = await startApi();
    servers.push(api);
    const bodyA = importBody("doc-1", "Manual A");
    const bodyB = { ...importBody("doc-2", "Manual B"), originalPdfBase64: Buffer.from([4, 5, 6]).toString("base64") };
    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(bodyA) })).status).toBe(201);
    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(bodyB) })).status).toBe(201);

    const conflict = await fetch(`${api.url}/api/documents/doc-2/title`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Manual A" }),
    });
    expect(conflict.status).toBe(409);

    // No partial state: doc-2 keeps its original title.
    const listed = await fetch(`${api.url}/api/documents`);
    const docs = (await listed.json()).documents as { id: string; title: string }[];
    expect(docs.find((doc) => doc.id === "doc-2")?.title).toBe("Manual B");
  });

  it("rejects malformed records and injection-looking query strings safely", async () => {
    const api = await startApi();
    servers.push(api);
    const body = importBody();
    body.searchRecords[0].blockId = "missing-1";
    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(body) })).status).toBe(400);
    const search = await fetch(`${api.url}/api/search?q=';DROP%20TABLE%20documents;--`);
    expect(search.status).toBe(200);
  });

  it("returns a bounded match-centered snippet with matched ranges instead of the full block", async () => {
    const api = await startApi();
    servers.push(api);
    const filler = "unrelated padding text ".repeat(300);
    const doc: ParsedDocument = {
      metadata: { id: "long-block-doc", pageCount: 1, title: "Long Block Doc" },
      pages: [{
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [{ type: "paragraph", id: "p-1", pageNumber: 1, text: [{ text: `${filler}beacon-code ZX-42 marks the spot${filler}` }] }],
      }],
      outline: [],
      assets: [],
      warnings: [],
      timings: { totalMs: 0, phases: [], inputBytes: 0 },
    };
    const body: ImportDocumentRequestBody = {
      documentId: "long-block-doc",
      title: "Long Block Doc",
      originalFilename: "long-block-doc.pdf",
      originalPdfBase64: Buffer.from([1, 2, 3]).toString("base64"),
      semanticDocument: doc,
      assets: [],
      searchRecords: generateDocumentSearchRecords(doc),
    };
    expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(body) })).status).toBe(201);
    const search = await fetch(`${api.url}/api/search?q=beacon-code`);
    const result = (await search.json()).results[0];
    expect(result.snippet.length).toBeLessThan(400);
    expect(result.matches.length).toBeGreaterThan(0);
    const match = result.matches[0];
    expect(result.snippet.slice(match.start, match.end).toLowerCase()).toBe("beacon-code");
  });

  it("caps results per document so one long document cannot crowd out other matching documents", async () => {
    const api = await startApi();
    servers.push(api);
    // A single document with many independently matching sections would otherwise fill the entire results page.
    const bigDoc: ParsedDocument = {
      metadata: { id: "one-big-doc", pageCount: 1, title: "One Big Doc" },
      pages: [{
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: Array.from({ length: 8 }, (_, index) => ({
          type: "heading" as const,
          id: `bh-${index}`,
          sectionId: `bh-${index}`,
          pageNumber: 1,
          level: 1,
          text: [{ text: `Beacon section ${index}` }],
        })),
      }],
      outline: [],
      assets: [],
      warnings: [],
      timings: { totalMs: 0, phases: [], inputBytes: 0 },
    };
    const smallDoc: ParsedDocument = {
      metadata: { id: "small-doc", pageCount: 1, title: "Small Doc" },
      pages: [{
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [{ type: "paragraph", id: "sp-1", pageNumber: 1, text: [{ text: "A single beacon reading appears here." }] }],
      }],
      outline: [],
      assets: [],
      warnings: [],
      timings: { totalMs: 0, phases: [], inputBytes: 0 },
    };
    for (const [index, doc] of [bigDoc, smallDoc].entries()) {
      const response = await fetch(`${api.url}/api/documents/import`, {
        method: "POST",
        body: JSON.stringify({
          documentId: doc.metadata.id!,
          title: doc.metadata.title!,
          originalFilename: `${doc.metadata.id}.pdf`,
          originalPdfBase64: Buffer.from([1, 2, 3, index]).toString("base64"),
          semanticDocument: doc,
          assets: [],
          searchRecords: generateDocumentSearchRecords(doc),
        } satisfies ImportDocumentRequestBody),
      });
      expect(response.status).toBe(201);
    }

    const search = await fetch(`${api.url}/api/search?q=Beacon&limit=10&perDocumentLimit=2`);
    const results = (await search.json()).results as { documentId: string }[];
    const byDocument = new Map<string, number>();
    for (const result of results) byDocument.set(result.documentId, (byDocument.get(result.documentId) ?? 0) + 1);
    expect(byDocument.get("one-big-doc")).toBe(2);
    expect(byDocument.get("small-doc")).toBe(1);
  });
});
