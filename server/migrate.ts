import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";
const migrationsDir = process.env.MIGRATIONS_DIR ?? path.resolve("database", "migrations");
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const baseline = await pool.query("SELECT to_regclass('public.documents') AS documents_table");
  if (baseline.rows[0].documents_table && !(await isApplied("001_initial_document_search.sql"))) {
    await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", ["001_initial_document_search.sql"]);
  }

  const files = (await readdir(migrationsDir)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  for (const file of files) {
    if (await isApplied(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  console.log("Migrations are up to date.");
} finally {
  await pool.end();
}

async function isApplied(filename: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
  return (result.rowCount ?? 0) > 0;
}
