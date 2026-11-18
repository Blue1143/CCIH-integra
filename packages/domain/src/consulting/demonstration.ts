import type { IndicatorTarget } from '../config';
import { addDays, addMonths, monthLabel, monthLongLabel, type IsoDate } from '../dates';
import { formatNumber, formatSigned } from '../format';
import { getIndicator } from '../indicators/catalog';
import { computeIndicator, sumCounts, type FactRow } from '../indicators/engine';
import type { IndicatorComputation, IndicatorDefinition, MetricKey } from '../indicators/types';
import { compareWithPrevious, evaluateTarget, roundTrend, type TargetEvaluation, type Trend } from '../rules/target';
import type { Status } from '../status';

/**
 * "Consultoria — Demonstração": a self-contained academic demonstration of a consulting panel
 * in infection prevention and control. Every name and number is fictitious. This module holds
 * the types and the pure, deterministic selectors; overview cards, charts and reports all read
 * through them so they can never disagree. Indicator values come only from the indicator engine.
 */

export const DEMO_CONSULTING_NOTICE = 'Ambiente demonstrativo — dados fictícios, sem uso assistencial.';
export const FICTITIOUS_TARGET_LABEL = 'Meta fictícia';

/* ---------- Data shapes ---------- */

export interface DemoUnit {
  id: string;
  name: string;
}

export interface DemoInstitution {
  id: string;
  name: string;
  /** Short description of the fictitious profile (size, care profile). */
  profile: string;
  beds: number;
  consultant: string;
  units: DemoUnit[];
}

export type ChecklistDomain = 'vigilancia' | 'protocolos' | 'capacitacao' | 'registros';
export const CHECKLIST_DOMAIN_LABEL: Record<ChecklistDomain, string> = {
  vigilancia: 'Vigilância',
  protocolos: 'Protocolos',
  capacitacao: 'Capacitação',
  registros: 'Organização dos registros',
};
export const CHECKLIST_DOMAINS = Object.keys(CHECKLIST_DOMAIN_LABEL) as ChecklistDomain[];

export interface ChecklistItem {
  id: string;
  domain: ChecklistDomain;
  text: string;
}

export type ChecklistAnswer = 'conforme' | 'parcial' | 'nao_conforme' | 'nao_se_aplica';
export const CHECKLIST_ANSWERS: ChecklistAnswer[] = ['conforme', 'parcial', 'nao_conforme', 'nao_se_aplica'];
export const CHECKLIST_ANSWER_LABEL: Record<ChecklistAnswer, string> = {
  conforme: 'Conforme',
  parcial: 'Parcialmente conforme',
  nao_conforme: 'Não conforme',
  nao_se_aplica: 'Não se aplica',
};
export const CHECKLIST_ANSWER_STATUS: Record<ChecklistAnswer, Status> = { conforme: 'ok', parcial: 'warn', nao_conforme: 'crit', nao_se_aplica: 'neutral' };

export interface ChecklistResponse {
  itemId: string;
  answer: ChecklistAnswer | null;
  observation: string;
  /** Simulated evidence (description only; no file is stored). */
  evidence: string;
}

export type AssessmentStatus = 'em_andamento' | 'concluida';
export const ASSESSMENT_STATUS_LABEL: Record<AssessmentStatus, string> = { em_andamento: 'Em andamento', concluida: 'Concluída' };

export interface DemoAssessment {
  id: string;
  institutionId: string;
  /** null = the whole institution. */
  unitId: string | null;
  date: IsoDate;
  status: AssessmentStatus;
  responses: ChecklistResponse[];
}

export type ActionPriority = 'alta' | 'media' | 'baixa';
export const ACTION_PRIORITY_LABEL: Record<ActionPriority, string> = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
export const ACTION_PRIORITY_RANK: Record<ActionPriority, number> = { alta: 0, media: 1, baixa: 2 };

/** Situation recorded by the user. "Atrasada" is never recorded: it is derived from the deadline. */
export type ActionSituation = 'pendente' | 'em_andamento' | 'concluida';
export const ACTION_SITUATION_LABEL: Record<ActionSituation, string> = { pendente: 'Pendente', em_andamento: 'Em andamento', concluida: 'Concluída' };

export type DemoActionStatus = ActionSituation | 'atrasada';
export const DEMO_ACTION_STATUSES: DemoActionStatus[] = ['pendente', 'em_andamento', 'atrasada', 'concluida'];
export const DEMO_ACTION_STATUS_LABEL: Record<DemoActionStatus, string> = { ...ACTION_SITUATION_LABEL, atrasada: 'Atrasada' };
export const DEMO_ACTION_STATUS_TONE: Record<DemoActionStatus, Status> = { pendente: 'info', em_andamento: 'warn', atrasada: 'crit', concluida: 'ok' };

export interface DemoAction {
  id: string;
  institutionId: string;
  unitId: string | null;
  /** Finding that originated the action: `<assessmentId>:<itemId>`. */
  findingId: string;
  problem: string;
  action: string;
  responsible: string;
  createdAt: IsoDate;
  deadline: IsoDate;
  priority: ActionPriority;
  situation: ActionSituation;
  completedAt: IsoDate | null;
}

export interface DemoReportRecord {
  id: string;
  institutionId: string;
  unitId: string | null;
  from: string;
  to: string;
  issuedAt: IsoDate;
}

export interface DemoConsultingState {
  version: 1;
  origin: 'demonstracao';
  /** Day the dataset was generated; deadlines and "atrasada" are judged against it. */
  referenceDate: IsoDate;
  /** The six month starts of the synthetic series, oldest first. */
  periods: string[];
  institutions: DemoInstitution[];
  /** Monthly counts per unit (FactRow.sectorId = unit id). A missing row is missing data, never zero. */
  facts: FactRow[];
  /** Fictitious targets, for the demonstration only (origin 'demonstracao'). */
  targets: IndicatorTarget[];
  checklist: ChecklistItem[];
  assessments: DemoAssessment[];
  actions: DemoAction[];
  reports: DemoReportRecord[];
}

/* ---------- Filters ---------- */

export interface DemoFilter {
  /** null = whole portfolio. */
  institutionId: string | null;
  unitId: string | null;
  /** Inclusive month starts within state.periods. */
  from: string;
  to: string;
}

export function periodsBetween(state: DemoConsultingState, from: string, to: string): string[] {
  return state.periods.filter((p) => p >= from && p <= to);
}

/** Last day of the month that starts at `monthStartIso`. */
export const monthEnd = (monthStartIso: string): IsoDate => addDays(addMonths(monthStartIso, 1), -1);

/**
 * Last day covered by a window. A window that reaches the last month of the series also covers
 * the days up to the reference date, so what is recorded "today" shows in the current view.
 */
export function windowEnd(state: DemoConsultingState, f: Pick<DemoFilter, 'to'>): IsoDate {
  const end = monthEnd(f.to);
  return f.to === state.periods[state.periods.length - 1] && state.referenceDate > end ? state.referenceDate : end;
}

export function periodLabel(from: string, to: string): string {
  return from === to ? monthLongLabel(from) : `${monthLongLabel(from)} a ${monthLongLabel(to)}`;
}

/** Normalizes a filter against the dataset: unknown ids are dropped and the window is clamped. */
export function normalizeFilter(state: DemoConsultingState, raw: Partial<Record<'institutionId' | 'unitId' | 'from' | 'to', string | null>>): DemoFilter {
  const first = state.periods[0]!;
  const last = state.periods[state.periods.length - 1]!;
  const inst = state.institutions.find((i) => i.id === raw.institutionId) ?? null;
  const unit = inst?.units.find((u) => u.id === raw.unitId) ?? null;
  let from = raw.from && state.periods.includes(raw.from) ? raw.from : first;
  let to = raw.to && state.periods.includes(raw.to) ? raw.to : last;
  if (from > to) [from, to] = [to, from];
  return { institutionId: inst?.id ?? null, unitId: unit?.id ?? null, from, to };
}

export function institutionOf(state: DemoConsultingState, id: string | null): DemoInstitution | undefined {
  return id ? state.institutions.find((i) => i.id === id) : undefined;
}

export function unitName(state: DemoConsultingState, unitId: string | null): string {
  if (!unitId) return 'Toda a instituição';
  for (const i of state.institutions) {
    const u = i.units.find((x) => x.id === unitId);
    if (u) return u.name;
  }
  return 'Unidade';
}

/** Units (sector ids of the facts) covered by the filter. */
export function unitScope(state: DemoConsultingState, f: Pick<DemoFilter, 'institutionId' | 'unitId'>): string[] {
  if (f.unitId) return [f.unitId];
  const insts = f.institutionId ? state.institutions.filter((i) => i.id === f.institutionId) : state.institutions;
  return insts.flatMap((i) => i.units.map((u) => u.id));
}

const unitMatches = (f: Pick<DemoFilter, 'institutionId' | 'unitId'>, institutionId: string, unitId: string | null) =>
  (!f.institutionId || f.institutionId === institutionId) && (!f.unitId || unitId == null || unitId === f.unitId);

/* ---------- Indicators (device-associated infections) ---------- */

/** Device-associated scope available in the catalog: densities and device utilization. */
export const DEVICE_INDICATOR_IDS = ['di-ipcs', 'di-pav', 'di-itu', 'tu-cvc', 'tu-vm', 'tu-svd'] as const;
export const DEVICE_DENSITY_IDS = ['di-ipcs', 'di-pav', 'di-itu'] as const;

export function formulaText(def: IndicatorDefinition): string {
  if (!def.denominator) return `${def.numerator.label}${def.multiplier !== 1 ? ` × ${formatNumber(def.multiplier)}` : ''}`;
  return `(${def.numerator.label} ÷ ${def.denominator.label}) × ${formatNumber(def.multiplier)}`;
}

/** A gap in the data: a unit with no row in a month, or a row without the metric. */
export interface DataGap {
  unitId: string;
  period: string;
  metric: MetricKey;
}

export interface MonthPoint {
  period: string;
  label: string;
  result: IndicatorComputation;
  gaps: DataGap[];
}

export interface PeriodComparison {
  periods: string[];
  label: string;
  result: IndicatorComputation;
  gaps: DataGap[];
}

export interface IndicatorView {
  id: string;
  def: IndicatorDefinition;
  formula: string;
  current: PeriodComparison;
  /** Window of the same length right before the current one, when the series has it. */
  previous: PeriodComparison | null;
  /** Why there is no comparison, when there is none. */
  noComparisonReason: string | null;
  trend: Trend;
  target: IndicatorTarget | undefined;
  evaluation: TargetEvaluation;
  /** Every month of the six-month series, for charts and the month-by-month table. */
  series: MonthPoint[];
}

const metricsOf = (def: IndicatorDefinition): MetricKey[] => [def.numerator.metric, ...(def.denominator ? [def.denominator.metric] : [])];

function gapsFor(state: DemoConsultingState, def: IndicatorDefinition, periods: string[], units: string[]): DataGap[] {
  const gaps: DataGap[] = [];
  for (const period of periods) {
    for (const unitId of units) {
      const row = state.facts.find((r) => r.period === period && r.sectorId === unitId);
      for (const metric of metricsOf(def)) if (row?.counts[metric] == null) gaps.push({ unitId, period, metric });
    }
  }
  return gaps;
}

/**
 * Value of an indicator over a window: the counts of every unit and month are summed first and
 * the rate is computed once (never an average of rates). Units or months without data are left
 * out of the sums and reported as gaps.
 */
export function computeWindow(state: DemoConsultingState, def: IndicatorDefinition, periods: string[], units: string[]): PeriodComparison {
  const rows = state.facts.filter((r) => periods.includes(r.period) && units.includes(r.sectorId));
  const result = rows.length ? computeIndicator(def, sumCounts(rows.map((r) => r.counts))) : ({ kind: 'sem_dado', value: null, numerator: null, denominator: null } as const);
  return { periods, label: periods.length ? periodLabel(periods[0]!, periods[periods.length - 1]!) : '—', result, gaps: gapsFor(state, def, periods, units) };
}

export function findDemoTarget(state: DemoConsultingState, indicatorId: string): IndicatorTarget | undefined {
  return state.targets.find((t) => t.indicatorId === indicatorId);
}

/** In the demonstration every target is fictitious, so the absence of one is named that way. */
const relabelNoTarget = (e: TargetEvaluation): TargetEvaluation => (e.result === 'sem_meta' ? { ...e, label: 'Sem meta fictícia' } : e);

export function indicatorView(state: DemoConsultingState, f: DemoFilter, id: string): IndicatorView {
  const def = getIndicator(id);
  const units = unitScope(state, f);
  const windowPeriods = periodsBetween(state, f.from, f.to);
  const current = computeWindow(state, def, windowPeriods, units);
  const firstIndex = state.periods.indexOf(f.from);
  const len = windowPeriods.length;
  let previous: PeriodComparison | null = null;
  let noComparisonReason: string | null = null;
  if (firstIndex - len >= 0) previous = computeWindow(state, def, state.periods.slice(firstIndex - len, firstIndex), units);
  else noComparisonReason = `A série demonstrativa não tem ${len === 1 ? 'o mês anterior' : `os ${len} meses anteriores`} a ${periodLabel(f.from, f.to)}.`;
  const target = findDemoTarget(state, id);
  return {
    id,
    def,
    formula: formulaText(def),
    current,
    previous,
    noComparisonReason,
    trend: previous ? roundTrend(compareWithPrevious(current.result.value, previous.result.value, def.direction), def.decimals) : { delta: null, improved: null },
    target,
    evaluation: relabelNoTarget(evaluateTarget(current.result.value, target)),
    series: state.periods.map((period) => {
      const w = computeWindow(state, def, [period], units);
      return { period, label: monthLabel(period), result: w.result, gaps: w.gaps };
    }),
  };
}

export function indicatorViews(state: DemoConsultingState, f: DemoFilter, ids: readonly string[] = DEVICE_INDICATOR_IDS): IndicatorView[] {
  return ids.map((id) => indicatorView(state, f, id));
}

/** "2 IPCS confirmadas / 480 cateter central-dia" or the reason why there is no value. */
export function describeComputation(def: IndicatorDefinition, r: IndicatorComputation): string {
  if (r.kind === 'sem_dado') return 'sem dados no período';
  if (r.kind === 'denominador_zero') return `${formatNumber(r.numerator)} ${def.numerator.label} / 0 ${def.denominator?.label ?? ''} — denominador zero, taxa não calculada`;
  if (!def.denominator) return `${formatNumber(r.numerator)} ${def.numerator.label}`;
  return `${formatNumber(r.numerator)} ${def.numerator.label} / ${formatNumber(r.denominator)} ${def.denominator.label}`;
}

export function formatValue(def: IndicatorDefinition, r: IndicatorComputation): string {
  return r.value == null ? (r.kind === 'denominador_zero' ? 'Denominador zero' : 'Sem dado') : `${formatNumber(r.value, def.decimals)} ${def.unit}`;
}

export function describeGaps(state: DemoConsultingState, gaps: DataGap[]): string[] {
  const seen = new Map<string, string[]>();
  for (const g of gaps) {
    const key = `${unitName(state, g.unitId)} — ${monthLabel(g.period)}`;
    const list = seen.get(key) ?? [];
    if (!list.includes(g.metric)) list.push(g.metric);
    seen.set(key, list);
  }
  return [...seen.keys()];
}

/* ---------- Diagnosis (checklist) ---------- */

export interface Finding {
  id: string;
  institutionId: string;
  unitId: string | null;
  assessmentId: string;
  assessmentDate: IsoDate;
  item: ChecklistItem;
  answer: Extract<ChecklistAnswer, 'parcial' | 'nao_conforme'>;
  observation: string;
  evidence: string;
}

export const findingId = (assessmentId: string, itemId: string) => `${assessmentId}:${itemId}`;

/** Every partially conforming or non-conforming answer is a finding. */
export function findingsOf(state: DemoConsultingState, assessment: DemoAssessment): Finding[] {
  const out: Finding[] = [];
  for (const r of assessment.responses) {
    if (r.answer !== 'parcial' && r.answer !== 'nao_conforme') continue;
    const item = state.checklist.find((c) => c.id === r.itemId);
    if (!item) continue;
    out.push({
      id: findingId(assessment.id, r.itemId), institutionId: assessment.institutionId, unitId: assessment.unitId, assessmentId: assessment.id, assessmentDate: assessment.date,
      item, answer: r.answer, observation: r.observation, evidence: r.evidence,
    });
  }
  return out;
}

export function findingById(state: DemoConsultingState, id: string): Finding | undefined {
  const [assessmentId] = id.split(':');
  const a = state.assessments.find((x) => x.id === assessmentId);
  return a ? findingsOf(state, a).find((f) => f.id === id) : undefined;
}

export interface ChecklistScore {
  total: number;
  answered: number;
  unanswered: number;
  counts: Record<ChecklistAnswer, number>;
  /** Items that apply (answered and not "não se aplica"). */
  applicable: number;
  /** conforme ÷ applicable × 100; null when nothing applicable was answered. */
  conformPercent: number | null;
}

export const CHECKLIST_SCORE_FORMULA = '(itens conformes ÷ itens aplicáveis respondidos) × 100 — itens parciais não contam como conformes; "não se aplica" e itens sem resposta ficam fora do denominador.';

export function scoreResponses(responses: ChecklistResponse[]): ChecklistScore {
  const counts: Record<ChecklistAnswer, number> = { conforme: 0, parcial: 0, nao_conforme: 0, nao_se_aplica: 0 };
  for (const r of responses) if (r.answer) counts[r.answer]++;
  const answered = counts.conforme + counts.parcial + counts.nao_conforme + counts.nao_se_aplica;
  const applicable = answered - counts.nao_se_aplica;
  return { total: responses.length, answered, unanswered: responses.length - answered, counts, applicable, conformPercent: applicable ? (counts.conforme / applicable) * 100 : null };
}

export function scoreByDomain(state: DemoConsultingState, assessment: DemoAssessment): Array<{ domain: ChecklistDomain; score: ChecklistScore }> {
  return CHECKLIST_DOMAINS.map((domain) => ({
    domain,
    score: scoreResponses(assessment.responses.filter((r) => state.checklist.find((c) => c.id === r.itemId)?.domain === domain)),
  }));
}

export function assessmentsIn(state: DemoConsultingState, f: DemoFilter): DemoAssessment[] {
  const end = windowEnd(state, f);
  return state.assessments
    .filter((a) => unitMatches(f, a.institutionId, a.unitId) && a.date >= f.from && a.date <= end)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Most recent assessment of an institution (any date), the one the diagnosis starts from. */
export function latestAssessment(state: DemoConsultingState, institutionId: string, unitId: string | null = null): DemoAssessment | undefined {
  return state.assessments
    .filter((a) => a.institutionId === institutionId && (!unitId || a.unitId == null || a.unitId === unitId))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}

/* ---------- Action plans ---------- */

export function demoActionStatus(a: DemoAction, referenceDate: IsoDate): DemoActionStatus {
  if (a.situation === 'concluida') return 'concluida';
  return a.deadline < referenceDate ? 'atrasada' : a.situation;
}

/** Actions alive during the window: created before its end and not completed before its start. */
export function actionsIn(state: DemoConsultingState, f: DemoFilter): DemoAction[] {
  const end = windowEnd(state, f);
  return state.actions
    .filter((a) => unitMatches(f, a.institutionId, a.unitId) && a.createdAt <= end && (a.completedAt == null || a.completedAt >= f.from))
    .sort((a, b) => ACTION_PRIORITY_RANK[a.priority] - ACTION_PRIORITY_RANK[b.priority] || a.deadline.localeCompare(b.deadline));
}

export function countByStatus(actions: DemoAction[], referenceDate: IsoDate): Record<DemoActionStatus, number> {
  const out: Record<DemoActionStatus, number> = { pendente: 0, em_andamento: 0, atrasada: 0, concluida: 0 };
  for (const a of actions) out[demoActionStatus(a, referenceDate)]++;
  return out;
}

export function reportsIn(state: DemoConsultingState, f: DemoFilter): DemoReportRecord[] {
  return state.reports
    .filter((r) => (!f.institutionId || r.institutionId === f.institutionId) && (!f.unitId || r.unitId == null || r.unitId === f.unitId) && r.to >= f.from && r.from <= f.to)
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

/* ---------- Pending items ---------- */

export type PendingKind = 'acao_atrasada' | 'acao_aberta' | 'achado_sem_acao' | 'item_sem_resposta' | 'dado_ausente';
export const PENDING_KIND_LABEL: Record<PendingKind, string> = {
  acao_atrasada: 'Ação atrasada',
  acao_aberta: 'Ação em aberto',
  achado_sem_acao: 'Achado sem plano de ação',
  item_sem_resposta: 'Item do checklist sem resposta',
  dado_ausente: 'Dado de indicador ausente',
};

export interface PendingItem {
  kind: PendingKind;
  institutionId: string;
  text: string;
}

export function pendingItems(state: DemoConsultingState, f: DemoFilter): PendingItem[] {
  const out: PendingItem[] = [];
  const insts = f.institutionId ? state.institutions.filter((i) => i.id === f.institutionId) : state.institutions;
  for (const inst of insts) {
    const scope = { ...f, institutionId: inst.id };
    for (const a of actionsIn(state, scope)) {
      const s = demoActionStatus(a, state.referenceDate);
      if (s === 'atrasada') out.push({ kind: 'acao_atrasada', institutionId: inst.id, text: `${a.action} — prazo ${formatIso(a.deadline)}` });
      else if (s !== 'concluida') out.push({ kind: 'acao_aberta', institutionId: inst.id, text: `${a.action} — prazo ${formatIso(a.deadline)}` });
    }
    const latest = latestAssessment(state, inst.id, f.unitId);
    if (latest) {
      for (const finding of findingsOf(state, latest)) {
        if (!state.actions.some((a) => a.findingId === finding.id)) out.push({ kind: 'achado_sem_acao', institutionId: inst.id, text: finding.item.text });
      }
      for (const r of latest.responses) {
        if (r.answer == null) out.push({ kind: 'item_sem_resposta', institutionId: inst.id, text: state.checklist.find((c) => c.id === r.itemId)?.text ?? r.itemId });
      }
    }
    const units = unitScope(state, scope);
    const gaps = gapsFor(state, getIndicator('di-ipcs'), periodsBetween(state, f.from, f.to), units)
      .concat(gapsFor(state, getIndicator('di-pav'), periodsBetween(state, f.from, f.to), units))
      .concat(gapsFor(state, getIndicator('di-itu'), periodsBetween(state, f.from, f.to), units));
    for (const label of describeGaps(state, gaps)) out.push({ kind: 'dado_ausente', institutionId: inst.id, text: `Sem dados de numerador ou denominador: ${label}` });
  }
  return out;
}

/* ---------- Portfolio overview ---------- */

export interface InstitutionSummary {
  institution: DemoInstitution;
  pending: number;
  pendingByKind: Record<PendingKind, number>;
  assessments: number;
  assessmentsDone: number;
  actions: Record<DemoActionStatus, number>;
  actionsTotal: number;
  reports: number;
  /** Device densities outside their fictitious target in the window. */
  outsideTarget: string[];
  latestConformPercent: number | null;
}

export function institutionSummary(state: DemoConsultingState, f: DemoFilter, institutionId: string): InstitutionSummary {
  const institution = state.institutions.find((i) => i.id === institutionId)!;
  const scope: DemoFilter = { ...f, institutionId, unitId: f.institutionId === institutionId ? f.unitId : null };
  const pending = pendingItems(state, scope);
  const pendingByKind: Record<PendingKind, number> = { acao_atrasada: 0, acao_aberta: 0, achado_sem_acao: 0, item_sem_resposta: 0, dado_ausente: 0 };
  for (const p of pending) pendingByKind[p.kind]++;
  const assessments = assessmentsIn(state, scope);
  const actions = actionsIn(state, scope);
  const latest = latestAssessment(state, institutionId, scope.unitId);
  return {
    institution,
    pending: pending.length,
    pendingByKind,
    assessments: assessments.length,
    assessmentsDone: assessments.filter((a) => a.status === 'concluida').length,
    actions: countByStatus(actions, state.referenceDate),
    actionsTotal: actions.length,
    reports: reportsIn(state, scope).length,
    outsideTarget: indicatorViews(state, scope, DEVICE_DENSITY_IDS).filter((v) => v.evaluation.result === 'fora_da_meta').map((v) => v.def.shortName),
    latestConformPercent: latest ? scoreResponses(latest.responses).conformPercent : null,
  };
}

export interface PortfolioSummary {
  institutions: InstitutionSummary[];
  pending: number;
  assessments: number;
  assessmentsDone: number;
  actions: Record<DemoActionStatus, number>;
  actionsTotal: number;
  reports: number;
}

/** Totals are sums of the per-institution summaries, so the cards always add up. */
export function portfolioSummary(state: DemoConsultingState, f: DemoFilter): PortfolioSummary {
  const ids = f.institutionId ? [f.institutionId] : state.institutions.map((i) => i.id);
  const institutions = ids.map((id) => institutionSummary(state, f, id));
  const actions: Record<DemoActionStatus, number> = { pendente: 0, em_andamento: 0, atrasada: 0, concluida: 0 };
  for (const s of institutions) for (const k of DEMO_ACTION_STATUSES) actions[k] += s.actions[k];
  const sum = (pick: (s: InstitutionSummary) => number) => institutions.reduce((n, s) => n + pick(s), 0);
  return {
    institutions,
    pending: sum((s) => s.pending),
    assessments: sum((s) => s.assessments),
    assessmentsDone: sum((s) => s.assessmentsDone),
    actions,
    actionsTotal: sum((s) => s.actionsTotal),
    reports: sum((s) => s.reports),
  };
}

/* ---------- Rule-based summary (not AI) ---------- */

export const RULE_SUMMARY_LABEL = 'Resumo automático por regras (modelo de texto) — não gerado por inteligência artificial';
export const RULE_SUMMARY_METHOD =
  'Texto montado por regras fixas a partir dos mesmos números dos cartões e gráficos: valores, numeradores e denominadores, comparação com o período anterior, situação frente à meta fictícia, lacunas de dados, checklist e planos de ação. Não infere causas, não cita referências e não faz recomendações clínicas. Requer revisão profissional.';

export interface RuleSummary {
  observed: string[];
  missing: string[];
  forInvestigation: string[];
}

const formatIso = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function ruleSummary(state: DemoConsultingState, f: DemoFilter): RuleSummary {
  const observed: string[] = [];
  const missing: string[] = [];
  const forInvestigation: string[] = [];
  const views = indicatorViews(state, f);

  for (const v of views) {
    const { def, current, previous } = v;
    const cur = current.result;
    let line = `${def.shortName}: ${formatValue(def, cur)} (${describeComputation(def, cur)}) em ${current.label}`;
    if (previous) line += `; período anterior (${previous.label}): ${formatValue(def, previous.result)} (${describeComputation(def, previous.result)})`;
    if (v.trend.delta != null) line += `; variação ${formatSigned(v.trend.delta, def.decimals)} ${def.unit}`;
    if (v.target && cur.value != null) line += `; ${FICTITIOUS_TARGET_LABEL.toLowerCase()} ${v.target.direction === 'lower' ? '≤' : '≥'} ${formatNumber(v.target.value, def.decimals)} ${def.unit}: ${v.evaluation.label.toLowerCase()}`;
    observed.push(`${line}.`);

    if (cur.kind === 'denominador_zero') missing.push(`${def.shortName}: denominador zero (${def.denominator?.label ?? ''} = 0) em ${current.label}; a taxa não é calculada.`);
    if (cur.kind === 'sem_dado') missing.push(`${def.shortName}: nenhum dado de numerador ou denominador em ${current.label}.`);
    const gapLabels = describeGaps(state, current.gaps);
    if (gapLabels.length && cur.kind !== 'sem_dado') missing.push(`${def.shortName}: sem dados em ${gapLabels.join('; ')} — o valor do período considera só os meses e unidades com registro.`);
    if (!previous && v.noComparisonReason && def.id === views[0]?.def.id) missing.push(`Comparação entre períodos indisponível: ${v.noComparisonReason}`);

    if (DEVICE_DENSITY_IDS.includes(def.id as (typeof DEVICE_DENSITY_IDS)[number])) {
      if (v.trend.improved === false && previous) {
        forInvestigation.push(`${def.shortName} passou de ${formatValue(def, previous.result)} para ${formatValue(def, cur)}: a variação exige conferência dos registros de numerador e denominador e investigação pela equipe antes de qualquer conclusão.`);
      }
      if (v.evaluation.result === 'fora_da_meta') {
        forInvestigation.push(`${def.shortName} está fora da ${FICTITIOUS_TARGET_LABEL.toLowerCase()} da demonstração: verificar se o resultado se confirma após a validação dos dados.`);
      }
    }
  }

  const insts = f.institutionId ? state.institutions.filter((i) => i.id === f.institutionId) : state.institutions;
  for (const inst of insts) {
    const latest = latestAssessment(state, inst.id, f.unitId);
    const prefix = insts.length > 1 ? `${inst.name}: ` : '';
    if (!latest) {
      missing.push(`${prefix}nenhuma avaliação de diagnóstico registrada.`);
      continue;
    }
    const s = scoreResponses(latest.responses);
    observed.push(
      `${prefix}diagnóstico de ${formatIso(latest.date)} (${ASSESSMENT_STATUS_LABEL[latest.status].toLowerCase()}): ${s.counts.conforme} conforme(s), ${s.counts.parcial} parcialmente conforme(s), ${s.counts.nao_conforme} não conforme(s), ${s.counts.nao_se_aplica} não se aplica` +
        (s.conformPercent != null ? `; ${formatNumber(s.conformPercent, 0)}% de conformidade entre ${s.applicable} itens aplicáveis.` : '.'),
    );
    if (s.unanswered) missing.push(`${prefix}${s.unanswered} item(ns) do checklist sem resposta na avaliação de ${formatIso(latest.date)}.`);
    for (const finding of findingsOf(state, latest)) {
      if (!state.actions.some((a) => a.findingId === finding.id)) forInvestigation.push(`${prefix}achado sem plano de ação: "${finding.item.text}" (${CHECKLIST_ANSWER_LABEL[finding.answer].toLowerCase()}).`);
    }
  }

  const actions = actionsIn(state, f);
  const c = countByStatus(actions, state.referenceDate);
  observed.push(`Planos de ação no período: ${actions.length} ação(ões) — ${c.pendente} pendente(s), ${c.em_andamento} em andamento, ${c.atrasada} atrasada(s) e ${c.concluida} concluída(s), na data de referência ${formatIso(state.referenceDate)}.`);
  for (const a of actions) {
    if (demoActionStatus(a, state.referenceDate) === 'atrasada') forInvestigation.push(`Ação atrasada desde ${formatIso(a.deadline)}: "${a.action}" (responsável fictício: ${a.responsible}).`);
  }
  return { observed, missing, forInvestigation };
}

/* ---------- Report ---------- */

export interface ConsultingReport {
  institution: DemoInstitution | undefined;
  scopeLabel: string;
  periodLabel: string;
  referenceDate: IsoDate;
  indicators: IndicatorView[];
  assessment: DemoAssessment | undefined;
  score: ChecklistScore | undefined;
  domainScores: Array<{ domain: ChecklistDomain; score: ChecklistScore }>;
  findings: Array<Finding & { actions: DemoAction[] }>;
  pending: PendingItem[];
  actions: DemoAction[];
  summary: RuleSummary;
}

/** One structure for the report preview, its print and its export. */
export function buildReport(state: DemoConsultingState, f: DemoFilter): ConsultingReport {
  const institution = institutionOf(state, f.institutionId);
  const assessment = institution ? latestAssessment(state, institution.id, f.unitId) : undefined;
  return {
    institution,
    scopeLabel: institution ? `${institution.name} · ${unitName(state, f.unitId)}` : 'Carteira completa',
    periodLabel: periodLabel(f.from, f.to),
    referenceDate: state.referenceDate,
    indicators: indicatorViews(state, f),
    assessment,
    score: assessment ? scoreResponses(assessment.responses) : undefined,
    domainScores: assessment ? scoreByDomain(state, assessment) : [],
    findings: assessment ? findingsOf(state, assessment).map((x) => ({ ...x, actions: state.actions.filter((a) => a.findingId === x.id) })) : [],
    pending: pendingItems(state, f),
    actions: actionsIn(state, f),
    summary: ruleSummary(state, f),
  };
}
