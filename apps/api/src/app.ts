import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { sql, type Kysely } from 'kysely';
import type { DB } from './db/types';
import type { Env } from './env';
import { HttpError } from './http/errors';
import { csrfGuard, sessionLoader } from './http/auth';
import { authRoutes } from './routes/auth';
import { dataRoutes } from './routes/data';
import { configRoutes } from './routes/config';
import { adminRoutes } from './routes/admin';
import { orgRoutes } from './routes/org';
import { patientRoutes } from './routes/patients';
import { irasRoutes } from './routes/iras';
import { surgeryMicroRoutes } from './routes/surgery-micro';
import { FieldCipher } from './security/field-crypto';
import { qualityRoutes } from './routes/quality';
import { trainingSupplyRoutes } from './routes/training-supplies';
import { alertRoutes } from './routes/alerts';
import { attachmentRoutes } from './routes/attachments';
import { cmeRoutes } from './routes/cme';
import { cmeFlowRoutes } from './routes/cme-flow';
import { notificationRoutes } from './routes/notifications';
import { realtimeRoutes } from './routes/realtime';
import { userRoutes } from './routes/users';
import { EventHub } from './realtime/hub';

export interface AppOptions {
  db: Kysely<DB>;
  env: Env;
  logger?: boolean;
  /** Keep-alive interval of the real-time stream (tests shorten it). */
  realtimeHeartbeatMs?: number;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db, env, logger = true } = opts;
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    logger: logger
      ? {
          level: env.NODE_ENV === 'production' ? 'info' : 'debug',
          // Never log credentials, session or CSRF tokens.
          redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
        }
      : false,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  const hub = new EventHub(env.DATABASE_URL, db, app.log, env.REALTIME_RETENTION_HOURS);
  // Before the server stops accepting: end the open streams, otherwise closing would wait for them.
  app.addHook('preClose', async () => hub.stop());
  // Counted per signed-in session (runs after the session is loaded), so the stations of a CME or
  // a whole hospital behind one NAT address do not share a single budget; anonymous calls count per IP.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: (req) => (req.auth ? `s:${req.auth.sessionId}` : `ip:${req.ip}`) });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', sessionLoader(db, env));
  app.addHook('preHandler', csrfGuard(env));
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) });
    }
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (status === 429) return reply.status(429).send({ error: 'limite', message: 'Muitas tentativas. Aguarde um minuto e tente novamente.' });
    if (status === 413) return reply.status(413).send({ error: 'tamanho', message: 'Arquivo ou requisição maior que o permitido.' });
    if (status === 415) return reply.status(415).send({ error: 'formato', message: 'Formato não aceito.' });
    if (status < 500) return reply.status(status).send({ error: 'requisicao', message: 'Requisição inválida.' });
    req.log.error({ err: error }, 'erro interno');
    return reply.status(500).send({ error: 'interno', message: 'Erro interno. Informe ao suporte o código da requisição.', requestId: req.id });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'nao_encontrado', message: 'Recurso não encontrado.' }));

  app.get('/api/health', async () => {
    await sql`SELECT 1`.execute(db);
    return { status: 'ok' };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, { db, env });
      await api.register(dataRoutes, { db });
      await api.register(configRoutes, { db });
      await api.register(adminRoutes, { db });
      await api.register(userRoutes, { db });
      await api.register(orgRoutes, { db });
      await api.register(patientRoutes, { db, cipher: FieldCipher.fromEnv(env.FIELD_ENCRYPTION_KEY) });
      await api.register(irasRoutes, { db });
      await api.register(surgeryMicroRoutes, { db });
      await api.register(qualityRoutes, { db });
      await api.register(trainingSupplyRoutes, { db });
      await api.register(alertRoutes, { db });
      await api.register(notificationRoutes, { db });
      await api.register(realtimeRoutes, { db, env, hub, ...(opts.realtimeHeartbeatMs ? { heartbeatMs: opts.realtimeHeartbeatMs } : {}) });
      await api.register(attachmentRoutes, { db, env });
      await api.register(cmeRoutes, { db });
      await api.register(cmeFlowRoutes, { db, env });
    },
    { prefix: '/api' },
  );
  return app;
}
