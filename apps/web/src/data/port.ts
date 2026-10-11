import type {
  CensusMonthPayload, CensusPayload, CultureDetail, CultureSummary, DataOrigin, FactRow, InstitutionData, InvestigationStatus, IrasCaseDetail, IrasCaseSummary,
  MetricKey, OrgPayload, Paged, PatientDetail, PatientSummary, Permission, Procedure, Professional, SterilizationTestType, SurgeryDetail, SurgerySummary, WithProvenance,
  AlertDetail, AlertDto, AlertSummary, BundleAuditDto, BundleSummary, BundleTemplateDto, HandHygieneDto, HandHygieneSummaryRow, NonconformityDetail, NonconformityDto,
  QualityAuditDetail, QualityAuditDto, StaffMember, SupplyDto, SupplyMovementDto, SurveillanceRow, TrainingCoveragePayload, TrainingDto, TrainingSessionDto,
  AttachmentDto, CmeOverview, CmeTestDto, EquipmentStatus, IbControl, InstrumentSetDto, LoadDetail, LoadStatus, LoadSummary, PackagingType, RecordedTestType,
  SterilizerDto, SterilizerType, TestResult, TraceResult,
  LabelEntity, LabelLayoutDto, LabelLayoutInput, LabelOutput, LabelPrintDto, LabelPrintKind, PrintedLabel,
  AssetDto, CmeSectorDto, UseRecorded, UserNotificationDto, RoleCode, UserAccessInput, UserAccountDto, UserHistoryEntry, FlowConfigDto, InputMethod, ProcessDetail, ProcessStep, ProcessSummaryDto, ScanConfig, ScanEventDto, ScanResponse, StationDto, Symbology,
} from '@ccih/domain';

export type { InstitutionData, Sector, SectorKind, Unit } from '@ccih/domain';

/**
 * The only contract the UI knows. The demo source and the HTTP API source implement it;
 * screens never import mock data directly. `auth` and `admin` exist only with a backend.
 */
export interface FactsQuery {
  /** Inclusive month starts (YYYY-MM-01). */
  from: string;
  to: string;
}

export interface SessionInfo {
  user: { id: string; login: string; displayName: string };
  roles: string[];
  permissions: Permission[];
  /** null = every sector of the institution. */
  scope: string[] | null;
  session: { expiresAt: string; idleExpiresAt: string; idleMinutes: number };
  /** Temporary or expired password: the app only allows the password change. */
  mustChangePassword?: boolean;
  /** The creator account (the only one that creates system administrators). */
  isFounder?: boolean;
}

export interface AuthPort {
  /** null when nobody is signed in. */
  me(): Promise<SessionInfo | null>;
  login(login: string, password: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
}

export interface ConfigVersions {
  targets: Array<{ indicator_id: string; row_version: number; approved_by_name: string | null; updated_at: string }>;
  rules: Array<{ key: string; row_version: number; approved_by_name: string | null; updated_at: string }>;
  references: Array<{ id: string; code: string; row_version: number }>;
  policy: { row_version: number; updated_at: string } | null;
}

export interface Justified {
  justification: string;
}

export interface TargetInput extends Justified {
  value: number;
  warningBand: number | null;
  referenceId: string | null;
  rowVersion: number | null;
}

export interface RuleInput extends Justified {
  value: unknown;
  referenceId: string | null;
  /** null when the parameter has never been configured. */
  rowVersion: number | null;
}

export interface ReferenceInput extends Justified {
  title: string;
  kind: 'regulatoria' | 'diretriz' | 'protocolo_institucional' | 'literatura';
  source: string;
  version: string;
  updatedAt: string;
  notes: string | null;
}

export interface PolicyInput extends Justified {
  requiredLoadTests: SterilizationTestType[];
  requireDailyBowieDick: boolean;
  holdImplantsUntilBiological: boolean;
  referenceId: string | null;
  rowVersion: number;
}

/** Account management (functions, scope, individual grants) — shapes shared with the API. */
export type { UserAccountDto as AdminUser, UserAccessInput, UserHistoryEntry } from '@ccih/domain';

export interface UsersMeta {
  assignableRoles: RoleCode[];
  modules: Array<'ccih' | 'cme'> | 'all' | null;
  supervisors: Array<{ id: string; name: string }>;
}

export interface AuditRow {
  id: string;
  occurred_at: string;
  user_login: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  context: Record<string, unknown> | null;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminPort {
  versions(): Promise<ConfigVersions>;
  saveTarget(indicatorId: string, input: TargetInput): Promise<void>;
  deleteTarget(indicatorId: string, justification: string): Promise<void>;
  saveRule(key: string, input: RuleInput): Promise<void>;
  createReference(input: ReferenceInput & { code: string }): Promise<void>;
  updateReference(id: string, input: ReferenceInput & { rowVersion: number }): Promise<void>;
  validateReference(id: string, input: Justified & { status: 'vigente' | 'revisao_necessaria' | 'arquivado'; rowVersion: number }): Promise<void>;
  savePolicy(input: PolicyInput): Promise<void>;
  users(q?: Query): Promise<{ users: UserAccountDto[] }>;
  usersMeta(): Promise<UsersMeta>;
  userHistory(id: string): Promise<{ entries: UserHistoryEntry[] }>;
  roles(): Promise<{ roles: Array<{ code: string; name: string; permissions: string[]; module: string }>; permissions: Record<string, string> }>;
  updateUser(id: string, input: UserAccessInput & { rowVersion: number }): Promise<void>;
  unlockUser(id: string): Promise<void>;
  audit(query: { entity?: string; action?: string; page: number; pageSize: number }): Promise<AuditPage>;
  verifyAudit(): Promise<{ ok: boolean; checked: number; brokenAtId: string | null }>;
  logExport(event: { resource: string; rows: number; filters?: Record<string, string> }): Promise<void>;
  createUser(input: UserAccessInput & { login: string }): Promise<{ id: string; temporaryPassword: string }>;
  resetPassword(id: string, justification: string): Promise<{ temporaryPassword: string }>;
}

/* ---------- Clinical (Phase 3) ---------- */

export type Query = Record<string, string | number | undefined>;

export interface AdmissionInput { admittedAt: string; sectorId: string; bedId: string | null; diagnosis: string | null }
export interface PatientInput { recordNumber: string; initials: string; fullName: string | null; birthDate: string | null; sex: 'F' | 'M' | 'NI'; admission: AdmissionInput | null }
export interface PatientUpdateInput extends Justified { initials: string; birthDate: string | null; sex: 'F' | 'M' | 'NI'; fullName?: string | null; rowVersion: number }
export interface CaseLinks { deviceUseId: string | null; surgeryId: string | null; cultureIds: string[] }
export interface CaseInput extends CaseLinks, Justified { admissionId: string; type: IrasCaseSummary['type']; eventDate: string; sectorId: string; description: string | null }
export interface CaseUpdateInput extends CaseLinks, Justified { type: IrasCaseSummary['type']; eventDate: string; sectorId: string; description: string | null; rowVersion: number }
export interface CaseStatusInput extends Justified { to: InvestigationStatus; criterionReferenceId: string | null; deviceAssociated: boolean | null; rowVersion: number }
export interface SurgeryInput {
  procedureId: string; surgeonId: string; sectorId: string; room: string | null; startedAt: string; endedAt: string | null;
  woundClass: SurgerySummary['woundClass']; asa: number | null; implant: boolean; urgency: boolean; prophylaxisIndicated: boolean | null;
  prophylaxisDrug: string | null; prophylaxisDoseAt: string | null; prophylaxisDurationH: number | null; redose: boolean | null; notes: string | null;
}
export interface IsolateInput {
  organism: string; quantity: string | null; resistanceProfile: 'MDR' | 'XDR' | 'PDR' | null; mechanism: string | null;
  susceptibility: Array<{ antimicrobial: string; mic: string | null; interpretation: 'S' | 'I' | 'R' }>;
}
export interface CultureResultInput { outcome: 'negativa' | 'positiva' | 'contaminada'; reportedAt: string; breakpointVersion: string | null; notes: string | null; isolates: IsolateInput[]; justification: string | null }
export interface ConsolidationSummary { months: string[]; rows: number; metrics: MetricKey[]; skipped: string[]; origin: DataOrigin; partialMonth: boolean }
export interface RevealResult { fullName: string | null; available: boolean; reason: string | null }

export interface ClinicalPort {
  org(): Promise<OrgPayload>;
  patients(q: Query): Promise<Paged<PatientSummary>>;
  patient(id: string): Promise<PatientDetail>;
  createPatient(input: PatientInput): Promise<{ id: string }>;
  updatePatient(id: string, input: PatientUpdateInput): Promise<void>;
  revealName(id: string, reason: string): Promise<RevealResult>;
  admit(patientId: string, input: AdmissionInput): Promise<{ id: string }>;
  transfer(admissionId: string, input: { at: string; sectorId: string; bedId: string | null; reason: string | null; rowVersion: number }): Promise<void>;
  discharge(admissionId: string, input: { at: string; outcome: 'alta' | 'obito' | 'transferencia_externa'; rowVersion: number }): Promise<{ devicesClosed: number }>;
  addDevice(admissionId: string, input: { type: string; site: string | null; indication: string | null; insertedAt: string }): Promise<void>;
  removeDevice(deviceId: string, input: { removedAt: string; reason: string; rowVersion: number }): Promise<void>;
  addNote(patientId: string, input: { kind: string; body: string; admissionId: string | null; caseId: string | null }): Promise<void>;
  amendNote(noteId: string, input: { body: string; justification: string }): Promise<void>;
  census(date?: string): Promise<CensusPayload>;
  censusMonth(month: string): Promise<CensusMonthPayload>;
  cases(q: Query): Promise<Paged<IrasCaseSummary> & { counts: Record<InvestigationStatus, number> }>;
  case(id: string): Promise<IrasCaseDetail>;
  createCase(input: CaseInput): Promise<{ id: string }>;
  updateCase(id: string, input: CaseUpdateInput): Promise<void>;
  changeCaseStatus(id: string, input: CaseStatusInput): Promise<{ criterionValidated: boolean | null }>;
  surgeries(q: Query): Promise<Paged<SurgerySummary>>;
  surgery(id: string): Promise<SurgeryDetail>;
  createSurgery(input: SurgeryInput & { admissionId: string }): Promise<{ id: string }>;
  updateSurgery(id: string, input: SurgeryInput & Justified & { rowVersion: number }): Promise<void>;
  professionals(): Promise<{ professionals: Professional[] }>;
  procedures(): Promise<{ procedures: Procedure[] }>;
  cultures(q: Query): Promise<Paged<CultureSummary>>;
  culture(id: string): Promise<CultureDetail>;
  createCulture(input: { admissionId: string; sectorId: string; material: string; collectedAt: string }): Promise<{ id: string }>;
  addCultureResult(id: string, input: CultureResultInput): Promise<{ version: number }>;
  consolidate(months: string[]): Promise<ConsolidationSummary>;
}

export interface OrgAdminPort {
  createUnit(input: Justified & { name: string }): Promise<void>;
  updateUnit(id: string, input: Justified & { name: string; active: boolean; rowVersion: number }): Promise<void>;
  createSector(input: Justified & { unitId: string; code: string; name: string; kind: string }): Promise<void>;
  updateSector(id: string, input: Justified & { unitId: string; name: string; kind: string; active: boolean; rowVersion: number }): Promise<void>;
  addBeds(sectorId: string, input: Justified & { codes: string[] }): Promise<void>;
  updateBed(id: string, input: Justified & { active: boolean }): Promise<void>;
}

/* ---------- Operations (Phase 4) ---------- */

export interface TemplateInput extends Justified {
  code: string; name: string; metric: 'cvc' | 'vm' | 'svd' | null; method: 'tudo_ou_nada' | 'por_item'; referenceId: string | null; active: boolean;
  items: Array<{ id: string | null; label: string }>; rowVersion: number | null;
}
export interface ActionInput { what: string; why: string; where: string; who: string; dueOn: string; how: string; howMuch: string | null }
export interface TrainingInput extends Justified {
  id: string | null; title: string; theme: string; mandatory: boolean; validityMonths: number | null; targetJobRoleIds: string[]; description: string | null; active: boolean; rowVersion: number | null;
}
export interface SupplyInput extends Justified { code: string; name: string; category: string; unit: string; minCoverageDays: number | null; active: boolean; rowVersion: number | null }
export interface MovementInput { kind: 'entrada' | 'consumo' | 'ajuste' | 'descarte'; lot: string; expiresOn: string | null; quantity: number; sectorId: string | null; occurredAt: string; reason: string | null }

export interface OperationsPort {
  bundleTemplates(): Promise<{ templates: BundleTemplateDto[] }>;
  saveBundleTemplate(input: TemplateInput): Promise<void>;
  bundleAudits(q: Query): Promise<Paged<BundleAuditDto>>;
  createBundleAudit(input: { templateId: string; sectorId: string; admissionId: string | null; auditedAt: string; notes: string | null; answers: Array<{ itemId: string; answer: string }> }): Promise<{ id: string; result: string; nonCompliant: number }>;
  voidBundleAudit(id: string, reason: string): Promise<void>;
  bundleSummary(q: Query): Promise<BundleSummary>;
  handHygiene(q: Query): Promise<Paged<HandHygieneDto> & { summary: HandHygieneSummaryRow[] }>;
  createHandHygiene(input: { sectorId: string; observedAt: string; category: string; opportunities: number; actions: number }): Promise<void>;
  voidHandHygiene(id: string, reason: string): Promise<void>;
  qualityAudits(): Promise<{ audits: QualityAuditDto[] }>;
  qualityAudit(id: string): Promise<QualityAuditDetail>;
  createQualityAudit(input: Justified & { title: string; kind: string; sectorId: string | null; scope: string | null; plannedFor: string }): Promise<{ id: string }>;
  updateQualityAudit(id: string, input: Justified & { title: string; scope: string | null; plannedFor: string; findings: string | null; rowVersion: number }): Promise<void>;
  changeAuditStatus(id: string, input: Justified & { to: string; rowVersion: number }): Promise<void>;
  nonconformities(status?: string): Promise<{ nonconformities: NonconformityDto[] }>;
  nonconformity(id: string): Promise<NonconformityDetail>;
  createNonconformity(input: Justified & { auditId: string | null; sectorId: string | null; origin: string; severity: string; description: string; detectedOn: string }): Promise<{ id: string }>;
  changeNcStatus(id: string, input: Justified & { to: string; effectiveness: string | null; rowVersion: number }): Promise<void>;
  addAction(ncId: string, input: ActionInput): Promise<void>;
  changeActionStatus(id: string, input: Justified & { status: string; completedOn: string | null; rowVersion: number }): Promise<void>;
  alerts(q: Query): Promise<Paged<AlertDto>>;
  alertSummary(): Promise<AlertSummary>;
  refreshAlerts(): Promise<{ created: number; resolved: number }>;
  assumeAlert(id: string, rowVersion: number): Promise<void>;
  closeAlert(id: string, resolution: string, rowVersion: number): Promise<void>;
  alert(id: string): Promise<AlertDetail>;
  acknowledgeAlert(id: string, rowVersion: number): Promise<void>;
  resolveAlert(id: string, note: string, rowVersion: number): Promise<void>;
  alertException(id: string, note: string, rowVersion: number): Promise<void>;
  commentAlert(id: string, note: string): Promise<void>;
  staff(): Promise<{ staff: StaffMember[]; jobRoles: Array<{ id: string; name: string }> }>;
  createStaff(input: Justified & { name: string; registration: string | null; jobRoleId: string; sectorId: string }): Promise<void>;
  trainings(): Promise<{ trainings: TrainingDto[]; sessions: TrainingSessionDto[] }>;
  trainingCoverage(): Promise<TrainingCoveragePayload>;
  saveTraining(input: TrainingInput): Promise<void>;
  createSession(trainingId: string, input: { heldOn: string; instructor: string; hours: number; sectorId: string | null; notes: string | null; attendees: Array<{ professionalId: string; present: boolean; score: number | null }> }): Promise<void>;
  supplies(): Promise<{ supplies: SupplyDto[] }>;
  supplyMovements(id: string): Promise<{ movements: SupplyMovementDto[] }>;
  saveSupply(input: SupplyInput): Promise<void>;
  addMovement(supplyId: string, input: MovementInput): Promise<void>;
  surveillance(pending: boolean): Promise<{ rows: SurveillanceRow[]; ruleMissing: boolean }>;
  addFollowup(surgeryId: string, input: { contactedOn: string; method: string; outcome: string; notes: string | null; openCase: boolean }): Promise<{ caseId: string | null }>;
}

/* ---------- CME (Phase 5) ---------- */

export interface SterilizerInput extends Justified {
  code: string; name: string; type: SterilizerType; serial: string | null; sectorId: string; status: EquipmentStatus; statusReason: string | null;
  qualificationDueOn: string | null; rowVersion: number | null;
}
export interface SetInput extends Justified {
  code: string; name: string; specialty: string | null; composition: string | null; itemCount: number | null; packaging: PackagingType; implant: boolean; active: boolean; rowVersion: number | null;
}
export interface LoadInput {
  sterilizerId: string; program: string; startedAt: string | null; notes: string | null; reprocessedFromId: string | null;
  items: Array<{ setId: string | null; description: string | null; quantity: number; packaging: PackagingType | null; implant: boolean | null }>;
}
export interface CycleInput { endedAt: string; temperatureC: number | null; pressureKpa: number | null; exposureMinutes: number | null; physicalResult: 'conforme' | 'nao_conforme'; notes: string | null; rowVersion: number }
export interface TestInput {
  sterilizerId: string | null; loadId: string | null; type: RecordedTestType; result: TestResult; performedAt: string; indicatorLot: string; indicatorExpiry: string | null;
  incubationStart: string | null; readAt: string | null; controlResult: IbControl | null; notes: string | null;
}
export interface TestReplaceInput { result: TestResult; readAt: string | null; controlResult: IbControl | null; notes: string | null; justification: string | null }
export type AttachmentEntity = 'sterilization_test' | 'training_session';

export interface CmePort {
  overview(): Promise<CmeOverview>;
  sterilizers(): Promise<{ sterilizers: SterilizerDto[] }>;
  saveSterilizer(id: string | null, input: SterilizerInput): Promise<void>;
  sets(): Promise<{ sets: InstrumentSetDto[] }>;
  saveSet(id: string | null, input: SetInput): Promise<void>;
  loads(q: Query): Promise<Paged<LoadSummary>>;
  load(id: string): Promise<LoadDetail>;
  createLoad(input: LoadInput): Promise<{ id: string; code: string }>;
  finishCycle(id: string, input: CycleInput): Promise<void>;
  decide(id: string, input: Justified & { status: LoadStatus; rowVersion: number }): Promise<void>;
  bowieDick(from: string, to: string): Promise<{ tests: CmeTestDto[] }>;
  createTest(input: TestInput): Promise<{ id: string }>;
  replaceTest(id: string, input: TestReplaceInput): Promise<{ id: string }>;
  trace(q: string): Promise<TraceResult>;
  addSurgeryMaterial(surgeryId: string, input: { labelCode: string; usedAt: string | null }): Promise<UseRecorded>;
  addLooseUse(input: { labelCode: string; sectorId: string; usedAt: string }): Promise<UseRecorded>;
  voidUse(useId: string, justification: string): Promise<void>;
  upload(entity: AttachmentEntity, entityId: string, file: File): Promise<AttachmentDto>;
  /** Same-origin download link (the session cookie authorizes it; the API logs it). */
  attachmentUrl(id: string): string;
  startCycle(id: string, input: { startedAt: string; rowVersion: number }): Promise<void>;
  sectors(): Promise<{ sectors: CmeSectorDto[] }>;
  flowConfig(): Promise<FlowConfigDto>;
  saveFlowConfig(input: Justified & Omit<FlowConfigDto, 'rowVersion'> & { rowVersion: number }): Promise<void>;
  stations(): Promise<{ stations: StationDto[] }>;
  saveStation(id: string | null, input: StationInput): Promise<void>;
  pairStation(id: string, label: string): Promise<{ deviceId: string }>;
  revokeDevice(id: string): Promise<void>;
  thisStation(): Promise<{ station: StationDto | null; deviceId: string | null }>;
  assets(q?: { q?: string; setId?: string }): Promise<{ assets: AssetDto[] }>;
  createAssets(input: Justified & { setId: string; count: number; tag: string | null }): Promise<{ assets: AssetDto[] }>;
  updateAsset(id: string, input: Justified & { tag: string | null; status: AssetDto['status']; statusReason: string | null; rowVersion: number }): Promise<void>;
  scan(input: ScanInput): Promise<ScanResponse>;
  receiveLoose(input: { stationId: string; description: string; setId: string | null; originSectorId: string | null; clientEventId: string | null }): Promise<ScanResponse>;
  processes(q: Query): Promise<Paged<ProcessSummaryDto>>;
  process(id: string): Promise<ProcessDetail>;
  scanEvents(q: { stationId?: string; limit?: number }): Promise<{ events: ScanEventDto[] }>;
  labelLayouts(): Promise<{ layouts: LabelLayoutDto[] }>;
  saveLabelLayout(id: string | null, input: LabelLayoutInput & Justified & { isDefault: boolean; active: boolean; rowVersion: number | null }): Promise<LabelLayoutDto>;
  labelPrints(q: { entity?: LabelEntity; entityId?: string; q?: string; situacao?: 'ativas' | 'todas'; limit?: number }): Promise<{ prints: LabelPrintDto[] }>;
  printLabels(input: { entity: LabelEntity; ids: string[]; layoutId: string; output: LabelOutput; mode: LabelPrintKind; reason: string | null }): Promise<{ labels: PrintedLabel[]; zpl: string | null; prints: LabelPrintDto[] }>;
  cancelLabel(id: string, reason: string): Promise<LabelPrintDto>;
}

export interface StationInput extends Justified {
  sectorId: string; name: string; location: string | null; steps: ProcessStep[]; inputMethods: InputMethod[]; symbologies: Symbology[]; deviceLabel: string | null;
  responsibleUserId: string | null; requirePairing: boolean; scanConfig: ScanConfig; enabled: boolean; rowVersion: number | null;
}
export interface ScanInput {
  stationId: string; code: string; inputMethod: InputMethod; step: ProcessStep; clientEventId: string | null; deviceAt: string | null; outcome: string | null;
  destinationSectorId: string | null; originSectorId: string | null; loadId: string | null; packaging: PackagingType | null; justification: string | null; override: boolean;
}

export interface RealtimeConfig { mode: 'sse' | 'polling'; pollSeconds: number }
export interface RealtimePort {
  config(): Promise<RealtimeConfig>;
  /** Same-origin Server-Sent Events stream (the session cookie authorizes it). */
  eventsUrl: string;
}

export interface InboxPort {
  notifications(q: { situacao: 'nao_lidas' | 'todas' }): Promise<{ rows: UserNotificationDto[]; unread: number }>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

export interface CcihDataSource {
  readonly origin: DataOrigin;
  readonly auth?: AuthPort;
  readonly admin?: AdminPort;
  /** Clinical modules exist only with the backend (no synthetic patients in the browser). */
  readonly clinical?: ClinicalPort;
  readonly orgAdmin?: OrgAdminPort;
  readonly operations?: OperationsPort;
  readonly cme?: CmePort;
  /** Personal notifications of the signed-in user. */
  readonly inbox?: InboxPort;
  /** Live updates of the screens (only with the backend). */
  readonly realtime?: RealtimePort;
  getInstitution(): Promise<WithProvenance<InstitutionData>>;
  getFacts(query: FactsQuery): Promise<WithProvenance<{ rows: FactRow[] }>>;
}
