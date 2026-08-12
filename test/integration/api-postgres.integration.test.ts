import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentApiServer, type ImportDocumentRequestBody } from "../../server/api.ts";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { generateDocumentSearchRecords, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

const shouldRun = process.env.RUN_LOCAL_DB_TESTS === "1" || process.env.DATABASE_URL !== undefined;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";
const servers: { close: () => Promise<void> }[] = [];

function semanticDocument(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 1, title },
    pages: [{ pageNumber: 1, width: 1, height: 1, warnings: [], blocks: [
      { type: "heading", id: "h-1", pageNumber: 1, level: 1, text: [{ text: "Hydraulic Search" }] },
      { type: "paragraph", id: "p-1", pageNumber: 1, text: [{ text: "Hydraulic test code ZX-99 appears only in body text." }] },
    ] }],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

function body(id: string, title: string): ImportDocumentRequestBody {
  const doc = semanticDocument(id, title);
  return {
    documentId: id,
    title,
    originalFilename: `${id}.pdf`,
    originalPdfBase64: Buffer.from(`%PDF-${id}`).toString("base64"),
    semanticDocument: doc,
    assets: [],
    searchRecords: generateDocumentSearchRecords(doc),
  };
}

async function startRealApi() {
  const database = new PgDocumentDatabase({ connectionString: databaseUrl });
  const storage = new DocumentStorage(await mkdtemp(path.join(os.tmpdir(), "pdf-real-api-")));
  const lifecycle = new DocumentLifecycle(storage, database, "api-postgres-test");
  const server = createDocumentApiServer({ lifecycle });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  };
  servers.push({ close });
  return { url: `http://127.0.0.1:${address.port}`, database };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe.skipIf(!shouldRun)("document API with PostgreSQL and temporary storage", () => {
  it("imports, searches, loads, rejects duplicates, and deletes atomically", async () => {
    const id = `api-${Date.now()}`;
    const title = `API PG ${id}`;
    const api = await startRealApi();
    try {
      expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(body(id, title)) })).status).toBe(201);
      const search = await fetch(`${api.url}/api/search?q=ZX-99`);
      expect((await search.json()).results[0]).toMatchObject({ documentId: id, blockId: "p-1", pageNumber: 1 });
      const loaded = await fetch(`${api.url}/api/documents/${id}`);
      expect((await loaded.json()).stored.semanticDocument.metadata.title).toBe(title);
      expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(body(`${id}-dup`, title)) })).status).toBe(409);
      expect((await fetch(`${api.url}/api/documents/${id}`, { method: "DELETE" })).status).toBe(200);
      const afterDelete = await fetch(`${api.url}/api/search?q=ZX-99`);
      expect((await afterDelete.json()).results).toEqual([]);
    } finally {
      await api.database.deleteDocument(id);
      await api.database.deleteDocument(`${id}-dup`);
    }
  });

  it("overrides a title without reparsing the PDF, rebuilding the vocabulary and search results", async () => {
    const id = `override-${Date.now()}`;
    const otherId = `${id}-other`;
    // Deliberately nonsense/unique words so this test can assert exactly
    // which vocabulary terms appear and disappear, unaffected by any other
    // document already in this (possibly populated) database.
    const oldTitle = `Zzyzxqrp Manual ${id}`;
    const newTitle = `Vorlqnex Handbook ${id}`;
    const api = await startRealApi();
    try {
      expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(body(id, oldTitle)) })).status).toBe(201);
      expect(await api.database.vocabularyHasTerm("zzyzxqrp")).toBe(true);
      expect(await api.database.vocabularyHasTerm("vorlqnex")).toBe(false);

      const searchBefore = await fetch(`${api.url}/api/search?q=Zzyzxqrp`);
      expect((await searchBefore.json()).results.length).toBeGreaterThan(0);

      const override = await fetch(`${api.url}/api/documents/${id}/title`, {
        method: "PATCH",
        body: JSON.stringify({ title: newTitle }),
      });
      expect(override.status).toBe(200);
      const overrideBody = await override.json();
      expect(overrideBody.found).toBe(true);
      expect(overrideBody.document.title).toBe(newTitle);
      expect(overrideBody.storageSynced).toBe(true);

      // Vocabulary reflects the override: the new title's distinctive word
      // is now findable, the old one no longer lingers (it appeared only in
      // the title, which was fully replaced, not merged).
      expect(await api.database.vocabularyHasTerm("vorlqnex")).toBe(true);
      expect(await api.database.vocabularyHasTerm("zzyzxqrp")).toBe(false);
      // The heading word from the document body is untouched by the
      // title-only override.
      expect(await api.database.vocabularyHasTerm("hydraulic")).toBe(true);

      // Search results and the document listing reflect the new title too,
      // all without resending or reparsing the original PDF bytes.
      const searchAfter = await fetch(`${api.url}/api/search?q=Vorlqnex`);
      expect((await searchAfter.json()).results.some((result: { documentTitle: string }) => result.documentTitle === newTitle)).toBe(true);
      const listed = await fetch(`${api.url}/api/documents`);
      const docs = (await listed.json()).documents as { id: string; title: string }[];
      expect(docs.find((doc) => doc.id === id)?.title).toBe(newTitle);

      // Raw PDF metadata title is preserved separately in the stored semantic JSON.
      const loaded = await fetch(`${api.url}/api/documents/${id}`);
      const loadedBody = await loaded.json();
      expect(loadedBody.stored.semanticDocument.metadata.title).toBe(oldTitle);
      expect(loadedBody.stored.semanticDocument.metadata.displayTitle).toBe(newTitle);
      expect(loadedBody.stored.semanticDocument.metadata.titleSource).toBe("host");

      // A conflicting override (against a second document) is rejected with
      // 409 and leaves the second document's title and vocabulary untouched.
      expect((await fetch(`${api.url}/api/documents/import`, { method: "POST", body: JSON.stringify(body(otherId, `Other Manual ${id}`)) })).status).toBe(201);
      const conflict = await fetch(`${api.url}/api/documents/${otherId}/title`, {
        method: "PATCH",
        body: JSON.stringify({ title: newTitle }),
      });
      expect(conflict.status).toBe(409);
      const stillOther = await fetch(`${api.url}/api/documents/${otherId}`);
      expect((await stillOther.json()).document.title).toBe(`Other Manual ${id}`);
    } finally {
      await api.database.deleteDocument(id);
      await api.database.deleteDocument(otherId);
    }
  });
});
