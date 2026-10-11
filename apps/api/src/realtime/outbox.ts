import type { Kysely, Transaction } from 'kysely';
import type { Permission } from '@ccih/domain';
import type { DB, RealtimeTopic } from '../db/types';

export interface OutboxEvent {
  institutionId: string;
  topic: RealtimeTopic;
  /** Receivers need this permission (null: any signed-in user of the institution). */
  permission: Permission | null;
  /** Receivers with a sector scope get it only for their sectors (null: not sector-bound). */
  sectorId?: string | null;
  /** Only this user receives it (personal notifications). */
  userId?: string | null;
}

/** Writes the event in the caller's transaction: it exists (and is announced) only if the change commits. */
export async function publish(db: Kysely<DB> | Transaction<DB>, e: OutboxEvent): Promise<void> {
  await db.insertInto('event_outbox').values({ institution_id: e.institutionId, topic: e.topic, permission: e.permission, sector_id: e.sectorId ?? null, user_id: e.userId ?? null }).execute();
}

const T = (topic: RealtimeTopic, permission: Permission) => ({ topic, permission });

/** Audited entities that changed → who should refresh. Entities absent here are not broadcast. */
const BY_ENTITY: Record<string, { topic: RealtimeTopic; permission: Permission }> = {
  patient: T('clinico', 'patient:view'), admission: T('clinico', 'patient:view'), admission_movement: T('clinico', 'patient:view'), device_use: T('clinico', 'patient:view'),
  iras_case: T('clinico', 'iras:view'), ccih_note: T('clinico', 'iras:view'), surgery: T('clinico', 'surgery:view'), ssi_followup: T('clinico', 'surgery:view'),
  culture: T('clinico', 'micro:view'), culture_result: T('clinico', 'micro:view'), indicator_fact: T('clinico', 'indicators:view'),
  sterilization_load: T('cme', 'cme:view'), sterilization_test: T('cme', 'cme:view'), sterilizer: T('cme', 'cme:view'), material_use: T('cme', 'cme:view'),
  instrument_set: T('cme', 'cme:view'), instrument_asset: T('cme', 'cme:view'), cme_process: T('cme', 'cme:view'), scan_station: T('cme', 'cme:view'),
  station_device: T('cme', 'cme:view'), cme_flow_config: T('cme', 'cme:view'), load_release_policy: T('cme', 'cme:view'),
  label_layout: T('cme', 'cme:view'), label_print: T('cme', 'cme:view'),
  nonconformity: T('qualidade', 'quality:view'), action_plan: T('qualidade', 'quality:view'), quality_audit: T('qualidade', 'quality:view'), bundle_audit: T('qualidade', 'quality:view'),
  bundle_template: T('qualidade', 'quality:view'), hand_hygiene_observation: T('qualidade', 'quality:view'), training: T('qualidade', 'quality:view'),
  training_session: T('qualidade', 'quality:view'), supply: T('qualidade', 'quality:view'), supply_movement: T('qualidade', 'quality:view'),
  alert: T('alertas', 'alerts:view'),
  rule_parameter: T('config', 'config:view'), indicator_target: T('config', 'config:view'), clinical_reference: T('config', 'config:view'), unit: T('config', 'config:view'),
  sector: T('config', 'config:view'), bed: T('config', 'config:view'), institution: T('config', 'config:view'),
};

export const topicOfEntity = (entity: string) => BY_ENTITY[entity] ?? null;

/** Audited entities that belong to a module (for the module administrators' log). */
export function auditEntitiesOf(modules: Array<'cme' | 'ccih'>): string[] {
  const topics: RealtimeTopic[] = modules.map((m) => (m === 'cme' ? 'cme' : 'clinico'));
  return Object.entries(BY_ENTITY).filter(([, t]) => topics.includes(t.topic)).map(([e]) => e);
}
