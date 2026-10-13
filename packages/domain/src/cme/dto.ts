import type { DataOrigin } from '../provenance';
import type { PatientRef } from '../clinical/dto';
import type { SectorKind } from '../org';
import type { LoadReleaseEvaluation, LoadStatus, SterilizationTestType, TestResult } from '../rules/sterilization';
import type { EquipmentStatus, IbControl, PackagingType, PhysicalResult, RecordedTestType, SterilizerType } from './cme';
import type { Symbology } from './codes';
import type { InputMethod, ProcessState, ProcessStep, ScanResult } from './flow';

/** Payloads of the CME module (Phase 5), shared by the API and the web client. */

export interface SterilizerDto {
  id: string; code: string; name: string; type: SterilizerType; serial: string | null; sectorId: string; status: EquipmentStatus;
  statusReason: string | null; qualificationDueOn: string | null; rowVersion: number; bowieDickApplies: boolean;
  todayBowieDick: TestResult | null; loadsToday: number;
}

export interface InstrumentSetDto {
  id: string; code: string; name: string; specialty: string | null; composition: string | null; itemCount: number | null;
  packaging: PackagingType; implant: boolean; active: boolean; rowVersion: number;
}

export interface AttachmentDto {
  id: string; fileName: string; mime: string; size: number; uploadedBy: string; uploadedAt: string;
  /** Latest antivirus result, or "não verificado"/"pendente" when never checked (see attachmentScanStatus). */
  scan: 'limpo' | 'infectado' | 'erro' | null; scannedAt: string | null;
}

export interface CmeTestDto {
  id: string; type: RecordedTestType; result: TestResult; performedAt: string; indicatorLot: string | null; indicatorExpiry: string | null;
  incubationStart: string | null; readAt: string | null; controlResult: IbControl | null; notes: string | null; recordedBy: string;
  sterilizerId: string; loadId: string | null; replacesId: string | null; justification: string | null; current: boolean; attachments: AttachmentDto[];
}

export interface ItemUseDto {
  id: string; usedAt: string; sectorId: string; surgeryId: string | null; patient: PatientRef | null; procedure: string | null; recordedBy: string;
}

export interface LoadItemDto {
  id: string; position: number; labelCode: string; setId: string | null; setCode: string | null; description: string; quantity: number;
  packaging: PackagingType; implant: boolean; expiresOn: string | null; use: ItemUseDto | null;
  /** Processing round that produced the package (null for packages issued before the flow). */
  processId: string | null;
}

export interface LoadSummary {
  id: string; code: string; sterilizerId: string; sterilizerName: string; program: string;
  /** Null while the load is being assembled (the cycle has not started). */
  startedAt: string | null; endedAt: string | null;
  physical: PhysicalResult | null; status: LoadStatus; suggestion: LoadStatus; hasImplant: boolean; items: number; used: number;
  origin: DataOrigin; reprocessedFromId: string | null;
}

export interface PolicySnapshot { version: number; requiredLoadTests: SterilizationTestType[]; requireDailyBowieDick: boolean; holdImplantsUntilBiological: boolean; referenceId: string | null }

export interface LoadDecisionDto {
  id: string; from: LoadStatus | null; to: LoadStatus; at: string; by: string; justification: string;
  policy: PolicySnapshot | null; evaluation: { status: LoadStatus; reasons: string[] };
}

export interface LoadDetail extends LoadSummary {
  operatorName: string; temperatureC: number | null; pressureKpa: number | null; exposureMinutes: number | null; notes: string | null; rowVersion: number;
  evaluation: LoadReleaseEvaluation; policy: PolicySnapshot | null; bowieDickApplies: boolean; equipmentBowieDick: CmeTestDto | null;
  tests: CmeTestDto[]; itemList: LoadItemDto[]; decisions: LoadDecisionDto[]; exposed: { patients: number; surgeries: number };
  reprocessedIntoId: string | null;
}

export interface CmeOverview {
  awaiting: number; retained: number; releasedToday: number; ibPending: number; recalled30d: number;
  sterilizers: SterilizerDto[];
}

/** One link of the traceability chain: package → load → sterilizer, and package → use → surgery → patient. */
export interface TraceRow {
  itemId: string; labelCode: string; description: string; setCode: string | null; implant: boolean;
  loadId: string; loadCode: string; loadStatus: LoadStatus; cycleStartedAt: string | null; sterilizerName: string; expiresOn: string | null;
  /** When the load reached its current status (last release decision). */
  statusAt: string | null;
  processId: string | null;
  use: ItemUseDto | null;
}
export interface TraceResult { query: string; rows: TraceRow[]; truncated: boolean }

/** Materials used in a surgery (backward traceability from the surgical record). */
export interface SurgeryMaterialDto {
  useId: string; itemId: string; labelCode: string; description: string; implant: boolean; loadId: string; loadCode: string; loadStatus: LoadStatus;
  sterilizerName: string; cycleStartedAt: string | null; usedAt: string;
}

/* ---------- Processing flow and reading stations ---------- */

export interface FlowConfigDto { storageRequired: boolean; separationRequired: boolean; rowVersion: number }

/** How a workstation tells a keyboard-wedge (HID) reader from a person typing. */
export interface ScanConfig { maxKeyIntervalMs: number; minLength: number; terminator: 'enter' | 'tab' | 'nenhum' }
export const DEFAULT_SCAN_CONFIG: ScanConfig = { maxKeyIntervalMs: 35, minLength: 6, terminator: 'enter' };

export interface StationDeviceDto { id: string; label: string; pairedBy: string; pairedAt: string; lastSeenAt: string | null; revoked: boolean }
export interface StationDto {
  id: string; sectorId: string; name: string; location: string | null; steps: ProcessStep[]; inputMethods: InputMethod[]; symbologies: Symbology[];
  deviceLabel: string | null; responsibleUserId: string | null; responsibleName: string | null; requirePairing: boolean; scanConfig: ScanConfig; enabled: boolean;
  lastSeenAt: string | null; devices: StationDeviceDto[]; rowVersion: number;
}

export interface AssetDto {
  id: string; code: string; setId: string; setName: string; tag: string | null; status: 'ativo' | 'manutencao' | 'baixado'; statusReason: string | null;
  openProcess: { id: string; step: ProcessStep; state: ProcessState } | null; rowVersion: number;
}

export interface ProcessSummaryDto {
  id: string; code: string; assetCode: string | null; description: string; setName: string | null; currentStep: ProcessStep; state: ProcessState; nextSteps: ProcessStep[];
  packageLabel: string | null; loadId: string | null; loadCode: string | null; loadStatus: LoadStatus | null; destinationSectorId: string | null;
  openedAt: string; closedAt: string | null; legacy: boolean; origin: DataOrigin;
}

export interface ScanEventDto {
  id: string; rawCode: string; codeKind: string; inputMethod: InputMethod; step: ProcessStep; operation: string; outcome: string | null; result: ScanResult; message: string;
  userName: string; stationId: string | null; stationName: string | null; device: string | null; serverAt: string; deviceAt: string | null;
  originSectorId: string | null; destinationSectorId: string | null; justification: string | null; processId: string | null; loadId: string | null; loadCode: string | null;
}

export interface ProcessDetail extends ProcessSummaryDto { events: ScanEventDto[]; previousProcessId: string | null; nextProcessId: string | null }

export interface ScanResponse {
  eventId: string; result: ScanResult; message: string;
  /** The same reading had already been recorded (sent twice): nothing was applied again. */
  replay: boolean;
  process: ProcessSummaryDto | null;
  load: { id: string; code: string; packages: number } | null;
}

/** Institution sectors as the CME sees them: destinations and use places are hospital-wide, whatever the user's clinical scope. */
export interface CmeSectorDto { id: string; code: string; name: string; kind: SectorKind; active: boolean }

/** Result of recording a package use. A missing CME exit does not block: it opens a non-conformity. */
export interface UseRecorded { id: string; withoutExit: boolean; nonconformityId: string | null }
