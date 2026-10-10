import pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, EventOutboxTable } from '../db/types';

/** One open real-time connection, with the access it had when it connected. */
export interface Subscriber {
  institutionId: string;
  userId: string;
  permissions: readonly string[];
  /** undefined = every sector of the institution. */
  scope: readonly string[] | undefined;
  send(id: string, topic: string): void;
  /** The connection may have missed events: the screen must refresh everything. */
  reset(): void;
  close(): void;
}

/** Same rules as the API: institution, permission, personal target and sector scope. */
export function visibleTo(e: Selectable<EventOutboxTable>, s: Pick<Subscriber, 'institutionId' | 'userId' | 'permissions' | 'scope'>): boolean {
  if (e.institution_id !== s.institutionId) return false;
  if (e.permission && !s.permissions.includes(e.permission)) return false;
  if (e.user_id && e.user_id !== s.userId) return false;
  if (e.sector_id && s.scope && !s.scope.includes(e.sector_id)) return false;
  return true;
}

/**
 * Listens to the outbox notifications (one database connection per API instance, opened on the
 * first subscriber) and forwards each committed event to the connections allowed to see it.
 */
export class EventHub {
  readonly stats = { listening: false, deliveryErrors: 0, lastError: null as string | null };
  private readonly subs = new Set<Subscriber>();
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Set<string>();
  private flushing = false;
  private stopped = false;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly db: Kysely<DB>,
    private readonly log: FastifyBaseLogger,
    private readonly retentionHours: number,
  ) {}

  get size() {
    return this.subs.size;
  }

  async subscribe(s: Subscriber): Promise<() => void> {
    await this.ensureListening();
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  private ensureListening(): Promise<void> {
    if (this.client || this.stopped) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect() {
    const c = new pg.Client({ connectionString: this.url, application_name: 'ccih-integra-realtime' });
    c.on('notification', (m) => {
      if (m.channel !== 'ccih_events' || !m.payload) return;
      this.pending.add(m.payload);
      void this.flush();
    });
    c.on('error', (e) => this.lost(c, e));
    c.on('end', () => this.lost(c, new Error('conexão de escuta encerrada')));
    await c.connect();
    await c.query('LISTEN ccih_events');
    this.client = c;
    this.stats.listening = true;
    if (!this.pruneTimer) {
      void this.prune();
      this.pruneTimer = setInterval(() => void this.prune(), 3_600_000);
      this.pruneTimer.unref();
    }
  }

  /** Lost the listening connection: open screens may have missed events, so they refresh; then retry. */
  private lost(c: pg.Client, e: Error) {
    if (this.client !== c) return;
    this.client = null;
    this.stats.listening = false;
    this.stats.lastError = e.message;
    if (this.stopped) return;
    this.log.warn({ err: e }, 'tempo real: escuta do banco perdida');
    for (const s of this.subs) s.reset();
    const retry = setTimeout(() => void this.ensureListening().catch((err: Error) => { this.stats.lastError = err.message; }), 2_000);
    retry.unref();
  }

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.size) {
        const ids = [...this.pending];
        this.pending.clear();
        const rows = await this.db.selectFrom('event_outbox').selectAll().where('id', 'in', ids).orderBy('id').execute();
        for (const r of rows) {
          for (const s of this.subs) {
            if (!visibleTo(r, s)) continue;
            try {
              s.send(r.id, r.topic);
            } catch {
              this.stats.deliveryErrors++;
              this.subs.delete(s);
            }
          }
        }
      }
    } catch (e) {
      this.stats.deliveryErrors++;
      this.stats.lastError = (e as Error).message;
      this.log.error({ err: e }, 'tempo real: falha ao distribuir eventos');
      for (const s of this.subs) s.reset();
    } finally {
      this.flushing = false;
    }
  }

  async prune() {
    try {
      await this.db.deleteFrom('event_outbox').where('created_at', '<', sql<Date>`now() - make_interval(hours => ${this.retentionHours})`).execute();
    } catch (e) {
      this.log.warn({ err: e }, 'tempo real: falha na limpeza do outbox');
    }
  }

  async stop() {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const s of this.subs) s.close();
    this.subs.clear();
    const c = this.client;
    this.client = null;
    this.stats.listening = false;
    await c?.end().catch(() => undefined);
  }
}
