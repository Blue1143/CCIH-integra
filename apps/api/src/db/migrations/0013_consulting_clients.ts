import { sql, type Kysely } from 'kysely';

/**
 * Consulting model (M3): the consultancy's team profiles, its client portfolio (clients, contacts,
 * establishments and units), who answers for each client (assignments with history) and the client
 * timeline. Every table carries the consultancy's institution_id and references its parents together
 * with it, so a row can never point to a record of another organization. Client tables only accept
 * rows of consulting organizations.
 */
const CONSULTING = [
  'consultoria:clients:view', 'consultoria:clients:edit', 'consultoria:clients:record', 'consultoria:clients:internal_notes', 'consultoria:portfolio:all', 'consultoria:portfolio:assign',
];
// Frozen copy of the default profiles at this version (later changes come in later migrations).
const ROLES: Array<{ code: string; name: string; permissions: string[] }> = [
  { code: 'gestor_consultoria', name: 'Gestor da consultoria', permissions: [...CONSULTING, 'users:view', 'alerts:view', 'alerts:manage'] },
  { code: 'consultor', name: 'Consultor', permissions: ['consultoria:clients:view', 'consultoria:clients:record', 'alerts:view', 'alerts:manage'] },
  { code: 'assistente_consultoria', name: 'Assistente administrativo', permissions: ['consultoria:clients:view', 'consultoria:clients:edit', 'consultoria:clients:record', 'consultoria:clients:internal_notes', 'consultoria:portfolio:all', 'alerts:view'] },
  { code: 'financeiro_consultoria', name: 'Financeiro da consultoria', permissions: ['consultoria:clients:view', 'consultoria:clients:internal_notes', 'consultoria:portfolio:all', 'alerts:view'] },
];

const address = sql`street text, number text, district text, city text, state text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'), zip text CHECK (zip IS NULL OR zip ~ '^[0-9]{8}$')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE role DROP CONSTRAINT IF EXISTS role_module_check;
    ALTER TABLE role ADD CONSTRAINT role_module_check CHECK (module IN ('ccih', 'cme', 'qualidade', 'sistema', 'consultoria'));
    ALTER TABLE event_outbox DROP CONSTRAINT IF EXISTS event_outbox_topic_check;
    ALTER TABLE event_outbox ADD CONSTRAINT event_outbox_topic_check CHECK (topic IN ('clinico', 'cme', 'qualidade', 'alertas', 'notificacoes', 'config', 'consultoria'));

    CREATE FUNCTION consulting_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT organization_type FROM institution WHERE id = NEW.institution_id) <> 'consultoria' THEN
        RAISE EXCEPTION '%: registro exclusivo de organizações de consultoria', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END $$;

    CREATE TABLE client (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL REFERENCES institution(id),
      legal_name text NOT NULL,
      trade_name text,
      cnpj text CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
      kind text NOT NULL,
      status text NOT NULL CHECK (status IN ('prospecto', 'ativo', 'suspenso', 'encerrado')),
      email text,
      phone text,
      ${address},
      services_summary text,
      internal_notes text,
      created_by uuid REFERENCES app_user(id),
      created_by_name text NOT NULL,
      data_origin text NOT NULL CHECK (data_origin IN ('real', 'demo')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1,
      UNIQUE (id, institution_id)
    );
    CREATE UNIQUE INDEX client_cnpj_idx ON client (institution_id, cnpj) WHERE cnpj IS NOT NULL;
    CREATE INDEX client_name_idx ON client (institution_id, legal_name);
    CREATE TRIGGER client_consulting_only BEFORE INSERT ON client FOR EACH ROW EXECUTE FUNCTION consulting_only();

    CREATE TABLE client_contact (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      client_id uuid NOT NULL,
      kind text NOT NULL CHECK (kind IN ('responsavel_tecnico', 'responsavel_administrativo', 'contato_autorizado')),
      name text NOT NULL,
      role_title text,
      registry text,
      email text,
      phone text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1,
      FOREIGN KEY (client_id, institution_id) REFERENCES client (id, institution_id),
      CHECK (email IS NOT NULL OR phone IS NOT NULL)
    );
    CREATE INDEX client_contact_client_idx ON client_contact (client_id);

    CREATE TABLE client_establishment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      client_id uuid NOT NULL,
      name text NOT NULL,
      cnes text CHECK (cnes IS NULL OR cnes ~ '^[0-9]{7}$'),
      cnpj text CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
      kind text NOT NULL,
      beds integer CHECK (beds IS NULL OR beds BETWEEN 0 AND 5000),
      ${address},
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1,
      UNIQUE (id, institution_id),
      FOREIGN KEY (client_id, institution_id) REFERENCES client (id, institution_id)
    );
    CREATE INDEX client_establishment_client_idx ON client_establishment (client_id);

    CREATE TABLE client_unit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      establishment_id uuid NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      beds integer CHECK (beds IS NULL OR beds BETWEEN 0 AND 1000),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1,
      FOREIGN KEY (establishment_id, institution_id) REFERENCES client_establishment (id, institution_id)
    );
    CREATE INDEX client_unit_establishment_idx ON client_unit (establishment_id);

    -- Who answers for each client. Never deleted: an assignment is ended (once), which keeps the history.
    CREATE TABLE client_assignment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      client_id uuid NOT NULL,
      user_id uuid NOT NULL,
      role text NOT NULL CHECK (role IN ('responsavel', 'apoio')),
      specialty text CHECK (specialty IS NULL OR specialty IN ('ccih', 'cme', 'qualidade', 'seguranca_paciente', 'gestao')),
      starts_on date NOT NULL,
      ends_on date,
      assigned_by uuid REFERENCES app_user(id),
      assigned_by_name text NOT NULL,
      reason text NOT NULL,
      ended_by_name text,
      end_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (client_id, institution_id) REFERENCES client (id, institution_id),
      FOREIGN KEY (user_id, institution_id) REFERENCES app_user (id, institution_id),
      CHECK (ends_on IS NULL OR ends_on >= starts_on),
      CHECK ((ends_on IS NULL) = (end_reason IS NULL))
    );
    CREATE UNIQUE INDEX client_assignment_responsible_idx ON client_assignment (client_id) WHERE ends_on IS NULL AND role = 'responsavel';
    CREATE UNIQUE INDEX client_assignment_active_idx ON client_assignment (client_id, user_id) WHERE ends_on IS NULL;
    CREATE INDEX client_assignment_user_idx ON client_assignment (user_id) WHERE ends_on IS NULL;

    CREATE FUNCTION client_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'client_assignment: atribuições não são apagadas (encerre-as)'; END IF;
      IF OLD.ends_on IS NOT NULL OR NEW.ends_on IS NULL
         OR (NEW.id, NEW.institution_id, NEW.client_id, NEW.user_id, NEW.role, NEW.specialty, NEW.starts_on, NEW.assigned_by, NEW.assigned_by_name, NEW.reason, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.client_id, OLD.user_id, OLD.role, OLD.specialty, OLD.starts_on, OLD.assigned_by, OLD.assigned_by_name, OLD.reason, OLD.created_at) THEN
        RAISE EXCEPTION 'client_assignment: só é permitido encerrar uma atribuição ativa, uma única vez';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER client_assignment_guard BEFORE UPDATE OR DELETE ON client_assignment FOR EACH ROW EXECUTE FUNCTION client_assignment_guard();

    -- Client timeline: what happened with the client, written by the system and by the team (insert-only).
    CREATE TABLE client_event (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      client_id uuid NOT NULL,
      kind text NOT NULL CHECK (kind IN ('cadastro', 'alteracao', 'atribuicao', 'substituicao', 'encerramento_atribuicao', 'atendimento', 'observacao')),
      summary text NOT NULL,
      detail text,
      occurred_on date NOT NULL,
      actor_id uuid REFERENCES app_user(id),
      actor_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (client_id, institution_id) REFERENCES client (id, institution_id)
    );
    CREATE INDEX client_event_client_idx ON client_event (client_id, occurred_on DESC, created_at DESC);
    CREATE TRIGGER client_event_append_only BEFORE UPDATE OR DELETE ON client_event FOR EACH ROW EXECUTE FUNCTION append_only();
  `.execute(db);

  // Profiles of the consulting model in the consulting organizations that already exist.
  const orgs = await sql<{ id: string }>`SELECT id FROM institution WHERE organization_type = 'consultoria'`.execute(db);
  for (const org of orgs.rows) {
    for (const r of ROLES) {
      await sql`INSERT INTO role (institution_id, code, name, permissions, module) VALUES (${org.id}, ${r.code}, ${r.name}, ${r.permissions}, 'consultoria') ON CONFLICT DO NOTHING`.execute(db);
    }
    await sql`UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ${CONSULTING}::text[]) p) WHERE institution_id = ${org.id} AND code = 'admin'`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS client_event;
    DROP TABLE IF EXISTS client_assignment;
    DROP FUNCTION IF EXISTS client_assignment_guard();
    DROP TABLE IF EXISTS client_unit;
    DROP TABLE IF EXISTS client_establishment;
    DROP TABLE IF EXISTS client_contact;
    DROP TABLE IF EXISTS client;
    DROP FUNCTION IF EXISTS consulting_only();
    DELETE FROM user_role WHERE role_code IN ('gestor_consultoria', 'consultor', 'assistente_consultoria', 'financeiro_consultoria');
    DELETE FROM role WHERE code IN ('gestor_consultoria', 'consultor', 'assistente_consultoria', 'financeiro_consultoria');
    UPDATE role SET permissions = (SELECT coalesce(array_agg(p), '{}') FROM unnest(permissions) p WHERE p NOT LIKE 'consultoria:%');
    ALTER TABLE role DROP CONSTRAINT IF EXISTS role_module_check;
    ALTER TABLE role ADD CONSTRAINT role_module_check CHECK (module IN ('ccih', 'cme', 'qualidade', 'sistema'));
    DELETE FROM event_outbox WHERE topic = 'consultoria';
    ALTER TABLE event_outbox DROP CONSTRAINT IF EXISTS event_outbox_topic_check;
    ALTER TABLE event_outbox ADD CONSTRAINT event_outbox_topic_check CHECK (topic IN ('clinico', 'cme', 'qualidade', 'alertas', 'notificacoes', 'config'));
  `.execute(db);
}
