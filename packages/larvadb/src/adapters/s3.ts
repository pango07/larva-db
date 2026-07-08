import { CasConflictError, GetResult, ListedObject, PutOptions, StorageAdapter } from "../storage";

/**
 * StorageAdapter for any S3-compatible store — AWS S3, Cloudflare R2, and
 * friends (Design §12). Zero dependencies: SigV4 request signing is done with
 * WebCrypto. The CAS contract maps to conditional writes: `If-Match` for swaps
 * and `If-None-Match: *` for create-only, both answered with 412 on loss (S3
 * also answers 409 when conditional writes race in flight — same meaning).
 */
export interface S3AdapterOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** AWS region, e.g. "us-east-1". Use "auto" for R2. */
  region?: string;
  /** Custom endpoint (e.g. https://<account>.r2.cloudflarestorage.com).
   * When set, path-style addressing is used. */
  endpoint?: string;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

const encoder = new TextEncoder();
const strongEtag = (etag: string): string => (etag.startsWith("W/") ? etag.slice(2) : etag);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RFC 3986 escaping, stricter than encodeURIComponent (SigV4 requires it). */
const uriEscape = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const sha256 = async (data: string | Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? encoder.encode(data) : (data as BufferSource)));

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export class S3Adapter implements StorageAdapter {
  private region: string;

  constructor(private opts: S3AdapterOptions) {
    this.region = opts.region ?? (opts.endpoint ? "auto" : "us-east-1");
  }

  private baseUrl(): URL {
    return this.opts.endpoint
      ? new URL(`${this.opts.endpoint.replace(/\/$/, "")}/${this.opts.bucket}`)
      : new URL(`https://${this.opts.bucket}.s3.${this.region}.amazonaws.com`);
  }

  /** Sign and send one S3 request. query values must be raw (unencoded). */
  private async request(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    const base = this.baseUrl();
    const path = `${base.pathname === "/" ? "" : base.pathname}/${key.split("/").map(uriEscape).join("/")}`;
    const query = Object.entries(opts.query ?? {})
      .map(([k, v]) => [uriEscape(k), uriEscape(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const queryString = query.map(([k, v]) => `${k}=${v}`).join("&");

    const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const date = now.slice(0, 8);
    const payloadHash = await sha256(opts.body ?? "");

    const headers: Record<string, string> = {
      host: base.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": now,
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
    const canonicalRequest = [method, path || "/", queryString, canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");

    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", now, scope, await sha256(canonicalRequest)].join("\n");
    let signingKey = await hmac(encoder.encode(`AWS4${this.opts.secretAccessKey}`), date);
    for (const part of [this.region, "s3", "aws4_request"]) signingKey = await hmac(signingKey, part);
    const signature = hex(await hmac(signingKey, stringToSign));

    const { host: _host, ...fetchHeaders } = headers;
    void _host;
    return fetch(`${base.origin}${path || "/"}${queryString ? `?${queryString}` : ""}`, {
      method,
      headers: {
        ...fetchHeaders,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.opts.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
      },
      body: opts.body,
    });
  }

  async get(path: string, _opts?: { fresh?: boolean }): Promise<GetResult | null> {
    void _opts; // S3 reads are strongly consistent; no cache layer to bust
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.request("GET", path);
      } catch (err) {
        if (attempt < 4) {
          await sleep(Math.random() * 200 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      if (res.status === 404) return null;
      if (res.status >= 500 && attempt < 4) {
        await sleep(Math.random() * 200 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new S3Error(res.status, `GET ${path} failed: ${res.status} ${await res.text()}`);
      return { body: await res.text(), etag: strongEtag(res.headers.get("etag") ?? "") };
    }
  }

  async put(path: string, body: string, opts?: PutOptions): Promise<{ etag: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts?.ifMatch) headers["if-match"] = opts.ifMatch;
    if (opts?.createOnly) headers["if-none-match"] = "*";
    const res = await this.request("PUT", path, { headers, body });
    // 412: precondition failed; 409: racing in-flight conditional writes — same meaning here.
    if (res.status === 412 || res.status === 409) throw new CasConflictError(path);
    if (!res.ok) throw new S3Error(res.status, `PUT ${path} failed: ${res.status} ${await res.text()}`);
    return { etag: strongEtag(res.headers.get("etag") ?? "") };
  }

  async del(paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 20) {
      await Promise.all(
        paths.slice(i, i + 20).map(async (path) => {
          const res = await this.request("DELETE", path);
          if (!res.ok && res.status !== 404) {
            throw new S3Error(res.status, `DELETE ${path} failed: ${res.status}`);
          }
        }),
      );
    }
  }

  async list(prefix: string): Promise<ListedObject[]> {
    const objects: ListedObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.request("GET", "", {
        query: { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) },
      });
      if (!res.ok) throw new S3Error(res.status, `LIST ${prefix} failed: ${res.status} ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
        const modified = m[1].match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
        if (key) objects.push({ path: unescapeXml(key), uploadedAt: new Date(modified ?? 0) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
        : undefined;
    } while (token);
    return objects;
  }
}
