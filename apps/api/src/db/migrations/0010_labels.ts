import { sql, type Kysely } from 'kysely';

/**
 * Labels (F1). Layouts describe size, margins, resolution and fields of each kind of label; there is
 * no default size (it depends on the printer the institution adopts). Every print, reprint and
 * cancellation is kept: prints and cancellations are insert-only, a reprint points to the label it
 * replaces (with a mandatory reason) and keeps the layout and the content exactly as printed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE label_layout (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL REFERENCES institution(id),
      name text NOT NULL,
      entity text NOT NULL CHECK (entity IN ('pacote', 'ativo', 'processo')),
      width_mm numeric(5,1) NOT NULL CHECK (width_mm BETWEEN 20 AND 120),
      height_mm numeric(5,1) NOT NULL CHECK (height_mm BETWEEN 10 AND 120),
      margin_mm numeric(4,1) NOT NULL CHECK (margin_mm BETWEEN 0 AND 10),
      dpi integer NOT NULL CHECK (dpi IN (203, 300, 600)),
      bar_height_mm numeric(4,1) NOT NULL CHECK (bar_height_mm BETWEEN 4 AND 40),
      fields text[] NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT true,
      data_origin text NOT NULL CHECK (data_origin IN ('real', 'demo')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1,
      UNIQUE (institution_id, name),
      CHECK (active OR NOT is_default)
    );
    CREATE UNIQUE INDEX label_layout_default_idx ON label_layout (institution_id, entity) WHERE is_default;

    CREATE TABLE label_print (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL REFERENCES institution(id),
      batch_id uuid NOT NULL,
      entity text NOT NULL CHECK (entity IN ('pacote', 'ativo', 'processo')),
      entity_id uuid NOT NULL,
      code text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('impressao', 'reimpressao')),
      output text NOT NULL CHECK (output IN ('navegador', 'zpl')),
      reason text,
      replaces_id uuid UNIQUE REFERENCES label_print(id),
      layout_id uuid NOT NULL REFERENCES label_layout(id),
      layout jsonb NOT NULL,
      content jsonb NOT NULL,
      printed_by uuid NOT NULL REFERENCES app_user(id),
      printed_by_name text NOT NULL,
      printed_at timestamptz NOT NULL DEFAULT now(),
      data_origin text NOT NULL CHECK (data_origin IN ('real', 'demo')),
      CHECK (kind = 'impressao' OR (reason IS NOT NULL AND length(btrim(reason)) >= 5 AND replaces_id IS NOT NULL))
    );
    CREATE INDEX label_print_entity_idx ON label_print (institution_id, entity, entity_id, printed_at DESC);
    CREATE INDEX label_print_code_idx ON label_print (institution_id, code);

    CREATE TABLE label_cancel (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL REFERENCES institution(id),
      label_print_id uuid NOT NULL UNIQUE REFERENCES label_print(id),
      reason text NOT NULL CHECK (length(btrim(reason)) >= 5),
      cancelled_by uuid NOT NULL REFERENCES app_user(id),
      cancelled_by_name text NOT NULL,
      cancelled_at timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS label_cancel;
    DROP TABLE IF EXISTS label_print;
    DROP TABLE IF EXISTS label_layout;
  `.execute(db);
}
