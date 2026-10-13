import { basename } from 'node:path';
import type { AttachmentDto } from '@ccih/domain';
import { HttpError } from '../http/errors';
import type { Db } from '../repositories/clinical';
import { blobKey } from './storage/blob-store';
import type { BlobLocation } from './storage/vault';

/**
 * Uploaded files: the type is decided by the content (magic bytes), never by the name or the
 * declared header alone; PDFs with active content are refused; files are stored outside the web
 * root under a generated name and only served as downloads.
 */
export type AttachmentMime = 'application/pdf' | 'image/png' | 'image/jpeg';
export const ATTACHMENT_MIMES: AttachmentMime[] = ['application/pdf', 'image/png', 'image/jpeg'];
export const MAX_ATTACHMENTS_PER_RECORD = 10;
export type AttachmentEntity = 'sterilization_test' | 'training_session';

const reject = (message: string) => new HttpError(400, 'arquivo_invalido', message, [{ path: 'file', message }]);

export function detectMime(buf: Buffer): AttachmentMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** PDF features that run code or carry other files are not accepted as evidence. */
const ACTIVE_PDF = /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA|RichMedia|XFA)\b/;

export function validateUpload(buf: Buffer, declared: string | undefined, maxBytes: number): AttachmentMime {
  if (!buf.length) throw reject('Arquivo vazio.');
  if (buf.length > maxBytes) throw reject(`Arquivo maior que ${Math.floor(maxBytes / 1_048_576)} MB.`);
  const mime = detectMime(buf);
  if (!mime) throw reject('Formato não aceito. Envie PDF, PNG ou JPEG.');
  if (declared && declared.split(';')[0]!.trim().toLowerCase() !== mime) throw reject('O conteúdo do arquivo não corresponde ao tipo informado.');
  if (mime === 'application/pdf' && ACTIVE_PDF.test(buf.toString('latin1'))) throw reject('PDF com conteúdo ativo (scripts, ações ou arquivos embutidos) não é aceito.');
  return mime;
}

/** Display name only (the stored file never uses it). */
export function safeFileName(raw: string | undefined, mime: AttachmentMime): string {
  let name = '';
  try {
    name = basename(decodeURIComponent(raw ?? '')).normalize('NFC');
  } catch {
    name = '';
  }
  name = name.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  const ext = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' }[mime];
  if (!name || name.startsWith('.')) name = `anexo${ext}`;
  return name;
}

/** Where the content of an attachment is now: the latest copy made by the migration command, or where it was uploaded. */
export async function attachmentLocation(db: Db, a: { id: string; institution_id: string; storage_backend: 'local' | 's3'; storage_key: string; encryption: 'none' | 'aes-256-gcm'; key_id: string | null; sha256: string }): Promise<BlobLocation> {
  const copy = await db.selectFrom('attachment_copy').select(['storage_backend', 'storage_key', 'encryption', 'key_id']).where('attachment_id', '=', a.id).orderBy('copied_at', 'desc').limit(1).executeTakeFirst();
  const at = copy ?? a;
  return { backend: at.storage_backend, key: blobKey(a.institution_id, at.storage_key), encryption: at.encryption, keyId: at.key_id, sha256: a.sha256 };
}

/** Latest antivirus result of each attachment. */
export async function latestScans(db: Db, ids: string[]): Promise<Map<string, { status: 'limpo' | 'infectado' | 'erro'; scannedAt: Date }>> {
  if (!ids.length) return new Map();
  const rows = await db.selectFrom('attachment_scan').select(['attachment_id', 'status', 'scanned_at']).where('attachment_id', 'in', ids).orderBy('scanned_at', 'desc').execute();
  const out = new Map<string, { status: 'limpo' | 'infectado' | 'erro'; scannedAt: Date }>();
  for (const r of rows) if (!out.has(r.attachment_id)) out.set(r.attachment_id, { status: r.status, scannedAt: r.scanned_at });
  return out;
}

export const attachmentDto = (a: { id: string; file_name: string; mime: string; size_bytes: number; uploaded_by_name: string; created_at: Date }, scan: { status: 'limpo' | 'infectado' | 'erro'; scannedAt: Date } | undefined): AttachmentDto => ({
  id: a.id, fileName: a.file_name, mime: a.mime, size: a.size_bytes, uploadedBy: a.uploaded_by_name, uploadedAt: a.created_at.toISOString(),
  scan: scan?.status ?? null, scannedAt: scan ? scan.scannedAt.toISOString() : null,
});

/** Attachments of several records of one kind, by record id. */
export async function attachmentsFor(db: Db, entity: AttachmentEntity, ids: string[]): Promise<Map<string, AttachmentDto[]>> {
  const out = new Map<string, AttachmentDto[]>();
  if (!ids.length) return out;
  const rows = await db.selectFrom('attachment').selectAll().where('entity', '=', entity).where('entity_id', 'in', ids).orderBy('created_at').execute();
  const scans = await latestScans(db, rows.map((r) => r.id));
  for (const a of rows) {
    const list = out.get(a.entity_id) ?? [];
    list.push(attachmentDto(a, scans.get(a.id)));
    out.set(a.entity_id, list);
  }
  return out;
}
