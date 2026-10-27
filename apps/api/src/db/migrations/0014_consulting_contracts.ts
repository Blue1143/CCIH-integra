import { sql, type Kysely } from 'kysely';

/**
 * Consulting model (M4): contracts and proposals of each client, the services and scope they cover
 * (planned frequency of visits, hours or deliveries), amendments (insert-only), deliveries actually
 * made (planned × done; voided, never deleted) and the financial terms in a table of their own, read
 * only by the profiles allowed to see them. Every table references its parent together with the
 * consultancy's institution_id, so nothing can point to another organization's records.
 */
const CONTRACTS = ['consultoria:contracts:view', 'consultoria:contracts:edit', 'consultoria:contracts:deliveries', 'consultoria:contracts:financial'];
// Frozen copy of the profile defaults at this version.
const ROLE_ADDITIONS: Record<string, string[]> = {
  admin: CONTRACTS,
  gestor_consultoria: ['consultoria:contracts:view', 'consultoria:contracts:edit', 'consultoria:contracts:deliveries'],
  consultor: ['consultoria:contracts:view', 'consultoria:contracts:deliveries'],
  assistente_consultoria: ['consultoria:contracts:view', 'consultoria:contracts:edit', 'consultoria:contracts:deliveries'],
  financeiro_consultoria: ['consultoria:contracts:view', 'consultoria:contracts:financial'],
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE contract (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL REFERENCES institution(id),
      client_id uuid NOT NULL,
      code text NOT NULL,
      title text NOT NULL,
      status text NOT NULL CHECK (status IN ('proposta', 'vigente', 'suspenso', 'encerrado', 'recusada')),
      starts_on date,
      ends_on date,
      auto_renew boolean NOT NULL DEFAULT false,
      renewal_notice_days integer NOT NULL DEFAULT 60 CHECK (renewal_notice_days BETWEEN 0 AND 365),
      responsible_id uuid,
      scope_notes text,
      signed_on date,
      closed_on date,
      close_reason text,
      created_by uuid REFERENCES app_user(id),
      created_by_name text NOT NULL,
      data_origin text NOT NULL CHECK (data_origin IN ('real', 'demo')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      row_version integer NOT NULL DEFAULT 1,
      UNIQUE (id, institution_id),
      UNIQUE (institution_id, code),
      FOREIGN KEY (client_id, institution_id) REFERENCES client (id, institution_id),
      FOREIGN KEY (responsible_id, institution_id) REFERENCES app_user (id, institution_id),
      CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
      -- A signed contract has its signature date and start; a closed or refused one, its reason.
      CHECK (status IN ('proposta', 'recusada') OR (signed_on IS NOT NULL AND starts_on IS NOT NULL)),
      CHECK ((status IN ('encerrado', 'recusada')) = (close_reason IS NOT NULL))
    );
    CREATE INDEX contract_client_idx ON contract (client_id);
    CREATE INDEX contract_end_idx ON contract (institution_id, ends_on) WHERE status IN ('vigente', 'suspenso');
    CREATE TRIGGER contract_consulting_only BEFORE INSERT ON contract FOR EACH ROW EXECUTE FUNCTION consulting_only();

    CREATE TABLE contract_amendment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      contract_id uuid NOT NULL,
      number integer NOT NULL CHECK (number > 0),
      kinds text[] NOT NULL CHECK (cardinality(kinds) > 0 AND kinds <@ ARRAY['prazo', 'renovacao', 'escopo', 'valor', 'outro']),
      description text NOT NULL,
      signed_on date NOT NULL,
      effective_on date NOT NULL,
      changes text[] NOT NULL,
      snapshot jsonb NOT NULL,
      created_by uuid REFERENCES app_user(id),
      created_by_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (id, institution_id),
      UNIQUE (contract_id, number),
      FOREIGN KEY (contract_id, institution_id) REFERENCES contract (id, institution_id)
    );
    CREATE TRIGGER contract_amendment_append_only BEFORE UPDATE OR DELETE ON contract_amendment FOR EACH ROW EXECUTE FUNCTION append_only();

    CREATE TABLE contract_service (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      contract_id uuid NOT NULL,
      area text NOT NULL CHECK (area IN ('ccih', 'cme', 'qualidade', 'seguranca_paciente', 'gestao')),
      kind text NOT NULL,
      description text NOT NULL,
      establishment_id uuid,
      unit text NOT NULL CHECK (unit IN ('visitas', 'horas', 'entregas')),
      quantity numeric(10, 2) NOT NULL CHECK (quantity > 0),
      period text NOT NULL CHECK (period IN ('mensal', 'bimestral', 'trimestral', 'semestral', 'anual', 'contrato')),
      starts_on date,
      ends_on date,
      replaces_id uuid,
      amendment_id uuid,
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, institution_id),
      FOREIGN KEY (contract_id, institution_id) REFERENCES contract (id, institution_id),
      FOREIGN KEY (establishment_id, institution_id) REFERENCES client_establishment (id, institution_id),
      FOREIGN KEY (replaces_id, institution_id) REFERENCES contract_service (id, institution_id),
      FOREIGN KEY (amendment_id, institution_id) REFERENCES contract_amendment (id, institution_id),
      CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on - 1)
    );
    CREATE INDEX contract_service_contract_idx ON contract_service (contract_id);

    -- Lines of a proposal are edited freely; once the contract is signed a line only gets its end (once).
    CREATE FUNCTION contract_service_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE st text;
    BEGIN
      SELECT status INTO st FROM contract WHERE id = OLD.contract_id;
      IF st = 'proposta' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contract_service: serviços de contrato assinado não são apagados (encerre-os por aditivo)'; END IF;
      IF OLD.ends_on IS NOT NULL OR NEW.ends_on IS NULL
         OR (NEW.id, NEW.institution_id, NEW.contract_id, NEW.area, NEW.kind, NEW.description, NEW.establishment_id, NEW.unit, NEW.quantity, NEW.period, NEW.starts_on, NEW.replaces_id, NEW.amendment_id, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.contract_id, OLD.area, OLD.kind, OLD.description, OLD.establishment_id, OLD.unit, OLD.quantity, OLD.period, OLD.starts_on, OLD.replaces_id, OLD.amendment_id, OLD.created_at) THEN
        RAISE EXCEPTION 'contract_service: serviço de contrato assinado só pode ser encerrado (por aditivo), uma única vez';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER contract_service_guard BEFORE UPDATE OR DELETE ON contract_service FOR EACH ROW EXECUTE FUNCTION contract_service_guard();

    CREATE TABLE contract_delivery (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      institution_id uuid NOT NULL,
      service_id uuid NOT NULL,
      occurred_on date NOT NULL,
      quantity numeric(10, 2) NOT NULL CHECK (quantity > 0),
      description text NOT NULL,
      created_by uuid REFERENCES app_user(id),
      created_by_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      voided_at timestamptz,
      voided_by_name text,
      void_reason text,
      FOREIGN KEY (service_id, institution_id) REFERENCES contract_service (id, institution_id),
      CHECK ((voided_at IS NULL) = (void_reason IS NULL))
    );
    CREATE INDEX contract_delivery_service_idx ON contract_delivery (service_id, occurred_on);

    -- Deliveries are never deleted or rewritten: a mistaken one is voided (once), with the reason.
    CREATE FUNCTION contract_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contract_delivery: entregas não são apagadas (anule-as com justificativa)'; END IF;
      IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
         OR (NEW.id, NEW.institution_id, NEW.service_id, NEW.occurred_on, NEW.quantity, NEW.description, NEW.created_by, NEW.created_by_name, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.institution_id, OLD.service_id, OLD.occurred_on, OLD.quantity, OLD.description, OLD.created_by, OLD.created_by_name, OLD.created_at) THEN
        RAISE EXCEPTION 'contract_delivery: só é permitido anular uma entrega, uma única vez';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER contract_delivery_guard BEFORE UPDATE OR DELETE ON contract_delivery FOR EACH ROW EXECUTE FUNCTION contract_delivery_guard();

    -- Financial terms: separate table, read only with consultoria:contracts:financial.
    CREATE TABLE contract_financial (
      contract_id uuid PRIMARY KEY,
      institution_id uuid NOT NULL,
      basis text NOT NULL CHECK (basis IN ('mensal', 'total', 'por_entrega')),
      amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
      billing_day integer CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 31),
      payment_terms text,
      adjustment_rule text,
      notes text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by_name text NOT NULL,
      row_version integer NOT NULL DEFAULT 1,
      FOREIGN KEY (contract_id, institution_id) REFERENCES contract (id, institution_id)
    );

    -- The client timeline also tells the story of its contracts.
    ALTER TABLE client_event DROP CONSTRAINT client_event_kind_check;
    ALTER TABLE client_event ADD CONSTRAINT client_event_kind_check CHECK (kind IN ('cadastro', 'alteracao', 'atribuicao', 'substituicao', 'encerramento_atribuicao', 'atendimento', 'observacao', 'contrato'));
    ALTER TABLE client_event ADD COLUMN contract_id uuid;
    ALTER TABLE client_event ADD CONSTRAINT client_event_contract_fk FOREIGN KEY (contract_id, institution_id) REFERENCES contract (id, institution_id);
    CREATE INDEX client_event_contract_idx ON client_event (contract_id) WHERE contract_id IS NOT NULL;

    -- Alerts of the consulting model follow the client scope of each person.
    ALTER TABLE alert ADD COLUMN client_id uuid REFERENCES client(id);
    CREATE INDEX alert_client_idx ON alert (client_id) WHERE client_id IS NOT NULL;
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
    DROP INDEX IF EXISTS alert_client_idx;
    ALTER TABLE alert DROP COLUMN IF EXISTS client_id;
    ALTER TABLE alert_action DISABLE TRIGGER alert_action_append_only;
    DELETE FROM alert_action WHERE alert_id IN (SELECT id FROM alert WHERE kind LIKE 'contrato_%');
    ALTER TABLE alert_action ENABLE TRIGGER alert_action_append_only;
    DELETE FROM alert WHERE kind LIKE 'contrato_%';
    DROP INDEX IF EXISTS client_event_contract_idx;
    ALTER TABLE client_event DISABLE TRIGGER client_event_append_only;
    DELETE FROM client_event WHERE kind = 'contrato';
    ALTER TABLE client_event ENABLE TRIGGER client_event_append_only;
    ALTER TABLE client_event DROP CONSTRAINT IF EXISTS client_event_contract_fk;
    ALTER TABLE client_event DROP COLUMN IF EXISTS contract_id;
    ALTER TABLE client_event DROP CONSTRAINT IF EXISTS client_event_kind_check;
    ALTER TABLE client_event ADD CONSTRAINT client_event_kind_check CHECK (kind IN ('cadastro', 'alteracao', 'atribuicao', 'substituicao', 'encerramento_atribuicao', 'atendimento', 'observacao'));
    DROP TABLE IF EXISTS contract_financial;
    DROP TABLE IF EXISTS contract_delivery;
    DROP FUNCTION IF EXISTS contract_delivery_guard();
    DROP TABLE IF EXISTS contract_service;
    DROP FUNCTION IF EXISTS contract_service_guard();
    DROP TABLE IF EXISTS contract_amendment;
    DROP TABLE IF EXISTS contract;
    UPDATE role SET permissions = (SELECT coalesce(array_agg(p), '{}') FROM unnest(permissions) p WHERE p NOT LIKE 'consultoria:contracts:%');
  `.execute(db);
}
