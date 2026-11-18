import { sql, type Kysely } from 'kysely';

/**
 * Consulting model (M5): the agenda (activities with the clients, who takes part, what happened),
 * the insert-only history of each activity and the follow-up tasks it leaves. A realized activity
 * linked to a contracted service becomes a delivery of that service (contract_delivery.activity_id).
 * Every table references its parents together with the consultancy's institution_id.
 */
const AGENDA = ['consultoria:agenda:view', 'consultoria:agenda:edit', 'consultoria:agenda:record'];
// Frozen copy of the profile defaults at this version.
const ROLE_ADDITIONS: Record<string, string[]> = {
  admin: AGENDA,
  gestor_consultoria: AGENDA,
  consultor: AGENDA,
  assistente_consultoria: ['consultoria:agenda:view', 'consultoria:agenda:edit'],
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE consulting_activity (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL REFERENCES institution(id),
      client_id uuid NOT NULL,
      establishment_id uuid,
      contract_service_id uuid,
      kind text NOT NULL CHECK (kind IN ('visita_tecnica', 'reuniao', 'auditoria', 'inspecao', 'treinamento', 'entrega', 'diagnostico', 'outro')),
      mode text NOT NULL CHECK (mode IN ('presencial', 'remoto')),
      title text NOT NULL,
      description text,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      location text,
      responsible_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'agendada' CHECK (status IN ('agendada', 'realizada', 'nao_realizada', 'cancelada')),
      outcome_summary text,
      outcome_detail text,
      actual_minutes integer CHECK (actual_minutes IS NULL OR actual_minutes BETWEEN 5 AND 720),
      close_reason text,
      recorded_by_name text,
      recorded_at timestamptz,
      created_by uuid REFERENCES app_user(id),
      created_by_name text NOT NULL,
      data_origin text NOT NULL CHECK (data_origin IN ('real', 'demo')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1,
      UNIQUE (id, institution_id),
      FOREIGN KEY (client_id, institution_id) REFERENCES client (id, institution_id),
      FOREIGN KEY (establishment_id, institution_id) REFERENCES client_establishment (id, institution_id),
      FOREIGN KEY (contract_service_id, institution_id) REFERENCES contract_service (id, institution_id),
      FOREIGN KEY (responsible_id, institution_id) REFERENCES app_user (id, institution_id),
      CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '12 hours'),
      -- A realized activity has its summary and duration; one not realized or cancelled, its reason.
      CHECK (status <> 'realizada' OR (outcome_summary IS NOT NULL AND actual_minutes IS NOT NULL)),
      CHECK ((status IN ('nao_realizada', 'cancelada')) = (close_reason IS NOT NULL)),
      CHECK ((status = 'agendada') = (recorded_at IS NULL))
    );
    CREATE INDEX consulting_activity_period_idx ON consulting_activity (institution_id, starts_at);
    CREATE INDEX consulting_activity_client_idx ON consulting_activity (client_id, starts_at);
    CREATE INDEX consulting_activity_open_idx ON consulting_activity (institution_id, ends_at) WHERE status = 'agendada';
    CREATE TRIGGER consulting_activity_consulting_only BEFORE INSERT ON consulting_activity FOR EACH ROW EXECUTE FUNCTION consulting_only();

    -- A scheduled activity is edited freely (history in consulting_activity_event); once recorded it is final.
    CREATE FUNCTION consulting_activity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'consulting_activity: atividades não são apagadas (cancele-as com o motivo)'; END IF;
      IF OLD.status <> 'agendada' THEN RAISE EXCEPTION 'consulting_activity: atividade já registrada (%) não é alterada', OLD.status; END IF;
      IF NEW.institution_id <> OLD.institution_id OR NEW.client_id <> OLD.client_id OR NEW.created_at <> OLD.created_at OR NEW.data_origin <> OLD.data_origin THEN
        RAISE EXCEPTION 'consulting_activity: organização, cliente e origem não mudam';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER consulting_activity_guard BEFORE UPDATE OR DELETE ON consulting_activity FOR EACH ROW EXECUTE FUNCTION consulting_activity_guard();

    CREATE TABLE consulting_activity_participant (
      activity_id uuid NOT NULL,
      user_id uuid NOT NULL,
      institution_id uuid NOT NULL,
      PRIMARY KEY (activity_id, user_id),
      FOREIGN KEY (activity_id, institution_id) REFERENCES consulting_activity (id, institution_id),
      FOREIGN KEY (user_id, institution_id) REFERENCES app_user (id, institution_id)
    );
    CREATE INDEX consulting_activity_participant_user_idx ON consulting_activity_participant (user_id);

    CREATE TABLE consulting_activity_event (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      activity_id uuid NOT NULL,
      kind text NOT NULL CHECK (kind IN ('agendada', 'alterada', 'remarcada', 'realizada', 'nao_realizada', 'cancelada', 'pendencia', 'pendencia_encerrada')),
      summary text NOT NULL,
      detail text,
      actor_id uuid REFERENCES app_user(id),
      actor_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (activity_id, institution_id) REFERENCES consulting_activity (id, institution_id)
    );
    CREATE INDEX consulting_activity_event_activity_idx ON consulting_activity_event (activity_id, created_at);
    CREATE TRIGGER consulting_activity_event_append_only BEFORE UPDATE OR DELETE ON consulting_activity_event FOR EACH ROW EXECUTE FUNCTION append_only();

    CREATE TABLE consulting_task (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      client_id uuid NOT NULL,
      activity_id uuid,
      description text NOT NULL,
      owner_id uuid NOT NULL,
      due_on date NOT NULL,
      status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'concluida', 'cancelada')),
      closed_note text,
      closed_by_name text,
      closed_at timestamptz,
      created_by uuid REFERENCES app_user(id),
      created_by_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1,
      FOREIGN KEY (client_id, institution_id) REFERENCES client (id, institution_id),
      FOREIGN KEY (activity_id, institution_id) REFERENCES consulting_activity (id, institution_id),
      FOREIGN KEY (owner_id, institution_id) REFERENCES app_user (id, institution_id),
      CHECK ((status = 'aberta') = (closed_at IS NULL)),
      CHECK (status <> 'aberta' OR closed_note IS NULL)
    );
    CREATE INDEX consulting_task_open_idx ON consulting_task (institution_id, due_on) WHERE status = 'aberta';
    CREATE INDEX consulting_task_owner_idx ON consulting_task (owner_id) WHERE status = 'aberta';

    -- An open task is closed once (concluded or cancelled, with a note); never deleted or rewritten.
    CREATE FUNCTION consulting_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'consulting_task: pendências não são apagadas (cancele-as com a observação)'; END IF;
      IF OLD.status <> 'aberta' OR NEW.status = 'aberta'
         OR (NEW.id, NEW.institution_id, NEW.client_id, NEW.activity_id, NEW.description, NEW.owner_id, NEW.due_on, NEW.created_by, NEW.created_by_name, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.client_id, OLD.activity_id, OLD.description, OLD.owner_id, OLD.due_on, OLD.created_by, OLD.created_by_name, OLD.created_at) THEN
        RAISE EXCEPTION 'consulting_task: só é permitido encerrar uma pendência aberta, uma única vez';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER consulting_task_guard BEFORE UPDATE OR DELETE ON consulting_task FOR EACH ROW EXECUTE FUNCTION consulting_task_guard();

    -- The delivery registered from a realized activity points to it (and is protected like the others).
    ALTER TABLE contract_delivery ADD COLUMN activity_id uuid;
    ALTER TABLE contract_delivery ADD CONSTRAINT contract_delivery_activity_fk FOREIGN KEY (activity_id, institution_id) REFERENCES consulting_activity (id, institution_id);
    CREATE UNIQUE INDEX contract_delivery_activity_idx ON contract_delivery (activity_id) WHERE activity_id IS NOT NULL;
    CREATE OR REPLACE FUNCTION contract_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contract_delivery: entregas não são apagadas (anule-as com justificativa)'; END IF;
      IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
         OR (NEW.id, NEW.institution_id, NEW.service_id, NEW.occurred_on, NEW.quantity, NEW.description, NEW.created_by, NEW.created_by_name, NEW.created_at, NEW.activity_id)
            IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.service_id, OLD.occurred_on, OLD.quantity, OLD.description, OLD.created_by, OLD.created_by_name, OLD.created_at, OLD.activity_id) THEN
        RAISE EXCEPTION 'contract_delivery: só é permitido anular uma entrega, uma única vez';
      END IF;
      RETURN NEW;
    END $$;

    ALTER TABLE client_event DROP CONSTRAINT client_event_kind_check;
    ALTER TABLE client_event ADD CONSTRAINT client_event_kind_check CHECK (kind IN ('cadastro', 'alteracao', 'atribuicao', 'substituicao', 'encerramento_atribuicao', 'atendimento', 'observacao', 'contrato', 'atividade'));
  `.execute(db);

  const orgs = await sql<{ id: string }>`SELECT id FROM institution WHERE organization_type = 'consultoria'`.execute(db);
  for (const org of orgs.rows) {
    for (const [code, perms] of Object.entries(ROLE_ADDITIONS)) {
      await sql`UPDATE role SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ${perms}::text[]) p) WHERE institution_id = ${org.id} AND code = ${code}`.execute(db);
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE alert_action DISABLE TRIGGER alert_action_append_only;
    DELETE FROM alert_action WHERE alert_id IN (SELECT id FROM alert WHERE kind IN ('atividade_sem_registro', 'pendencia_atrasada'));
    ALTER TABLE alert_action ENABLE TRIGGER alert_action_append_only;
    DELETE FROM alert WHERE kind IN ('atividade_sem_registro', 'pendencia_atrasada');
    ALTER TABLE client_event DISABLE TRIGGER client_event_append_only;
    DELETE FROM client_event WHERE kind = 'atividade';
    ALTER TABLE client_event ENABLE TRIGGER client_event_append_only;
    ALTER TABLE client_event DROP CONSTRAINT IF EXISTS client_event_kind_check;
    ALTER TABLE client_event ADD CONSTRAINT client_event_kind_check CHECK (kind IN ('cadastro', 'alteracao', 'atribuicao', 'substituicao', 'encerramento_atribuicao', 'atendimento', 'observacao', 'contrato'));
    -- Deliveries that came from the agenda stay (they are history of the contract); only the link goes.
    DROP INDEX IF EXISTS contract_delivery_activity_idx;
    ALTER TABLE contract_delivery DROP CONSTRAINT IF EXISTS contract_delivery_activity_fk;
    ALTER TABLE contract_delivery DROP COLUMN IF EXISTS activity_id;
    CREATE OR REPLACE FUNCTION contract_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contract_delivery: entregas não são apagadas (anule-as com justificativa)'; END IF;
      IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
         OR (NEW.id, NEW.institution_id, NEW.service_id, NEW.occurred_on, NEW.quantity, NEW.description, NEW.created_by, NEW.created_by_name, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.service_id, OLD.occurred_on, OLD.quantity, OLD.description, OLD.created_by, OLD.created_by_name, OLD.created_at) THEN
        RAISE EXCEPTION 'contract_delivery: só é permitido anular uma entrega, uma única vez';
      END IF;
      RETURN NEW;
    END $$;
    DROP TABLE IF EXISTS consulting_task;
    DROP FUNCTION IF EXISTS consulting_task_guard();
    DROP TABLE IF EXISTS consulting_activity_event;
    DROP TABLE IF EXISTS consulting_activity_participant;
    DROP TABLE IF EXISTS consulting_activity;
    DROP FUNCTION IF EXISTS consulting_activity_guard();
    UPDATE role SET permissions = (SELECT coalesce(array_agg(p), '{}') FROM unnest(permissions) p WHERE p NOT LIKE 'consultoria:agenda:%');
  `.execute(db);
}
