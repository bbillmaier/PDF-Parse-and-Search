import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentStorage, StorageConflictError, validateAssetName, validateDocumentId } from "../../server/storage.ts";
import type { ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

function semanticDocument(): ParsedDocument {
  return {
    metadata: { id: "doc-1", pageCount: 1, title: "Stored" },
    pages: [{ pageNumber: 1, width: 1, height: 1, warnings: [], blocks: [{ type: "paragraph", id: "p-1", pageNumber: 1, text: [{ text: "hello" }] }] }],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pdf-storage-"));
}

describe("DocumentStorage", () => {
  it("saves, loads, lists, and deletes a complete document", async () => {
    const storage = new DocumentStorage(await tempRoot());
    await storage.save({
      documentId: "doc-1",
      title: "Stored",
      originalFilename: "stored.pdf",
      originalPdf: new Uint8Array([1, 2, 3]),
      semanticDocument: semanticDocument(),
      assets: [{ name: "image-1.png", bytes: new Uint8Array([4, 5]) }],
    });
    const loaded = await storage.load("doc-1");
    expect([...loaded.originalPdf]).toEqual([1, 2, 3]);
    expect(loaded.assetNames).toEqual(["image-1.png"]);
    expect(await storage.listMetadata()).toHaveLength(1);
    expect(await storage.delete("doc-1")).toEqual({ deleted: true });
  });

  it("rejects traversal ids and asset names before resolving paths", () => {
    expect(() => validateDocumentId("../bad")).toThrow(/Invalid document id/);
    expect(() => validateAssetName("../bad.png")).toThrow(/Invalid asset name/);
  });

  it("cleans staging directories when publication fails", async () => {
    const root = await tempRoot();
    const storage = new DocumentStorage(root, { beforePublish: () => { throw new Error("boom"); } });
    await expect(storage.save({
      documentId: "doc-1",
      title: "Stored",
      originalFilename: "stored.pdf",
      originalPdf: new Uint8Array([1]),
      semanticDocument: semanticDocument(),
      assets: [],
    })).rejects.toThrow("boom");
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a duplicate document directory without deleting the stored document", async () => {
    const root = await tempRoot();
    const storage = new DocumentStorage(root);
    const input = {
      documentId: "doc-1",
      title: "Stored",
      originalFilename: "stored.pdf",
      originalPdf: new Uint8Array([1, 2, 3]),
      semanticDocument: semanticDocument(),
      assets: [],
    };
    await storage.save(input);
    await expect(storage.save(input)).rejects.toBeInstanceOf(StorageConflictError);
    expect([...(await storage.load("doc-1")).originalPdf]).toEqual([1, 2, 3]);
  });
});
