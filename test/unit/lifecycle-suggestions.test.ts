import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { DocumentRow, DocumentRowInput, SearchResultRow } from "../../server/database.ts";
import { DocumentLifecycle, type DocumentDatabase } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { normalizeSuggestionText, type SuggestionCandidateRow, type SuggestionType } from "../../src/search-suggestions.ts";
import { MIN_SUGGESTION_PREFIX_LENGTH } from "../../src/search-suggestions.ts";

/**
 * TKT-037 lifecycle-level orchestration tests for autocomplete suggestions,
 * run against a fast in-memory fake so they exercise
 * DocumentLifecycle.suggest's prefix-length gating (never querying the
 * database for a too-short prefix) and its use of
 * rankAndDedupeSuggestions on every `npm run test:unit` run. The fake's
 * `suggest` does a plain in-memory prefix filter; the real indexed btree
 * `LIKE` lookup is covered against PostgreSQL in
 * test/integration/search-suggestions.integration.test.ts.
 */
class SuggestFakeDatabase implements DocumentDatabase {
  documents = new Map<string, DocumentRow>();
  candidates: SuggestionCandidateRow[] = [];
  suggestCalls: { likePattern: string; limit: number }[] = [];

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return work({} as pg.PoolClient);
  }

  async insertDocument(_client: pg.PoolClient, input: DocumentRowInput): Promise<void> {
    this.documents.set(input.id, { ...input, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
  }

  async insertSearchRecords(): Promise<void> {}

  async listDocuments(): Promise<DocumentRow[]> {
    return [...this.documents.values()];
  }

  async getDocument(id: string): Promise<DocumentRow | undefined> {
    return this.documents.get(id);
  }

  async deleteDocument(id: string): Promise<boolean> {
    return this.documents.delete(id);
  }

  async search(): Promise<SearchResultRow[]> {
    return [];
  }

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

  async updateDocumentTitle(): Promise<boolean> {
    return false;
  }

  async reindexDocumentVocabulary(): Promise<{ blocksSeen: number; blocksUpdated: number; vocabularyTermsWritten: number; suggestionsWritten: number }> {
    return { blocksSeen: 0, blocksUpdated: 0, vocabularyTermsWritten: 0, suggestionsWritten: 0 };
  }

  async suggest(likePattern: string, limit: number): Promise<SuggestionCandidateRow[]> {
    this.suggestCalls.push({ likePattern, limit });
    // Mirrors the real `LIKE 'prefix%' ESCAPE '\'` predicate closely enough
    // to test orchestration -- strip the trailing "%" and any "\"-escaping
    // this fake does not need to unescape since its own fixtures never
    // contain literal % or _.
    const prefix = likePattern.replace(/%$/, "");
    return this.candidates.filter((candidate) => normalizeSuggestionText(candidate.text).startsWith(prefix)).slice(0, limit);
  }
}

function candidate(documentId: string, type: SuggestionType, text: string): SuggestionCandidateRow {
  return { documentId, type, text };
}

async function makeLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-suggest-search-"));
  const database = new SuggestFakeDatabase();
  const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "suggest-test");
  return { root, database, lifecycle };
}

describe("DocumentLifecycle.suggest (TKT-037)", () => {
  it("never queries the database for a prefix shorter than MIN_SUGGESTION_PREFIX_LENGTH", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      const response = await lifecycle.suggest("h".repeat(MIN_SUGGESTION_PREFIX_LENGTH - 1));
      expect(response.suggestions).toEqual([]);
      expect(database.suggestCalls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns bounded, ranked suggestions for a valid prefix", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.candidates.push(
        candidate("doc-1", "technical", "HY-100"),
        candidate("doc-1", "heading", "Hydraulic Overview"),
        candidate("doc-2", "title", "Hydraulic Systems Manual"),
      );
      const response = await lifecycle.suggest("hydr");
      expect(response.suggestions.map((s) => s.type)).toEqual(["title", "heading"]);
      expect(database.suggestCalls[0].likePattern).toBe("hydr%");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates the same suggestion contributed by multiple documents", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.candidates.push(candidate("doc-1", "heading", "Introduction"), candidate("doc-2", "heading", "Introduction"));
      const response = await lifecycle.suggest("intro");
      expect(response.suggestions).toEqual([{ text: "Introduction", type: "heading" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a prefix with no matching candidates", async () => {
    const { root, database, lifecycle } = await makeLifecycle();
    try {
      database.candidates.push(candidate("doc-1", "heading", "Hydraulic Overview"));
      const response = await lifecycle.suggest("zzz");
      expect(response.suggestions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
