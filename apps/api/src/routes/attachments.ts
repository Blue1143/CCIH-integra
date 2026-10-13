import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { attachmentAvailability, attachmentCanRescan, attachmentScanStatus, type AttachmentDto, type AttachmentPolicyDto, type Permission } from '@ccih/domain';
import type { DB } from '../db/types';
import type { Env } from '../env';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, type AuthContext } from '../http/auth';
import { HttpError, forbidden, notFound, parse } from '../http/errors';
import { Uuid } from '../http/schemas';
import {
  ATTACHMENT_MIMES, type AttachmentEntity, MAX_ATTACHMENTS_PER_RECORD, attachmentDto, attachmentLocation, latestScans, safeFileName, validateUpload,
} from '../services/attachments';
import type { Scanner } from '../services/storage/antivirus';
import { IntegrityError, StorageUnavailableError, type AttachmentVault } from '../services/storage/vault';

type Entity = AttachmentEntity;

/** Who may read and attach files to each kind of record. */
const RULES: Record<Entity, { view: Permission; edit: Permission }> = {
  sterilization_test: { view: 'cme:view', edit: 'cme:test:record' },
  training_session: { view: 'quality:view', edit: 'quality:training:edit' },
};

const UploadQuery = z.object({ entity: z.enum(['sterilization_test', 'training_session']), entityId: Uuid }).strict();

/** Sector of the record, after checking it belongs to the institution (404 otherwise). */
async function recordSector(db: Kysely<DB>, auth: AuthContext, entity: Entity, id: string): Promise<string | null> {
  const row = entity === 'sterilization_test'
    ? await db.selectFrom('sterilization_test as t').innerJoin('sterilizer as s', 's.id', 't.sterilizer_id').select('s.sector_id').where('t.id', '=', id).where('t.institution_id', '=', auth.institutionId).executeTakeFirst()
    : await db.selectFrom('training_session as s').innerJoin('training as t', 't.id', 's.training_id').select('s.sector_id').where('s.id', '=', id).where('t.institution_id', '=', auth.institutionId).executeTakeFirst();
  if (!row) throw notFound('Registro');
  if (auth.scope && row.sector_id && !auth.scope.includes(row.sector_id)) throw notFound('Registro');
  return row.sector_id;
}

async function allow(db: Kysely<DB>, req: FastifyRequest, permission: Permission) {
  const auth = requireAuth(req);
  if (auth.permissions.includes(permission)) return auth;
  await audit(db, actorOf(req), { action: 'access_denied', entity: 'route', entityId: `${req.method} ${req.routeOptions.url ?? req.url}`, context: { required: [permission] } });
  throw forbidden();
}

const unavailable = (e: unknown) => {
  if (e instanceof IntegrityError) return new HttpError(500, 'integridade', `${e.message} O acesso foi bloqueado e registrado.`);
  if (e instanceof StorageUnavailableError) return new HttpError(503, 'armazenamento_indisponivel', e.message);
  return new HttpError(503, 'armazenamento_indisponivel', 'O armazenamento de anexos não respondeu. Tente novamente.');
};

export async function attachmentRoutes(app: FastifyInstance, { db, env, vault, scanner }: { db: Kysely<DB>; env: Env; vault: AttachmentVault; scanner: Scanner }) {
  const maxBytes = env.UPLOAD_MAX_MB * 1_048_576;
  app.addContentTypeParser(ATTACHMENT_MIMES, { parseAs: 'buffer', bodyLimit: maxBytes }, (_req, body, done) => done(null, body));

  app.get('/attachments/policy', async (req): Promise<AttachmentPolicyDto> => {
    requireAuth(req);
    return { antivirus: scanner.mode, storage: vault.backend, encrypted: vault.encrypted, maxMb: env.UPLOAD_MAX_MB };
  });

  /**
   * With an antivirus, the file is checked before anything is stored: a threat is refused (nothing is
   * kept, the attempt is logged); a failed check keeps the file unavailable until a new check.
   */
  app.post('/attachments', { bodyLimit: maxBytes }, async (req, reply) => {
    const q = parse(UploadQuery, req.query);
    const auth = await allow(db, req, RULES[q.entity].edit);
    await recordSector(db, auth, q.entity, q.entityId);
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw new HttpError(400, 'arquivo_invalido', 'Envie o arquivo (PDF, PNG ou JPEG).', [{ path: 'file', message: 'Envie o arquivo (PDF, PNG ou JPEG).' }]);
    const mime = validateUpload(body, req.headers['content-type'], maxBytes);
    const count = await db.selectFrom('attachment').select((e) => e.fn.countAll<string>().as('n')).where('entity', '=', q.entity).where('entity_id', '=', q.entityId).executeTakeFirstOrThrow();
    if (Number(count.n) >= MAX_ATTACHMENTS_PER_RECORD) throw new HttpError(409, 'limite_anexos', `Limite de ${MAX_ATTACHMENTS_PER_RECORD} anexos por registro.`);
    const header = req.headers['x-file-name'];
    const fileName = safeFileName(typeof header === 'string' ? header : undefined, mime);
    const scan = scanner.mode === 'off' ? null : await scanner.scan(body);
    if (scan?.status === 'infectado') {
      await audit(db, actorOf(req), { action: 'malware_blocked', entity: 'attachment', entityId: q.entityId, context: { entity: q.entity, fileName, size: body.length, engine: scan.engine, signature: scan.signature } });
      throw new HttpError(422, 'arquivo_infectado', `Arquivo recusado: o antivírus detectou ameaça (${scan.signature}). Nada foi gravado.`, [{ path: 'file', message: 'Ameaça detectada pelo antivírus.' }]);
    }
    let stored;
    try {
      stored = await vault.save(auth.institutionId, body);
    } catch (e) {
      throw unavailable(e);
    }
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('attachment').values({
        institution_id: auth.institutionId, entity: q.entity, entity_id: q.entityId, file_name: fileName, mime, size_bytes: body.length, sha256: stored.sha256, storage_key: stored.fileId,
        storage_backend: stored.backend, encryption: stored.encryption, key_id: stored.keyId, uploaded_by: auth.userId, uploaded_by_name: auth.displayName,
      }).returningAll().executeTakeFirstOrThrow();
      if (scan) await trx.insertInto('attachment_scan').values({ institution_id: auth.institutionId, attachment_id: created.id, status: scan.status, engine: scan.engine, signature: scan.signature, detail: scan.detail, requested_by: auth.userId, requested_by_name: auth.displayName }).execute();
      // Metadata only: the file content never goes to the log.
      await audit(trx, actorOf(req), { action: 'upload', entity: 'attachment', entityId: created.id, after: { entity: q.entity, entityId: q.entityId, fileName, mime, size: created.size_bytes, sha256: stored.sha256, storage: stored.backend, encrypted: stored.encryption !== 'none', scan: scan?.status ?? 'nao_verificado' } });
      return created;
    });
    reply.code(201);
    return attachmentDto(row, scan ? { status: scan.status, scannedAt: new Date() } : undefined) satisfies AttachmentDto;
  });

  const findVisible = async (req: FastifyRequest, id: string, permission: 'view' | 'edit') => {
    const auth = requireAuth(req);
    const row = await db.selectFrom('attachment').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!row) throw notFound('Anexo');
    await allow(db, req, RULES[row.entity][permission]);
    await recordSector(db, auth, row.entity, row.entity_id);
    return { auth, row };
  };

  app.get<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    const { row } = await findVisible(req, parse(Uuid, req.params.id), 'view');
    const latest = (await latestScans(db, [row.id])).get(row.id);
    const availability = attachmentAvailability(attachmentScanStatus(latest?.status ?? null, scanner.mode), scanner.mode);
    if (!availability.downloadable) throw new HttpError(409, 'arquivo_indisponivel', availability.reason!);
    let buf: Buffer;
    try {
      buf = await vault.read(await attachmentLocation(db, row));
    } catch (e) {
      if (e instanceof IntegrityError) await audit(db, actorOf(req), { action: 'integrity_failure', entity: 'attachment', entityId: row.id, context: { message: e.message } });
      throw unavailable(e);
    }
    await audit(db, actorOf(req), { action: 'download', entity: 'attachment', entityId: row.id, context: { entity: row.entity, entityId: row.entity_id, scan: latest?.status ?? 'nao_verificado' } });
    return reply
      .header('content-type', row.mime)
      .header('content-disposition', `attachment; filename="${row.file_name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(buf);
  });

  /** New check (scanner was unavailable, or the file predates the antivirus). A threat found later discards the content. */
  app.post<{ Params: { id: string } }>('/attachments/:id/scan', async (req) => {
    const { auth, row } = await findVisible(req, parse(Uuid, req.params.id), 'edit');
    const latest = (await latestScans(db, [row.id])).get(row.id);
    if (!attachmentCanRescan(attachmentScanStatus(latest?.status ?? null, scanner.mode), scanner.mode)) {
      throw new HttpError(409, 'verificacao_desnecessaria', scanner.mode === 'off' ? 'Não há antivírus configurado.' : 'O arquivo já foi verificado.');
    }
    const loc = await attachmentLocation(db, row);
    let content: Buffer;
    try {
      content = await vault.read(loc);
    } catch (e) {
      throw unavailable(e);
    }
    const scan = await scanner.scan(content);
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('attachment_scan').values({ institution_id: auth.institutionId, attachment_id: row.id, status: scan.status, engine: scan.engine, signature: scan.signature, detail: scan.detail, requested_by: auth.userId, requested_by_name: auth.displayName }).execute();
      await audit(trx, actorOf(req), { action: 'scan', entity: 'attachment', entityId: row.id, after: { status: scan.status, engine: scan.engine, signature: scan.signature } });
    });
    if (scan.status === 'infectado') await vault.remove(loc).catch(() => undefined);
    return attachmentDto(row, { status: scan.status, scannedAt: new Date() }) satisfies AttachmentDto;
  });
}
