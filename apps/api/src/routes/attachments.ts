import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { AttachmentDto, Permission } from '@ccih/domain';
import type { DB } from '../db/types';
import type { Env } from '../env';
import { audit } from '../audit/audit';
import { actorOf, requireAuth, type AuthContext } from '../http/auth';
import { HttpError, forbidden, notFound, parse } from '../http/errors';
import { Uuid } from '../http/schemas';
import { ATTACHMENT_MIMES, AttachmentStore, type AttachmentEntity, MAX_ATTACHMENTS_PER_RECORD, safeFileName, validateUpload } from '../services/attachments';

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

export async function attachmentRoutes(app: FastifyInstance, { db, env }: { db: Kysely<DB>; env: Env }) {
  const store = new AttachmentStore(env.UPLOAD_DIR);
  const maxBytes = env.UPLOAD_MAX_MB * 1_048_576;
  app.addContentTypeParser(ATTACHMENT_MIMES, { parseAs: 'buffer', bodyLimit: maxBytes }, (_req, body, done) => done(null, body));

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
    const { key, sha256 } = await store.save(auth.institutionId, body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('attachment').values({ institution_id: auth.institutionId, entity: q.entity, entity_id: q.entityId, file_name: fileName, mime, size_bytes: body.length, sha256, storage_key: key, uploaded_by: auth.userId, uploaded_by_name: auth.displayName }).returningAll().executeTakeFirstOrThrow();
      // Metadata only: the file content never goes to the log.
      await audit(trx, actorOf(req), { action: 'upload', entity: 'attachment', entityId: created.id, after: { entity: q.entity, entityId: q.entityId, fileName, mime, size: created.size_bytes, sha256 } });
      return created;
    });
    reply.code(201);
    return { id: row.id, fileName: row.file_name, mime: row.mime, size: row.size_bytes, uploadedBy: row.uploaded_by_name, uploadedAt: row.created_at.toISOString() } satisfies AttachmentDto;
  });

  app.get<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(Uuid, req.params.id);
    const row = await db.selectFrom('attachment').selectAll().where('id', '=', id).where('institution_id', '=', auth.institutionId).executeTakeFirst();
    if (!row) throw notFound('Anexo');
    await allow(db, req, RULES[row.entity].view);
    await recordSector(db, auth, row.entity, row.entity_id);
    const buf = await store.read(auth.institutionId, row.storage_key);
    await audit(db, actorOf(req), { action: 'download', entity: 'attachment', entityId: row.id, context: { entity: row.entity, entityId: row.entity_id } });
    return reply
      .header('content-type', row.mime)
      .header('content-disposition', `attachment; filename="${row.file_name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`)
      .header('x-content-type-options', 'nosniff')
      .send(buf);
  });
}
