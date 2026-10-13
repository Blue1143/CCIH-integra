import { sql, type Kysely } from 'kysely';

/**
 * Attachments (F2): where each content is stored and how (backend, application encryption and key
 * name), every antivirus check (insert-only; the latest one decides availability) and every copy made
 * by the migration command (insert-only; the source is never deleted). Existing files stay on the
 * local disk without application encryption and without a check ("não verificado").
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attachment
      ADD COLUMN storage_backend text NOT NULL DEFAULT 'local' CHECK (storage_backend IN ('local', 's3')),
      ADD COLUMN encryption text NOT NULL DEFAULT 'none' CHECK (encryption IN ('none', 'aes-256-gcm')),
      ADD COLUMN key_id text,
      ADD CONSTRAINT attachment_key_check CHECK ((encryption = 'none') = (key_id IS NULL));

    CREATE TABLE attachment_scan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL REFERENCES institution(id),
      attachment_id uuid NOT NULL REFERENCES attachment(id),
      status text NOT NULL CHECK (status IN ('limpo', 'infectado', 'erro')),
      engine text NOT NULL,
      signature text,
      detail text,
      requested_by uuid REFERENCES app_user(id),
      requested_by_name text NOT NULL,
      scanned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (status <> 'infectado' OR signature IS NOT NULL)
    );
    CREATE INDEX attachment_scan_latest_idx ON attachment_scan (attachment_id, scanned_at DESC);

    CREATE TABLE attachment_copy (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL REFERENCES institution(id),
      attachment_id uuid NOT NULL REFERENCES attachment(id),
      storage_backend text NOT NULL CHECK (storage_backend IN ('local', 's3')),
      storage_key text NOT NULL UNIQUE,
      encryption text NOT NULL CHECK (encryption IN ('none', 'aes-256-gcm')),
      key_id text,
      sha256 text NOT NULL,
      operator text NOT NULL,
      copied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((encryption = 'none') = (key_id IS NULL))
    );
    CREATE INDEX attachment_copy_latest_idx ON attachment_copy (attachment_id, copied_at DESC);

    CREATE TRIGGER attachment_scan_append_only BEFORE UPDATE OR DELETE ON attachment_scan FOR EACH ROW EXECUTE FUNCTION append_only();
    CREATE TRIGGER attachment_copy_append_only BEFORE UPDATE OR DELETE ON attachment_copy FOR EACH ROW EXECUTE FUNCTION append_only();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS attachment_copy;
    DROP TABLE IF EXISTS attachment_scan;
    ALTER TABLE attachment DROP CONSTRAINT IF EXISTS attachment_key_check, DROP COLUMN IF EXISTS key_id, DROP COLUMN IF EXISTS encryption, DROP COLUMN IF EXISTS storage_backend;
  `.execute(db);
}
