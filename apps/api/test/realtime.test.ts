import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { publish } from '../src/realtime/outbox';
import { notifyUser } from '../src/services/notifications';
import { ORIGIN, login, setupTestApp, teardown, type Session, type TestContext } from './helpers';

let ctx: TestContext;
let base: string;
let cme: Session;
let enf: Session;
let consulta: Session;

interface Received { id: string | null; event: string; data: string }
interface Stream { events: Received[]; ended: boolean; close(): void; waitFor(pred: (e: Received) => boolean, ms?: number): Promise<Received> }

/** Opens /api/events with the session cookie and collects the parsed events. */
function openStream(s: Session, lastEventId?: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const events: Received[] = [];
    const waiters: Array<{ pred: (e: Received) => boolean; done: (e: Received) => void }> = [];
    const stream: Stream = {
      events, ended: false,
      close: () => req.destroy(),
      waitFor: (pred, ms = 3000) => new Promise((ok, fail) => {
        const hit = events.find(pred);
        if (hit) return ok(hit);
        const t = setTimeout(() => fail(new Error(`evento não recebido; recebidos: ${JSON.stringify(events)}`)), ms);
        waiters.push({ pred, done: (e) => { clearTimeout(t); ok(e); } });
      }),
    };
    const req = request(`${base}/api/events`, { headers: { cookie: s.cookie, origin: ORIGIN, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`status ${res.statusCode}`)); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = block.split('\n');
          const ev = lines.find((l) => l.startsWith('event: '))?.slice(7);
          if (!ev) continue;
          const e = { id: lines.find((l) => l.startsWith('id: '))?.slice(4) ?? null, event: ev, data: lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '' };
          events.push(e);
          for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.done(e); }
        }
      });
      res.on('end', () => { stream.ended = true; });
      resolve(stream);
    });
    req.on('error', (e) => { if (!stream.ended) reject(e); });
    req.end();
  });
}

const ready = (s: Stream) => s.waitFor((e) => e.event === 'ready');
const topicOf = (e: Received) => (e.event === 'change' ? (JSON.parse(e.data) as { topic: string }).topic : null);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  ctx = await setupTestApp({}, { realtimeHeartbeatMs: 300 });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = ctx.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  [cme, enf, consulta] = await Promise.all([login(ctx.app, 'cme'), login(ctx.app, 'enf.ccih'), login(ctx.app, 'consulta')]);
});
afterAll(async () => teardown(ctx));

describe('real-time updates', () => {
  it('requires a session and announces only after commit, to those allowed to see it', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/events' });
    expect(anon.statusCode).toBe(401);
    const [a, b] = await Promise.all([openStream(cme), openStream(consulta)]);
    await Promise.all([ready(a), ready(b)]);

    // Rolled back: never announced.
    await ctx.db.transaction().execute(async (trx) => {
      await publish(trx, { institutionId: ctx.institutionId, topic: 'config', permission: null });
      throw new Error('desfaz');
    }).catch(() => undefined);
    // Committed through a real change: a CME reading.
    const station = (await ctx.db.selectFrom('scan_station').select('id').where('name', '=', 'Limpeza').executeTakeFirstOrThrow()).id;
    const res = await ctx.app.inject({ method: 'POST', url: '/api/cme/scan', headers: cme.headers, payload: { stationId: station, code: 'AT-ZZZZZZZZ', inputMethod: 'leitor', step: 'limpeza', clientEventId: null, deviceAt: null, outcome: null, destinationSectorId: null, originSectorId: null, loadId: null, packaging: null, justification: null, override: false } });
    expect(res.statusCode).toBe(200);
    const got = await a.waitFor((e) => topicOf(e) === 'cme');
    expect(got.data).toBe('{"topic":"cme"}');
    await pause(300);
    expect(a.events.some((e) => topicOf(e) === 'config')).toBe(false);
    // Consulta has no CME access: it hears nothing about it.
    expect(b.events.some((e) => topicOf(e) === 'cme')).toBe(false);
    a.close();
    b.close();
  });

  it('respects the sector scope and personal targets', async () => {
    const [c, e, q] = await Promise.all([openStream(cme), openStream(enf), openStream(consulta)]);
    await Promise.all([ready(c), ready(e), ready(q)]);
    const inScope = (await ctx.db.selectFrom('user_scope').innerJoin('app_user', 'app_user.id', 'user_scope.user_id').select('user_scope.sector_id').where('app_user.login', '=', 'consulta').executeTakeFirstOrThrow()).sector_id;
    const outside = (await ctx.db.selectFrom('sector').select('id').where('code', '=', 'cme').executeTakeFirstOrThrow()).id;
    await publish(ctx.db, { institutionId: ctx.institutionId, topic: 'qualidade', permission: null, sectorId: outside });
    await publish(ctx.db, { institutionId: ctx.institutionId, topic: 'clinico', permission: null, sectorId: inScope });
    await q.waitFor((x) => topicOf(x) === 'clinico');
    await e.waitFor((x) => topicOf(x) === 'qualidade');
    expect(q.events.some((x) => topicOf(x) === 'qualidade')).toBe(false);

    const enfUser = (await ctx.db.selectFrom('app_user').select(['id', 'institution_id']).where('login', '=', 'enf.ccih').executeTakeFirstOrThrow());
    await notifyUser(ctx.db, { institutionId: enfUser.institution_id, userId: enfUser.id, kind: 'nao_conformidade', title: 'Teste', detail: 'Notificação de teste', entity: 'nonconformity', entityId: '00000000-0000-0000-0000-000000000001', link: null, origin: 'demo' });
    await e.waitFor((x) => topicOf(x) === 'notificacoes');
    await pause(300);
    expect(c.events.some((x) => topicOf(x) === 'notificacoes')).toBe(false);
    for (const s of [c, e, q]) s.close();
  });

  it('replays what a reconnecting screen missed, and asks for a full refresh when the gap is too old', async () => {
    const first = await openStream(cme);
    const r = await ready(first);
    first.close();
    await publish(ctx.db, { institutionId: ctx.institutionId, topic: 'alertas', permission: 'alerts:view' });
    await publish(ctx.db, { institutionId: ctx.institutionId, topic: 'qualidade', permission: 'quality:view' });
    const again = await openStream(cme, r.id!);
    await ready(again);
    expect(again.events.filter((e) => e.event === 'change').map(topicOf)).toEqual(['alertas']);
    again.close();

    await ctx.owner.deleteFrom('event_outbox').where('id', '<=', r.id!).execute();
    const old = await openStream(cme, '1');
    await old.waitFor((e) => e.event === 'reset');
    old.close();
  });

  it('closes the stream when the session ends', async () => {
    const s = await login(ctx.app, 'cme');
    const stream = await openStream(s);
    await ready(stream);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: s.headers })).statusCode).toBeLessThan(300);
    await stream.waitFor((e) => e.event === 'session_end', 3000);
    await pause(100);
    expect(stream.ended).toBe(true);
  });

  it('tells the screens to refresh periodically when the installation disables real time', async () => {
    const app = await buildApp({ db: ctx.db, env: { ...ctx.env, REALTIME_MODE: 'polling', REALTIME_POLL_SECONDS: 30 }, logger: false });
    const s = await login(app, 'cme');
    expect((await app.inject({ method: 'GET', url: '/api/realtime', headers: s.headers })).json()).toEqual({ mode: 'polling', pollSeconds: 30 });
    expect((await app.inject({ method: 'GET', url: '/api/events', headers: s.headers })).statusCode).toBe(409);
    await app.close();
  });
});
