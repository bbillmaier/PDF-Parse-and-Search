import { PgDocumentDatabase } from "./database.ts";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";

const db = new PgDocumentDatabase({ connectionString: databaseUrl });
try {
  if (process.env.APPLY_MIGRATIONS === "1") await db.applyMigrations();
  const id = `smoke-${Date.now()}`;
  const hash = "a".repeat(52) + Date.now().toString(16).padStart(12, "0").slice(-12);
  await db.transaction(async (client) => {
    await db.insertDocument(client, {
      id,
      title: `Smoke ${id}`,
      originalFilename: "smoke.pdf",
      pdfStoragePath: `${id}/original.pdf`,
      semanticStoragePath: `${id}/semantic-document.json`,
      assetsStoragePath: `${id}/assets`,
      contentSha256: hash,
      extractorVersion: "db-smoke",
      pageCount: 1,
    });
    await db.insertSearchRecords(client, [{
      documentId: id,
      documentTitle: `Smoke ${id}`,
      sectionId: "h-1",
      blockId: "p-1",
      heading: "Hydraulic Test",
      headingPath: ["Hydraulic Test"],
      pageNumber: 1,
      blockType: "paragraph",
      text: "Hydraulic code A-12 confirms indexed search.",
    }]);
  });
  const results = await db.search("Hydraulic A-12", 5);
  if (!results.some((result) => result.documentId === id)) throw new Error("Smoke search did not return the inserted document.");
  const plan = await db.explainSearch("Hydraulic");
  if (!plan.join("\n").includes("document_search_blocks_search_simple_idx")) {
    throw new Error(`Expected simple-vector GIN index in search plan:\n${plan.join("\n")}`);
  }

  // TKT-034: bounded technical-identifier variant ("A-12" also indexed as "A12").
  const codeVariant = await db.search("A12", 5);
  if (!codeVariant.some((result) => result.documentId === id)) {
    throw new Error("Smoke search did not resolve the A-12/A12 technical identifier variant.");
  }

  // TKT-034: complementary english vector uses its own GIN index.
  const englishResults = await db.searchEnglish("indexing", 5);
  if (!englishResults.some((result) => result.documentId === id)) {
    throw new Error("Smoke search did not return an english-stemmed match.");
  }
  const englishPlan = await db.explainSearchEnglish("indexing");
  if (!englishPlan.join("\n").includes("document_search_blocks_search_english_idx")) {
    throw new Error(`Expected english-vector GIN index in search plan:\n${englishPlan.join("\n")}`);
  }

  // TKT-035: the imported record's heading ("Hydraulic Test") populates the
  // bounded typo-suggestion vocabulary, queryable by prefix/length before
  // any edit distance is computed.
  if (!(await db.vocabularyHasTerm("hydraulic"))) {
    throw new Error("Smoke import did not populate the search vocabulary with its own heading word.");
  }
  const vocabularyCandidates = await db.vocabularyCandidates("hy", 5, 12, 10);
  if (!vocabularyCandidates.includes("hydraulic")) {
    throw new Error(`Expected "hydraulic" among bounded vocabulary candidates, got: ${JSON.stringify(vocabularyCandidates)}`);
  }

  await db.deleteDocument(id);

  // ON DELETE CASCADE must remove this document's vocabulary contribution
  // with it -- no separate application-level cleanup step.
  if (await db.vocabularyHasTerm("hydraulic")) {
    throw new Error("Deleting the document did not cascade-delete its vocabulary terms.");
  }

  console.log("Database smoke test passed.");
} finally {
  await db.close();
}
