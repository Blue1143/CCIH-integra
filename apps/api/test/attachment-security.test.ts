import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { EMPTY_SHA256, S3CompatibleStore, signV4 } from '../src/services/storage/s3';
import { LocalDiskStore, type BlobStore } from '../src/services/storage/blob-store';
import { AttachmentVault, IntegrityError, StorageUnavailableError } from '../src/services/storage/vault';
import { ClamAvScanner, type Scanner } from '../src/services/storage/antivirus';
import { migrateAll, verifyAll } from '../src/cli/attachments';
import { login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

/** EICAR anti-malware test string (harmless by design), assembled so the source file itself is not a test file. */
const EICAR = Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-', 'TEST-FILE!$H+H*'].join(''));
const pdf = (body: string | Buffer) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(body), Buffer.from('\n%%EOF')]);

/**
 * SIMULATED clamd (always available in the test suite): implements the INSTREAM framing and answers
 * FOUND when the stream contains the EICAR string. The real clamd is exercised further down when
 * CLAMAV_TEST_HOST is set.
 */
function fakeClamd(behaviour: 'normal' | 'broken' = 'normal'): Promise<{ server: TcpServer; port: number }> {
  return new Promise((resolve) => {
    const server = createTcpServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const cmd = buf.subarray(0, buf.indexOf(0) + 1).toString();
        if (cmd === 'zVERSION\0') { socket.end('ClamAV simulado/0/0\0'); return; }
        if (cmd === 'zPING\0') { socket.end('PONG\0'); return; }
        if (behaviour === 'broken') { socket.end('INSTREAM size limit exceeded. ERROR\0'); return; }
        let at = 10;
        const chunks: Buffer[] = [];
        while (at + 4 <= buf.length) {
          const len = buf.readUInt32BE(at);
          if (len === 0) {
            const data = Buffer.concat(chunks);
            socket.end(data.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (at + 4 + len > buf.length) return;
          chunks.push(buf.subarray(at + 4, at + 4 + len));
          at += 4 + len;
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

/** SIMULATED S3-compatible server: in-memory objects; checks the signed payload hash and the encryption header. */
function fakeS3(): Promise<{ server: Server; endpoint: string; objects: Map<string, Buffer>; requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }> }> {
  const objects = new Map<string, Buffer>();
  const requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }> = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        requests.push({ method: req.method!, url: req.url!, headers: req.headers });
        if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=TESTKEY/')) { res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>'); return; }
        const body = Buffer.concat(parts);
        if (req.method === 'PUT') {
          const hash = createHash('sha256').update(body).digest('hex');
          if (req.headers['x-amz-content-sha256'] !== hash) { res.writeHead(400).end('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>'); return; }
          objects.set(req.url!, body);
          res.writeHead(200).end();
        } else if (req.method === 'GET') {
          const o = objects.get(req.url!);
          if (!o) { res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); return; }
          res.writeHead(200).end(o);
        } else if (req.method === 'DELETE') { objects.delete(req.url!); res.writeHead(204).end(); } else res.writeHead(200).end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, objects, requests }));
  });
}

describe('S3 signature (AWS Signature Version 4)', () => {
  it('matches the GET Object example published in the AWS documentation', () => {
    const auth = signV4({
      method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': '20130524T000000Z' },
      payloadHash: EMPTY_SHA256, accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z',
    });
    expect(auth).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('stores, reads and removes objects with path-style addressing and server-side encryption (simulated server)', async () => {
    const s3 = await fakeS3();
    const store = new S3CompatibleStore({ endpoint: s3.endpoint, region: 'sa-east-1', bucket: 'ccih-anexos', accessKeyId: 'TESTKEY', secretAccessKey: 'testsecret', forcePathStyle: true, serverSideEncryption: 'AES256' });
    const key = `${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}`;
    await store.put(key, Buffer.from('conteúdo'));
    expect([...s3.objects.keys()]).toEqual([`/ccih-anexos/${key}`]);
    expect(s3.requests[0]!.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect((await store.get(key)).toString()).toBe('conteúdo');
    await store.remove(key);
    await expect(store.get(key)).rejects.toThrow(/404 \(NoSuchKey\)/);
    await expect(new S3CompatibleStore({ endpoint: s3.endpoint, region: 'x', bucket: 'ccih-anexos', accessKeyId: 'OUTRA', secretAccessKey: 'x', forcePathStyle: true, serverSideEncryption: 'none' }).probe()).rejects.toThrow(/403/);
    expect(() => store.get('../../etc/passwd')).rejects.toThrow(/inválida/);
    s3.server.close();
  });
});

describe('application encryption', () => {
  const inst = '2b0c6c3e-1d1a-4c55-9b55-0a3f2e8d7c11';
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'ccih-vault-')); });

  it('encrypts at rest, checks integrity, and reads old files with a previous key', async () => {
    const store = new LocalDiskStore(dir);
    const v1 = new AttachmentVault({ local: store }, 'local', new Map([['k1', k1]]), 'k1');
    const content = pdf('evidência');
    const loc = await v1.save(inst, content);
    const raw = await readFile(join(dir, ...loc.key.split('/')));
    expect(raw.includes(Buffer.from('%PDF'))).toBe(false);
    expect(loc).toMatchObject({ encryption: 'aes-256-gcm', keyId: 'k1' });
    expect((await v1.read(loc)).equals(content)).toBe(true);
    // Rotated key: the old file still opens while the previous key is configured, and not without it.
    const v2 = new AttachmentVault({ local: store }, 'local', new Map([['k1', k1], ['k2', k2]]), 'k2');
    expect((await v2.read(loc)).equals(content)).toBe(true);
    await expect(new AttachmentVault({ local: store }, 'local', new Map([['k2', k2]]), 'k2').read(loc)).rejects.toBeInstanceOf(StorageUnavailableError);
    // Tampering, or the ciphertext presented under another name, is detected.
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 1]! ^= 1;
    await writeFile(join(dir, ...loc.key.split('/')), tampered);
    await expect(v1.read(loc)).rejects.toBeInstanceOf(IntegrityError);
    const other = await v1.save(inst, content);
    await expect(v1.read({ ...other, key: loc.key })).rejects.toBeInstanceOf(IntegrityError);
    // Without encryption the SHA-256 still guards the content.
    const plain = new AttachmentVault({ local: store }, 'local', new Map(), null);
    const p = await plain.save(inst, content);
    await expect(plain.read({ ...p, sha256: '0'.repeat(64) })).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('ClamAV adapter (simulated clamd)', () => {
  it('reports clean, threat (with signature) and errors without throwing', async () => {
    const ok = await fakeClamd();
    const scanner = new ClamAvScanner('127.0.0.1', ok.port, 2000);
    expect(await scanner.scan(pdf('limpo'))).toMatchObject({ status: 'limpo', engine: 'ClamAV simulado/0/0' });
    expect(await scanner.scan(pdf(EICAR))).toMatchObject({ status: 'infectado', signature: 'Eicar-Test-Signature' });
    // Larger than one INSTREAM chunk.
    expect(await scanner.scan(Buffer.concat([pdf(randomBytes(200_000)), EICAR]))).toMatchObject({ status: 'infectado' });
    await scanner.probe();
    const broken = await fakeClamd('broken');
    expect(await new ClamAvScanner('127.0.0.1', broken.port, 2000).scan(pdf('x'))).toMatchObject({ status: 'erro', detail: expect.stringContaining('ERROR') });
    ok.server.close();
    broken.server.close();
    expect(await new ClamAvScanner('127.0.0.1', 1, 1000).scan(pdf('x'))).toMatchObject({ status: 'erro', detail: expect.stringContaining('indisponível') });
  });
});

const realClamd = process.env.CLAMAV_TEST_HOST;
describe.skipIf(!realClamd)('ClamAV adapter against a real clamd (CLAMAV_TEST_HOST)', () => {
  it('detects the EICAR test file inside a PDF and passes a clean PDF', async () => {
    const [host, port] = realClamd!.split(':');
    const scanner = new ClamAvScanner(host!, Number(port ?? 3310), 10_000);
    await scanner.probe();
    expect(await scanner.scan(pdf('relatório limpo'))).toMatchObject({ status: 'limpo', engine: expect.stringMatching(/^ClamAV \d/) });
    const r = await scanner.scan(pdf(EICAR));
    expect(r.status).toBe('infectado');
    expect(r.signature).toMatch(/EICAR/i);
  });
});

/* ---------- API ---------- */

let ctx: TestContext;
let s: Record<string, Session>;
let testId: string;
let scannerSwitch: { current: Scanner };
let dir: string;
let target: AttachmentVault;
const memory = (): BlobStore & { objects: Map<string, Buffer> } => {
  const objects = new Map<string, Buffer>();
  return { backend: 's3', objects, put: async (k, d) => { objects.set(k, d); }, get: async (k) => { const o = objects.get(k); if (!o) throw new Error('ausente'); return o; }, remove: async (k) => { objects.delete(k); }, probe: async () => undefined };
};

describe('attachments API with antivirus and encryption', () => {
  let clamd: { server: TcpServer; port: number };
  beforeAll(async () => {
    clamd = await fakeClamd();
    dir = await mkdtemp(join(tmpdir(), 'ccih-api-'));
    const mem = memory();
    const keys = new Map([['k1', randomBytes(32)]]);
    const vault = new AttachmentVault({ local: new LocalDiskStore(dir), s3: mem }, 'local', keys, 'k1');
    // Same stores and keys, with the object store as destination (what the operator configures before migrating).
    target = new AttachmentVault({ local: new LocalDiskStore(dir), s3: mem }, 's3', keys, 'k1');
    // The scanner can be swapped during the test (antivirus down, then back).
    scannerSwitch = { current: new ClamAvScanner('127.0.0.1', clamd.port, 2000) };
    const scanner: Scanner = { get mode() { return scannerSwitch.current.mode; }, scan: (b) => scannerSwitch.current.scan(b), probe: () => scannerSwitch.current.probe() };
    ctx = await setupTestApp({ ANTIVIRUS: 'clamav', CLAMAV_HOST: '127.0.0.1' }, { vault, scanner });
    s = { enf: await login(ctx.app, 'cme'), consulta: await login(ctx.app, 'enf.ccih') };
    testId = (await ctx.db.selectFrom('sterilization_test').select('id').limit(1).executeTakeFirstOrThrow()).id;
  });
  afterAll(async () => { clamd.server.close(); await teardown(ctx); });

  const upload = (body: Buffer, name = 'evidencia.pdf') => ctx.app.inject({ method: 'POST', url: `/api/attachments?entity=sterilization_test&entityId=${testId}`, headers: { ...s.enf!.headers, 'content-type': 'application/pdf', 'x-file-name': name }, payload: body });
  const get = (who: Session, path: string, method: 'GET' | 'POST' = 'GET') => ctx.app.inject({ method, url: `/api${path}`, headers: who.headers, ...(method === 'POST' ? { payload: {} } : {}) });

  it('publishes the policy (antivirus, storage, encryption)', async () => {
    expect((await get(s.consulta!, '/attachments/policy')).json()).toEqual({ antivirus: 'clamav', storage: 'local', encrypted: true, maxMb: 5 });
  });

  it('checks the file before storing it: a clean file is stored encrypted and downloadable', async () => {
    const body = pdf('folha do Bowie-Dick');
    const res = await upload(body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ scan: 'limpo' });
    const row = await ctx.db.selectFrom('attachment').selectAll().where('id', '=', res.json().id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ storage_backend: 'local', encryption: 'aes-256-gcm', key_id: 'k1' });
    const raw = await readFile(join(dir, row.institution_id, row.storage_key));
    expect(raw.includes(Buffer.from('Bowie'))).toBe(false);
    const down = await get(s.enf!, `/attachments/${row.id}`);
    expect(down.statusCode).toBe(200);
    expect(down.rawPayload.equals(body)).toBe(true);
    expect(down.headers['cache-control']).toBe('no-store');
  });

  it('refuses a threat: nothing is stored and the attempt is logged with the signature', async () => {
    const before = await ctx.db.selectFrom('attachment').select((e) => e.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    const files = (await readdir(dir, { recursive: true })).length;
    const res = await upload(pdf(EICAR), 'malicioso.pdf');
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/Eicar-Test-Signature/);
    expect((await ctx.db.selectFrom('attachment').select((e) => e.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n).toBe(before.n);
    expect((await readdir(dir, { recursive: true })).length).toBe(files);
    const log = await ctx.db.selectFrom('audit_log').select(['action', 'context']).where('action', '=', 'malware_blocked').executeTakeFirstOrThrow();
    expect(JSON.stringify(log.context)).toContain('Eicar-Test-Signature');
  });

  it('keeps the file unavailable when the antivirus fails, until a new check passes', async () => {
    const working = scannerSwitch.current;
    scannerSwitch.current = new ClamAvScanner('127.0.0.1', 1, 500);
    const res = await upload(pdf('impressão do ciclo'));
    expect(res.json()).toMatchObject({ scan: 'erro' });
    const id = res.json().id;
    const blocked = await get(s.enf!, `/attachments/${id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/verificação falhou/);
    expect((await get(s.consulta!, `/attachments/${id}/scan`, 'POST')).statusCode).toBe(403);
    scannerSwitch.current = working;
    const again = await get(s.enf!, `/attachments/${id}/scan`, 'POST');
    expect(again.json()).toMatchObject({ scan: 'limpo' });
    expect((await get(s.enf!, `/attachments/${id}`)).statusCode).toBe(200);
    expect((await get(s.enf!, `/attachments/${id}/scan`, 'POST')).statusCode).toBe(409);
    const history = await ctx.db.selectFrom('attachment_scan').select('status').where('attachment_id', '=', id).orderBy('scanned_at').execute();
    expect(history.map((h) => h.status)).toEqual(['erro', 'limpo']);
  });

  it('blocks files never checked once an antivirus exists, and discards a threat found later', async () => {
    // A file that predates the antivirus (no check) and happens to carry a threat.
    const vaultPlain = new AttachmentVault({ local: new LocalDiskStore(dir) }, 'local', new Map(), null);
    const content = pdf(EICAR);
    const loc = await vaultPlain.save(ctx.institutionId, content);
    const row = await ctx.db.insertInto('attachment').values({ institution_id: ctx.institutionId, entity: 'sterilization_test', entity_id: testId, file_name: 'antigo.pdf', mime: 'application/pdf', size_bytes: content.length, sha256: loc.sha256, storage_key: loc.fileId, uploaded_by: null, uploaded_by_name: 'Carga inicial' }).returning('id').executeTakeFirstOrThrow();
    expect((await get(s.enf!, `/attachments/${row.id}`)).json().message).toMatch(/depois da verificação/);
    expect((await get(s.enf!, `/attachments/${row.id}/scan`, 'POST')).json()).toMatchObject({ scan: 'infectado' });
    await expect(readFile(join(dir, ...loc.key.split('/')))).rejects.toThrow();
    expect((await get(s.enf!, `/attachments/${row.id}`)).json().message).toMatch(/descartado/);
    expect((await get(s.enf!, `/attachments/${row.id}/scan`, 'POST')).statusCode).toBe(409);
  });

  it('keeps every check and copy: the history cannot be changed', async () => {
    await expect(sql`UPDATE attachment_scan SET status = 'limpo'`.execute(ctx.db)).rejects.toThrow();
    await expect(sql`DELETE FROM attachment_copy`.execute(ctx.db)).rejects.toThrow();
  });

  it('migrates to the object store with re-encryption only when applied, verifying each copy and keeping the source', async () => {
    const res = await upload(pdf('registro do ciclo'));
    const id = res.json().id;
    const row = await ctx.db.selectFrom('attachment').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const dry = await migrateAll(ctx.db, target, { reencrypt: false, apply: false, operator: 'teste' });
    expect(dry.copiado).toBe(0);
    expect(dry.planejado).toBeGreaterThan(0);
    expect(await ctx.db.selectFrom('attachment_copy').select('id').executeTakeFirst()).toBeUndefined();
    const applied = await migrateAll(ctx.db, target, { reencrypt: false, apply: true, operator: 'teste' });
    expect(applied.copiado).toBe(dry.planejado);
    expect(applied.falha).toBe(0);
    const copy = await ctx.db.selectFrom('attachment_copy').selectAll().where('attachment_id', '=', id).executeTakeFirstOrThrow();
    expect(copy).toMatchObject({ storage_backend: 's3', encryption: 'aes-256-gcm', sha256: row.sha256, operator: 'teste' });
    // The source stays on disk; downloads now read the copy.
    expect((await readFile(join(dir, row.institution_id, row.storage_key))).length).toBeGreaterThan(0);
    const down = await get(s.enf!, `/attachments/${id}`);
    expect(down.statusCode).toBe(200);
    expect(down.rawPayload.equals(pdf('registro do ciclo'))).toBe(true);
    const again = await migrateAll(ctx.db, target, { reencrypt: false, apply: true, operator: 'teste' });
    expect(again.copiado).toBe(0);
  });

  it('verifies in batch everything not yet clean', async () => {
    const c = await verifyAll(ctx.db, target, scannerSwitch.current);
    expect(c).toMatchObject({ infectado: 0, erro: 0 });
    expect(c.ignorado).toBeGreaterThan(0);
  });

  it('detects a file changed on disk, blocks it and logs the integrity failure', async () => {
    const res = await upload(pdf('lista de presença'));
    const row = await ctx.db.selectFrom('attachment').selectAll().where('id', '=', res.json().id).executeTakeFirstOrThrow();
    const path = join(dir, row.institution_id, row.storage_key);
    const raw = await readFile(path);
    raw[raw.length - 2]! ^= 0xff;
    await writeFile(path, raw);
    const down = await get(s.enf!, `/attachments/${row.id}`);
    expect(down.statusCode).toBe(500);
    expect(down.json().error).toBe('integridade');
    expect(await ctx.db.selectFrom('audit_log').select('id').where('action', '=', 'integrity_failure').where('entity_id', '=', row.id).executeTakeFirst()).toBeDefined();
  });
});

