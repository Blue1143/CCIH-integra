import { addDays, dayDiff, type IsoDate } from '../dates';
import type { AlertCandidate } from '../operations/alerts';
import type { FieldProblem } from '../users';
import type { ServiceUnit } from './contracts';

/**
 * Consulting agenda: visits, meetings, audits, inspections, trainings and deliveries scheduled with
 * the clients, who takes part, what happened (realized, not realized, cancelled) and the follow-up
 * tasks each activity leaves. A realized activity linked to a contracted service becomes a delivery
 * of that service (planned × done).
 */
export type ActivityKind = 'visita_tecnica' | 'reuniao' | 'auditoria' | 'inspecao' | 'treinamento' | 'entrega' | 'diagnostico' | 'outro';
export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  visita_tecnica: 'Visita técnica', reuniao: 'Reunião', auditoria: 'Auditoria', inspecao: 'Inspeção', treinamento: 'Treinamento', entrega: 'Entrega',
  diagnostico: 'Diagnóstico', outro: 'Outra atividade',
};
export type ActivityMode = 'presencial' | 'remoto';
export const ACTIVITY_MODE_LABEL: Record<ActivityMode, string> = { presencial: 'Presencial', remoto: 'Remota' };

export type ActivityStatus = 'agendada' | 'realizada' | 'nao_realizada' | 'cancelada';
export const ACTIVITY_STATUS_LABEL: Record<ActivityStatus, string> = { agendada: 'Agendada', realizada: 'Realizada', nao_realizada: 'Não realizada', cancelada: 'Cancelada' };
/** Shown to people: a scheduled activity whose end has passed without a record is "sem registro". */
export type ActivitySituation = ActivityStatus | 'sem_registro';
export const ACTIVITY_SITUATION_LABEL: Record<ActivitySituation, string> = { ...ACTIVITY_STATUS_LABEL, sem_registro: 'Sem registro' };
export function activitySituation(a: { status: ActivityStatus; endsAt: string }, now: Date): ActivitySituation {
  return a.status === 'agendada' && new Date(a.endsAt).getTime() < now.getTime() ? 'sem_registro' : a.status;
}

export type TaskStatus = 'aberta' | 'concluida' | 'cancelada';
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { aberta: 'Aberta', concluida: 'Concluída', cancelada: 'Cancelada' };

export type ActivityEventKind = 'agendada' | 'alterada' | 'remarcada' | 'realizada' | 'nao_realizada' | 'cancelada' | 'pendencia' | 'pendencia_encerrada';
export const ACTIVITY_EVENT_LABEL: Record<ActivityEventKind, string> = {
  agendada: 'Agendada', alterada: 'Alterada', remarcada: 'Remarcada', realizada: 'Realizada', nao_realizada: 'Não realizada', cancelada: 'Cancelada',
  pendencia: 'Pendência registrada', pendencia_encerrada: 'Pendência encerrada',
};

/** Longest activity accepted (one working block): longer work is scheduled as several activities. */
export const MAX_ACTIVITY_HOURS = 12;

/* ---------- Inputs and validation ---------- */

export interface ActivityInput {
  kind: ActivityKind; mode: ActivityMode; title: string; description: string | null; startsAt: string; endsAt: string; location: string | null;
  establishmentId: string | null; contractServiceId: string | null; responsibleId: string; participantIds: string[];
}
export interface TaskInput { description: string; ownerId: string; dueOn: IsoDate }
export interface OutcomeInput {
  status: 'realizada' | 'nao_realizada' | 'cancelada';
  summary: string | null; detail: string | null; actualMinutes: number | null; reason: string | null;
  /** Realized and linked to a contracted service: register the delivery of that service. */
  registerDelivery: boolean;
  tasks: TaskInput[];
}

const isInstant = (v: string) => !Number.isNaN(Date.parse(v)) && /T\d{2}:\d{2}/.test(v);

export function checkActivity(a: ActivityInput): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (a.title.trim().length < 3) p.push({ path: 'title', message: 'Informe o assunto da atividade (mínimo 3 caracteres).' });
  if (!isInstant(a.startsAt)) p.push({ path: 'startsAt', message: 'Informe o início (data e hora).' });
  if (!isInstant(a.endsAt)) p.push({ path: 'endsAt', message: 'Informe o término (data e hora).' });
  if (isInstant(a.startsAt) && isInstant(a.endsAt)) {
    const minutes = (Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000;
    if (minutes <= 0) p.push({ path: 'endsAt', message: 'O término deve ser depois do início.' });
    else if (minutes > MAX_ACTIVITY_HOURS * 60) p.push({ path: 'endsAt', message: `Uma atividade dura no máximo ${MAX_ACTIVITY_HOURS} horas; agende períodos separados.` });
  }
  if (!a.responsibleId) p.push({ path: 'responsibleId', message: 'Escolha o responsável pela atividade.' });
  if (a.participantIds.includes(a.responsibleId)) p.push({ path: 'participantIds', message: 'O responsável já participa; não o repita entre os participantes.' });
  if (new Set(a.participantIds).size !== a.participantIds.length) p.push({ path: 'participantIds', message: 'Participante repetido.' });
  if (a.mode === 'presencial' && a.kind === 'visita_tecnica' && !a.location && !a.establishmentId) p.push({ path: 'establishmentId', message: 'Informe o estabelecimento ou o local da visita.' });
  return p;
}

export function checkTask(t: TaskInput, today: IsoDate, prefix = ''): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (t.description.trim().length < 3) p.push({ path: `${prefix}description`, message: 'Descreva a pendência (mínimo 3 caracteres).' });
  if (!t.ownerId) p.push({ path: `${prefix}ownerId`, message: 'Escolha o responsável pela pendência.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.dueOn)) p.push({ path: `${prefix}dueOn`, message: 'Informe o prazo.' });
  else if (t.dueOn < today) p.push({ path: `${prefix}dueOn`, message: 'O prazo não pode estar no passado.' });
  return p;
}

export function checkOutcome(o: OutcomeInput, today: IsoDate): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (o.status === 'realizada') {
    if (!o.summary || o.summary.trim().length < 10) p.push({ path: 'summary', message: 'Resuma o que foi feito (mínimo 10 caracteres).' });
    if (o.actualMinutes == null || !Number.isInteger(o.actualMinutes) || o.actualMinutes < 5 || o.actualMinutes > MAX_ACTIVITY_HOURS * 60) {
      p.push({ path: 'actualMinutes', message: `Duração realizada: de 5 minutos a ${MAX_ACTIVITY_HOURS} horas.` });
    }
  } else if (!o.reason || o.reason.trim().length < 5) p.push({ path: 'reason', message: 'Informe o motivo (mínimo 5 caracteres).' });
  if (o.status !== 'realizada' && o.tasks.length) p.push({ path: 'tasks', message: 'Pendências acompanham uma atividade realizada (registre-as depois, se necessário).' });
  if (o.status !== 'realizada' && o.registerDelivery) p.push({ path: 'registerDelivery', message: 'Só uma atividade realizada conta como entrega.' });
  o.tasks.forEach((t, i) => p.push(...checkTask(t, today, `tasks.${i}.`)));
  return p;
}

/**
 * Quantity a realized activity delivers for its contracted service: one visit or one delivery, or
 * the realized duration in hours (in quarters of an hour, rounded to the nearest).
 */
export function deliveredQuantity(unit: ServiceUnit, actualMinutes: number): number {
  if (unit !== 'horas') return 1;
  return Math.max(0.25, Math.round((actualMinutes / 60) * 4) / 4);
}

/* ---------- Conflicts ---------- */

export interface Busy { activityId: string; userId: string; startsAt: string; endsAt: string; title: string; clientName: string }

/** Scheduled activities of the same people overlapping [startsAt, endsAt) (ends touching starts is not a conflict). */
export function scheduleConflicts(people: string[], startsAt: string, endsAt: string, busy: Busy[], ignoreActivityId: string | null = null): Busy[] {
  const s = Date.parse(startsAt);
  const e = Date.parse(endsAt);
  return busy.filter((b) => b.activityId !== ignoreActivityId && people.includes(b.userId) && Date.parse(b.startsAt) < e && Date.parse(b.endsAt) > s);
}

/* ---------- Calendar export ---------- */

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
const icsInstant = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** UTF-8 size of one character. */
const utf8 = (ch: string) => { const c = ch.codePointAt(0)!; return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; };

/** Lines folded at 75 octets (RFC 5545 3.1). */
function fold(line: string): string {
  if ([...line].reduce((n, ch) => n + utf8(ch), 0) <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = utf8(ch);
    if (size + n > (out.length ? 74 : 75)) { out.push(current); current = ''; size = 0; }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

export interface IcsEvent { id: string; title: string; startsAt: string; endsAt: string; location: string | null; description: string | null; status: ActivityStatus; updatedAt: string }

/** iCalendar (RFC 5545) with the activities, for the person's own calendar application. */
export function agendaIcs(calendarName: string, events: IcsEvent[], domain = 'ccih-integra'): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CCIH Integra//Agenda da consultoria//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(calendarName)}`];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT', `UID:${e.id}@${domain}`, `DTSTAMP:${icsInstant(e.updatedAt)}`, `DTSTART:${icsInstant(e.startsAt)}`, `DTEND:${icsInstant(e.endsAt)}`,
      `SUMMARY:${icsText(e.title)}`, ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []), ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
      `STATUS:${e.status === 'cancelada' || e.status === 'nao_realizada' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/* ---------- Alerts ---------- */

/** Days after the end of a scheduled activity before it is flagged as without record. */
export const ACTIVITY_RECORD_GRACE_DAYS = 1;

export interface AgendaAlertInput {
  today: IsoDate;
  activities: Array<{ id: string; title: string; kind: ActivityKind; clientId: string; clientName: string; endsOn: IsoDate; responsible: string }>;
  tasks: Array<{ id: string; description: string; clientId: string; clientName: string; dueOn: IsoDate; owner: string; activityId: string | null }>;
}

/** Scheduled activities left without a record after the grace period, and open tasks past their due date. */
export function buildAgendaAlertCandidates(input: AgendaAlertInput): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  for (const a of input.activities) {
    const late = dayDiff(a.endsOn, input.today);
    if (late < ACTIVITY_RECORD_GRACE_DAYS) continue;
    out.push({
      kind: 'atividade_sem_registro', dedupKey: `atividade_sem_registro:${a.id}`, priority: late > 7 ? 'alta' : 'media',
      title: `${ACTIVITY_KIND_LABEL[a.kind]} sem registro: ${a.title} (${a.clientName})`,
      detail: `Atividade de ${a.responsible} terminada há ${late} dia(s) sem registro de realização, não realização ou cancelamento.`,
      entity: 'consulting_activity', entityId: a.id, sectorId: null, clientId: a.clientId, link: `/consultoria/agenda/${a.id}`, dueOn: addDays(a.endsOn, ACTIVITY_RECORD_GRACE_DAYS),
    });
  }
  for (const t of input.tasks) {
    if (t.dueOn >= input.today) continue;
    const late = dayDiff(t.dueOn, input.today);
    out.push({
      kind: 'pendencia_atrasada', dedupKey: `pendencia_atrasada:${t.id}:${t.dueOn}`, priority: late > 7 ? 'alta' : 'media',
      title: `Pendência atrasada: ${t.description} (${t.clientName})`, detail: `Responsável: ${t.owner}. Prazo era ${t.dueOn}, há ${late} dia(s).`,
      entity: 'consulting_task', entityId: t.id, sectorId: null, clientId: t.clientId, link: t.activityId ? `/consultoria/agenda/${t.activityId}` : '/consultoria/agenda', dueOn: t.dueOn,
    });
  }
  return out;
}

/* ---------- DTOs ---------- */

export interface ActivitySummaryDto {
  id: string; kind: ActivityKind; mode: ActivityMode; title: string; clientId: string; clientName: string; establishmentName: string | null;
  startsAt: string; endsAt: string; location: string | null; status: ActivityStatus; situation: ActivitySituation;
  responsible: { userId: string; name: string }; participants: Array<{ userId: string; name: string }>;
  serviceDescription: string | null; openTasks: number; dataOrigin: 'real' | 'demo';
}
export interface TaskDto {
  id: string; description: string; clientId: string; clientName: string; activityId: string | null; activityTitle: string | null;
  owner: { userId: string; name: string }; dueOn: IsoDate; status: TaskStatus; late: boolean;
  closedNote: string | null; closedBy: string | null; closedAt: string | null; createdBy: string; createdAt: string; rowVersion: number;
}
export interface ActivityEventDto { id: string; kind: ActivityEventKind; summary: string; detail: string | null; by: string; at: string }
export interface ActivityDetailDto extends ActivitySummaryDto {
  description: string | null; establishmentId: string | null; contractServiceId: string | null; contractId: string | null; contractCode: string | null;
  outcomeSummary: string | null; outcomeDetail: string | null; actualMinutes: number | null; closeReason: string | null; recordedBy: string | null; recordedAt: string | null;
  deliveryId: string | null; tasks: TaskDto[]; events: ActivityEventDto[]; rowVersion: number; createdBy: string; createdAt: string;
}
/** What the activity form needs for a client: establishments, contracted services in force and who may take part. */
export interface ActivityOptionsDto {
  establishments: Array<{ id: string; name: string }>;
  services: Array<{ id: string; contractCode: string; description: string; unit: ServiceUnit; frequency: string }>;
  people: Array<{ userId: string; name: string }>;
}
