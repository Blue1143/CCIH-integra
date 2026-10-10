import { sql, type Kysely } from 'kysely';

/**
 * Users, functions and permissions (RBAC by module):
 * - account record: institutional e-mail, professional category, function, status, who created and
 *   who authorized it, last change of permissions, validity window and supervisor (Jovem Aprendiz);
 * - the creator account (one per institution, protected by the database);
 * - individual grants (express authorization, with justification and validity);
 * - module of each profile, the split permissions and the nine functions.
 * Profile permissions below are a frozen copy of the matrix approved on 10/10/2026 (later changes
 * are made in Administração or in new migrations, never by editing this one).
 */
const ROLES: Array<{ code: string; name: string; module: string; permissions: string[] }> = [
  { code: 'admin', name: 'Administrador do sistema', module: 'sistema', permissions: ['dashboard:view', 'indicators:view', 'indicators:consolidate', 'reports:view', 'config:view', 'config:targets:edit', 'config:rules:edit', 'config:references:edit', 'config:references:validate', 'config:org:edit', 'config:cme_policy:edit', 'ccih:parameters:edit', 'cme:parameters:edit', 'users:view', 'users:manage', 'users:manage:ccih', 'users:manage:cme', 'audit:view', 'audit:view:module', 'patient:view', 'patient:view_identified', 'patient:edit', 'iras:view', 'iras:edit', 'iras:decide', 'surgery:view', 'surgery:edit', 'micro:view', 'micro:edit', 'atm:view', 'atm:review', 'cme:view', 'cme:scan', 'cme:cycle:record', 'cme:test:record', 'cme:release', 'cme:configure', 'cme:stations:configure', 'cme:override', 'quality:view', 'quality:bundle:record', 'quality:audit:execute', 'quality:audit:manage', 'quality:training:edit', 'quality:supplies:edit', 'quality:configure', 'nc:record', 'alerts:view', 'alerts:manage', 'alerts:exception', 'export:aggregate', 'export:identified'] },
  { code: 'enf_ccih', name: 'Enfermeiro CCIH', module: 'ccih', permissions: ['dashboard:view', 'indicators:view', 'reports:view', 'config:view', 'config:references:validate', 'indicators:consolidate', 'patient:view', 'patient:view_identified', 'patient:edit', 'iras:view', 'iras:edit', 'iras:decide', 'surgery:view', 'surgery:edit', 'micro:view', 'atm:view', 'cme:view', 'quality:view', 'quality:bundle:record', 'quality:training:edit', 'quality:supplies:edit', 'nc:record', 'alerts:view', 'alerts:manage', 'alerts:exception', 'export:aggregate'] },
  { code: 'tec_ccih', name: 'Técnico de Enfermagem CCIH', module: 'ccih', permissions: ['dashboard:view', 'indicators:view', 'reports:view', 'patient:view', 'patient:edit', 'iras:view', 'iras:edit', 'surgery:view', 'micro:view', 'atm:view', 'cme:view', 'quality:view', 'nc:record', 'alerts:view'] },
  { code: 'cme', name: 'Enfermeiro CME', module: 'cme', permissions: ['cme:view', 'cme:scan', 'cme:cycle:record', 'cme:test:record', 'cme:release', 'cme:override', 'cme:configure', 'cme:stations:configure', 'nc:record', 'alerts:view', 'alerts:manage', 'reports:view'] },
  { code: 'tec_cme', name: 'Técnico de Enfermagem CME', module: 'cme', permissions: ['cme:view', 'cme:scan', 'cme:cycle:record', 'cme:test:record', 'nc:record', 'alerts:view'] },
  { code: 'enf_qualidade', name: 'Enfermeiro Qualidade', module: 'qualidade', permissions: ['dashboard:view', 'indicators:view', 'reports:view', 'config:view', 'quality:view', 'quality:audit:manage', 'quality:audit:execute', 'quality:bundle:record', 'quality:training:edit', 'quality:supplies:edit', 'nc:record', 'alerts:view', 'alerts:manage', 'export:aggregate'] },
  { code: 'tec_qualidade', name: 'Técnico de Enfermagem Qualidade', module: 'qualidade', permissions: ['dashboard:view', 'indicators:view', 'reports:view', 'quality:view', 'quality:audit:execute', 'quality:bundle:record', 'nc:record', 'alerts:view'] },
  { code: 'adm_cme', name: 'ADM CME', module: 'cme', permissions: ['cme:view', 'cme:scan', 'cme:cycle:record', 'cme:test:record', 'cme:release', 'cme:override', 'cme:configure', 'cme:stations:configure', 'nc:record', 'alerts:view', 'alerts:manage', 'reports:view', 'config:view', 'cme:parameters:edit', 'config:cme_policy:edit', 'quality:training:edit', 'users:manage:cme', 'audit:view:module'] },
  { code: 'adm_ccih', name: 'ADM CCIH', module: 'ccih', permissions: ['dashboard:view', 'indicators:view', 'reports:view', 'config:view', 'config:references:validate', 'indicators:consolidate', 'patient:view', 'patient:view_identified', 'patient:edit', 'iras:view', 'iras:edit', 'iras:decide', 'surgery:view', 'surgery:edit', 'micro:view', 'atm:view', 'cme:view', 'quality:view', 'quality:bundle:record', 'quality:training:edit', 'quality:supplies:edit', 'nc:record', 'alerts:view', 'alerts:manage', 'alerts:exception', 'export:aggregate', 'ccih:parameters:edit', 'config:targets:edit', 'config:references:edit', 'quality:configure', 'users:manage:ccih', 'audit:view:module'] },
  { code: 'aprendiz', name: 'Jovem Aprendiz', module: 'sistema', permissions: [] },
  { code: 'infectologista', name: 'Médico infectologista', module: 'ccih', permissions: ['dashboard:view', 'indicators:view', 'reports:view', 'config:view', 'config:references:validate', 'patient:view', 'patient:view_identified', 'iras:view', 'iras:edit', 'iras:decide', 'surgery:view', 'micro:view', 'micro:edit', 'atm:view', 'atm:review', 'nc:record', 'alerts:view', 'alerts:manage', 'export:aggregate'] },
  { code: 'auditor', name: 'Auditor', module: 'qualidade', permissions: ['dashboard:view', 'indicators:view', 'reports:view', 'config:view', 'audit:view', 'users:view', 'patient:view', 'iras:view', 'surgery:view', 'micro:view', 'atm:view', 'cme:view', 'quality:view', 'alerts:view'] },
  { code: 'gestor', name: 'Gestor', module: 'sistema', permissions: ['dashboard:view', 'indicators:view', 'reports:view', 'quality:view', 'export:aggregate'] },
  { code: 'consulta', name: 'Consulta', module: 'sistema', permissions: ['dashboard:view', 'indicators:view'] },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app_user
      ADD COLUMN email text CHECK (email IS NULL OR email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'),
      ADD COLUMN professional_category text CHECK (professional_category IN ('enfermeiro', 'tecnico_enfermagem', 'medico', 'administrativo', 'aprendiz', 'outro')),
      ADD COLUMN function_role text,
      ADD COLUMN status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('pendente', 'ativo', 'suspenso', 'desativado')),
      ADD COLUMN status_reason text,
      ADD COLUMN created_by uuid REFERENCES app_user(id),
      ADD COLUMN authorized_by uuid REFERENCES app_user(id),
      ADD COLUMN authorized_by_name text,
      ADD COLUMN permissions_changed_at timestamptz,
      ADD COLUMN valid_from date,
      ADD COLUMN valid_until date,
      ADD COLUMN supervisor_id uuid REFERENCES app_user(id),
      ADD COLUMN is_founder boolean NOT NULL DEFAULT false;
    UPDATE app_user SET status = CASE WHEN active THEN 'ativo' ELSE 'desativado' END, permissions_changed_at = created_at;
    UPDATE app_user u SET function_role = (SELECT min(r.role_code) FROM user_role r WHERE r.user_id = u.id);
    ALTER TABLE app_user
      ADD CONSTRAINT app_user_active_status_check CHECK (active = (status = 'ativo')),
      ADD CONSTRAINT app_user_validity_check CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
      ADD CONSTRAINT app_user_founder_active_check CHECK (NOT is_founder OR status = 'ativo');
    CREATE UNIQUE INDEX app_user_founder_idx ON app_user (institution_id) WHERE is_founder;

    -- The creator account cannot be demoted, deactivated or created by an update, whoever runs the SQL.
    CREATE FUNCTION app_user_founder_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.is_founder AND NOT NEW.is_founder THEN RAISE EXCEPTION 'conta criadora não pode perder a condição de criadora'; END IF;
      IF NOT OLD.is_founder AND NEW.is_founder THEN RAISE EXCEPTION 'a conta criadora só é definida na criação'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER app_user_founder_guard BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION app_user_founder_guard();
    CREATE FUNCTION user_role_founder_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.role_code = 'admin' AND EXISTS (SELECT 1 FROM app_user WHERE id = OLD.user_id AND is_founder) THEN
        RAISE EXCEPTION 'a conta criadora mantém o perfil de administrador';
      END IF;
      RETURN OLD;
    END $$;
    CREATE TRIGGER user_role_founder_guard BEFORE DELETE ON user_role FOR EACH ROW EXECUTE FUNCTION user_role_founder_guard();

    CREATE TABLE user_permission (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES app_user(id),
      permission text NOT NULL,
      granted_by uuid REFERENCES app_user(id),
      granted_by_name text NOT NULL,
      justification text NOT NULL,
      valid_until date,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      revoked_by_name text,
      CHECK ((revoked_at IS NULL) = (revoked_by_name IS NULL))
    );
    CREATE UNIQUE INDEX user_permission_active_idx ON user_permission (user_id, permission) WHERE revoked_at IS NULL;

    ALTER TABLE role ADD COLUMN module text NOT NULL DEFAULT 'sistema' CHECK (module IN ('ccih', 'cme', 'qualidade', 'sistema'));
  `.execute(db);

  // Profiles: existing ones get the split permissions; new functions are added to every institution.
  for (const r of ROLES) {
    await sql`
      INSERT INTO role (institution_id, code, name, permissions, module)
      SELECT id, ${r.code}, ${r.name}, ${r.permissions}::text[], ${r.module} FROM institution
      ON CONFLICT (institution_id, code) DO UPDATE SET name = EXCLUDED.name, permissions = EXCLUDED.permissions, module = EXCLUDED.module
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM user_role WHERE role_code IN ('tec_ccih', 'tec_cme', 'enf_qualidade', 'tec_qualidade', 'adm_cme', 'adm_ccih', 'aprendiz');
    DELETE FROM role WHERE code IN ('tec_ccih', 'tec_cme', 'enf_qualidade', 'tec_qualidade', 'adm_cme', 'adm_ccih', 'aprendiz');
    ALTER TABLE role DROP COLUMN IF EXISTS module;
    DROP TABLE IF EXISTS user_permission;
    DROP TRIGGER IF EXISTS user_role_founder_guard ON user_role;
    DROP FUNCTION IF EXISTS user_role_founder_guard();
    DROP TRIGGER IF EXISTS app_user_founder_guard ON app_user;
    DROP FUNCTION IF EXISTS app_user_founder_guard();
    DROP INDEX IF EXISTS app_user_founder_idx;
    ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_active_status_check, DROP CONSTRAINT IF EXISTS app_user_validity_check, DROP CONSTRAINT IF EXISTS app_user_founder_active_check,
      DROP COLUMN email, DROP COLUMN professional_category, DROP COLUMN function_role, DROP COLUMN status, DROP COLUMN status_reason, DROP COLUMN created_by,
      DROP COLUMN authorized_by, DROP COLUMN authorized_by_name, DROP COLUMN permissions_changed_at, DROP COLUMN valid_from, DROP COLUMN valid_until,
      DROP COLUMN supervisor_id, DROP COLUMN is_founder;
  `.execute(db);
}
