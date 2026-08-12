/**
 * TKT-033/TKT-037 search benchmark. Run with `npm run bench:search` (via
 * `vite-node`, same convention as `npm run bench` in test/bench/run.ts).
 * Requires a reachable PostgreSQL database (`npm run db:up` +
 * `npm run db:migrate`); uses DATABASE_URL if set, otherwise the same local
 * default every other DB-backed script/test in this repo uses.
 *
 * Records representative strict/phrase/prefix/partial/synonym/typo/filtered/
 * suggestion/no-result query latency against two corpora (docs/DESIGN.md
 * section 21.8):
 *  1. Whatever real, previously-imported sample PDF documents already exist
 *     in the target database (the "supplied PDF corpus").
 *  2. A deterministic synthetic dataset of SYNTHETIC_DOCUMENT_COUNT
 *     documents this script inserts directly (bypassing filesystem storage
 *     -- this benchmark measures query latency, not import/storage cost)
 *     and always deletes again in a `finally` block, so the run is
 *     repeatable and never leaves benchmark data behind.
 *
 * Also captures one representative EXPLAIN plan per stage (including a
 * filtered query and the suggestion prefix lookup) against the synthetic
 * corpus to confirm indexed candidate selection at scale, and records
 * database/index/vocabulary/suggestion sizes plus machine configuration so a
 * later run can be compared against this one without a brittle universal
 * timing threshold (docs/DESIGN.md 21.8: "record reproducible measurements
 * and flag material regressions against the local baseline," not enforce a
 * fixed millisecond budget).
 */
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { MAX_CANDIDATES_EXAMINED_PER_TERM } from "../../src/search-typo.ts";
import { MAX_SUGGESTION_CANDIDATES_EXAMINED, MAX_SUGGESTIONS_RETURNED } from "../../src/search-suggestions.ts";
import type { RawSearchFilterInput } from "../../src/search-filters.ts";
import type { DocumentSearchRecord } from "../../src/pdf-content-extractor/index.ts";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";
const SYNTHETIC_DOCUMENT_COUNT = Number.parseInt(process.env.SEARCH_BENCH_DOCS ?? "2000", 10);
const SYNTHETIC_PREFIX = "bench-synth-";

interface QueryCase {
  label: string;
  query: string;
  expectedStrategyClass: "strict" | "prefix" | "stemmed" | "synonym" | "partial" | "corrected" | "no-result";
  /** TKT-037: optional filters applied alongside the query, for cases that
   *  benchmark filter composition rather than an unfiltered strategy. */
  filters?: RawSearchFilterInput;
}

interface TimingResult extends QueryCase {
  runMs: number;
  resultCount: number;
  strategy: string;
}

interface SuggestionQueryCase {
  label: string;
  prefix: string;
}

interface SuggestionTimingResult extends SuggestionQueryCase {
  runMs: number;
  suggestionCount: number;
}

async function timeQuery(lifecycle: DocumentLifecycle, case_: QueryCase): Promise<TimingResult> {
  const start = performance.now();
  const { results, strategy } = await lifecycle.searchDetailed(case_.query, 25, 5, case_.filters);
  const runMs = performance.now() - start;
  return { ...case_, runMs, resultCount: results.length, strategy };
}

async function timeSuggestion(lifecycle: DocumentLifecycle, case_: SuggestionQueryCase): Promise<SuggestionTimingResult> {
  const start = performance.now();
  const { suggestions } = await lifecycle.suggest(case_.prefix);
  const runMs = performance.now() - start;
  return { ...case_, runMs, suggestionCount: suggestions.length };
}

function syntheticRecords(index: number): DocumentSearchRecord[] {
  const documentId = `${SYNTHETIC_PREFIX}${index}`;
  const documentTitle = `Synthetic Manual ${index}`;
  const code = `SC-${index}`;
  return [
    {
      documentId,
      documentTitle,
      sectionId: "h-1",
      blockId: "h-1",
      heading: documentTitle,
      headingPath: [],
      pageNumber: 1,
      blockType: "heading",
      text: documentTitle,
    },
    {
      documentId,
      documentTitle,
      sectionId: "p-1",
      blockId: "p-1",
      heading: "",
      headingPath: [documentTitle],
      pageNumber: 2,
      blockType: "paragraph",
      text: `Routine hydraulic calibration report for unit ${code}. System pressure nominal.`,
    },
    {
      documentId,
      documentTitle,
      sectionId: "p-2",
      blockId: "p-2",
      heading: "",
      headingPath: [documentTitle],
      pageNumber: 2,
      // No document ever contains the literal word "inspect" -- only
      // "inspection" -- so a strict search for "inspect" always has to
      // reach this content through the prefix stage.
      blockType: "paragraph",
      text: `Technical inspection completed for component ${code} during scheduled maintenance.`,
    },
    {
      documentId,
      documentTitle,
      sectionId: "p-3",
      blockId: "p-3",
      heading: "",
      headingPath: [documentTitle],
      pageNumber: 3,
      blockType: "paragraph",
      text: `Beacon reading logged for reference code ${code} under routine audit.`,
    },
    {
      documentId,
      documentTitle,
      sectionId: "p-4",
      blockId: "p-4",
      heading: "",
      headingPath: [documentTitle],
      pageNumber: 3,
      // No document ever contains the literal word "sanitizer" -- only its
      // configured domain synonym "disinfectant" -- so a strict search for
      // "sanitizer" always has to reach this content through the TKT-035
      // synonym-expansion stage.
      blockType: "paragraph",
      text: `Disinfectant supplies were restocked for unit ${code} this week.`,
    },
  ];
}

async function insertSyntheticCorpus(database: PgDocumentDatabase, count: number): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < count; i += 1) {
    await database.transaction(async (client) => {
      await database.insertDocument(client, {
        id: `${SYNTHETIC_PREFIX}${i}`,
        title: `Synthetic Manual ${i}`,
        originalFilename: `synthetic-${i}.pdf`,
        pdfStoragePath: `${SYNTHETIC_PREFIX}${i}/original.pdf`,
        semanticStoragePath: `${SYNTHETIC_PREFIX}${i}/semantic-document.json`,
        assetsStoragePath: `${SYNTHETIC_PREFIX}${i}/assets`,
        contentSha256: i.toString(16).padStart(64, "0"),
        extractorVersion: "search-bench",
        pageCount: 3,
      });
      await database.insertSearchRecords(client, syntheticRecords(i));
    });
  }
  return performance.now() - start;
}

async function deleteSyntheticCorpus(database: PgDocumentDatabase, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await database.deleteDocument(`${SYNTHETIC_PREFIX}${i}`);
  }
}

const REAL_CORPUS_QUERIES: QueryCase[] = [
  { label: "strict multiword", query: "training program", expectedStrategyClass: "strict" },
  { label: "phrase", query: '"infection prevention"', expectedStrategyClass: "strict" },
  { label: "prefix (final term incomplete)", query: "manag", expectedStrategyClass: "prefix" },
  // TKT-034: best-effort against uncontrolled real corpus content -- not
  // asserted, just recorded, since we cannot guarantee its exact wording.
  { label: "english-stemmed (mid-query word form)", query: "trained programs", expectedStrategyClass: "stemmed" },
  { label: "no-result", query: "zzz-nonexistent-term-9182", expectedStrategyClass: "no-result" },
];

const SYNTHETIC_CORPUS_QUERIES: QueryCase[] = [
  { label: "strict multiword (matches most of the corpus)", query: "hydraulic calibration", expectedStrategyClass: "strict" },
  { label: "strict unique-code lookup", query: `SC-${Math.floor(SYNTHETIC_DOCUMENT_COUNT / 2)}`, expectedStrategyClass: "strict" },
  // TKT-034: same technical identifier as above, in its bounded no-separator
  // variant form -- resolves as a direct simple-vector match through
  // technical_variants, not a broadened match class.
  { label: "technical identifier variant (no separator)", query: `SC${Math.floor(SYNTHETIC_DOCUMENT_COUNT / 2)}`, expectedStrategyClass: "strict" },
  { label: "prefix: 'inspect' reaches 'inspection' at scale", query: "inspect", expectedStrategyClass: "prefix" },
  // TKT-034: "inspected" is not a character-prefix of "inspection" (only
  // reachable via English stemming, not TKT-033 final-term prefix matching)
  // and "component" co-occurs with it in every synthetic record's body text.
  { label: "english-stemmed: 'inspected' reaches 'inspection' at scale", query: "component inspected", expectedStrategyClass: "stemmed" },
  { label: "partial fallback: terms that never co-occur in one row", query: "pressure audit", expectedStrategyClass: "partial" },
  // TKT-035: "sanitizer" is never a literal word in the synthetic corpus --
  // only its configured domain synonym "disinfectant" is -- so this always
  // has to reach content through the synonym-expansion stage.
  { label: "synonym: 'sanitizer' reaches 'disinfectant' at scale", query: "sanitizer", expectedStrategyClass: "synonym" },
  // TKT-035: "manaul" is a bounded-edit-distance misspelling of "manual",
  // the heading word every synthetic document's title vocabulary contains,
  // so this always has to reach content through the typo-correction stage.
  { label: "corrected: 'manaul' typo reaches 'manual' at scale", query: "manaul", expectedStrategyClass: "corrected" },
  { label: "no-result", query: "zzz-nonexistent-term-9182", expectedStrategyClass: "no-result" },
  // TKT-037: filtered queries -- same strategies as above, narrowed by a
  // filter, to measure whether filter predicates add material overhead on
  // top of the GIN candidate-selection cost at scale.
  {
    label: "filtered strict (documentId narrows a corpus-wide term)",
    query: "hydraulic calibration",
    expectedStrategyClass: "strict",
    filters: { documentId: `${SYNTHETIC_PREFIX}${Math.floor(SYNTHETIC_DOCUMENT_COUNT / 2)}` },
  },
  {
    label: "filtered prefix (page narrows an incomplete word)",
    query: "inspect",
    expectedStrategyClass: "prefix",
    filters: { page: "2" },
  },
];

// TKT-037: bounded indexed prefix suggestion queries against the synthetic
// corpus -- every synthetic document contributes its title ("Synthetic
// Manual N") and technical identifier ("SC-N") as suggestion candidates
// (see syntheticRecords below), so these prefixes exercise the shared
// search_suggestions table at SYNTHETIC_DOCUMENT_COUNT scale.
const SUGGESTION_QUERIES: SuggestionQueryCase[] = [
  { label: "title/heading prefix matching many documents", prefix: "synthetic manual" },
  { label: "technical identifier prefix at scale", prefix: `sc-${Math.floor(SYNTHETIC_DOCUMENT_COUNT / 2)}` },
  { label: "no-match prefix", prefix: "zzznomatchprefix" },
];

async function main() {
  const database = new PgDocumentDatabase({ connectionString: databaseUrl });
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "pdf-search-bench-"));
  const lifecycle = new DocumentLifecycle(new DocumentStorage(storageRoot), database, "search-bench");
  const report: {
    generatedAt: string;
    databaseUrl: string;
    machine: { node: string; platform: string; arch: string; cpuCount: number; cpuModel: string; totalMemoryBytes: number };
    realCorpus: { documentCount: number; blockCount: number; timings: TimingResult[] };
    syntheticCorpus: {
      documentCount: number;
      importMs: number;
      timings: TimingResult[];
      suggestionTimings: SuggestionTimingResult[];
      explain: Record<string, string[]>;
    };
    // TKT-035: vocabulary/typo-suggestion support measurements (docs/DESIGN.md 21.8).
    vocabulary: { size: number; storageBytes: number; maxCandidatesExaminedPerTerm: number };
    // TKT-037: autocomplete-suggestion support measurements.
    suggestions: { size: number; storageBytes: number; maxCandidatesExamined: number; maxReturned: number };
    // Database/index sizes, recorded so a later run can flag material growth
    // or plan regressions against this one -- see the module doc for why no
    // fixed millisecond threshold is enforced here.
    sizes: { databaseBytes: number; indexBytes: Record<string, number> };
  } = {
    generatedAt: new Date().toISOString(),
    databaseUrl: databaseUrl.replace(/:[^:@/]*@/, ":***@"),
    machine: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: os.totalmem(),
    },
    realCorpus: { documentCount: 0, blockCount: 0, timings: [] },
    syntheticCorpus: { documentCount: SYNTHETIC_DOCUMENT_COUNT, importMs: 0, timings: [], suggestionTimings: [], explain: {} },
    vocabulary: { size: 0, storageBytes: 0, maxCandidatesExaminedPerTerm: MAX_CANDIDATES_EXAMINED_PER_TERM },
    suggestions: { size: 0, storageBytes: 0, maxCandidatesExamined: MAX_SUGGESTION_CANDIDATES_EXAMINED, maxReturned: MAX_SUGGESTIONS_RETURNED },
    sizes: { databaseBytes: 0, indexBytes: {} },
  };

  try {
    console.log(`Connecting to ${report.databaseUrl} ...`);

    // -- Real corpus: whatever is already imported -----------------------
    const realDocuments = await database.listDocuments();
    report.realCorpus.documentCount = realDocuments.length;
    console.log(`\nReal corpus: ${realDocuments.length} document(s) already imported.`);
    if (realDocuments.length === 0) {
      console.log("No real documents found -- import sample PDFs first (see README) to benchmark the real corpus. Skipping.");
    } else {
      for (const case_ of REAL_CORPUS_QUERIES) {
        const result = await timeQuery(lifecycle, case_);
        report.realCorpus.timings.push(result);
        console.log(
          `  [${result.expectedStrategyClass.padEnd(9)}] "${result.query}" -> ${result.resultCount} result(s), ` +
            `strategy=${result.strategy}, ${result.runMs.toFixed(2)}ms`,
        );
      }
    }

    // -- Synthetic thousands-document corpus -------------------------------
    console.log(`\nInserting ${SYNTHETIC_DOCUMENT_COUNT} deterministic synthetic documents ...`);
    report.syntheticCorpus.importMs = await insertSyntheticCorpus(database, SYNTHETIC_DOCUMENT_COUNT);
    console.log(`Inserted in ${report.syntheticCorpus.importMs.toFixed(0)}ms.`);

    for (const case_ of SYNTHETIC_CORPUS_QUERIES) {
      const result = await timeQuery(lifecycle, case_);
      report.syntheticCorpus.timings.push(result);
      console.log(
        `  [${result.expectedStrategyClass.padEnd(9)}] "${result.query}"${result.filters ? ` filters=${JSON.stringify(result.filters)}` : ""} -> ` +
          `${result.resultCount} result(s), strategy=${result.strategy}, ${result.runMs.toFixed(2)}ms`,
      );
    }

    // TKT-037: bounded indexed prefix suggestion timing at scale.
    console.log("\nSuggestion (autocomplete) queries against the synthetic corpus:");
    for (const case_ of SUGGESTION_QUERIES) {
      const result = await timeSuggestion(lifecycle, case_);
      report.syntheticCorpus.suggestionTimings.push(result);
      console.log(`  "${result.prefix}" -> ${result.suggestionCount} suggestion(s), ${result.runMs.toFixed(2)}ms`);
    }

    console.log("\nEXPLAIN plans against the synthetic corpus:");
    const strictPlan = await database.explainSearch("hydraulic calibration");
    report.syntheticCorpus.explain.strict = strictPlan;
    console.log(`  strict "hydraulic calibration":\n    ${strictPlan.join("\n    ")}`);

    const prefixPlan = await database.explainSearchByTsQuery("inspect:*");
    report.syntheticCorpus.explain.prefix = prefixPlan;
    console.log(`  prefix "inspect:*":\n    ${prefixPlan.join("\n    ")}`);

    const partialPlan = await database.explainSearchByTsQuery("pressure | audit");
    report.syntheticCorpus.explain.partial = partialPlan;
    console.log(`  partial "pressure | audit":\n    ${partialPlan.join("\n    ")}`);

    // TKT-034: complementary english-vector pass uses its own GIN index.
    const englishPlan = await database.explainSearchEnglish("component inspected");
    report.syntheticCorpus.explain.stemmed = englishPlan;
    console.log(`  stemmed "component inspected" (english vector):\n    ${englishPlan.join("\n    ")}`);

    // TKT-034: a bounded technical-identifier variant is still an ordinary
    // simple-vector predicate -- same index as the strict/prefix/partial plans.
    const technicalVariantPlan = await database.explainSearch(`SC${Math.floor(SYNTHETIC_DOCUMENT_COUNT / 2)}`);
    report.syntheticCorpus.explain.technicalVariant = technicalVariantPlan;
    console.log(`  technical variant "SC${Math.floor(SYNTHETIC_DOCUMENT_COUNT / 2)}" (simple vector):\n    ${technicalVariantPlan.join("\n    ")}`);

    // TKT-035: the synonym-expansion tsquery is still an ordinary bounded
    // simple-vector predicate -- same GIN index as strict/prefix/partial.
    const synonymPlan = await database.explainSearchByTsQuery("(sanitizer | disinfectant)");
    report.syntheticCorpus.explain.synonym = synonymPlan;
    console.log(`  synonym "(sanitizer | disinfectant)":\n    ${synonymPlan.join("\n    ")}`);

    // TKT-035: the corrected-term search is an ordinary strict `search()`
    // call against the substituted term -- same GIN index as the direct pass.
    const correctedPlan = await database.explainSearch("manual");
    report.syntheticCorpus.explain.corrected = correctedPlan;
    console.log(`  corrected "manual" (substituted for "manaul"):\n    ${correctedPlan.join("\n    ")}`);

    // TKT-037: a filtered strict query -- confirms filtering never
    // downgrades candidate selection to a sequential scan (the planner may
    // legitimately prefer a selective btree index over the GIN index for a
    // narrow documentId+page combination; either is an indexed plan).
    const filteredPlan = await database.explainSearch("hydraulic", { documentId: `${SYNTHETIC_PREFIX}${Math.floor(SYNTHETIC_DOCUMENT_COUNT / 2)}` });
    report.syntheticCorpus.explain.filtered = filteredPlan;
    console.log(`  filtered strict "hydraulic" (documentId filter):\n    ${filteredPlan.join("\n    ")}`);

    // TKT-037: the suggestion prefix lookup uses its own btree index
    // (search_suggestions_prefix_idx, migration 005), never the GIN index.
    const suggestionPlan = await database.explainSuggest("synthetic manual%");
    report.syntheticCorpus.explain.suggestion = suggestionPlan;
    console.log(`  suggestion prefix "synthetic manual%":\n    ${suggestionPlan.join("\n    ")}`);

    // TKT-035: vocabulary size and on-disk storage added by
    // search_vocabulary_terms (table + its prefix index), measured against
    // the synthetic corpus just inserted above.
    report.vocabulary.size = await database.vocabularySize();
    report.vocabulary.storageBytes = await database.vocabularyStorageBytes();
    console.log(
      `\nVocabulary: ${report.vocabulary.size} distinct term(s), ${(report.vocabulary.storageBytes / 1024).toFixed(1)} KiB on disk, ` +
        `max ${report.vocabulary.maxCandidatesExaminedPerTerm} candidates examined per misspelled term.`,
    );

    // TKT-037: suggestion-candidate size and on-disk storage added by
    // search_suggestions (table + its prefix index).
    report.suggestions.size = await database.suggestionsSize();
    report.suggestions.storageBytes = await database.suggestionsStorageBytes();
    console.log(
      `Suggestions: ${report.suggestions.size} candidate row(s), ${(report.suggestions.storageBytes / 1024).toFixed(1)} KiB on disk, ` +
        `max ${report.suggestions.maxCandidatesExamined} candidates examined, max ${report.suggestions.maxReturned} returned.`,
    );

    // -- Database and index sizes (docs/DESIGN.md 21.8) -----------------------
    report.sizes.databaseBytes = await database.databaseSizeBytes();
    report.sizes.indexBytes = await database.searchIndexSizeBytes();
    console.log(
      `\nDatabase size: ${(report.sizes.databaseBytes / 1024 / 1024).toFixed(1)} MiB. Index sizes (KiB): ` +
        Object.entries(report.sizes.indexBytes).map(([name, bytes]) => `${name}=${(bytes / 1024).toFixed(1)}`).join(", "),
    );
    console.log(
      `Machine: node ${report.machine.node} on ${report.machine.platform}/${report.machine.arch}, ` +
        `${report.machine.cpuCount}x ${report.machine.cpuModel}, ${(report.machine.totalMemoryBytes / 1024 / 1024 / 1024).toFixed(1)} GiB RAM.`,
    );

    const outPath = fileURLToPath(new URL("./search-bench-results.json", import.meta.url));
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(`\nMachine-readable report written to ${outPath}`);
  } finally {
    console.log(`\nCleaning up ${SYNTHETIC_DOCUMENT_COUNT} synthetic documents ...`);
    await deleteSyntheticCorpus(database, SYNTHETIC_DOCUMENT_COUNT);
    await rm(storageRoot, { recursive: true, force: true });
    await database.close();
  }
}

await main();
