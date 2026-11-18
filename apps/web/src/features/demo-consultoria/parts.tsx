import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  DEMO_ACTION_STATUS_LABEL, DEMO_ACTION_STATUS_TONE, FICTITIOUS_TARGET_LABEL, RULE_SUMMARY_LABEL, RULE_SUMMARY_METHOD, demoActionStatus, describeComputation, describeGaps,
  formatDate, formatNumber, formatSigned, type DemoAction, type DemoConsultingState, type DemoFilter, type IndicatorView, type RuleSummary,
} from '@ccih/domain';
import { Card, Icon, ProvenanceTag, StatusBadge, type TrendSeries } from '@ccih/ui';
import { filterQuery } from './filters';

export const DEMO_BASE = '/demo/consultoria';
export const demoLink = (path: string, f: DemoFilter, extra?: Record<string, string>) => `${DEMO_BASE}${path}${filterQuery(f, extra)}`;

export function FictitiousTargetTag() {
  return <ProvenanceTag kind="meta_demo" title="Meta criada só para esta demonstração; não é atribuída à Anvisa nem a outra entidade.">{FICTITIOUS_TARGET_LABEL}</ProvenanceTag>;
}

export function ActionStatusBadge({ action, state }: { action: DemoAction; state: DemoConsultingState }) {
  const s = demoActionStatus(action, state.referenceDate);
  return <StatusBadge status={DEMO_ACTION_STATUS_TONE[s]}>{DEMO_ACTION_STATUS_LABEL[s]}</StatusBadge>;
}

/** Value, numerator, denominator, formula, unit, comparison and fictitious target of one indicator. */
export function IndicatorCard({ view, state }: { view: IndicatorView; state: DemoConsultingState }) {
  const { def, current, previous, trend, target, evaluation } = view;
  const r = current.result;
  const gaps = describeGaps(state, current.gaps);
  return (
    <article className="ig-card demo-ind" aria-label={def.name}>
      <div className="ig-kpi-top">
        <span className="ig-label">{def.shortName}</span>
        <StatusBadge status={evaluation.status}>{evaluation.label}</StatusBadge>
      </div>
      <p className="demo-ind-value">
        {r.value != null ? <>{formatNumber(r.value, def.decimals)}<span className="ig-kpi-unit">{def.unit}</span></> : <span className="demo-ind-empty">{r.kind === 'denominador_zero' ? 'Denominador zero' : 'Sem dado'}</span>}
      </p>
      <dl className="demo-ind-dl">
        <dt>Numerador</dt><dd>{r.numerator != null ? formatNumber(r.numerator) : '—'} <span className="ig-muted">{def.numerator.label}</span></dd>
        <dt>Denominador</dt><dd>{r.denominator != null ? formatNumber(r.denominator) : '—'} <span className="ig-muted">{def.denominator?.label ?? 'não se aplica'}</span></dd>
        <dt>Fórmula</dt><dd>{view.formula}</dd>
        <dt>Unidade</dt><dd>{def.unit}</dd>
        <dt>Período</dt><dd>{current.label}</dd>
        <dt>Anterior</dt>
        <dd>
          {previous ? (
            <>
              {previous.result.value != null ? `${formatNumber(previous.result.value, def.decimals)} ${def.unit}` : previous.result.kind === 'denominador_zero' ? 'Denominador zero' : 'Sem dado'}
              <span className="ig-muted"> ({describeComputation(def, previous.result)}; {previous.label})</span>
            </>
          ) : <span className="ig-muted">{view.noComparisonReason}</span>}
        </dd>
        <dt>Variação</dt>
        <dd>
          {trend.delta != null ? (
            <span aria-label={`Variação ${formatSigned(trend.delta, def.decimals)}, ${trend.improved == null ? 'estável' : trend.improved ? 'melhora' : 'piora'}`}>
              <span style={{ color: trend.improved == null ? 'var(--ink-muted)' : trend.improved ? 'var(--ok)' : 'var(--crit)', verticalAlign: '-2px' }}>
                <Icon name={trend.delta > 0 ? 'up' : trend.delta < 0 ? 'down' : 'flat'} size={14} />
              </span>{' '}
              {formatSigned(trend.delta, def.decimals)} {def.unit} ({trend.improved == null ? 'estável' : trend.improved ? 'melhora' : 'piora'})
            </span>
          ) : <span className="ig-muted">Não calculada</span>}
        </dd>
        <dt>Meta</dt>
        <dd>
          {target ? <>{target.direction === 'lower' ? '≤' : '≥'} {formatNumber(target.value, def.decimals)} {def.unit} <FictitiousTargetTag /></> : <span className="ig-muted">Sem meta fictícia definida</span>}
        </dd>
      </dl>
      {gaps.length ? (
        <p className="demo-ind-gap"><StatusBadge status="warn">Dados incompletos</StatusBadge> Sem registro em {gaps.join('; ')}. O valor considera só os meses e unidades com dados.</p>
      ) : null}
    </article>
  );
}

/** Line series of a set of indicator views; months without a value stay as gaps. */
export function trendSeries(views: IndicatorView[], colors: Record<string, string>): TrendSeries[] {
  return views.map((v) => ({ name: v.def.shortName, color: colors[v.id] ?? 'primary', values: v.series.map((p) => p.result.value) }));
}

export const DENSITY_COLORS: Record<string, string> = { 'di-ipcs': 'iras-ipcs', 'di-pav': 'iras-pav', 'di-itu': 'iras-itu', 'tu-cvc': 'iras-ipcs', 'tu-vm': 'iras-pav', 'tu-svd': 'iras-itu' };

/** Months that have no value in a chart, in words (denominator zero or missing data). */
export function chartGapNote(views: IndicatorView[]): string | null {
  const notes = views.flatMap((v) => {
    const zero = v.series.filter((p) => p.result.kind === 'denominador_zero').map((p) => p.label);
    const none = v.series.filter((p) => p.result.kind === 'sem_dado').map((p) => p.label);
    return [zero.length ? `${v.def.shortName}: denominador zero em ${zero.join(', ')}` : null, none.length ? `${v.def.shortName}: sem dados em ${none.join(', ')}` : null].filter(Boolean);
  });
  return notes.length ? `Pontos ausentes no gráfico — ${notes.join(' · ')}.` : null;
}

export function RuleSummaryView({ summary, headingLevel = 3 }: { summary: RuleSummary; headingLevel?: 2 | 3 | 4 }) {
  const H = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  return (
    <div className="demo-summary">
      <p className="demo-summary-label"><StatusBadge status="info" className="demo-badge-wrap">{RULE_SUMMARY_LABEL}</StatusBadge></p>
      <p className="ig-small ig-muted">{RULE_SUMMARY_METHOD}</p>
      <div className="demo-summary-cols">
        <section>
          <H className="demo-summary-h">Dados observados</H>
          <ul>{summary.observed.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </section>
        <section>
          <H className="demo-summary-h">Dados ausentes ou incompletos</H>
          {summary.missing.length ? <ul>{summary.missing.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="ig-small">Nenhuma lacuna nos dados selecionados.</p>}
        </section>
        <section className="demo-hypotheses">
          <H className="demo-summary-h">Hipóteses e pontos que exigiriam investigação</H>
          <p className="ig-small ig-muted">Não são conclusões: apenas sinalizam onde a equipe precisaria investigar antes de afirmar qualquer coisa.</p>
          {summary.forInvestigation.length ? <ul>{summary.forInvestigation.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="ig-small">Nenhum ponto sinalizado pelas regras.</p>}
        </section>
      </div>
    </div>
  );
}

export function SectionCard({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <Card title={title} subtitle={subtitle} actions={actions} headingLevel={2}>{children}</Card>;
}

export function InstitutionLink({ state, f, id }: { state: DemoConsultingState; f: DemoFilter; id: string }) {
  const inst = state.institutions.find((i) => i.id === id);
  return <Link to={demoLink(`/instituicoes/${id}`, { ...f, institutionId: id, unitId: null })}>{inst?.name ?? id}</Link>;
}

export const fmtDay = (iso: string | null | undefined) => formatDate(iso ?? null);
