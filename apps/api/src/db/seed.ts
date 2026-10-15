import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { DEFAULT_ROLE_PERMISSIONS, effectivePermissions, ROLE_LABEL, ROLE_MODULE, rolesOfModel, addDays, addMonths, monthStart, parametersFromRules, todayIn, type Permission, type RoleCode } from '@ccih/domain';
import { DEMO_CONFIG, DEMO_LOAD_POLICY, DEMO_REFERENCES, DEMO_SECTORS, DEMO_UNITS, WARD_PROFILES, generateFacts } from '@ccih/demo-data';
import { audit } from '../audit/audit';
import { hashPassword, passwordProblem } from '../security/crypto';
import { consolidateMonths } from '../repositories/consolidation';
import { seedClinical } from './seed-clinical';
import { seedOperations } from './seed-operations';
import { seedCme } from './seed-cme';
import type { DB } from './types';

/** Synthetic users, one per initial profile. Logins are fictitious; passwords are never stored in code. */
type Category = 'enfermeiro' | 'tecnico_enfermagem' | 'medico' | 'administrativo' | 'aprendiz' | 'outro';
/** Synthetic users, one per function. The creator account is never seeded: it is created by `admin:bootstrap`. */
const DEMO_USERS: Array<{ login: string; name: string; role: RoleCode; jobRole: string; category: Category; scope: 'all' | string[]; grants?: Permission[] }> = [
  { login: 'admin', name: 'Administrador (demonstração)', role: 'admin', jobRole: 'Analista de sistemas', category: 'administrativo', scope: 'all' },
  { login: 'enf.ccih', name: 'Enfermeira CCIH (demonstração)', role: 'enf_ccih', jobRole: 'Enfermeiro(a) CCIH', category: 'enfermeiro', scope: 'all' },
  { login: 'tec.ccih', name: 'Técnico de Enfermagem CCIH (demonstração)', role: 'tec_ccih', jobRole: 'Técnico(a) de enfermagem CCIH', category: 'tecnico_enfermagem', scope: 'all' },
  { login: 'adm.ccih', name: 'ADM CCIH (demonstração)', role: 'adm_ccih', jobRole: 'Coordenador(a) da CCIH', category: 'enfermeiro', scope: 'all' },
  { login: 'infecto', name: 'Infectologista (demonstração)', role: 'infectologista', jobRole: 'Médico(a) infectologista', category: 'medico', scope: 'all' },
  { login: 'cme', name: 'Enfermeira CME (demonstração)', role: 'cme', jobRole: 'Enfermeiro(a) RT da CME', category: 'enfermeiro', scope: ['cme'] },
  { login: 'tec.cme', name: 'Técnico de Enfermagem CME (demonstração)', role: 'tec_cme', jobRole: 'Técnico(a) de enfermagem CME', category: 'tecnico_enfermagem', scope: ['cme'] },
  { login: 'adm.cme', name: 'ADM CME (demonstração)', role: 'adm_cme', jobRole: 'Coordenador(a) da CME', category: 'enfermeiro', scope: ['cme'] },
  { login: 'enf.qualidade', name: 'Enfermeira Qualidade (demonstração)', role: 'enf_qualidade', jobRole: 'Enfermeiro(a) da Qualidade', category: 'enfermeiro', scope: 'all' },
  { login: 'tec.qualidade', name: 'Técnico de Enfermagem Qualidade (demonstração)', role: 'tec_qualidade', jobRole: 'Técnico(a) de enfermagem da Qualidade', category: 'tecnico_enfermagem', scope: 'all' },
  { login: 'aprendiz', name: 'Jovem Aprendiz CME (demonstração)', role: 'aprendiz', jobRole: 'Jovem aprendiz', category: 'aprendiz', scope: ['cme'], grants: ['cme:view', 'cme:scan', 'nc:record'] },
  { login: 'auditor', name: 'Auditor (demonstração)', role: 'auditor', jobRole: 'Auditor(a) de qualidade', category: 'outro', scope: 'all' },
  { login: 'gestor', name: 'Gestor (demonstração)', role: 'gestor', jobRole: 'Gestor(a) assistencial', category: 'administrativo', scope: 'all' },
  { login: 'consulta', name: 'Consulta Unidade Norte (demonstração)', role: 'consulta', jobRole: 'Coordenador(a) de unidade', category: 'outro', scope: ['uti-coronariana', 'clinica-cirurgica'] },
];

export interface SeedOptions {
  /** Same password for every demo user (tests/e2e). Without it, random passwords are generated. */
  password?: string;
  now?: Date;
  /**
   * Tests only: an additional synthetic organization in a database that already has one (isolation
   * tests). Logins get this prefix, since logins are unique across the platform.
   */
  additional?: { loginPrefix: string; name: string };
}

export interface SeedResult {
  institutionId: string;
  credentials: Array<{ login: string; role: RoleCode; password: string }>;
  facts: number;
  clinical: { admissions: number; surgeries: number; cases: number; cultures: number };
}

/** Synthetic demo institution, coherent across entities and flagged data_origin = 'demo'. */
export async function seedDemo(db: Kysely<DB>, opts: SeedOptions = {}): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  const weak = opts.password ? passwordProblem(opts.password) : null;
  if (weak) throw new Error(`SEED_PASSWORD fora da política de senhas: ${weak}`);
  const existing = await db.selectFrom('institution').select('id').executeTakeFirst();
  if (existing && !opts.additional) throw new Error('O banco já possui uma instituição. Use db:reset para recriar o ambiente de demonstração.');
  const login = (l: string) => `${opts.additional?.loginPrefix ?? ''}${l}`;

  return db.transaction().execute(async (trx) => {
    const inst = await trx.insertInto('institution').values({ name: opts.additional?.name ?? DEMO_CONFIG.institutionName, cnes: null, timezone: DEMO_CONFIG.timezone, data_origin: 'demo' }).returning('id').executeTakeFirstOrThrow();
    const institutionId = inst.id;

    const unitIds = new Map<string, string>();
    for (const u of DEMO_UNITS) {
      const row = await trx.insertInto('unit').values({ institution_id: institutionId, name: u.name }).returning('id').executeTakeFirstOrThrow();
      unitIds.set(u.id, row.id);
    }
    const sectorIds = new Map<string, string>();
    for (const s of DEMO_SECTORS) {
      const row = await trx.insertInto('sector').values({ institution_id: institutionId, unit_id: unitIds.get(s.unitId)!, code: s.code, name: s.name, kind: s.kind }).returning('id').executeTakeFirstOrThrow();
      sectorIds.set(s.code, row.id);
      if (s.kind === 'uti' || s.kind === 'internacao') {
        const beds = WARD_PROFILES[s.code]?.beds ?? 6;
        await trx.insertInto('bed').values(Array.from({ length: beds }, (_, i) => ({ sector_id: row.id, code: String(i + 1).padStart(2, '0') }))).execute();
      }
    }

    for (const code of rolesOfModel('hospitalar')) {
      await trx.insertInto('role').values({ institution_id: institutionId, code, name: ROLE_LABEL[code], permissions: effectivePermissions(DEFAULT_ROLE_PERMISSIONS[code], 'hospitalar'), module: ROLE_MODULE[code] }).execute();
    }

    const credentials: SeedResult['credentials'] = [];
    for (const u of DEMO_USERS) {
      const job = await trx.insertInto('job_role').values({ institution_id: institutionId, name: u.jobRole }).onConflict((oc) => oc.columns(['institution_id', 'name']).doUpdateSet({ name: u.jobRole })).returning('id').executeTakeFirstOrThrow();
      const prof = await trx.insertInto('professional').values({ institution_id: institutionId, name: u.name, registration: null, job_role_id: job.id }).returning('id').executeTakeFirstOrThrow();
      const password = opts.password ?? `${randomBytes(9).toString('base64url')}-Aa1!`;
      const user = await trx
        .insertInto('app_user')
        .values({
          institution_id: institutionId, professional_id: prof.id, login: login(u.login), display_name: u.name, password_hash: await hashPassword(password), scope_all: u.scope === 'all', password_changed_at: now,
          function_role: u.role, professional_category: u.category, status: 'ativo', permissions_changed_at: now, authorized_by_name: 'Carga de demonstração',
          ...(u.grants ? { valid_from: todayIn(DEMO_CONFIG.timezone, now), valid_until: addDays(todayIn(DEMO_CONFIG.timezone, now), 180) } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('user_role').values({ user_id: user.id, institution_id: institutionId, role_code: u.role }).execute();
      if (u.scope !== 'all') await trx.insertInto('user_scope').values(u.scope.map((code) => ({ user_id: user.id, sector_id: sectorIds.get(code)! }))).execute();
      if (u.grants) await trx.insertInto('user_permission').values(u.grants.map((permission) => ({ user_id: user.id, permission, granted_by: null, granted_by_name: 'Carga de demonstração', justification: 'Pacote Registro operacional CME (demonstração)', valid_until: null }))).execute();
      credentials.push({ login: login(u.login), role: u.role, password });
    }
    // The apprentice is supervised by the CME nurse.
    const [apprentice, supervisor] = await Promise.all(['aprendiz', 'cme'].map((l) => trx.selectFrom('app_user').select('id').where('login', '=', login(l)).executeTakeFirstOrThrow()));
    await trx.updateTable('app_user').set({ supervisor_id: supervisor!.id }).where('id', '=', apprentice!.id).execute();

    const refIds = new Map<string, string>();
    for (const r of DEMO_REFERENCES) {
      const row = await trx
        .insertInto('clinical_reference')
        .values({ institution_id: institutionId, code: r.id, title: r.title, kind: r.kind, source: r.source, doc_version: r.version, updated_on: r.updatedAt, status: r.status, notes: r.notes ?? null, validated_by: null, validated_by_name: null, validated_at: null, updated_at: now })
        .returning('id')
        .executeTakeFirstOrThrow();
      refIds.set(r.id, row.id);
    }
    const ref = (code: string | null) => (code ? (refIds.get(code) ?? null) : null);

    for (const p of parametersFromRules(DEMO_CONFIG.rules)) {
      await trx.insertInto('rule_parameter').values({ institution_id: institutionId, key: p.key, value: JSON.stringify(p.value), reference_id: ref(p.referenceId), approved_by: null, approved_by_name: null, updated_at: now }).execute();
    }
    for (const t of DEMO_CONFIG.targets) {
      await trx
        .insertInto('indicator_target')
        .values({ institution_id: institutionId, indicator_id: t.indicatorId, value: t.value, direction: t.direction, warning_band: t.warningBand ?? null, origin: 'demonstracao', approved_by: null, approved_by_name: null, valid_from: t.validFrom, reference_id: ref(t.referenceId), updated_at: now })
        .execute();
    }
    await trx
      .insertInto('load_release_policy')
      .values({ institution_id: institutionId, required_tests: DEMO_LOAD_POLICY.requiredLoadTests, require_daily_bowie_dick: DEMO_LOAD_POLICY.requireDailyBowieDick, hold_implants_until_biological: DEMO_LOAD_POLICY.holdImplantsUntilBiological, reference_id: ref(DEMO_LOAD_POLICY.referenceId), updated_at: now })
      .execute();

    const anchor = addMonths(monthStart(todayIn(DEMO_CONFIG.timezone, now)), -1);
    const facts = generateFacts(addMonths(anchor, -23), anchor, anchor).flatMap((row) =>
      Object.entries(row.counts).map(([metric, value]) => ({ institution_id: institutionId, period: row.period, sector_id: sectorIds.get(row.sectorId)!, metric, value: value!, data_origin: 'demo' as const, consolidated_at: now })),
    );
    for (let i = 0; i < facts.length; i += 1000) await trx.insertInto('indicator_fact').values(facts.slice(i, i + 1000)).execute();

    // Synthetic clinical records for the last two closed months and the current one; the closed
    // months' clinical metrics are then consolidated from those records (same path as production).
    const clinicalFrom = addMonths(anchor, -1);
    const clinical = await seedClinical(trx, { institutionId, sectorIds, refIds, from: clinicalFrom, now, timezone: DEMO_CONFIG.timezone });
    const operations = await seedOperations(trx, { institutionId, sectorIds, from: clinicalFrom, now, timezone: DEMO_CONFIG.timezone });
    const cme = await seedCme(trx, { institutionId, sectorIds, from: clinicalFrom, now, timezone: DEMO_CONFIG.timezone, shelfLifeDays: DEMO_CONFIG.rules.cme.shelfLifeDays?.value });
    await consolidateMonths(trx, institutionId, [clinicalFrom, anchor], now);

    await audit(trx, { institutionId, userId: null, login: 'seed', ip: null, userAgent: null }, { action: 'seed', entity: 'institution', entityId: institutionId, context: { origin: 'demo', users: DEMO_USERS.length, facts: facts.length, ...clinical, ...operations, ...cme } });
    return { institutionId, credentials, facts: facts.length, clinical };
  });
}
