/**
 * TKT-034/TKT-035: CLI entry point for the repeatable technical-identifier
 * and typo-suggestion vocabulary reindex command. See
 * server/reindex-search-core.ts for the reindex logic and its
 * safety/idempotency contract.
 *
 * Usage: `npm run db:reindex-search` (uses DATABASE_URL, same default as
 * every other DB-backed script in this repo).
 */
import pg from "pg";
import { reindexAllDocuments } from "./reindex-search-core.ts";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const result = await reindexAllDocuments(pool, (line) => console.log(line));
  console.log(
    `\nReindex complete in ${result.durationMs.toFixed(0)}ms: ${result.documentsSucceeded}/${result.documentsTotal} document(s) processed ` +
      `(${result.blocksUpdated}/${result.blocksSeen} block(s) updated, ${result.vocabularyTermsWritten} vocabulary term(s), ` +
      `${result.suggestionsWritten} suggestion candidate(s) written), ${result.documentsFailed} failed.`,
  );
  if (result.documentsFailed > 0) {
    console.error(
      "One or more documents failed to reindex. This command is safe to re-run: " +
        "already-reindexed documents recompute to the same values (no-op), so a re-run only does new work for the documents listed above.",
    );
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
