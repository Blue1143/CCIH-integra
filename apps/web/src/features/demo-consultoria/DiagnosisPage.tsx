import { Link, useSearchParams } from 'react-router-dom';
import {
  ASSESSMENT_STATUS_LABEL, CHECKLIST_ANSWERS, CHECKLIST_ANSWER_LABEL, CHECKLIST_ANSWER_STATUS, CHECKLIST_DOMAINS, CHECKLIST_DOMAIN_LABEL, CHECKLIST_SCORE_FORMULA,
  assessmentsIn, findingsOf, formatNumber, scoreByDomain, scoreResponses, unitName,
  type ChecklistResponse, type DemoAssessment, type DemoConsultingState, type DemoFilter,
} from '@ccih/domain';
import { AlertBanner, Button, DataTable, EmptyState, StatusBadge, type Column } from '@ccih/ui';
import { useDemoState, useDemoStore } from './store';
import { useDemoFilters } from './filters';
import { ActionStatusBadge, InstitutionLink, SectionCard, demoLink, fmtDay } from './parts';

const ILLUSTRATIVE = 'Checklist ilustrativo, criado para a demonstração: não representa certificação, acreditação nem avaliação regulatória, e as evidências são simuladas.';

export function DemoDiagnosisPage() {
  const state = useDemoState();
  const [filter] = useDemoFilters(state);
  const [params, setParams] = useSearchParams();
  const own = filter.institutionId ? state.assessments.filter((a) => a.institutionId === filter.institutionId).sort((a, b) => b.date.localeCompare(a.date)) : [];
  const chosen = own.find((a) => a.id === params.get('avaliacao')) ?? own[0];

  return (
    <>
      <AlertBanner tone="warn" title="Checklist ilustrativo">{ILLUSTRATIVE}</AlertBanner>
      {!filter.institutionId ? (
        <AssessmentList state={state} filter={filter} />
      ) : !chosen ? (
        <SectionCard title="Diagnóstico situacional"><EmptyState title="Nenhuma avaliação registrada para esta instituição" /></SectionCard>
      ) : (
        <>
          <div className="filters demo-noprint" role="group" aria-label="Avaliação">
            <div className="field">
              <label htmlFor="demo-avaliacao">Avaliação</label>
              <select id="demo-avaliacao" className="select" value={chosen.id} onChange={(e) => setParams((p) => { const n = new URLSearchParams(p); n.set('avaliacao', e.target.value); return n; }, { replace: true })}>
                {own.map((a) => <option key={a.id} value={a.id}>{fmtDay(a.date)} — {ASSESSMENT_STATUS_LABEL[a.status]}</option>)}
              </select>
            </div>
          </div>
          <AssessmentEditor state={state} filter={filter} assessment={chosen} />
        </>
      )}
    </>
  );
}

function AssessmentList({ state, filter }: { state: DemoConsultingState; filter: DemoFilter }) {
  const rows = assessmentsIn(state, filter);
  const cols: Column<DemoAssessment>[] = [
    { key: 'inst', label: 'Instituição', value: (a) => state.institutions.find((i) => i.id === a.institutionId)?.name, render: (a) => <InstitutionLink state={state} f={filter} id={a.institutionId} /> },
    { key: 'date', label: 'Data', value: (a) => a.date, render: (a) => fmtDay(a.date) },
    { key: 'status', label: 'Situação', value: (a) => ASSESSMENT_STATUS_LABEL[a.status], render: (a) => <StatusBadge status={a.status === 'concluida' ? 'ok' : 'info'}>{ASSESSMENT_STATUS_LABEL[a.status]}</StatusBadge> },
    { key: 'conf', label: 'Conformidade', align: 'right', value: (a) => scoreResponses(a.responses).conformPercent, render: (a) => { const s = scoreResponses(a.responses); return s.conformPercent != null ? `${formatNumber(s.conformPercent, 0)}% (${s.counts.conforme}/${s.applicable})` : '—'; } },
    { key: 'open', label: 'Abrir', exportable: false, render: (a) => <Link to={demoLink('/diagnostico', { ...filter, institutionId: a.institutionId, unitId: null }, { avaliacao: a.id })}>Abrir checklist</Link> },
  ];
  return (
    <SectionCard title="Avaliações no período" subtitle="Escolha uma instituição no filtro, ou abra uma avaliação abaixo, para preencher o checklist.">
      <DataTable caption="Avaliações de diagnóstico" columns={cols} rows={rows} rowKey={(a) => a.id} dense emptyMessage="Nenhuma avaliação no período selecionado." />
    </SectionCard>
  );
}

function AssessmentEditor({ state, filter, assessment }: { state: DemoConsultingState; filter: DemoFilter; assessment: DemoAssessment }) {
  const store = useDemoStore();
  const score = scoreResponses(assessment.responses);
  const locked = assessment.status === 'concluida';
  const findings = findingsOf(state, assessment);
  const inst = state.institutions.find((i) => i.id === assessment.institutionId)!;
  return (
    <>
      <SectionCard
        title={`Diagnóstico situacional — ${inst.name}`}
        subtitle={`Avaliação de ${fmtDay(assessment.date)} · ${unitName(state, assessment.unitId)} · ${ASSESSMENT_STATUS_LABEL[assessment.status]}`}
        actions={
          locked
            ? <Button icon="refresh" onClick={() => store.setAssessmentStatus(assessment.id, 'em_andamento')}>Reabrir avaliação</Button>
            : <Button variant="primary" icon="ok" disabled={score.unanswered > 0} onClick={() => store.setAssessmentStatus(assessment.id, 'concluida')}>Concluir avaliação</Button>
        }
      >
        {!locked && score.unanswered ? <p className="ig-small" role="status">{score.unanswered} item(ns) sem resposta: responda todos para concluir a avaliação.</p> : null}
        <div className="ig-table-scroll">
          <table className="ig-table">
            <caption className="ig-sr-only">Resultado por domínio</caption>
            <thead><tr><th scope="col">Domínio</th>{CHECKLIST_ANSWERS.map((a) => <th key={a} scope="col" className="ig-r">{CHECKLIST_ANSWER_LABEL[a]}</th>)}<th scope="col" className="ig-r">Sem resposta</th><th scope="col" className="ig-r">Conformidade</th></tr></thead>
            <tbody>
              {scoreByDomain(state, assessment).map(({ domain, score: s }) => (
                <tr key={domain}>
                  <th scope="row">{CHECKLIST_DOMAIN_LABEL[domain]}</th>
                  {CHECKLIST_ANSWERS.map((a) => <td key={a} className="ig-r">{s.counts[a]}</td>)}
                  <td className="ig-r">{s.unanswered}</td>
                  <td className="ig-r">{s.conformPercent != null ? `${formatNumber(s.conformPercent, 0)}%` : '—'}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Total</th>
                {CHECKLIST_ANSWERS.map((a) => <td key={a} className="ig-r"><b>{score.counts[a]}</b></td>)}
                <td className="ig-r"><b>{score.unanswered}</b></td>
                <td className="ig-r"><b>{score.conformPercent != null ? `${formatNumber(score.conformPercent, 0)}%` : '—'}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="ig-card-foot">Conformidade = {CHECKLIST_SCORE_FORMULA}</p>
      </SectionCard>

      {CHECKLIST_DOMAINS.map((domain) => (
        <fieldset key={domain} className="ig-fieldset demo-domain">
          <legend>{CHECKLIST_DOMAIN_LABEL[domain]}</legend>
          {assessment.responses.filter((r) => state.checklist.find((c) => c.id === r.itemId)?.domain === domain).map((r) => (
            <ChecklistRow key={r.itemId} state={state} assessmentId={assessment.id} response={r} locked={locked} />
          ))}
        </fieldset>
      ))}

      <SectionCard title="Achados desta avaliação" subtitle="Itens parcialmente conformes ou não conformes. Cada ação do plano aponta para o achado que a originou.">
        {findings.length ? (
          <ul className="alert-list">
            {findings.map((f) => {
              const linked = state.actions.filter((a) => a.findingId === f.id);
              return (
                <li key={f.id} className="alert-item" id={`achado-${f.id.replace(':', '-')}`}>
                  <div className="alert-main">
                    <p className="alert-title">{f.item.text}</p>
                    <span className="ig-row" style={{ gap: 6 }}><StatusBadge status={CHECKLIST_ANSWER_STATUS[f.answer]}>{CHECKLIST_ANSWER_LABEL[f.answer]}</StatusBadge><span className="ig-small ig-muted">{CHECKLIST_DOMAIN_LABEL[f.item.domain]}</span></span>
                    {f.observation ? <span className="ig-small">Observação: {f.observation}</span> : null}
                    {f.evidence ? <span className="ig-small ig-muted">{f.evidence}</span> : null}
                    {linked.length ? (
                      <ul className="demo-linked">{linked.map((a) => <li key={a.id}><ActionStatusBadge action={a} state={state} /> {a.action}</li>)}</ul>
                    ) : <span className="ig-small"><StatusBadge status="warn">Sem plano de ação</StatusBadge></span>}
                  </div>
                  <Link className="ig-btn ig-btn-sm demo-noprint" to={demoLink('/planos', filter, { nova: f.id })}>Criar ação</Link>
                </li>
              );
            })}
          </ul>
        ) : <EmptyState title="Nenhum achado: todos os itens respondidos estão conformes ou não se aplicam" />}
      </SectionCard>
    </>
  );
}

function ChecklistRow({ state, assessmentId, response, locked }: { state: DemoConsultingState; assessmentId: string; response: ChecklistResponse; locked: boolean }) {
  const store = useDemoStore();
  const item = state.checklist.find((c) => c.id === response.itemId)!;
  const name = `${assessmentId}-${item.id}`;
  return (
    <div className="demo-check">
      <p className="demo-check-text" id={`${name}-q`}>{item.text}</p>
      <div className="demo-check-answers" role="radiogroup" aria-labelledby={`${name}-q`}>
        {CHECKLIST_ANSWERS.map((a) => (
          <label key={a} className="inline-check">
            <input type="radio" name={name} value={a} checked={response.answer === a} disabled={locked} onChange={() => store.setResponse(assessmentId, item.id, { answer: a })} />
            {CHECKLIST_ANSWER_LABEL[a]}
          </label>
        ))}
        {response.answer == null ? <StatusBadge status="neutral">Sem resposta</StatusBadge> : null}
      </div>
      <div className="ig-form-row">
        <label className="demo-text">
          <span className="ig-label">Observações</span>
          <textarea key={`${name}-o-${response.observation}`} rows={2} defaultValue={response.observation} disabled={locked} maxLength={500}
            onBlur={(e) => { if (e.target.value !== response.observation) store.setResponse(assessmentId, item.id, { observation: e.target.value }); }} />
        </label>
        <label className="demo-text">
          <span className="ig-label">Evidência simulada</span>
          <textarea key={`${name}-e-${response.evidence}`} rows={2} defaultValue={response.evidence} disabled={locked} maxLength={500}
            onBlur={(e) => { if (e.target.value !== response.evidence) store.setResponse(assessmentId, item.id, { evidence: e.target.value }); }} />
        </label>
      </div>
    </div>
  );
}
