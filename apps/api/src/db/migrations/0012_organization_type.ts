import { sql, type Kysely } from 'kysely';

/**
 * Two business models in one platform. Each organization (table "institution") gets its model,
 * chosen when it is created: every existing organization is a hospital ("hospitalar"), so nothing
 * changes for them. The model cannot be changed by the application role: only the database owner
 * (the administrative conversion command) can, and it never deletes data.
 *
 * Also hardens isolation between organizations at the database level: a profile, a sector scope or an
 * individual grant can only link a user to records of the user's own organization.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE institution
      ADD COLUMN organization_type text NOT NULL DEFAULT 'hospitalar' CHECK (organization_type IN ('hospitalar', 'consultoria')),
      ADD COLUMN legal_name text,
      ADD COLUMN cnpj text CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$');
    CREATE UNIQUE INDEX institution_cnpj_idx ON institution (cnpj) WHERE cnpj IS NOT NULL;

    CREATE FUNCTION institution_model_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_type IS DISTINCT FROM OLD.organization_type
         AND current_user <> (SELECT tableowner FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'institution') THEN
        RAISE EXCEPTION 'institution: o modelo da organização só muda pelo comando administrativo de conversão';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER institution_model_guard BEFORE UPDATE OF organization_type ON institution FOR EACH ROW EXECUTE FUNCTION institution_model_guard();

    -- A user's profile always belongs to the user's own organization.
    ALTER TABLE app_user ADD CONSTRAINT app_user_id_institution_key UNIQUE (id, institution_id);
    ALTER TABLE user_role ADD CONSTRAINT user_role_same_institution FOREIGN KEY (user_id, institution_id) REFERENCES app_user (id, institution_id);

    -- Sector scopes point to sectors of the user's organization.
    CREATE FUNCTION user_scope_same_institution() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT institution_id FROM app_user WHERE id = NEW.user_id) IS DISTINCT FROM (SELECT institution_id FROM sector WHERE id = NEW.sector_id) THEN
        RAISE EXCEPTION 'user_scope: setor de outra organização';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER user_scope_same_institution BEFORE INSERT OR UPDATE ON user_scope FOR EACH ROW EXECUTE FUNCTION user_scope_same_institution();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS user_scope_same_institution ON user_scope;
    DROP FUNCTION IF EXISTS user_scope_same_institution();
    ALTER TABLE user_role DROP CONSTRAINT IF EXISTS user_role_same_institution;
    ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_id_institution_key;
    DROP TRIGGER IF EXISTS institution_model_guard ON institution;
    DROP FUNCTION IF EXISTS institution_model_guard();
    DROP INDEX IF EXISTS institution_cnpj_idx;
    ALTER TABLE institution DROP COLUMN IF EXISTS cnpj, DROP COLUMN IF EXISTS legal_name, DROP COLUMN IF EXISTS organization_type;
  `.execute(db);
}
