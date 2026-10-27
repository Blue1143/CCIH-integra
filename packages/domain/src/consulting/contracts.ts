import { addDays, addMonths, dayDiff, type IsoDate } from '../dates';
import type { AlertCandidate } from '../operations/alerts';
import type { FieldProblem } from '../users';
import type { Specialty } from './clients';

/**
 * Consulting contracts: proposals and contracts of a client, the services and scope they include
 * (with the planned frequency of visits, hours or deliveries), amendments (history preserved),
 * deliveries actually made (planned × done) and, separately, the financial terms, which only the
 * profiles allowed to see them receive. No billing or payment integration is simulated.
 */
export type ContractStatus = 'proposta' | 'vigente' | 'suspenso' | 'encerrado' | 'recusada';
export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = { proposta: 'Proposta', vigente: 'Vigente', suspenso: 'Suspenso', encerrado: 'Encerrado', recusada: 'Proposta recusada' };

/** Status changes a person may make (signing, refusal, suspension, resumption, termination). */
export const CONTRACT_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  proposta: ['vigente', 'recusada'],
  vigente: ['suspenso', 'encerrado'],
  suspenso: ['vigente', 'encerrado'],
  encerrado: [],
  recusada: [],
};
export const CONTRACT_TRANSITION_LABEL: Partial<Record<`${ContractStatus}>${ContractStatus}`, string>> = {
  'proposta>vigente': 'Registrar assinatura', 'proposta>recusada': 'Registrar recusa', 'vigente>suspenso': 'Suspender', 'suspenso>vigente': 'Retomar',
  'vigente>encerrado': 'Encerrar contrato', 'suspenso>encerrado': 'Encerrar contrato',
};

export type ServiceKind = 'consultoria_continua' | 'visita_tecnica' | 'diagnostico' | 'auditoria' | 'treinamento' | 'documentacao' | 'indicadores' | 'reuniao' | 'outro';
export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  consultoria_continua: 'Consultoria contínua', visita_tecnica: 'Visita técnica', diagnostico: 'Diagnóstico situacional', auditoria: 'Auditoria', treinamento: 'Treinamento',
  documentacao: 'Elaboração e revisão de documentos', indicadores: 'Análise de indicadores', reuniao: 'Reunião de comissão / acompanhamento', outro: 'Outro',
};
export type ServiceUnit = 'visitas' | 'horas' | 'entregas';
export const SERVICE_UNIT_LABEL: Record<ServiceUnit, string> = { visitas: 'visitas', horas: 'horas', entregas: 'entregas' };
export type ServicePeriod = 'mensal' | 'bimestral' | 'trimestral' | 'semestral' | 'anual' | 'contrato';
export const SERVICE_PERIOD_LABEL: Record<ServicePeriod, string> = { mensal: 'por mês', bimestral: 'por bimestre', trimestral: 'por trimestre', semestral: 'por semestre', anual: 'por ano', contrato: 'no contrato' };
export const SERVICE_PERIOD_MONTHS: Record<ServicePeriod, number | null> = { mensal: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12, contrato: null };

export type AmendmentKind = 'prazo' | 'renovacao' | 'escopo' | 'valor' | 'outro';
export const AMENDMENT_KIND_LABEL: Record<AmendmentKind, string> = { prazo: 'Prazo', renovacao: 'Renovação', escopo: 'Escopo / serviços', valor: 'Valor', outro: 'Outro' };

export type FinancialBasis = 'mensal' | 'total' | 'por_entrega';
export const FINANCIAL_BASIS_LABEL: Record<FinancialBasis, string> = { mensal: 'Valor mensal', total: 'Valor total do contrato', por_entrega: 'Valor por entrega' };

/** Days before the end of a contract when the expiry alert starts (when the contract does not set its own). */
export const DEFAULT_RENEWAL_NOTICE_DAYS = 60;

/* ---------- Inputs and validation ---------- */

export interface ServiceInput {
  /** Existing line (proposals only); null = new line. */
  id: string | null;
  area: Specialty; kind: ServiceKind; description: string; establishmentId: string | null;
  unit: ServiceUnit; quantity: number; period: ServicePeriod;
}
export interface ContractInput {
  title: string; startsOn: IsoDate | null; endsOn: IsoDate | null; autoRenew: boolean; renewalNoticeDays: number;
  responsibleId: string | null; scopeNotes: string | null; services: ServiceInput[];
}
export interface AmendmentInput {
  kinds: AmendmentKind[]; description: string; signedOn: IsoDate; effectiveOn: IsoDate;
  /** New end of the contract (undefined = unchanged; null = becomes open-ended). */
  newEndsOn?: IsoDate | null;
  autoRenew?: boolean;
  addServices: ServiceInput[];
  /** New planned quantity/period of a line: the line ends at the effective date and a new one starts (history kept). */
  changeServices: Array<{ id: string; quantity: number; period: ServicePeriod }>;
  endServices: string[];
}
export interface DeliveryInput { serviceId: string; occurredOn: IsoDate | null; quantity: number; description: string }
export interface FinancialInput {
  basis: FinancialBasis; amountCents: number | null; billingDay: number | null; paymentTerms: string | null; adjustmentRule: string | null; notes: string | null;
}

const isDate = (v: string | null | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function checkService(s: ServiceInput, prefix = ''): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (s.description.trim().length < 3) p.push({ path: `${prefix}description`, message: 'Descreva o serviço (mínimo 3 caracteres).' });
  if (!Number.isFinite(s.quantity) || s.quantity <= 0 || s.quantity > 10_000) p.push({ path: `${prefix}quantity`, message: 'Quantidade prevista: número maior que zero.' });
  else if (s.unit !== 'horas' && !Number.isInteger(s.quantity)) p.push({ path: `${prefix}quantity`, message: 'Visitas e entregas são contadas em números inteiros.' });
  else if (Math.round(s.quantity * 4) !== s.quantity * 4) p.push({ path: `${prefix}quantity`, message: 'Horas em frações de 15 minutos (0,25).' });
  return p;
}

export function checkContract(c: ContractInput, opts: { signing?: boolean } = {}): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (c.title.trim().length < 3) p.push({ path: 'title', message: 'Informe o objeto do contrato (mínimo 3 caracteres).' });
  if (c.startsOn && !isDate(c.startsOn)) p.push({ path: 'startsOn', message: 'Data de início inválida.' });
  if (c.endsOn && !isDate(c.endsOn)) p.push({ path: 'endsOn', message: 'Data de término inválida.' });
  if (c.startsOn && c.endsOn && c.endsOn < c.startsOn) p.push({ path: 'endsOn', message: 'O término não pode ser anterior ao início.' });
  if (!Number.isInteger(c.renewalNoticeDays) || c.renewalNoticeDays < 0 || c.renewalNoticeDays > 365) p.push({ path: 'renewalNoticeDays', message: 'Aviso de vencimento: de 0 a 365 dias.' });
  if (opts.signing) {
    if (!c.startsOn) p.push({ path: 'startsOn', message: 'Informe o início da vigência para registrar a assinatura.' });
    if (!c.services.length) p.push({ path: 'services', message: 'Inclua ao menos um serviço antes de registrar a assinatura.' });
  }
  c.services.forEach((s, i) => p.push(...checkService(s, `services.${i}.`)));
  return p;
}

export function checkAmendment(a: AmendmentInput, contract: { startsOn: IsoDate | null; endsOn: IsoDate | null }): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (!a.kinds.length) p.push({ path: 'kinds', message: 'Marque o que o aditivo altera.' });
  if (a.description.trim().length < 10) p.push({ path: 'description', message: 'Descreva o aditivo (mínimo 10 caracteres).' });
  if (!isDate(a.signedOn)) p.push({ path: 'signedOn', message: 'Informe a data de assinatura.' });
  if (!isDate(a.effectiveOn)) p.push({ path: 'effectiveOn', message: 'Informe a data de efeito.' });
  else if (contract.startsOn && a.effectiveOn < contract.startsOn) p.push({ path: 'effectiveOn', message: 'O efeito não pode ser anterior ao início do contrato.' });
  if (a.newEndsOn && isDate(a.effectiveOn) && a.newEndsOn < a.effectiveOn) p.push({ path: 'newEndsOn', message: 'O novo término não pode ser anterior ao efeito do aditivo.' });
  const changes = a.newEndsOn !== undefined || a.autoRenew !== undefined || a.addServices.length || a.changeServices.length || a.endServices.length;
  if ((a.kinds.includes('prazo') || a.kinds.includes('renovacao')) && a.newEndsOn === undefined) p.push({ path: 'newEndsOn', message: 'Informe o novo término (prazo ou renovação).' });
  else if (!changes && !a.kinds.every((k) => k === 'valor' || k === 'outro')) p.push({ path: 'kinds', message: 'Informe a alteração de prazo ou de serviços que o aditivo faz.' });
  a.addServices.forEach((s, i) => p.push(...checkService(s, `addServices.${i}.`)));
  a.changeServices.forEach((s, i) => {
    if (!Number.isFinite(s.quantity) || s.quantity <= 0) p.push({ path: `changeServices.${i}.quantity`, message: 'Quantidade prevista: número maior que zero.' });
  });
  const touched = [...a.changeServices.map((s) => s.id), ...a.endServices];
  if (new Set(touched).size !== touched.length) p.push({ path: 'changeServices', message: 'Um mesmo serviço não pode ser alterado e encerrado no mesmo aditivo.' });
  return p;
}

export function checkDelivery(d: DeliveryInput, unit: ServiceUnit): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (d.description.trim().length < 3) p.push({ path: 'description', message: 'Descreva o que foi entregue.' });
  if (!Number.isFinite(d.quantity) || d.quantity <= 0 || d.quantity > 1000) p.push({ path: 'quantity', message: 'Quantidade: número maior que zero.' });
  else if (unit !== 'horas' && !Number.isInteger(d.quantity)) p.push({ path: 'quantity', message: 'Visitas e entregas são contadas em números inteiros.' });
  return p;
}

export function checkFinancial(f: FinancialInput): FieldProblem[] {
  const p: FieldProblem[] = [];
  if (f.amountCents != null && (!Number.isInteger(f.amountCents) || f.amountCents < 0 || f.amountCents > 100_000_000_00)) p.push({ path: 'amountCents', message: 'Valor inválido.' });
  if (f.billingDay != null && (!Number.isInteger(f.billingDay) || f.billingDay < 1 || f.billingDay > 31)) p.push({ path: 'billingDay', message: 'Dia de faturamento: de 1 a 31.' });
  return p;
}

/** "R$ 1.234,56" → 123456 cents (null when empty or not a number). */
export function parseMoney(text: string): number | null {
  const t = text.replace(/[R$\s]/g, '');
  if (!t) return null;
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}
export const formatMoney = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/* ---------- Contract state over time ---------- */

/** Status shown to people: a signed contract past its end is "vencido" until it is renewed or closed. */
export type ContractSituation = ContractStatus | 'vencido';
export const CONTRACT_SITUATION_LABEL: Record<ContractSituation, string> = { ...CONTRACT_STATUS_LABEL, vencido: 'Vencido' };
export function contractSituation(c: { status: ContractStatus; endsOn: IsoDate | null }, today: IsoDate): ContractSituation {
  if ((c.status === 'vigente' || c.status === 'suspenso') && c.endsOn && c.endsOn < today) return 'vencido';
  return c.status;
}

/** Days until the end of the contract (negative after it), or null when it has no end. */
export const daysToEnd = (endsOn: IsoDate | null, today: IsoDate) => (endsOn ? dayDiff(today, endsOn) : null);

export type ExpiryState = 'sem_termino' | 'em_dia' | 'vencendo' | 'vencido';
export function contractExpiry(c: { status: ContractStatus; endsOn: IsoDate | null; renewalNoticeDays: number }, today: IsoDate): ExpiryState | null {
  if (c.status !== 'vigente' && c.status !== 'suspenso') return null;
  const days = daysToEnd(c.endsOn, today);
  if (days == null) return 'sem_termino';
  if (days < 0) return 'vencido';
  return days <= c.renewalNoticeDays ? 'vencendo' : 'em_dia';
}

/* ---------- Planned × done ---------- */

export interface PlanPeriod { start: IsoDate; end: IsoDate }

/**
 * Periods of a service line, anchored at its start: [start, start + n months) for periodic lines
 * and a single period for "no contrato". `end` is exclusive.
 */
export function servicePeriodAt(period: ServicePeriod, lineStart: IsoDate, lineEnd: IsoDate | null, day: IsoDate): PlanPeriod | null {
  const months = SERVICE_PERIOD_MONTHS[period];
  const endExclusive = lineEnd ? addDays(lineEnd, 1) : null;
  if (day < lineStart || (endExclusive && day >= endExclusive)) return null;
  if (months == null) return { start: lineStart, end: endExclusive ?? '9999-12-31' };
  let i = Math.max(0, Math.floor(monthsBetween(lineStart, day) / months) - 1);
  for (;; i++) {
    const start = shiftMonths(lineStart, i * months);
    const end = shiftMonths(lineStart, (i + 1) * months);
    if (day >= start && day < end) return { start, end: endExclusive && endExclusive < end ? endExclusive : end };
  }
}

/** The same day of the month `n` months later (clamped to the last day of a shorter month). */
export function shiftMonths(iso: IsoDate, n: number): IsoDate {
  const first = addMonths(iso, n);
  const day = Number(iso.slice(8, 10));
  const lastDay = Number(addDays(addMonths(first, 1), -1).slice(8, 10));
  return `${first.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}
const monthsBetween = (a: IsoDate, b: IsoDate) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

export interface PlanVsDone {
  /** Period containing the reference day (null when the line is not active on that day). */
  current: (PlanPeriod & { planned: number; done: number }) | null;
  /** Periods already closed (end ≤ reference day): what was planned and what was delivered in them. */
  closedPeriods: number;
  plannedClosed: number;
  doneClosed: number;
  /** Last closed period, with its own planned and done. */
  lastClosed: (PlanPeriod & { planned: number; done: number }) | null;
  /** Everything delivered on the line until the reference day. */
  doneTotal: number;
}

/**
 * Planned × done of one service line on a reference day. Planned = the line's quantity in each
 * period; done = the deliveries registered with a date inside the period. A partial last period
 * (line ended before the period's natural end) keeps the full quantity: the contract states the
 * frequency, the system does not prorate it.
 */
export function planVsDone(line: { quantity: number; period: ServicePeriod; startsOn: IsoDate; endsOn: IsoDate | null }, deliveries: Array<{ occurredOn: IsoDate; quantity: number }>, today: IsoDate): PlanVsDone {
  const sum = (from: IsoDate, to: IsoDate) => round(deliveries.filter((d) => d.occurredOn >= from && d.occurredOn < to).reduce((s, d) => s + d.quantity, 0));
  const doneTotal = round(deliveries.filter((d) => d.occurredOn <= today).reduce((s, d) => s + d.quantity, 0));
  const cur = servicePeriodAt(line.period, line.startsOn, line.endsOn, today);
  const current = cur ? { ...cur, planned: line.quantity, done: sum(cur.start, cur.end) } : null;
  const months = SERVICE_PERIOD_MONTHS[line.period];
  const lineEndExclusive = line.endsOn ? addDays(line.endsOn, 1) : null;
  let closedPeriods = 0;
  let doneClosed = 0;
  let lastClosed: PlanVsDone['lastClosed'] = null;
  if (today >= line.startsOn) {
    if (months == null) {
      if (lineEndExclusive && lineEndExclusive <= today) {
        closedPeriods = 1;
        doneClosed = sum(line.startsOn, lineEndExclusive);
        lastClosed = { start: line.startsOn, end: lineEndExclusive, planned: line.quantity, done: doneClosed };
      }
    } else {
      for (let i = 0; i < 1200; i++) {
        const start = shiftMonths(line.startsOn, i * months);
        if (lineEndExclusive && start >= lineEndExclusive) break;
        let end = shiftMonths(line.startsOn, (i + 1) * months);
        if (lineEndExclusive && lineEndExclusive < end) end = lineEndExclusive;
        if (end > today) break;
        closedPeriods++;
        const done = sum(start, end);
        doneClosed += done;
        lastClosed = { start, end, planned: line.quantity, done };
      }
    }
  }
  return { current, closedPeriods, plannedClosed: round(closedPeriods * line.quantity), doneClosed: round(doneClosed), lastClosed, doneTotal };
}
const round = (n: number) => Math.round(n * 100) / 100;

/** Share of the planned that was done (0–100+), or null when nothing was planned yet. */
export const fulfillment = (planned: number, done: number) => (planned > 0 ? Math.round((done / planned) * 100) : null);

/** "4 visitas por mês". */
export function serviceFrequency(s: { quantity: number; unit: ServiceUnit; period: ServicePeriod }): string {
  const q = s.quantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  const unit = s.quantity === 1 ? { visitas: 'visita', horas: 'hora', entregas: 'entrega' }[s.unit] : SERVICE_UNIT_LABEL[s.unit];
  return `${q} ${unit} ${SERVICE_PERIOD_LABEL[s.period]}`;
}

/* ---------- Alerts ---------- */

export interface ContractAlertInput {
  today: IsoDate;
  contracts: Array<{ id: string; code: string; clientId: string; clientName: string; status: ContractStatus; endsOn: IsoDate | null; autoRenew: boolean; renewalNoticeDays: number }>;
  lines: Array<{ id: string; contractId: string; description: string; unit: ServiceUnit; quantity: number; period: ServicePeriod; startsOn: IsoDate; endsOn: IsoDate | null }>;
  deliveries: Array<{ serviceId: string; occurredOn: IsoDate; quantity: number }>;
}

/**
 * Contract alerts: end of term approaching (within the contract's notice window), term over with
 * the contract still open, and a closed period of a service line with fewer deliveries than planned.
 * Keys carry the end date or the period, so a renewal or a late delivery closes the alert by itself.
 */
export function buildContractAlertCandidates(input: ContractAlertInput): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const { today } = input;
  const byId = new Map(input.contracts.map((c) => [c.id, c]));
  for (const c of input.contracts) {
    const state = contractExpiry(c, today);
    const days = daysToEnd(c.endsOn, today);
    const link = `/consultoria/contratos/${c.id}`;
    const next = c.autoRenew ? 'Renovação automática prevista: registre o aditivo de renovação ou o encerramento.' : 'Negocie a renovação (aditivo) ou registre o encerramento.';
    if (state === 'vencendo' && days != null) {
      out.push({
        kind: 'contrato_vencendo', dedupKey: `contrato_vencendo:${c.id}:${c.endsOn}`, priority: days <= 15 ? 'alta' : 'media',
        title: `Contrato ${c.code} (${c.clientName}) ${days === 0 ? 'vence hoje' : `vence em ${days} dia(s)`}`, detail: next,
        entity: 'contract', entityId: c.id, sectorId: null, clientId: c.clientId, link, dueOn: c.endsOn,
      });
    } else if (state === 'vencido' && days != null) {
      out.push({
        kind: 'contrato_vencido', dedupKey: `contrato_vencido:${c.id}:${c.endsOn}`, priority: 'alta',
        title: `Contrato ${c.code} (${c.clientName}) vencido há ${-days} dia(s)`, detail: `O contrato segue aberto após o término. ${next}`,
        entity: 'contract', entityId: c.id, sectorId: null, clientId: c.clientId, link, dueOn: c.endsOn,
      });
    }
  }
  for (const line of input.lines) {
    const c = byId.get(line.contractId);
    if (!c || c.status !== 'vigente') continue;
    const plan = planVsDone(line, input.deliveries.filter((d) => d.serviceId === line.id), today);
    const last = plan.lastClosed;
    // Active lines, or lines that ended in the last 30 days (their last period is still being closed).
    if (!last || (!plan.current && last.end < addDays(today, -30))) continue;
    if (last.done >= last.planned) continue;
    out.push({
      kind: 'contrato_entregas_abaixo', dedupKey: `contrato_entregas_abaixo:${line.id}:${last.start}`, priority: 'media',
      title: `${c.code} (${c.clientName}): ${line.description} — ${fmt(last.done)} de ${fmt(last.planned)} ${SERVICE_UNIT_LABEL[line.unit]} no período`,
      detail: `Período de ${last.start} a ${addDays(last.end, -1)} encerrado abaixo do previsto. Registre as entregas que faltam ou ajuste o escopo por aditivo.`,
      entity: 'contract_service', entityId: line.id, sectorId: null, clientId: c.clientId, link: `/consultoria/contratos/${c.id}`, dueOn: addDays(last.end, -1),
    });
  }
  return out;
}
const fmt = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/* ---------- DTOs ---------- */

export interface ContractServiceDto {
  id: string; area: Specialty; kind: ServiceKind; description: string; establishmentId: string | null; establishmentName: string | null;
  unit: ServiceUnit; quantity: number; period: ServicePeriod; startsOn: IsoDate | null; endsOn: IsoDate | null;
  /** Line this one replaced through an amendment (new quantity or period). */
  replacesId: string | null; amendmentId: string | null;
  plan: PlanVsDone | null;
}
export interface DeliveryDto {
  id: string; serviceId: string; occurredOn: IsoDate; quantity: number; description: string; by: string; at: string;
  voidedAt: string | null; voidedBy: string | null; voidReason: string | null;
}
export interface AmendmentDto {
  id: string; number: number; kinds: AmendmentKind[]; description: string; signedOn: IsoDate; effectiveOn: IsoDate; changes: string[]; by: string; at: string;
}
export interface ContractFinancialDto extends FinancialInput { updatedAt: string | null; updatedBy: string | null; rowVersion: number | null }
export interface ContractSummaryDto {
  id: string; code: string; title: string; clientId: string; clientName: string; status: ContractStatus; situation: ContractSituation;
  startsOn: IsoDate | null; endsOn: IsoDate | null; autoRenew: boolean; renewalNoticeDays: number; expiry: ExpiryState | null; daysToEnd: number | null;
  services: number; amendments: number; responsible: string | null;
  /** Planned × done of the periods already closed, over all active lines (null = nothing planned yet). */
  plannedClosed: number; doneClosed: number; dataOrigin: 'real' | 'demo';
}
export interface ContractHistoryDto { id: string; summary: string; detail: string | null; occurredOn: IsoDate; by: string; at: string }
export interface ContractDetailDto extends ContractSummaryDto {
  scopeNotes: string | null; signedOn: IsoDate | null; closedOn: IsoDate | null; closeReason: string | null; responsibleId: string | null;
  rowVersion: number; createdAt: string; updatedAt: string;
  serviceLines: ContractServiceDto[]; deliveries: DeliveryDto[]; amendmentList: AmendmentDto[]; history: ContractHistoryDto[];
  /** Present only for profiles allowed to see the financial terms. */
  financial?: ContractFinancialDto | null;
  establishments: Array<{ id: string; name: string }>;
}
