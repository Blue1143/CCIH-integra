import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ACTION_PRIORITY_LABEL, CHECKLIST_ANSWER_LABEL, CHECKLIST_ANSWER_STATUS, CHECKLIST_DOMAIN_LABEL, CHECKLIST_SCORE_FORMULA, DEMO_CONSULTING_NOTICE, PENDING_KIND_LABEL, RULE_SUMMARY_LABEL, RULE_SUMMARY_METHOD,
  buildReport, describeComputation, formatNumber, formatSigned, formatValue, periodLabel, reportsIn, unitName,
  type ConsultingReport, type DemoConsultingState, type DemoFilter, type DemoReportRecord, type IndicatorView,
} from '@ccih/domain';
import { Button, DataTable, FormMessage, StatusBadge, type Column } from '@ccih/ui';
import { exportCsv } from '../dashboard/parts';
import { useDemoState, useDemoStore } from './store';
import { useDemoFilters } from './filters';
import { ActionStatusBadge, FictitiousTargetTag, InstitutionLink, SectionCard, demoLink, fmtDay } from './parts';

type IndRow = { id: string; view: IndicatorView };

function indicatorColumns(): Column<IndRow>[] {
  return [
    { key: 'name', label: 'Indicador', value: (r) => r.view.def.name },
    { key: 'formula', label: 'Fórmula', value: (r) => r.view.formula },
    { key: 'num', label: 'Numerador', align: 'right', value: (r) => r.view.current.result.numerator, render: (r) => formatNumber(r.view.current.result.numerator) },
    { key: 'den', label: 'Denominador', align: 'right', value: (r) => r.view.current.result.denominator, render: (r) => formatNumber(r.view.current.result.denominator) },
    { key: 'value', label: 'Valor', align: 'right', value: (r) => r.view.current.result.value, render: (r) => formatValue(r.view.def, r.view.current.result) },
    { key: 'unit', label: 'Unidade', value: (r) => r.view.def.unit },
    { key: 'prev', label: 'Período anterior', value: (r) => (r.view.previous ? r.view.previous.result.value : null),
      render: (r) => (r.view.previous ? `${formatValue(r.view.def, r.view.previous.result)} (${describeComputation(r.view.def, r.view.previous.result)})` : 'Sem período anterior na série') },
    { key: 'delta', label: 'Variação', align: 'right', value: (r) => r.view.trend.delta, render: (r) => (r.view.trend.delta != null ? formatSigned(r.view.trend.delta, r.view.def.decimals) : '—') },
    { key: 'target', label: 'Meta fictícia', value: (r) => (r.view.target ? `${r.view.target.direction === 'lower' ? '≤' : '≥'} ${formatNumber(r.view.target.value, r.view.def.decimals)}` : 'Sem meta fictícia') },
    { key: 'eval', label: 'Situação', value: (r) => r.view.evaluation.label, render: (r) => <StatusBadge status={r.view.evaluation.status}>{r.view.evaluation.label}</StatusBadge> },
  ];
}

export function DemoReportsPage() {
  const state = useDemoState();
  const store = useDemoStore();
  const [filter] = useDemoFilters(state);
  const [issued, setIssued] = useState(false);
  const issuedList = reportsIn(state, filter);

  if (!filter.institutionId) {
    return (
      <>
        <SectionCard title="Relatório por instituição e período" subtitle="Escolha a instituição para montar a prévia; o período vem do filtro acima.">
          <ul className="consulting-links">
            {state.institutions.map((i) => <li key={i.id}><Link to={demoLink('/relatorios', { ...filter, institutionId: i.id, unitId: null })}>{i.name}</Link> — {i.profile}</li>)}
          </ul>
        </SectionCard>
        <IssuedReports state={state} filter={filter} rows={issuedList} />
      </>
    );
  }

  const report = buildReport(state, filter);
  const cols = indicatorColumns();
  const rows: IndRow[] = report.indicators.map((view) => ({ id: view.id, view }));
  const name = `relatorio-${filter.institutionId}-${filter.from.slice(0, 7)}-a-${filter.to.slice(0, 7)}`;

  return (
    <>
      <div className="ig-row demo-noprint">
        <Button variant="primary" icon="printer" onClick={() => window.print()}>Imprimir ou salvar em PDF</Button>
        <Button icon="download" onClick={() => exportCsv(`${name}-indicadores`, cols.filter((c) => c.key !== 'eval').concat({ key: 'eval', label: 'Situação', value: (r) => r.view.evaluation.label }), rows, 'demo')}>Exportar indicadores (CSV)</Button>
        <Button icon="ok" onClick={() => { store.issueReport(filter); setIssued(true); }}>Registrar emissão</Button>
      </div>
      {issued ? <FormMessage tone="success">Emissão registrada na demonstração ({periodLabel(filter.from, filter.to)}).</FormMessage> : null}
      <ReportView state={state} report={report} rows={rows} cols={cols} />
      <IssuedReports state={state} filter={filter} rows={issuedList} />
    </>
  );
}

function IssuedReports({ state, filter, rows }: { state: DemoConsultingState; filter: DemoFilter; rows: DemoReportRecord[] }) {
  const cols: Column<DemoReportRecord>[] = [
    { key: 'inst', label: 'Instituição', value: (r) => state.institutions.find((i) => i.id === r.institutionId)?.name, render: (r) => <InstitutionLink state={state} f={filter} id={r.institutionId} /> },
    { key: 'scope', label: 'Abrangência', value: (r) => unitName(state, r.unitId) },
    { key: 'period', label: 'Período', value: (r) => periodLabel(r.from, r.to) },
    { key: 'issued', label: 'Emitido em', value: (r) => r.issuedAt, render: (r) => fmtDay(r.issuedAt) },
    { key: 'open', label: 'Abrir', exportable: false, render: (r) => <Link to={demoLink('/relatorios', { institutionId: r.institutionId, unitId: r.unitId, from: r.from, to: r.to })}>Ver prévia</Link> },
  ];
  return (
    <div className="demo-noprint">
      <SectionCard title="Relatórios emitidos" subtitle="Registros de emissão desta demonstração cujo período se sobrepõe ao filtro.">
        <DataTable caption="Relatórios emitidos" columns={cols} rows={rows} rowKey={(r) => r.id} dense emptyMessage="Nenhum relatório emitido para os filtros." />
      </SectionCard>
    </div>
  );
}

function ReportView({ state, report, rows, cols }: { state: DemoConsultingState; report: ConsultingReport; rows: IndRow[]; cols: Column<IndRow>[] }) {
  const { summary } = report;
  return (
    <article className="ig-card demo-report" aria-labelledby="rel-title">
      <header className="demo-report-head">
        <p className="demo-report-notice">{DEMO_CONSULTING_NOTICE}</p>
        <h2 id="rel-title" className="page-title">Relatório de consultoria — demonstração</h2>
        <dl className="def-list">
          <dt>Instituição</dt><dd>{report.institution?.name}</dd>
          <dt>Abrangência</dt><dd>{report.scopeLabel}</dd>
          <dt>Período</dt><dd>{report.periodLabel}</dd>
          <dt>Data de referência</dt><dd>{fmtDay(report.referenceDate)}</dd>
          <dt>Consultoria</dt><dd>{report.institution?.consultant} (nome fictício)</dd>
        </dl>
      </header>

      <section className="demo-report-sec" aria-labelledby="rel-ind">
        <h3 id="rel-ind" className="demo-report-h">1. Resumo dos indicadores</h3>
        <p className="ig-small ig-muted">Infecções associadas a dispositivos. Taxas recalculadas a partir das contagens somadas do período. Metas: <FictitiousTargetTag />, sem atribuição a nenhuma entidade.</p>
        <DataTable caption="Indicadores do período" columns={cols} rows={rows} rowKey={(r) => r.id} dense />
      </section>

      <section className="demo-report-sec" aria-labelledby="rel-diag">
        <h3 id="rel-diag" className="demo-report-h">2. Diagnóstico situacional e achados</h3>
        {report.assessment && report.score ? (
          <>
            <p className="ig-small">
              Avaliação de {fmtDay(report.assessment.date)} (checklist ilustrativo, sem valor de certificação ou avaliação regulatória): {report.score.counts.conforme} conforme(s), {report.score.counts.parcial} parcialmente conforme(s),{' '}
              {report.score.counts.nao_conforme} não conforme(s), {report.score.counts.nao_se_aplica} não se aplica, {report.score.unanswered} sem resposta.
              {report.score.conformPercent != null ? ` Conformidade: ${formatNumber(report.score.conformPercent, 0)}%.` : ''}
            </p>
            <p className="ig-small ig-muted">Conformidade = {CHECKLIST_SCORE_FORMULA}</p>
            <ul className="demo-report-list">
              {report.domainScores.map((d) => <li key={d.domain}>{CHECKLIST_DOMAIN_LABEL[d.domain]}: {d.score.conformPercent != null ? `${formatNumber(d.score.conformPercent, 0)}% (${d.score.counts.conforme} de ${d.score.applicable})` : 'sem itens aplicáveis respondidos'}</li>)}
            </ul>
            <h4 className="demo-summary-h">Achados</h4>
            {report.findings.length ? (
              <ul className="demo-report-list">
                {report.findings.map((f) => (
                  <li key={f.id}>
                    <StatusBadge status={CHECKLIST_ANSWER_STATUS[f.answer]}>{CHECKLIST_ANSWER_LABEL[f.answer]}</StatusBadge> {f.item.text}{f.observation ? ` — ${f.observation}` : ''}
                    {f.evidence ? <span className="ig-small ig-muted"> ({f.evidence})</span> : null}
                    <span className="ig-small"> · {f.actions.length ? `Ação vinculada: ${f.actions.map((a) => a.action).join('; ')}` : 'Sem ação vinculada'}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="ig-small">Nenhum achado na avaliação.</p>}
          </>
        ) : <p className="ig-small">Nenhuma avaliação registrada.</p>}
      </section>

      <section className="demo-report-sec" aria-labelledby="rel-pend">
        <h3 id="rel-pend" className="demo-report-h">3. Pendências</h3>
        {report.pending.length ? <ul className="demo-report-list">{report.pending.map((p, i) => <li key={i}><b>{PENDING_KIND_LABEL[p.kind]}:</b> {p.text}</li>)}</ul> : <p className="ig-small">Nenhuma pendência.</p>}
      </section>

      <section className="demo-report-sec" aria-labelledby="rel-acoes">
        <h3 id="rel-acoes" className="demo-report-h">4. Planos de ação</h3>
        {report.actions.length ? (
          <div className="ig-table-scroll">
            <table className="ig-table">
              <caption className="ig-sr-only">Planos de ação do período</caption>
              <thead><tr><th scope="col">Ação</th><th scope="col">Problema identificado</th><th scope="col">Responsável (fictício)</th><th scope="col">Prazo</th><th scope="col">Prioridade</th><th scope="col">Situação</th></tr></thead>
              <tbody>
                {report.actions.map((a) => (
                  <tr key={a.id}><td>{a.action}</td><td>{a.problem}</td><td>{a.responsible}</td><td>{fmtDay(a.deadline)}</td><td>{ACTION_PRIORITY_LABEL[a.priority]}</td><td><ActionStatusBadge action={a} state={state} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="ig-small">Nenhuma ação ativa no período.</p>}
      </section>

      <section className="demo-report-sec" aria-labelledby="rel-obs">
        <h3 id="rel-obs" className="demo-report-h">5. Dados observados</h3>
        <p className="ig-small"><StatusBadge status="info" className="demo-badge-wrap">{RULE_SUMMARY_LABEL}</StatusBadge></p>
        <p className="ig-small ig-muted">{RULE_SUMMARY_METHOD}</p>
        <ul className="demo-report-list">{summary.observed.map((s, i) => <li key={i}>{s}</li>)}</ul>
        <h4 className="demo-summary-h">Dados ausentes ou incompletos</h4>
        {summary.missing.length ? <ul className="demo-report-list">{summary.missing.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="ig-small">Nenhuma lacuna nos dados do período.</p>}
      </section>

      <section className="demo-report-sec demo-hypotheses" aria-labelledby="rel-hip">
        <h3 id="rel-hip" className="demo-report-h">6. Hipóteses que exigiriam investigação</h3>
        <p className="ig-small">Separadas dos dados observados: não são conclusões nem causas. Indicam apenas onde a equipe precisaria investigar e validar os dados antes de afirmar qualquer coisa.</p>
        {summary.forInvestigation.length ? <ul className="demo-report-list">{summary.forInvestigation.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="ig-small">Nenhum ponto sinalizado pelas regras.</p>}
      </section>

      <footer className="demo-report-foot">
        Documento demonstrativo gerado a partir de dados fictícios, para fins acadêmicos. Sem uso assistencial, sem validade como laudo, certificação ou avaliação regulatória. Requer revisão profissional.
      </footer>
    </article>
  );
}
