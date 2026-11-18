import { Link, useParams } from 'react-router-dom';
import {
  CHECKLIST_DOMAIN_LABEL, CHECKLIST_SCORE_FORMULA, DEMO_ACTION_STATUSES, DEMO_ACTION_STATUS_LABEL, DEMO_ACTION_STATUS_TONE, DEVICE_DENSITY_IDS, PENDING_KIND_LABEL,
  formatNumber, indicatorViews, institutionSummary, latestAssessment, pendingItems, portfolioSummary, scoreByDomain, actionsIn, unitName,
  type DemoActionStatus, type DemoConsultingState, type DemoFilter, type InstitutionSummary, type PendingItem,
} from '@ccih/domain';
import { BarChart, Card, DataTable, EmptyState, StatusBadge, TrendChart, type Column } from '@ccih/ui';
import { useDemoState } from './store';
import { useDemoFilters } from './filters';
import { ActionStatusBadge, DENSITY_COLORS, IndicatorCard, InstitutionLink, SectionCard, chartGapNote, demoLink, fmtDay, trendSeries } from './parts';

const PLURAL: Record<DemoActionStatus, string> = { pendente: 'pendentes', em_andamento: 'em andamento', atrasada: 'atrasadas', concluida: 'concluídas' };
const countLabel = (k: DemoActionStatus, n: number) => (n === 1 ? DEMO_ACTION_STATUS_LABEL[k].toLowerCase() : PLURAL[k]);

/** Portfolio overview: the three fictitious institutions side by side. */
export function DemoOverviewPage() {
  const state = useDemoState();
  const [filter] = useDemoFilters(state);
  const p = portfolioSummary(state, filter);
  const pending = pendingItems(state, filter);
  return (
    <>
      <section aria-labelledby="h-resumo">
        <h2 id="h-resumo" className="section-title">Resumo da carteira</h2>
        <dl className="cme-stats demo-stats">
          <div><dt>Pendências</dt><dd>{p.pending}</dd><dd className="demo-stat-note">{p.actions.atrasada} ações atrasadas</dd></div>
          <div><dt>Avaliações realizadas</dt><dd>{p.assessmentsDone}</dd><dd className="demo-stat-note">{p.assessments} no período, {p.assessments - p.assessmentsDone} em andamento</dd></div>
          <div><dt>Planos de ação</dt><dd>{p.actionsTotal}</dd><dd className="demo-stat-note">{p.actions.pendente} pendentes · {p.actions.em_andamento} em andamento · {p.actions.concluida} concluídas</dd></div>
          <div><dt>Relatórios emitidos</dt><dd>{p.reports}</dd><dd className="demo-stat-note">no período selecionado</dd></div>
        </dl>
      </section>

      <section aria-labelledby="h-inst">
        <h2 id="h-inst" className="section-title">Instituições</h2>
        <div className="cols-3">
          {p.institutions.map((s) => <InstitutionCard key={s.institution.id} s={s} filter={filter} />)}
        </div>
      </section>

      <SectionCard title="Pendências" subtitle="Ações atrasadas ou em aberto, achados sem plano de ação, itens do checklist sem resposta e meses sem dados de indicador.">
        <PendingTable state={state} rows={pending} filter={filter} />
      </SectionCard>
    </>
  );
}

function InstitutionCard({ s, filter }: { s: InstitutionSummary; filter: DemoFilter }) {
  const f = { ...filter, institutionId: s.institution.id, unitId: filter.institutionId === s.institution.id ? filter.unitId : null };
  return (
    <article className="ig-card demo-inst" aria-labelledby={`inst-${s.institution.id}`}>
      <h3 id={`inst-${s.institution.id}`} className="ig-card-title">{s.institution.name}</h3>
      <p className="ig-card-sub">{s.institution.profile}</p>
      <p className="ig-small">Responsável na consultoria (fictício): {s.institution.consultant}</p>
      <dl className="def-list">
        <dt>Pendências</dt><dd>{s.pending}{s.pendingByKind.acao_atrasada ? <StatusBadge status="crit">{s.pendingByKind.acao_atrasada} atrasada{s.pendingByKind.acao_atrasada > 1 ? 's' : ''}</StatusBadge> : null}</dd>
        <dt>Avaliações</dt><dd>{s.assessmentsDone} concluída{s.assessmentsDone === 1 ? '' : 's'} · {s.assessments - s.assessmentsDone} em andamento</dd>
        <dt>Conformidade</dt><dd>{s.latestConformPercent != null ? `${formatNumber(s.latestConformPercent, 0)}% na última avaliação` : 'Sem avaliação'}</dd>
        <dt>Planos de ação</dt>
        <dd>{DEMO_ACTION_STATUSES.filter((k) => s.actions[k]).map((k) => <StatusBadge key={k} status={DEMO_ACTION_STATUS_TONE[k]}>{s.actions[k]} {countLabel(k, s.actions[k])}</StatusBadge>)}{s.actionsTotal ? null : 'Nenhum'}</dd>
        <dt>Relatórios</dt><dd>{s.reports}</dd>
        <dt>Meta fictícia</dt><dd>{s.outsideTarget.length ? <StatusBadge status="crit">Fora: {s.outsideTarget.join(', ')}</StatusBadge> : <StatusBadge status="ok">Densidades dentro ou em atenção</StatusBadge>}</dd>
      </dl>
      <p style={{ margin: 'var(--space-4) 0 0' }}><Link className="ig-btn ig-btn-sm" to={demoLink(`/instituicoes/${s.institution.id}`, f)}>Abrir painel da instituição</Link></p>
    </article>
  );
}

function PendingTable({ state, rows, filter }: { state: DemoConsultingState; rows: PendingItem[]; filter: DemoFilter }) {
  const cols: Column<PendingItem>[] = [
    { key: 'kind', label: 'Tipo', value: (r) => PENDING_KIND_LABEL[r.kind], render: (r) => <StatusBadge status={r.kind === 'acao_atrasada' ? 'crit' : r.kind === 'dado_ausente' || r.kind === 'achado_sem_acao' ? 'warn' : 'info'}>{PENDING_KIND_LABEL[r.kind]}</StatusBadge> },
    { key: 'inst', label: 'Instituição', value: (r) => state.institutions.find((i) => i.id === r.institutionId)?.name, render: (r) => <InstitutionLink state={state} f={filter} id={r.institutionId} /> },
    { key: 'text', label: 'Descrição' },
  ];
  return <DataTable caption="Pendências" columns={cols} rows={rows} rowKey={(r, i) => `${r.kind}-${i}`} dense pageSize={10} searchable emptyMessage="Nenhuma pendência para os filtros." />;
}

/** Individual panel of one institution, from the same selectors as the portfolio. */
export function DemoInstitutionPage() {
  const state = useDemoState();
  const { id } = useParams();
  const [raw] = useDemoFilters(state);
  const inst = state.institutions.find((i) => i.id === id);
  if (!inst) return <Card title="Instituição não encontrada"><EmptyState title="Não há instituição fictícia com este endereço"><Link to={demoLink('', raw)}>Voltar à visão geral</Link></EmptyState></Card>;
  const filter: DemoFilter = { ...raw, institutionId: inst.id, unitId: raw.institutionId === inst.id ? raw.unitId : null };
  const s = institutionSummary(state, filter, inst.id);
  const views = indicatorViews(state, filter, DEVICE_DENSITY_IDS);
  const assessment = latestAssessment(state, inst.id, filter.unitId);
  const actions = actionsIn(state, filter);
  return (
    <>
      <header className="demo-inst-head">
        <Link to={demoLink('', filter)} className="back-link">← Visão geral da carteira</Link>
        <h2 className="section-title" style={{ marginBottom: 4 }}>{inst.name} · {unitName(state, filter.unitId)}</h2>
        <p className="page-sub">{inst.profile} Unidades: {inst.units.map((u) => u.name).join(', ')}. Consultoria (fictícia): {inst.consultant}.</p>
      </header>
      <dl className="cme-stats demo-stats">
        <div><dt>Pendências</dt><dd>{s.pending}</dd></div>
        <div><dt>Avaliações realizadas</dt><dd>{s.assessmentsDone}</dd></div>
        <div><dt>Planos de ação</dt><dd>{s.actionsTotal}</dd><dd className="demo-stat-note">{s.actions.atrasada} atrasadas</dd></div>
        <div><dt>Relatórios emitidos</dt><dd>{s.reports}</dd></div>
      </dl>
      <section aria-labelledby="h-ind-inst">
        <h2 id="h-ind-inst" className="section-title">Infecções associadas a dispositivos</h2>
        <div className="demo-ind-grid">{views.map((v) => <IndicatorCard key={v.id} view={v} state={state} />)}</div>
      </section>
      <div className="cols-2">
        <TrendChart
          title="Densidade de incidência por mês"
          description="Casos por 1.000 dispositivos-dia, série demonstrativa de seis meses"
          period={`${views[0]!.series[0]!.label} – ${views[0]!.series[5]!.label}`}
          unit="‰"
          labels={views[0]!.series.map((p) => p.label)}
          series={trendSeries(views, DENSITY_COLORS)}
          footnote={chartGapNote(views) ?? 'Todos os meses com valor calculado.'}
        />
        {assessment ? (
          <BarChart
            title="Conformidade por domínio do checklist"
            description={`Avaliação de ${fmtDay(assessment.date)} — ilustrativa`}
            unit="%"
            decimals={0}
            keepOrder
            categoryLabel="Domínio"
            valueLabel="Conformidade"
            data={scoreByDomain(state, assessment).filter((d) => d.score.conformPercent != null).map((d) => ({ key: d.domain, label: CHECKLIST_DOMAIN_LABEL[d.domain], value: d.score.conformPercent!, note: `${d.score.counts.conforme} de ${d.score.applicable} itens aplicáveis` }))}
            footnote={CHECKLIST_SCORE_FORMULA}
          />
        ) : <Card title="Conformidade por domínio"><EmptyState title="Sem avaliação registrada" /></Card>}
      </div>
      <SectionCard title="Ações da instituição" subtitle="Ativas no período selecionado" actions={<Link to={demoLink('/planos', filter)}>Ver planos de ação</Link>}>
        <ul className="alert-list">
          {actions.map((a) => (
            <li key={a.id} className="alert-item">
              <div className="alert-main"><p className="alert-title">{a.action}</p><span className="ig-small ig-muted">Prazo {fmtDay(a.deadline)} · {a.responsible}</span></div>
              <ActionStatusBadge action={a} state={state} />
            </li>
          ))}
        </ul>
        {actions.length ? null : <EmptyState title="Nenhuma ação no período" />}
      </SectionCard>
      <p className="ig-row demo-noprint">
        <Link className="ig-btn" to={demoLink('/indicadores', filter)}>Indicadores detalhados</Link>
        <Link className="ig-btn" to={demoLink('/diagnostico', filter)}>Diagnóstico situacional</Link>
        <Link className="ig-btn ig-btn-primary" to={demoLink('/relatorios', filter)}>Relatório da instituição</Link>
      </p>
    </>
  );
}
