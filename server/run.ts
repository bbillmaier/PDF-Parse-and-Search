import path from "node:path";
import { createDocumentApiServer } from "./api.ts";
import { PgDocumentDatabase } from "./database.ts";
import { DocumentLifecycle } from "./lifecycle.ts";
import { DocumentStorage } from "./storage.ts";

const port = Number(process.env.PORT ?? 3001);
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";
const storageRoot = process.env.DOCUMENT_STORAGE_ROOT ?? path.resolve("storage", "documents");
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const database = new PgDocumentDatabase({ connectionString: databaseUrl });
const storage = new DocumentStorage(storageRoot);
const lifecycle = new DocumentLifecycle(storage, database);
const server = createDocumentApiServer({
  lifecycle,
  allowedOrigins,
  onUnexpectedError(error, request) {
    console.error(`Unexpected ${request.method ?? "UNKNOWN"} ${request.url ?? "/"} failure:`, error);
  },
});

server.listen(port, () => {
  console.log(`Document API listening on http://localhost:${port}`);
  console.log(`Allowed browser origins: ${allowedOrigins.join(", ") || "none"}`);
});

process.on("SIGINT", () => {
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
});
