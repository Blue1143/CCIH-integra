import type { ColumnType, Generated } from 'kysely';

/** Kysely table types. Dates (`date`) are kept as 'YYYY-MM-DD' strings; timestamps as Date. */
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string, string>;
type NullableJson = ColumnType<unknown | null, string | null | undefined, string | null>;
type RowVersion = ColumnType<number, number | undefined, number>;

export type DataOriginColumn = 'real' | 'demo';

export interface InstitutionTable {
  id: Generated<string>;
  name: string;
  cnes: string | null;
  timezone: string;
  data_origin: DataOriginColumn;
  created_at: CreatedAt;
}

export interface UnitTable {
  id: Generated<string>;
  institution_id: string;
  name: string;
  active: Generated<boolean>;
  row_version: RowVersion;
}

export interface SectorTable {
  id: Generated<string>;
  institution_id: string;
  unit_id: string;
  code: string;
  name: string;
  kind: 'uti' | 'internacao' | 'centro_cirurgico' | 'cme' | 'apoio';
  active: Generated<boolean>;
  row_version: RowVersion;
}

export interface BedTable {
  id: Generated<string>;
  sector_id: string;
  code: string;
  active: Generated<boolean>;
}

export interface JobRoleTable {
  id: Generated<string>;
  institution_id: string;
  name: string;
}

export interface ProfessionalTable {
  id: Generated<string>;
  institution_id: string;
  name: string;
  registration: string | null;
  job_role_id: string | null;
  active: Generated<boolean>;
  sector_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface RoleTable {
  institution_id: string;
  code: string;
  name: string;
  permissions: string[];
}

export interface AppUserTable {
  id: Generated<string>;
  institution_id: string;
  professional_id: string | null;
  login: string;
  display_name: string;
  password_hash: string;
  active: Generated<boolean>;
  scope_all: Generated<boolean>;
  failed_attempts: Generated<number>;
  locked_until: NullableTimestamp;
  last_login_at: NullableTimestamp;
  password_changed_at: Timestamp;
  must_change_password: Generated<boolean>;
  created_at: CreatedAt;
  row_version: RowVersion;
}

export interface UserRoleTable {
  user_id: string;
  institution_id: string;
  role_code: string;
}

export interface UserScopeTable {
  user_id: string;
  sector_id: string;
}

export interface SessionTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  csrf_hash: string;
  created_at: CreatedAt;
  last_seen_at: Timestamp;
  expires_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
  revoked_at: NullableTimestamp;
  revoked_reason: string | null;
}

export interface AuditLogTable {
  id: Generated<string>;
  occurred_at: Timestamp;
  institution_id: string | null;
  user_id: string | null;
  user_login: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: NullableJson;
  after: NullableJson;
  ip: string | null;
  user_agent: string | null;
  context: NullableJson;
  prev_hash: string;
  hash: string;
}

export interface ClinicalReferenceTable {
  id: Generated<string>;
  institution_id: string;
  code: string;
  title: string;
  kind: 'regulatoria' | 'diretriz' | 'protocolo_institucional' | 'literatura';
  source: string;
  doc_version: string;
  updated_on: string;
  validated_by: string | null;
  validated_by_name: string | null;
  validated_at: NullableTimestamp;
  status: 'vigente' | 'revisao_necessaria' | 'arquivado';
  notes: string | null;
  updated_at: Timestamp;
  row_version: RowVersion;
}

export interface RuleParameterTable {
  institution_id: string;
  key: string;
  value: Json;
  reference_id: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  updated_at: Timestamp;
  row_version: RowVersion;
}

export interface IndicatorTargetTable {
  institution_id: string;
  indicator_id: string;
  value: number;
  direction: 'lower' | 'higher';
  warning_band: number | null;
  origin: 'institucional' | 'demonstracao';
  approved_by: string | null;
  approved_by_name: string | null;
  valid_from: string;
  reference_id: string | null;
  updated_at: Timestamp;
  row_version: RowVersion;
}

export interface LoadReleasePolicyTable {
  institution_id: string;
  required_tests: string[];
  require_daily_bowie_dick: boolean;
  hold_implants_until_biological: boolean;
  reference_id: string | null;
  updated_at: Timestamp;
  row_version: RowVersion;
}

export interface IndicatorFactTable {
  institution_id: string;
  period: string;
  sector_id: string;
  metric: string;
  value: number;
  data_origin: DataOriginColumn;
  consolidated_at: Timestamp;
}

type Origin = DataOriginColumn;

export interface PatientTable {
  id: string;
  institution_id: string;
  record_number: string;
  initials: string;
  full_name_enc: string | null;
  birth_date: string | null;
  sex: 'F' | 'M' | 'NI';
  data_origin: Origin;
  created_at: CreatedAt;
  updated_at: Timestamp;
  row_version: RowVersion;
}

export interface AdmissionTable {
  id: Generated<string>;
  institution_id: string;
  patient_id: string;
  admitted_at: Timestamp;
  discharged_at: NullableTimestamp;
  outcome: 'alta' | 'obito' | 'transferencia_externa' | null;
  diagnosis: string | null;
  data_origin: Origin;
  created_by: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  row_version: RowVersion;
}

export interface AdmissionMovementTable {
  id: Generated<string>;
  admission_id: string;
  sector_id: string;
  bed_id: string | null;
  start_at: Timestamp;
  end_at: NullableTimestamp;
  reason: string | null;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface DeviceUseTable {
  id: Generated<string>;
  institution_id: string;
  admission_id: string;
  device_type: 'CVC' | 'PICC' | 'VM' | 'SVD' | 'PAI' | 'DRENO' | 'OUTRO';
  site: string | null;
  indication: string | null;
  inserted_at: Timestamp;
  removed_at: NullableTimestamp;
  removal_reason: string | null;
  data_origin: Origin;
  created_by: string | null;
  created_at: CreatedAt;
  row_version: RowVersion;
}

export interface ProcedureCatalogTable {
  id: Generated<string>;
  institution_id: string;
  code: string;
  name: string;
  specialty: string;
  p75_minutes: number | null;
  p75_source: string | null;
  active: Generated<boolean>;
}

export interface SurgeryTable {
  id: Generated<string>;
  institution_id: string;
  admission_id: string;
  procedure_id: string;
  surgeon_id: string;
  sector_id: string;
  room: string | null;
  started_at: Timestamp;
  ended_at: NullableTimestamp;
  wound_class: 'limpa' | 'potencialmente_contaminada' | 'contaminada' | 'infectada' | null;
  asa: number | null;
  implant: boolean;
  urgency: boolean;
  prophylaxis_indicated: boolean | null;
  prophylaxis_drug: string | null;
  prophylaxis_dose_at: NullableTimestamp;
  /** numeric: pg returns a string. */
  prophylaxis_duration_h: ColumnType<string | null, number | null, number | null>;
  redose: boolean | null;
  notes: string | null;
  data_origin: Origin;
  created_by: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  row_version: RowVersion;
}

export interface CultureTable {
  id: Generated<string>;
  institution_id: string;
  admission_id: string;
  sector_id: string;
  material: string;
  collected_at: Timestamp;
  origin: 'manual' | 'lis';
  data_origin: Origin;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface CultureResultTable {
  id: Generated<string>;
  culture_id: string;
  version: number;
  outcome: 'negativa' | 'positiva' | 'contaminada';
  reported_at: Timestamp;
  breakpoint_version: string | null;
  notes: string | null;
  justification: string | null;
  recorded_by: string | null;
  recorded_by_name: string;
  created_at: CreatedAt;
}

export interface IsolateTable {
  id: Generated<string>;
  result_id: string;
  organism: string;
  quantity: string | null;
  resistance_profile: 'MDR' | 'XDR' | 'PDR' | null;
  mechanism: string | null;
}

export interface SusceptibilityTable {
  id: Generated<string>;
  isolate_id: string;
  antimicrobial: string;
  mic: string | null;
  interpretation: 'S' | 'I' | 'R';
}

export interface IrasCaseTable {
  id: Generated<string>;
  institution_id: string;
  admission_id: string;
  iras_type: 'IPCS' | 'PAV' | 'ITU-AC' | 'ISC' | 'OUTRA';
  status: 'suspeita' | 'em_investigacao' | 'confirmada' | 'descartada';
  event_date: string;
  sector_id: string;
  device_associated: boolean | null;
  device_use_id: string | null;
  surgery_id: string | null;
  criterion_reference_id: string | null;
  criterion_snapshot: NullableJson;
  description: string | null;
  data_origin: Origin;
  created_by: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  row_version: RowVersion;
}

export interface IrasCaseStatusTable {
  id: Generated<string>;
  case_id: string;
  from_status: string | null;
  to_status: string;
  justification: string;
  decided_by: string | null;
  decided_by_name: string;
  at: Timestamp;
}

export interface IrasCaseCultureTable {
  case_id: string;
  culture_id: string;
}

export interface CcihNoteTable {
  id: Generated<string>;
  institution_id: string;
  patient_id: string;
  admission_id: string | null;
  case_id: string | null;
  kind: 'avaliacao' | 'conduta' | 'recomendacao' | 'acompanhamento' | 'retificacao';
  body: string;
  amends_id: string | null;
  justification: string | null;
  author_id: string | null;
  author_name: string;
  data_origin: Origin;
  created_at: CreatedAt;
}

type Voidable = { voided_at: NullableTimestamp; voided_by_name: string | null; void_reason: string | null };

export interface BundleTemplateTable {
  id: Generated<string>; institution_id: string; code: string; name: string; metric: 'cvc' | 'vm' | 'svd' | null;
  method: 'tudo_ou_nada' | 'por_item'; reference_id: string | null; active: Generated<boolean>; updated_at: Timestamp; row_version: RowVersion;
}
export interface BundleItemTable { id: Generated<string>; template_id: string; position: number; label: string; active: Generated<boolean> }
export interface BundleAuditTable extends Voidable {
  id: Generated<string>; institution_id: string; template_id: string; sector_id: string; admission_id: string | null; audited_at: Timestamp;
  method: string; result: 'conforme' | 'nao_conforme'; notes: string | null; auditor_id: string | null; auditor_name: string; data_origin: Origin; created_at: CreatedAt;
}
export interface BundleAuditAnswerTable { audit_id: string; item_id: string; item_label: string; answer: 'conforme' | 'nao_conforme' | 'nao_aplicavel' }
export interface HandHygieneObservationTable extends Voidable {
  id: Generated<string>; institution_id: string; sector_id: string; observed_at: Timestamp; category: 'enfermagem' | 'medica' | 'fisioterapia' | 'apoio' | 'outros';
  opportunities: number; actions: number; observer_id: string | null; observer_name: string; data_origin: Origin; created_at: CreatedAt;
}
export interface QualityAuditTable {
  id: Generated<string>; institution_id: string; title: string; kind: 'processo' | 'estrutura' | 'documental' | 'outro'; sector_id: string | null; scope: string | null;
  planned_for: string; status: 'planejada' | 'em_andamento' | 'concluida' | 'plano_de_acao' | 'verificacao_eficacia' | 'encerrada' | 'cancelada';
  findings: string | null; data_origin: Origin; created_by: string | null; created_at: CreatedAt; updated_at: Timestamp; row_version: RowVersion;
}
export interface StatusHistoryRow { id: Generated<string>; from_status: string | null; to_status: string; justification: string; decided_by: string | null; decided_by_name: string; at: Timestamp }
export interface QualityAuditStatusTable extends StatusHistoryRow { audit_id: string }
export interface NonconformityTable {
  id: Generated<string>; institution_id: string; audit_id: string | null; sector_id: string | null; origin: 'auditoria' | 'bundle' | 'higiene_maos' | 'cme' | 'notificacao' | 'outro';
  severity: 'baixa' | 'media' | 'alta'; description: string; detected_on: string; status: 'aberta' | 'em_tratamento' | 'aguardando_eficacia' | 'encerrada' | 'cancelada';
  effectiveness: string | null; data_origin: Origin; created_by: string | null; created_at: CreatedAt; updated_at: Timestamp; row_version: RowVersion;
  notified_user_id: Generated<string | null>; notified_user_name: Generated<string | null>; source_entity: Generated<string | null>; source_id: Generated<string | null>;
}
export interface NonconformityStatusTable extends StatusHistoryRow { nonconformity_id: string }
export interface ActionPlanTable {
  id: Generated<string>; nonconformity_id: string; what: string; why: string; where_text: string; who_name: string; due_on: string; how: string; how_much: string | null;
  status: 'pendente' | 'em_andamento' | 'concluida' | 'cancelada'; completed_on: string | null; created_at: CreatedAt; updated_at: Timestamp; row_version: RowVersion;
}
export interface AlertTable {
  id: Generated<string>; institution_id: string; kind: string; dedup_key: string; priority: 'critica' | 'alta' | 'media' | 'baixa';
  status: 'aberto' | 'reconhecido' | 'assumido' | 'resolvido' | 'encerrado';
  title: string; detail: string; entity: string; entity_id: string | null; sector_id: string | null; link: string | null; created_at: CreatedAt; last_seen_at: Timestamp;
  assigned_to: string | null; assigned_name: string | null; assigned_at: NullableTimestamp; closed_at: NullableTimestamp; closed_by_name: string | null; resolution: string | null; row_version: RowVersion;
  category: 'erro_operacional' | 'violacao_sequencia' | 'pendencia_tempo' | 'falha_integracao' | 'informacao_obrigatoria' | 'nao_conformidade' | 'seguranca';
  blocking: Generated<boolean>; step: string | null; due_on: string | null; unit_id: string | null;
  acknowledged_at: NullableTimestamp; acknowledged_by: string | null; acknowledged_name: string | null;
  resolved_at: NullableTimestamp; resolved_by: string | null; resolved_name: string | null; resolved_note: string | null;
  closed_reason: 'manual' | 'automatico' | 'excecao' | null;
}
export type RealtimeTopic = 'clinico' | 'cme' | 'qualidade' | 'alertas' | 'notificacoes' | 'config';
export interface EventOutboxTable {
  /** bigserial: pg returns a string. */
  id: Generated<string>; institution_id: string; topic: RealtimeTopic; permission: string | null; sector_id: string | null; user_id: string | null; created_at: CreatedAt;
}
export interface AlertActionTable {
  id: Generated<string>; alert_id: string;
  action: 'criado' | 'visualizado' | 'reconhecido' | 'assumido' | 'comentado' | 'resolvido' | 'encerrado' | 'encerrado_automatico' | 'excecao';
  user_id: string | null; user_name: string; note: string | null; at: CreatedAt;
}
export interface TrainingTable {
  id: Generated<string>; institution_id: string; title: string; theme: string; mandatory: boolean; validity_months: number | null; target_job_role_ids: string[];
  description: string | null; active: Generated<boolean>; updated_at: Timestamp; row_version: RowVersion;
}
export interface TrainingSessionTable {
  id: Generated<string>; training_id: string; held_on: string; instructor: string; hours: ColumnType<string, number, number>; sector_id: string | null; notes: string | null;
  data_origin: Origin; created_by: string | null; created_at: CreatedAt;
}
export interface TrainingAttendanceTable { session_id: string; professional_id: string; present: boolean; score: ColumnType<string | null, number | null, number | null> }
export interface SupplyTable {
  id: Generated<string>; institution_id: string; code: string; name: string; category: 'preparacao_alcoolica' | 'sabonete' | 'epi' | 'antisseptico' | 'saneante' | 'outro';
  unit: string; min_coverage_days: number | null; active: Generated<boolean>; updated_at: Timestamp; row_version: RowVersion;
}
export interface SupplyLotTable { id: Generated<string>; supply_id: string; lot: string; expires_on: string | null; created_at: CreatedAt }
export interface SupplyMovementTable {
  id: Generated<string>; lot_id: string; kind: 'entrada' | 'consumo' | 'ajuste' | 'descarte'; delta: ColumnType<string, number, number>; sector_id: string | null; occurred_at: Timestamp;
  reason: string | null; created_by: string | null; created_by_name: string; data_origin: Origin; created_at: CreatedAt;
}
export interface SsiFollowupTable {
  id: Generated<string>; surgery_id: string; contacted_on: string; method: 'telefone' | 'ambulatorio' | 'retorno' | 'mensagem' | 'outro';
  outcome: 'sem_sinais' | 'suspeita' | 'nao_localizado'; notes: string | null; case_id: string | null; recorded_by: string | null; recorded_by_name: string; created_at: CreatedAt;
}

type LoadStatusCol = 'aguardando' | 'liberada' | 'retida' | 'rejeitada' | 'reprocessamento';
type PackagingCol = 'papel_grau_cirurgico' | 'sms' | 'container_rigido' | 'tecido_algodao' | 'outro';

export interface SterilizerTable {
  id: Generated<string>; institution_id: string; sector_id: string; code: string; name: string;
  type: 'vapor_prevacuo' | 'vapor_gravitacional' | 'peroxido_plasma' | 'oxido_etileno' | 'outro'; serial: string | null;
  status: ColumnType<'ativo' | 'manutencao' | 'inativo', 'ativo' | 'manutencao' | 'inativo' | undefined, 'ativo' | 'manutencao' | 'inativo'>;
  status_reason: string | null; qualification_due_on: string | null; updated_at: Generated<Date>; row_version: Generated<number>;
}

export interface InstrumentSetTable {
  id: Generated<string>; institution_id: string; code: string; name: string; specialty: string | null; composition: string | null; item_count: number | null;
  packaging: PackagingCol; implant: Generated<boolean>; active: Generated<boolean>; updated_at: Generated<Date>; row_version: Generated<number>;
}

export interface SterilizationLoadTable {
  id: Generated<string>; institution_id: string; sterilizer_id: string; code: string; program: string; started_at: NullableTimestamp; ended_at: NullableTimestamp;
  operator_id: string | null; operator_name: string;
  /** numeric: pg returns a string. */
  temperature_c: ColumnType<string | null, number | null | undefined, number | null>;
  pressure_kpa: ColumnType<string | null, number | null | undefined, number | null>;
  exposure_minutes: number | null; physical_result: 'conforme' | 'nao_conforme' | null; notes: string | null;
  status: ColumnType<LoadStatusCol, LoadStatusCol | undefined, LoadStatusCol>; has_implant: Generated<boolean>; reprocessed_from_id: string | null;
  data_origin: 'real' | 'demo'; created_at: CreatedAt; updated_at: Generated<Date>; row_version: Generated<number>;
}

export interface LoadItemTable {
  id: Generated<string>; institution_id: string; load_id: string; position: number; label_code: string; set_id: string | null; description: string;
  quantity: Generated<number>; packaging: PackagingCol; implant: Generated<boolean>; expires_on: string | null; process_id: string | null;
}

export interface SterilizationTestTable {
  id: Generated<string>; institution_id: string; sterilizer_id: string; load_id: string | null;
  type: 'BOWIE_DICK' | 'IQ1' | 'IQ2' | 'IQ3' | 'IQ4' | 'IQ5' | 'IQ6' | 'IB'; result: 'aprovado' | 'reprovado' | 'pendente';
  performed_at: Timestamp; performed_on: string; indicator_lot: string; indicator_expiry: string; incubation_start: NullableTimestamp; read_at: NullableTimestamp;
  control_result: 'positivo' | 'negativo' | null; notes: string | null; recorded_by: string | null; recorded_by_name: string; replaces_id: string | null;
  justification: string | null; data_origin: 'real' | 'demo'; created_at: CreatedAt;
}

export interface LoadReleaseDecisionTable {
  id: Generated<string>; load_id: string; from_status: LoadStatusCol | null; to_status: LoadStatusCol; decided_at: CreatedAt;
  decided_by: string | null; decided_by_name: string; justification: string; policy_snapshot: ColumnType<unknown, string | null, never>; evaluation: ColumnType<unknown, string, never>;
}

export interface MaterialUseTable {
  id: Generated<string>; institution_id: string; item_id: string; surgery_id: string | null; sector_id: string; used_at: Timestamp;
  recorded_by: string | null; recorded_by_name: string; data_origin: 'real' | 'demo'; created_at: CreatedAt;
  voided_at: NullableTimestamp; voided_by_name: string | null; void_reason: string | null;
}

export interface AttachmentTable {
  id: Generated<string>; institution_id: string; entity: 'sterilization_test' | 'training_session'; entity_id: string; file_name: string;
  mime: 'application/pdf' | 'image/png' | 'image/jpeg'; size_bytes: number; sha256: string; storage_key: string; uploaded_by: string | null;
  uploaded_by_name: string; created_at: CreatedAt;
}

type ProcessStepCol = 'recepcao' | 'limpeza' | 'inspecao' | 'preparo' | 'embalagem' | 'esterilizacao' | 'liberacao' | 'armazenamento' | 'separacao' | 'distribuicao' | 'devolucao';
type ProcessStateCol = 'em_processo' | 'bloqueado' | 'liberado' | 'distribuido' | 'devolvido' | 'encerrado' | 'descartado';
type ScanResultCol = 'aceita' | 'codigo_desconhecido' | 'etapa_incorreta' | 'duplicada' | 'bloqueado' | 'carga_nao_liberada' | 'destino_incompativel' | 'requer_conferencia' | 'estacao_invalida' | 'excecao_autorizada';
type InputMethodCol = 'leitor' | 'camera' | 'manual';

export interface CmeFlowConfigTable {
  institution_id: string; storage_required: Generated<boolean>; separation_required: Generated<boolean>; updated_at: Generated<Date>; row_version: Generated<number>;
}

export interface UserNotificationTable {
  id: Generated<string>; institution_id: string; user_id: string; kind: 'nao_conformidade'; title: string; detail: string; entity: string; entity_id: string;
  link: string | null; data_origin: Origin; created_at: CreatedAt; read_at: Date | null;
}

export interface InstrumentAssetTable {
  id: Generated<string>; institution_id: string; set_id: string; code: string; tag: string | null;
  status: ColumnType<'ativo' | 'manutencao' | 'baixado', 'ativo' | 'manutencao' | 'baixado' | undefined, 'ativo' | 'manutencao' | 'baixado'>;
  status_reason: string | null; data_origin: 'real' | 'demo'; created_at: CreatedAt; updated_at: Generated<Date>; row_version: Generated<number>;
}

export interface ScanStationTable {
  id: Generated<string>; institution_id: string; sector_id: string; name: string; location: string | null; steps: ProcessStepCol[];
  input_methods: InputMethodCol[]; symbologies: string[]; device_label: string | null; responsible_user_id: string | null; require_pairing: Generated<boolean>;
  scan_config: ColumnType<unknown, string | undefined, string>; enabled: Generated<boolean>; last_seen_at: NullableTimestamp;
  created_at: CreatedAt; updated_at: Generated<Date>; row_version: Generated<number>;
}

export interface StationDeviceTable {
  id: Generated<string>; station_id: string; token_hash: string; label: string; paired_by: string | null; paired_by_name: string; paired_at: CreatedAt;
  revoked_at: NullableTimestamp; revoked_by_name: string | null; last_seen_at: NullableTimestamp;
}

export interface CmeProcessTable {
  id: Generated<string>; institution_id: string; asset_id: string | null; code: string | null; set_id: string | null; description: string;
  current_step: ProcessStepCol; state: ProcessStateCol; next_steps: ColumnType<ProcessStepCol[], ProcessStepCol[] | undefined, ProcessStepCol[]>;
  load_item_id: string | null; destination_sector_id: string | null; legacy: Generated<boolean>; previous_process_id: string | null;
  opened_at: CreatedAt; closed_at: NullableTimestamp; data_origin: 'real' | 'demo'; updated_at: Generated<Date>; row_version: Generated<number>;
}

export interface CmeScanEventTable {
  id: Generated<string>; institution_id: string; station_id: string | null; device_id: string | null; client_event_id: string | null; raw_code: string;
  code_kind: string; symbology: string | null; input_method: InputMethodCol; process_id: string | null; asset_id: string | null;
  load_item_id: string | null; load_id: string | null; step: ProcessStepCol; operation: string; outcome: string | null; details: ColumnType<unknown, string | null, never>;
  result: ScanResultCol; message: string; user_id: string | null; user_name: string; server_at: CreatedAt; device_at: NullableTimestamp;
  origin_sector_id: string | null; destination_sector_id: string | null; justification: string | null; previous_event_id: string | null; data_origin: 'real' | 'demo';
}

export interface DB {
  institution: InstitutionTable;
  unit: UnitTable;
  sector: SectorTable;
  bed: BedTable;
  job_role: JobRoleTable;
  professional: ProfessionalTable;
  role: RoleTable;
  app_user: AppUserTable;
  user_role: UserRoleTable;
  user_scope: UserScopeTable;
  session: SessionTable;
  audit_log: AuditLogTable;
  clinical_reference: ClinicalReferenceTable;
  rule_parameter: RuleParameterTable;
  indicator_target: IndicatorTargetTable;
  load_release_policy: LoadReleasePolicyTable;
  indicator_fact: IndicatorFactTable;
  patient: PatientTable;
  admission: AdmissionTable;
  admission_movement: AdmissionMovementTable;
  device_use: DeviceUseTable;
  procedure_catalog: ProcedureCatalogTable;
  surgery: SurgeryTable;
  culture: CultureTable;
  culture_result: CultureResultTable;
  isolate: IsolateTable;
  susceptibility: SusceptibilityTable;
  iras_case: IrasCaseTable;
  iras_case_status: IrasCaseStatusTable;
  iras_case_culture: IrasCaseCultureTable;
  ccih_note: CcihNoteTable;
  bundle_template: BundleTemplateTable;
  bundle_item: BundleItemTable;
  bundle_audit: BundleAuditTable;
  bundle_audit_answer: BundleAuditAnswerTable;
  hand_hygiene_observation: HandHygieneObservationTable;
  quality_audit: QualityAuditTable;
  quality_audit_status: QualityAuditStatusTable;
  nonconformity: NonconformityTable;
  nonconformity_status: NonconformityStatusTable;
  action_plan: ActionPlanTable;
  alert: AlertTable;
  alert_action: AlertActionTable;
  event_outbox: EventOutboxTable;
  training: TrainingTable;
  training_session: TrainingSessionTable;
  training_attendance: TrainingAttendanceTable;
  supply: SupplyTable;
  supply_lot: SupplyLotTable;
  supply_movement: SupplyMovementTable;
  ssi_followup: SsiFollowupTable;
  sterilizer: SterilizerTable;
  instrument_set: InstrumentSetTable;
  sterilization_load: SterilizationLoadTable;
  load_item: LoadItemTable;
  sterilization_test: SterilizationTestTable;
  load_release_decision: LoadReleaseDecisionTable;
  material_use: MaterialUseTable;
  attachment: AttachmentTable;
  cme_flow_config: CmeFlowConfigTable;
  user_notification: UserNotificationTable;
  instrument_asset: InstrumentAssetTable;
  scan_station: ScanStationTable;
  station_device: StationDeviceTable;
  cme_process: CmeProcessTable;
  cme_scan_event: CmeScanEventTable;
}
