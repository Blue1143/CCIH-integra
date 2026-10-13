import { createHash, createHmac } from 'node:crypto';
import { assertKey, type BlobStore } from './blob-store';

/**
 * S3-compatible object store (Amazon S3, MinIO, providers that implement the S3 REST API), signed
 * with AWS Signature Version 4 as documented by AWS. Downloads go through the API (permission check
 * and audit on every access), so no pre-signed URL is handed to browsers.
 */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  serverSideEncryption: 'AES256' | 'none';
  /** Replaceable for tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
export const EMPTY_SHA256 = sha256hex('');

/** RFC 3986 encoding as SigV4 requires (paths are encoded segment by segment). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  amzDate: string;
  service?: string;
}

/** Authorization header value for the request (headers must include host and x-amz-date). */
export function signV4(i: SignInput): string {
  const service = i.service ?? 's3';
  const names = Object.keys(i.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...i.url.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const path = i.url.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const canonical = [i.method, path, query, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const day = i.amzDate.slice(0, 8);
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class S3Error extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class S3CompatibleStore implements BlobStore {
  readonly backend = 's3' as const;
  private readonly fetch: typeof fetch;
  constructor(private readonly c: S3Config) {
    this.fetch = c.fetch ?? fetch;
  }

  private url(key: string | null): URL {
    const base = new URL(this.c.endpoint);
    const path = key === null ? '' : `/${key}`;
    if (this.c.forcePathStyle) return new URL(`${base.protocol}//${base.host}/${this.c.bucket}${path || '/'}`);
    return new URL(`${base.protocol}//${this.c.bucket}.${base.host}${path || '/'}`);
  }

  private async send(method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string | null, body?: Buffer): Promise<Response> {
    const url = this.url(key);
    const amzDate = (this.c.now?.() ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = body ? sha256hex(body) : EMPTY_SHA256;
    const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
    if (body) {
      headers['content-type'] = 'application/octet-stream';
      if (this.c.serverSideEncryption === 'AES256') headers['x-amz-server-side-encryption'] = 'AES256';
    }
    const authorization = signV4({ method, url, headers, payloadHash, accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey, region: this.c.region, amzDate });
    const { host: _host, ...sent } = headers;
    const res = await this.fetch(url, { method, headers: { ...sent, authorization }, ...(body ? { body: new Uint8Array(body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = method === 'HEAD' ? '' : (await res.text()).slice(0, 300);
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      throw new S3Error(res.status, `Armazenamento de objetos respondeu ${res.status}${code ? ` (${code})` : ''}.`);
    }
    return res;
  }

  async put(key: string, data: Buffer) {
    assertKey(key);
    await this.send('PUT', key, data);
  }

  async get(key: string) {
    assertKey(key);
    return Buffer.from(await (await this.send('GET', key)).arrayBuffer());
  }

  async remove(key: string) {
    assertKey(key);
    await this.send('DELETE', key);
  }

  async probe() {
    await this.send('HEAD', null);
  }
}
