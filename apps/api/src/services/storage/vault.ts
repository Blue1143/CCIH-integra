import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Env } from '../../env';
import { LocalDiskStore, blobKey, type BlobStore, type StorageBackend } from './blob-store';
import { S3CompatibleStore } from './s3';

/**
 * Attachment contents: optional application encryption (AES-256-GCM, named keys so they can be
 * rotated) on top of the chosen store, and an integrity check (SHA-256 of the original content) on
 * every read. A ciphertext is bound to its storage key, so a file moved under another name does not
 * decrypt.
 */
export type Encryption = 'none' | 'aes-256-gcm';
export interface BlobLocation { backend: StorageBackend; key: string; encryption: Encryption; keyId: string | null; sha256: string }

const MAGIC = Buffer.from('CCIHENC1');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export class IntegrityError extends Error {}
export class StorageUnavailableError extends Error {}

export class AttachmentVault {
  constructor(
    private readonly stores: Partial<Record<StorageBackend, BlobStore>>,
    readonly backend: StorageBackend,
    private readonly keys: Map<string, Buffer>,
    readonly currentKeyId: string | null,
  ) {
    if (!stores[backend]) throw new Error(`Armazenamento ${backend} não configurado.`);
    if (currentKeyId && !keys.has(currentKeyId)) throw new Error('Chave atual dos anexos ausente.');
  }

  static fromEnv(env: Env, overrides: Partial<Record<StorageBackend, BlobStore>> = {}): AttachmentVault {
    const stores: Partial<Record<StorageBackend, BlobStore>> = { local: new LocalDiskStore(env.UPLOAD_DIR) };
    if (env.S3_ENDPOINT && env.S3_REGION && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
      stores.s3 = new S3CompatibleStore({
        endpoint: env.S3_ENDPOINT, region: env.S3_REGION, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE, serverSideEncryption: env.S3_SERVER_SIDE_ENCRYPTION,
      });
    }
    Object.assign(stores, overrides);
    const keys = new Map<string, Buffer>();
    for (const part of (env.ATTACHMENT_ENCRYPTION_PREVIOUS_KEYS ?? '').split(';').map((p) => p.trim()).filter(Boolean)) {
      const [id, b64] = part.split(':');
      const key = Buffer.from(b64 ?? '', 'base64');
      if (!id || !/^[a-z0-9-]{1,32}$/.test(id) || key.length !== 32) throw new Error('ATTACHMENT_ENCRYPTION_PREVIOUS_KEYS inválida: use "id:base64;id:base64" com chaves de 32 bytes.');
      keys.set(id, key);
    }
    if (env.ATTACHMENT_ENCRYPTION_KEY && env.ATTACHMENT_ENCRYPTION_KEY_ID) keys.set(env.ATTACHMENT_ENCRYPTION_KEY_ID, Buffer.from(env.ATTACHMENT_ENCRYPTION_KEY, 'base64'));
    return new AttachmentVault(stores, env.ATTACHMENT_STORAGE, keys, env.ATTACHMENT_ENCRYPTION_KEY_ID ?? null);
  }

  get encrypted() {
    return this.currentKeyId !== null;
  }

  private store(backend: StorageBackend): BlobStore {
    const s = this.stores[backend];
    if (!s) throw new StorageUnavailableError(`O arquivo está no armazenamento "${backend}", que não está configurado neste servidor.`);
    return s;
  }

  private seal(plain: Buffer, keyId: string, key: string): Buffer {
    const iv = randomBytes(12);
    const id = Buffer.from(keyId);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(keyId)!, iv);
    cipher.setAAD(Buffer.from(`attachment|${key}`));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([MAGIC, Buffer.from([id.length]), id, iv, cipher.getAuthTag(), ct]);
  }

  private open(sealed: Buffer, loc: BlobLocation): Buffer {
    if (!sealed.subarray(0, 8).equals(MAGIC)) throw new IntegrityError('Arquivo cifrado com formato desconhecido.');
    const idLen = sealed[8]!;
    const id = sealed.subarray(9, 9 + idLen).toString();
    if (id !== loc.keyId) throw new IntegrityError('A chave do arquivo não corresponde ao registro.');
    const key = this.keys.get(id);
    if (!key) throw new StorageUnavailableError(`A chave "${id}" deste arquivo não está configurada (ATTACHMENT_ENCRYPTION_PREVIOUS_KEYS).`);
    const at = 9 + idLen;
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(at, at + 12));
    decipher.setAAD(Buffer.from(`attachment|${loc.key}`));
    decipher.setAuthTag(sealed.subarray(at + 12, at + 28));
    try {
      return Buffer.concat([decipher.update(sealed.subarray(at + 28)), decipher.final()]);
    } catch {
      throw new IntegrityError('O arquivo cifrado foi alterado ou corrompido.');
    }
  }

  /** Stores a new content under a generated key, encrypted with the current key when configured. */
  async save(institutionId: string, plain: Buffer, backend: StorageBackend = this.backend, keyId: string | null = this.currentKeyId): Promise<BlobLocation & { fileId: string }> {
    const fileId = randomUUID();
    const key = blobKey(institutionId, fileId);
    const data = keyId ? this.seal(plain, keyId, key) : plain;
    await this.store(backend).put(key, data);
    return { backend, key, fileId, encryption: keyId ? 'aes-256-gcm' : 'none', keyId, sha256: sha256(plain) };
  }

  /** Content as uploaded; refuses anything whose SHA-256 differs from the registered one. */
  async read(loc: BlobLocation): Promise<Buffer> {
    const raw = await this.store(loc.backend).get(loc.key);
    const plain = loc.encryption === 'none' ? raw : this.open(raw, loc);
    if (sha256(plain) !== loc.sha256) throw new IntegrityError('O conteúdo do arquivo não confere com o registrado (SHA-256).');
    return plain;
  }

  remove(loc: Pick<BlobLocation, 'backend' | 'key'>) {
    return this.store(loc.backend).remove(loc.key);
  }

  /** Readiness of the current store (and that the current key exists). */
  async probe(): Promise<void> {
    await this.store(this.backend).probe();
  }

  /** Copy to the target store/key (migration or re-encryption): read, verify, write, read back and verify. The source is kept. */
  async copy(loc: BlobLocation, institutionId: string, to: StorageBackend, keyId: string | null): Promise<BlobLocation & { fileId: string }> {
    const plain = await this.read(loc);
    const next = await this.save(institutionId, plain, to, keyId);
    await this.read(next);
    return next;
  }
}
