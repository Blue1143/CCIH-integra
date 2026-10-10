import { sql, type Kysely } from 'kysely';

/**
 * Real-time updates. Each change writes an outbox row in its own transaction; a trigger notifies
 * the listening API instances (PostgreSQL delivers NOTIFY only after commit, so nothing is announced
 * for a change that rolled back). A row carries the topic and who may receive it, never record data.
 * Rows are pruned after the configured retention; reconnecting clients replay from the outbox.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE event_outbox (
      id bigserial PRIMARY KEY,
      institution_id uuid NOT NULL REFERENCES institution(id),
      topic text NOT NULL CHECK (topic IN ('clinico', 'cme', 'qualidade', 'alertas', 'notificacoes', 'config')),
      permission text,
      sector_id uuid,
      user_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX event_outbox_institution_idx ON event_outbox (institution_id, id);
    CREATE INDEX event_outbox_created_idx ON event_outbox (created_at);

    CREATE FUNCTION event_outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('ccih_events', NEW.id::text);
      RETURN NEW;
    END $$;
    CREATE TRIGGER event_outbox_notify AFTER INSERT ON event_outbox FOR EACH ROW EXECUTE FUNCTION event_outbox_notify();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS event_outbox;
    DROP FUNCTION IF EXISTS event_outbox_notify();
  `.execute(db);
}
