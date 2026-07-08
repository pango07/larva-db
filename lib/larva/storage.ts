import {
  BlobError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  del as blobDel,
  get as blobGet,
  list as blobList,
  put as blobPut,
} from "@vercel/blob";

/** Thrown by StorageAdapter.put when a compare-and-swap precondition fails
 * (ifMatch mismatch, or createOnly against an existing object). */
export class CasConflictError extends Error {
  constructor(path: string) {
    super(`CAS precondition failed for ${path}`);
    this.name = "CasConflictError";
  }
}

export interface GetResult {
  body: string;
  etag: string;
}

/**
 * Blob GETs return a weak ETag (W/"...") once the response is large enough to
 * be served gzip-transformed. A weak ETag never satisfies ifMatch, so using it
 * verbatim livelocks every writer with permanent 412s. The opaque value is the
 * same — strip the weakness marker.
 */
const strongEtag = (etag: string): string => (etag.startsWith("W/") ? etag.slice(2) : etag);

/** Blob throws transient 5xx/network errors under concurrent load. Reads are
 * idempotent and safely retried here; writes are NOT (an ambiguous put may have
 * landed) — the commit protocol must resolve those itself. */
export function isTransientStorageError(err: unknown): boolean {
  if (err instanceof BlobServiceNotAvailable || err instanceof BlobServiceRateLimited) return true;
  if (err instanceof BlobError && /:\s*5\d\d|internal server error/i.test(err.message)) return true;
  return err instanceof TypeError; // fetch network failure
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PutOptions {
  /** Only write if the object's current ETag matches (compare-and-swap). */
  ifMatch?: string;
  /** Only write if the object does not exist yet. */
  createOnly?: boolean;
}

/**
 * The four-operation storage contract from Design §12.
 * Everything Vercel-specific lives in VercelBlobAdapter below.
 */
export interface StorageAdapter {
  /** fresh: bypass any CDN/edge cache — required for manifest reads. */
  get(path: string, opts?: { fresh?: boolean }): Promise<GetResult | null>;
  put(path: string, body: string, opts?: PutOptions): Promise<{ etag: string }>;
  del(paths: string[]): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class VercelBlobAdapter implements StorageAdapter {
  async get(path: string, opts?: { fresh?: boolean }): Promise<GetResult | null> {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await blobGet(path, { access: "private", useCache: !opts?.fresh });
      } catch (err) {
        if (err instanceof BlobNotFoundError) return null;
        if (isTransientStorageError(err) && attempt < 4) {
          await sleep(Math.random() * 200 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      if (res === null || res.statusCode !== 200) return null;
      const body = await new Response(res.stream).text();
      return { body, etag: strongEtag(res.blob.etag) };
    }
  }

  async put(path: string, body: string, opts?: PutOptions): Promise<{ etag: string }> {
    try {
      const result = await blobPut(path, body, {
        access: "private",
        contentType: "application/json",
        allowOverwrite: !opts?.createOnly,
        ...(opts?.ifMatch ? { ifMatch: opts.ifMatch } : {}),
      });
      return { etag: strongEtag(result.etag) };
    } catch (err) {
      if (err instanceof BlobPreconditionFailedError) throw new CasConflictError(path);
      if (err instanceof BlobError) {
        // Two racing conditional ops on one object: Blob rejects the loser with a
        // bad_request "conflicting operation" error, not a 412. Same meaning: retry.
        if (/conflicting operation|conditional request/i.test(err.message)) {
          throw new CasConflictError(path);
        }
        // createOnly violation surfaces as a generic BlobError mentioning overwrite
        if (opts?.createOnly && /exist|overwrite/i.test(err.message)) {
          throw new CasConflictError(path);
        }
      }
      throw err;
    }
  }

  async del(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await blobDel(paths);
  }

  async list(prefix: string): Promise<string[]> {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await blobList({ prefix, cursor });
      paths.push(...page.blobs.map((b) => b.pathname));
      cursor = page.cursor;
    } while (cursor);
    return paths;
  }
}
