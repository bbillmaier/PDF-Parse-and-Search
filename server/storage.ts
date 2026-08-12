import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ParsedDocument, TitleSource } from "../src/pdf-content-extractor/index.ts";

const DOCUMENT_ID = /^[a-z][a-z0-9-]{0,127}$/;
const ASSET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1_600] as const;

export interface StoredDocumentMetadata {
  documentId: string;
  title: string;
  originalFilename: string;
  pdfStoragePath: string;
  semanticStoragePath: string;
  assetNames: string[];
}

export interface DocumentAssetInput {
  name: string;
  bytes: Uint8Array;
}

export interface SaveDocumentInput {
  documentId: string;
  title: string;
  originalFilename: string;
  originalPdf: Uint8Array;
  semanticDocument: ParsedDocument;
  assets: DocumentAssetInput[];
}

export interface LoadedDocument extends StoredDocumentMetadata {
  originalPdf: Uint8Array;
  semanticDocument: ParsedDocument;
  assets: DocumentAssetInput[];
}

export interface DeleteDocumentResult {
  deleted: boolean;
  partialFailure?: string;
}

/** TKT-036: a semantic-document.json update staged next to the live file but
 *  not yet visible to readers -- `publishTitleOverride` atomically replaces
 *  the live file with it, `discardStagedTitleOverride` deletes it unused.
 *  Kept as an opaque handle (rather than exposing the temp path directly) so
 *  callers cannot accidentally read or publish a half-written file. */
export interface StagedTitleOverride {
  documentId: string;
  tempPath: string;
  finalPath: string;
}

/** TKT-036: the display-title fields a host override writes into the stored
 *  semantic document's metadata -- always `source: "host"` in practice, but
 *  typed generally so a test can stage any selection. */
export interface TitleOverrideMetadataPatch {
  displayTitle: string;
  titleSource: TitleSource;
  titleConfidence: number;
}

export class StorageConflictError extends Error {
  constructor(documentId: string) {
    super(`Document storage already exists: ${documentId}`);
    this.name = "StorageConflictError";
  }
}

export interface DocumentStorageHooks {
  beforePublish?: (documentId: string) => Promise<void> | void;
}

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

export function validateDocumentId(documentId: string): string {
  if (!DOCUMENT_ID.test(documentId)) throw new Error(`Invalid document id: ${documentId}`);
  return documentId;
}

export function validateAssetName(assetName: string): string {
  if (!ASSET_NAME.test(assetName) || assetName.includes("..")) throw new Error(`Invalid asset name: ${assetName}`);
  return assetName;
}

function resolveInside(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Resolved path escapes storage root.");
  return resolved;
}

function isTransientRenameError(error: unknown): boolean {
  if (process.platform !== "win32" || typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY";
}

function isAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EEXIST" || error.code === "ENOTEMPTY";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function publishDirectory(stagingDir: string, finalDir: string, documentId: string): Promise<void> {
  try {
    await lstat(finalDir);
    throw new StorageConflictError(documentId);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  let lastTransientError: unknown;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(stagingDir, finalDir);
      return;
    } catch (error) {
      if (isAlreadyExistsError(error)) throw new StorageConflictError(documentId);
      const delayMs = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!isTransientRenameError(error)) throw error;
      lastTransientError = error;
      if (delayMs === undefined) break;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Some Windows antivirus/indexing configurations keep a handle on a newly
  // written PDF long enough to reject every directory rename. The database is
  // the publication boundary, so a guarded copy into a newly-created final
  // directory is still invisible to readers until the subsequent transaction
  // commits. Never copy over an existing document directory.
  let createdFinalDirectory = false;
  try {
    await mkdir(finalDir);
    createdFinalDirectory = true;
    await cp(stagingDir, finalDir, { recursive: true, force: false, errorOnExist: true });
    await rm(stagingDir, { recursive: true, force: true });
  } catch (copyError) {
    if (createdFinalDirectory) await rm(finalDir, { recursive: true, force: true });
    if (!createdFinalDirectory && isAlreadyExistsError(copyError)) throw new StorageConflictError(documentId);
    throw new AggregateError([lastTransientError, copyError], "Could not publish the staged document directory.");
  }
}

/** TKT-036: same bounded Windows-antivirus/indexer retry as
 *  `publishDirectory`, but for a single-file atomic replace -- `rename()`
 *  replacing an existing destination file is already atomic on POSIX and
 *  Windows, so (unlike `publishDirectory`) there is no "already exists"
 *  case to special-case here: the destination is expected to exist. */
async function renameFileWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const delayMs = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!isTransientRenameError(error) || delayMs === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export class DocumentStorage {
  readonly root: string;
  private readonly hooks: DocumentStorageHooks;

  constructor(root: string, hooks: DocumentStorageHooks = {}) {
    this.root = normalizeRoot(root);
    this.hooks = hooks;
  }

  documentPath(documentId: string): string {
    return resolveInside(this.root, validateDocumentId(documentId));
  }

  async save(input: SaveDocumentInput): Promise<StoredDocumentMetadata> {
    validateDocumentId(input.documentId);
    const seenAssets = new Set<string>();
    for (const asset of input.assets) {
      validateAssetName(asset.name);
      if (seenAssets.has(asset.name)) throw new Error(`Duplicate asset name: ${asset.name}`);
      seenAssets.add(asset.name);
    }

    await mkdir(this.root, { recursive: true });
    const finalDir = this.documentPath(input.documentId);
    const stagingDir = resolveInside(this.root, `.staging-${input.documentId}-${randomUUID()}`);
    const assetsDir = resolveInside(stagingDir, "assets");
    try {
      await mkdir(assetsDir, { recursive: true });
      await writeFile(resolveInside(stagingDir, "original.pdf"), input.originalPdf);
      await writeFile(resolveInside(stagingDir, "semantic-document.json"), JSON.stringify(input.semanticDocument, null, 2));
      for (const asset of input.assets) await writeFile(resolveInside(assetsDir, asset.name), asset.bytes);
      await this.hooks.beforePublish?.(input.documentId);
      // Windows virus scanners and file indexers can briefly retain a handle
      // after the last write. Retrying only transient Windows errors preserves
      // the atomic same-volume publish without masking real path conflicts.
      await publishDirectory(stagingDir, finalDir, input.documentId);
      return {
        documentId: input.documentId,
        title: input.title,
        originalFilename: input.originalFilename,
        pdfStoragePath: path.relative(this.root, resolveInside(finalDir, "original.pdf")),
        semanticStoragePath: path.relative(this.root, resolveInside(finalDir, "semantic-document.json")),
        assetNames: [...seenAssets].sort(),
      };
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  async load(documentId: string): Promise<LoadedDocument> {
    const dir = this.documentPath(documentId);
    const semanticBytes = await readFile(resolveInside(dir, "semantic-document.json"), "utf8");
    const semanticDocument = JSON.parse(semanticBytes) as ParsedDocument;
    const originalPdf = new Uint8Array(await readFile(resolveInside(dir, "original.pdf")));
    const assetsDir = resolveInside(dir, "assets");
    const assetNames = (await readdir(assetsDir)).filter((name) => validateAssetName(name)).sort();
    const assets = await Promise.all(assetNames.map(async (name) => ({ name, bytes: new Uint8Array(await readFile(resolveInside(assetsDir, name))) })));
    return {
      documentId,
      // TKT-036: prefer the selected display title over the raw PDF
      // metadata title, which may itself be boilerplate or absent.
      title: semanticDocument.metadata.displayTitle ?? semanticDocument.metadata.title ?? "Untitled document",
      originalFilename: "original.pdf",
      pdfStoragePath: path.relative(this.root, resolveInside(dir, "original.pdf")),
      semanticStoragePath: path.relative(this.root, resolveInside(dir, "semantic-document.json")),
      assetNames,
      originalPdf,
      semanticDocument,
      assets,
    };
  }

  async listMetadata(): Promise<StoredDocumentMetadata[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const ids = entries.filter((entry) => entry.isDirectory() && DOCUMENT_ID.test(entry.name)).map((entry) => entry.name).sort();
    return Promise.all(ids.map(async (id) => {
      const loaded = await this.load(id);
      return {
        documentId: loaded.documentId,
        title: loaded.title,
        originalFilename: loaded.originalFilename,
        pdfStoragePath: loaded.pdfStoragePath,
        semanticStoragePath: loaded.semanticStoragePath,
        assetNames: loaded.assetNames,
      };
    }));
  }

  async delete(documentId: string): Promise<DeleteDocumentResult> {
    const dir = this.documentPath(documentId);
    try {
      await rm(dir, { recursive: true, force: false });
      return { deleted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { deleted: false, partialFailure: message };
    }
  }

  /**
   * TKT-036: stages an updated semantic-document.json (raw `metadata.title`
   * untouched, `metadata.displayTitle`/`titleSource`/`titleConfidence`
   * replaced) next to the live file, without touching the live file itself.
   * Never reparses the PDF -- only reads the already-stored semantic JSON.
   * Callers should stage before committing any corresponding database
   * change, so a staging failure (e.g. disk full) never leaves the database
   * ahead of storage; see server/lifecycle.ts's `overrideTitle`.
   */
  async stageTitleOverride(documentId: string, patch: TitleOverrideMetadataPatch): Promise<StagedTitleOverride> {
    const dir = this.documentPath(documentId);
    const finalPath = resolveInside(dir, "semantic-document.json");
    const current = JSON.parse(await readFile(finalPath, "utf8")) as ParsedDocument;
    const updated: ParsedDocument = {
      ...current,
      metadata: {
        ...current.metadata,
        displayTitle: patch.displayTitle,
        titleSource: patch.titleSource,
        titleConfidence: patch.titleConfidence,
      },
    };
    const tempPath = resolveInside(dir, `.semantic-document.json.tmp-${randomUUID()}`);
    await writeFile(tempPath, JSON.stringify(updated, null, 2));
    return { documentId, tempPath, finalPath };
  }

  /** TKT-036: atomically replaces the live semantic-document.json with a
   *  previously staged update. Call only after the corresponding database
   *  change has committed -- if this throws, the database and storage are
   *  now inconsistent (title updated in the database, not yet in storage);
   *  callers must treat that as a reported, retryable partial failure
   *  rather than an overall operation failure, since re-staging and
   *  re-publishing the same title is idempotent. */
  async publishTitleOverride(staged: StagedTitleOverride): Promise<void> {
    await renameFileWithRetry(staged.tempPath, staged.finalPath);
  }

  /** TKT-036: discards a staged update that will never be published (the
   *  corresponding database change did not commit). Best-effort: a leftover
   *  temp file is inert (never read by `load`/`listMetadata`, which only
   *  look at `semantic-document.json` itself) and safe to ignore. */
  async discardStagedTitleOverride(staged: StagedTitleOverride): Promise<void> {
    await rm(staged.tempPath, { force: true });
  }
}
