import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types';
import type { Env } from '../env';
import { requireAuth } from '../http/auth';
import { HttpError } from '../http/errors';
import type { EventHub, Subscriber } from '../realtime/hub';
import { visibleTo } from '../realtime/hub';

/** Replays at most this many missed events; beyond it the screen simply refreshes everything. */
const MAX_REPLAY = 1000;

export async function realtimeRoutes(app: FastifyInstance, { db, env, hub, heartbeatMs = 25_000 }: { db: Kysely<DB>; env: Env; hub: EventHub; heartbeatMs?: number }) {
  const idleMs = env.SESSION_IDLE_MINUTES * 60_000;

  /** How the screens stay current here (and, for administrators, the state of the real-time link). */
  app.get('/realtime', async (req) => {
    const auth = requireAuth(req);
    return {
      mode: env.REALTIME_MODE, pollSeconds: env.REALTIME_POLL_SECONDS,
      ...(auth.permissions.includes('users:manage') ? { status: { ...hub.stats, connections: hub.size } } : {}),
    };
  });

  /**
   * Server-Sent Events. Each event carries only its id and topic; the screen refetches what it shows
   * through the normal, authorized endpoints. Reconnection with Last-Event-ID replays what was missed
   * within the retention; a larger gap sends "reset" (refresh everything).
   */
  app.get('/events', async (req, reply) => {
    const auth = requireAuth(req);
    if (env.REALTIME_MODE !== 'sse') throw new HttpError(409, 'tempo_real_desativado', 'Tempo real desativado nesta instalação: as telas usam atualização periódica.');
    if (hub.size >= env.REALTIME_MAX_CONNECTIONS) throw new HttpError(503, 'tempo_real_lotado', 'Limite de conexões em tempo real atingido: a tela usará atualização periódica.');
    const header = req.headers['last-event-id'] ?? (req.query as Record<string, string | undefined>).lastEventId;
    const last = typeof header === 'string' && /^\d{1,15}$/.test(header) ? header : null;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff',
    });
    let closed = false;
    const write = (chunk: string) => { if (!closed && !raw.writableEnded) raw.write(chunk); };
    const sub: Subscriber = {
      institutionId: auth.institutionId, userId: auth.userId, permissions: auth.permissions, scope: auth.scope,
      send: (id, topic) => write(`id: ${id}\nevent: change\ndata: ${JSON.stringify({ topic })}\n\n`),
      reset: () => write('event: reset\ndata: {}\n\n'),
      close: () => end(),
    };
    let unsubscribe: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    const end = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      if (timer) clearInterval(timer);
      raw.end();
    };
    raw.on('close', end);
    write('retry: 5000\n\n');

    try {
      // Subscribe before replaying: an event committed meanwhile may arrive twice, never zero times (the client ignores repeated ids).
      unsubscribe = await hub.subscribe(sub);
    } catch (e) {
      req.log.warn({ err: e }, 'tempo real: escuta indisponível');
      write('event: unavailable\ndata: {}\n\n');
      end();
      return;
    }
    if (last) {
      const oldest = await db.selectFrom('event_outbox').select((eb) => eb.fn.min('id').as('m')).where('institution_id', '=', auth.institutionId).executeTakeFirst();
      const m = oldest?.m as string | null | undefined;
      if (m && Number(last) < Number(m) - 1) sub.reset();
      else {
        const missed = await db.selectFrom('event_outbox').selectAll().where('institution_id', '=', auth.institutionId).where('id', '>', last).orderBy('id').limit(MAX_REPLAY + 1).execute();
        if (missed.length > MAX_REPLAY) sub.reset();
        else for (const e of missed) if (visibleTo(e, sub)) sub.send(e.id, e.topic);
      }
      write('event: ready\ndata: {}\n\n');
    } else {
      const max = await db.selectFrom('event_outbox').select((eb) => eb.fn.max('id').as('m')).executeTakeFirst();
      write(`id: ${(max?.m as string | null | undefined) ?? '0'}\nevent: ready\ndata: {}\n\n`);
    }

    // Keep-alive, and close the stream when the session ends (logout, revocation, inactivity or maximum time).
    timer = setInterval(() => {
      void (async () => {
        const s = await db.selectFrom('session').select(['revoked_at', 'expires_at', 'last_seen_at']).where('id', '=', auth.sessionId).executeTakeFirst();
        const now = Date.now();
        if (!s || s.revoked_at || now > s.expires_at.getTime() || now - s.last_seen_at.getTime() > idleMs) {
          write('event: session_end\ndata: {}\n\n');
          end();
        } else write(': ping\n\n');
      })().catch(() => end());
    }, heartbeatMs);
    timer.unref();
  });
}
