import { describe, expect, it } from "vitest";
import { PgDocumentDatabase } from "../../server/database.ts";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";
const shouldRun = process.env.RUN_LOCAL_DB_TESTS === "1" || process.env.DATABASE_URL !== undefined;

describe.skipIf(!shouldRun)("PostgreSQL document search schema", () => {
  it("enforces duplicates, cascades search rows, and uses the GIN-backed search vector", async () => {
    const db = new PgDocumentDatabase({ connectionString: databaseUrl });
    const id = `db-${Date.now()}`;
    const duplicateId = `${id}-dup`;
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      await db.transaction(async (client) => {
        await db.insertDocument(client, {
          id,
          title: `DB Integration ${id}`,
          originalFilename: "manual.pdf",
          pdfStoragePath: `${id}/original.pdf`,
          semanticStoragePath: `${id}/semantic-document.json`,
          assetsStoragePath: `${id}/assets`,
          contentSha256: "b".repeat(63) + "1",
          extractorVersion: "test",
          pageCount: 1,
        });
        await db.insertSearchRecords(client, [{
          documentId: id,
          documentTitle: `DB Integration ${id}`,
          sectionId: "h-1",
          blockId: "p-1",
          heading: "Hydraulic Checkout",
          headingPath: ["Hydraulic Checkout"],
          pageNumber: 1,
          blockType: "paragraph",
          text: "Hydraulic pump code A-12 confirms test indexing.",
        }]);
      });

      await expect(db.transaction(async (client) => {
        await db.insertDocument(client, {
          id: duplicateId,
          title: `DB Integration ${id}`,
          originalFilename: "manual-copy.pdf",
          pdfStoragePath: `${duplicateId}/original.pdf`,
          semanticStoragePath: `${duplicateId}/semantic-document.json`,
          assetsStoragePath: `${duplicateId}/assets`,
          contentSha256: "b".repeat(63) + "2",
          extractorVersion: "test",
          pageCount: 1,
        });
      })).rejects.toMatchObject({ code: "23505" });

      const results = await db.search("Hydraulic A-12", 5);
      expect(results.some((result) => result.documentId === id && result.blockId === "p-1")).toBe(true);

      const plan = await db.explainSearch("Hydraulic");
      expect(plan.join("\n")).toContain("document_search_blocks_search_simple_idx");

      await db.deleteDocument(id);
      const count = await pool.query("SELECT count(*)::int AS count FROM document_search_blocks WHERE document_id = $1", [id]);
      expect(count.rows[0].count).toBe(0);
    } finally {
      await pool.query("DELETE FROM documents WHERE id = ANY($1::text[])", [[id, duplicateId]]);
      await pool.end();
      await db.close();
    }
  });
});
