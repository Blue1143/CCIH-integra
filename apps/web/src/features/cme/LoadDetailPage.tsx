import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  IB_RESULT_LABEL, LOAD_STATUS_LABEL, LOAD_TRANSITIONS, PACKAGING_LABEL, PHYSICAL_RESULT_LABEL, TEST_RESULT_LABEL, TEST_TYPE_LABEL, decisionLabel, formatDate, todayIn,
  type CmeTestDto, type IbControl, type LoadDetail, type LoadItemDto, type LoadStatus, type RecordedTestType, type TestResult,
} from '@ccih/domain';
import { AlertBanner, Button, Card, ConfirmDialog, DataTable, ErrorState, Field, LoadingState, SterilizationCycle, type Column } from '@ccih/ui';
import { ApiError } from '../../data/api/http';
import { useSession } from '../auth/session';
import { JustificationField, justificationError } from '../admin/shared';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, PatientLabel, Timeline, localToIso, nowLocal, useTimeZone } from '../clinical/shared';
import { Attachments, CmeNav, LoadStatusBadge, RequireCme, TestResultBadge, cmeSectorName, useCme, useCmeMutation, useCmeSectors } from './shared';

export function LoadDetailPage() {
  return <RequireCme title="Carga"><LoadDetailView /></RequireCme>;
}

/** What the policy says about the load (its actual status is the badge in the page header). */
const POLICY_VERDICT: Record<LoadStatus, string> = { liberada: 'pode ser liberada', aguardando: 'pendências', retida: 'reter', rejeitada: 'reprovada', reprocessamento: 'reprocessar' };

const DECISION_DEFAULT: Partial<Record<LoadStatus, string>> = { liberada: 'Testes exigidos pela política aprovados.' };

function LoadDetailView() {
  const { id } = useParams();
  const cme = useCme()!;
  const session = useSession();
  const tz = useTimeZone();
  const q = useQuery({ queryKey: ['cme', 'load', id], queryFn: () => cme.load(id!) });
  const [deciding, setDeciding] = useState<LoadStatus | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [testing, setTesting] = useState(false);
  if (q.isPending) return <div className="page"><LoadingState /></div>;
  if (q.isError) return <div className="page"><ErrorState onRetry={() => void q.refetch()} /></div>;
  const l = q.data;
  const recalled = l.decisions.some((d) => d.from === 'liberada' && d.to === 'rejeitada');
  const invalidated = l.status === 'liberada' && l.evaluation.policyApplied && l.evaluation.status === 'rejeitada';
  const next = LOAD_TRANSITIONS[l.status];
  const current = l.tests.filter((t) => t.current);
  const physical = l.physical ? [{ id: 'fisico', type: 'REGISTRO_FISICO' as const, result: (l.physical === 'conforme' ? 'aprovado' : 'reprovado') as TestResult, detail: PHYSICAL_RESULT_LABEL[l.physical] }] : [];

  return (
    <div className="page">
      <PageHeader back={{ to: '/cme', label: 'CME' }} title={<span>Carga <span className="ig-mono">{l.code}</span> <DemoTag origin={l.origin} /></span>}
        subtitle={<>{l.sterilizerName} · {l.program} · início {formatDate(l.startedAt, tz)}{l.endedAt ? ` · término ${formatDate(l.endedAt, tz)}` : ' · ciclo em andamento'}</>}
        actions={<LoadStatusBadge status={l.status} />} />
      <CmeNav />
      {recalled ? (
        <AlertBanner tone="crit" title="Carga recolhida após liberação">
          {l.exposed.surgeries ? `${l.exposed.patients} paciente(s) em ${l.exposed.surgeries} cirurgia(s) receberam pacotes desta carga. ` : 'Nenhum pacote desta carga foi registrado em uso. '}
          <Link to={`/rastreabilidade?q=${encodeURIComponent(l.code)}`}>Ver rastreabilidade</Link>
        </AlertBanner>
      ) : null}
      {invalidated ? (
        <AlertBanner tone="crit" title="Carga liberada com teste reprovado">
          {l.evaluation.reasons.join(' ')} Avalie o recolhimento dos pacotes{session.can('cme:release') ? ' (Rejeitar → recolhimento)' : ''}.
        </AlertBanner>
      ) : null}
      {l.reprocessedFromId ? <p className="ig-small">Reprocessamento de outra carga: <Link to={`/cme/cargas/${l.reprocessedFromId}`}>ver carga de origem</Link>.</p> : null}
      {l.reprocessedIntoId ? <p className="ig-small">Pacotes reprocessados: <Link to={`/cme/cargas/${l.reprocessedIntoId}`}>ver nova carga</Link>.</p> : null}

      <SterilizationCycle timeZone={tz} equipment={l.sterilizerName} cycle={l.code} {...(l.startedAt ? { startedAt: l.startedAt } : {})} program={l.program} operator={l.operatorName}
        parameters={[
          { name: 'Temperatura', value: l.temperatureC != null ? `${l.temperatureC} °C` : '—' },
          { name: 'Pressão', value: l.pressureKpa != null ? `${l.pressureKpa} kPa` : '—' },
          { name: 'Exposição', value: l.exposureMinutes != null ? `${l.exposureMinutes} min` : '—' },
        ]}
        tests={[...physical, ...current.map((t) => ({ id: t.id, type: t.type, result: t.result, detail: t.type === 'IB' ? IB_RESULT_LABEL[t.result] : undefined }))]}
        {...(l.bowieDickApplies && l.equipmentBowieDick ? { equipmentBowieDick: l.equipmentBowieDick.result } : {})}
        release={l.evaluation} releaseLabel={l.evaluation.policyApplied ? `Pela política: ${POLICY_VERDICT[l.evaluation.status]}` : 'Sem política configurada'} items={l.itemList.length} hasImplant={l.hasImplant}
        actions={<div className="ig-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {session.can('cme:cycle:record') && !l.startedAt && !starting ? <Button variant="primary" onClick={() => setStarting(true)} disabled={!l.itemList.length}>Iniciar ciclo</Button> : null}
          {session.can('cme:cycle:record') && l.startedAt && !l.endedAt && !finishing ? <Button variant="primary" onClick={() => setFinishing(true)}>Encerrar ciclo</Button> : null}
          {session.can('cme:release') && !deciding ? next.map((to) => (
            <Button key={to} variant={to === 'liberada' ? 'primary' : 'secondary'} onClick={() => setDeciding(to)}
              disabled={to === 'liberada' && (!l.evaluation.policyApplied || l.evaluation.status !== 'liberada')}>{decisionLabel(l.status, to)}</Button>
          )) : null}
          {session.can('cme:cycle:record') && (l.status === 'reprocessamento' || l.status === 'rejeitada') && !l.reprocessedIntoId ? <Link className="ig-btn" to={`/cme?reprocessar=${l.id}`}>Registrar reprocessamento</Link> : null}
        </div>} />
      {l.bowieDickApplies && !l.equipmentBowieDick ? <AlertBanner tone="warn" title="Bowie-Dick do dia não registrado antes deste ciclo">Registre o teste do equipamento em <Link to="/cme/bowie-dick">Bowie-Dick</Link>.</AlertBanner> : null}
      {l.policy ? <p className="ig-small ig-muted">Política de liberação v{l.policy.version}: exige {l.policy.requiredLoadTests.map((t) => TEST_TYPE_LABEL[t]).join(', ')}{l.policy.requireDailyBowieDick ? ', Bowie-Dick diário (vapor pré-vácuo)' : ''}{l.policy.holdImplantsUntilBiological ? ', implantáveis só com IB negativo' : ''}.</p> : <AlertBanner tone="warn" title="Sem política de liberação">Configure a política em Administração para que cargas possam ser liberadas.</AlertBanner>}

      {!l.startedAt ? (
        <AlertBanner tone="info" title="Carga em montagem" actions={session.can('cme:scan') ? <Link className="ig-btn ig-btn-sm" to={`/cme/estacao?carga=${l.id}`}>Ler pacotes na estação</Link> : undefined}>
          {l.itemList.length} pacote(s) incluído(s) por leitura. Inicie o ciclo quando a carga estiver completa: depois disso, nenhum pacote entra.
        </AlertBanner>
      ) : null}
      {starting ? <StartForm load={l} onDone={() => setStarting(false)} /> : null}
      {finishing ? <CycleForm load={l} onDone={() => setFinishing(false)} /> : null}
      {deciding ? <DecisionForm load={l} to={deciding} onDone={() => setDeciding(null)} /> : null}

      <Card title="Testes e indicadores" subtitle="Leituras e correções são novas versões: o registro anterior continua visível." headingLevel={2}
        actions={session.can('cme:test:record') && !testing ? <Button icon="plus" onClick={() => setTesting(true)}>Registrar teste</Button> : null}>
        {testing ? <TestForm load={l} onDone={() => setTesting(false)} /> : null}
        <TestTable tests={l.tests} canEdit={session.can('cme:test:record')} />
        {l.equipmentBowieDick ? <p className="ig-small ig-muted">Bowie-Dick do equipamento considerado: {TEST_RESULT_LABEL[l.equipmentBowieDick.result]} em {formatDate(l.equipmentBowieDick.performedAt, tz)}.</p> : null}
      </Card>

      <ItemsTable items={l.itemList} />

      <Card title="Histórico de decisões" subtitle="Não pode ser alterado. Cada decisão guarda a versão da política e a avaliação mostrada a quem decidiu." headingLevel={2}>
        <Timeline timeZone={tz} items={[...l.decisions].reverse().map((d) => ({
          id: d.id, at: d.at, tone: d.to === 'liberada' ? 'ok' : d.to === 'aguardando' ? 'neutral' : d.to === 'retida' ? 'warn' : 'crit',
          title: d.from ? `${decisionLabel(d.from, d.to)} — ${LOAD_STATUS_LABEL[d.to]}` : 'Carga registrada',
          detail: <>{d.by} · {d.justification}{d.policy ? ` · política v${d.policy.version}, avaliação: ${LOAD_STATUS_LABEL[d.evaluation.status]}` : ''}{d.evaluation.reasons.length ? ` (${d.evaluation.reasons.join(' ')})` : ''}</>,
        }))} />
      </Card>
    </div>
  );
}

function TestTable({ tests, canEdit }: { tests: CmeTestDto[]; canEdit: boolean }) {
  const tz = useTimeZone();
  const [replacing, setReplacing] = useState<CmeTestDto | null>(null);
  const cols: Column<CmeTestDto>[] = [
    { key: 'type', label: 'Teste', value: (t) => TEST_TYPE_LABEL[t.type], render: (t) => <span>{TEST_TYPE_LABEL[t.type]}{t.current ? '' : <span className="ig-small ig-muted"> (versão substituída)</span>}</span> },
    { key: 'result', label: 'Resultado', render: (t) => <TestResultBadge type={t.type} result={t.result} /> },
    { key: 'performedAt', label: 'Realizado', value: (t) => t.performedAt, render: (t) => formatDate(t.performedAt, tz) },
    { key: 'lot', label: 'Indicador', render: (t) => <span className="ig-small"><span className="ig-mono">{t.indicatorLot}</span>{t.indicatorExpiry ? ` · val. ${formatDate(t.indicatorExpiry)}` : ''}</span> },
    { key: 'ib', label: 'Incubação e leitura', render: (t) => (t.type === 'IB' ? <span className="ig-small">{t.incubationStart ? `início ${formatDate(t.incubationStart, tz)}` : ''}{t.readAt ? ` · leitura ${formatDate(t.readAt, tz)}` : ''}{t.controlResult ? ` · controle ${t.controlResult === 'positivo' ? 'com crescimento' : 'sem crescimento'}` : ''}</span> : '—') },
    { key: 'by', label: 'Registro', render: (t) => <span className="ig-small">{t.recordedBy}{t.justification ? ` · ${t.justification}` : ''}</span> },
    { key: 'files', label: 'Evidências', render: (t) => <Attachments entity="sterilization_test" entityId={t.id} files={t.attachments} canUpload={canEdit && t.current} /> },
    { key: 'actions', label: 'Ações', render: (t) => (canEdit && t.current ? <Button size="sm" onClick={() => setReplacing(t)} aria-label={`${t.type === 'IB' && t.result === 'pendente' ? 'Registrar leitura' : 'Corrigir'}: ${TEST_TYPE_LABEL[t.type]}`}>{t.type === 'IB' && t.result === 'pendente' ? 'Registrar leitura' : 'Corrigir'}</Button> : null) },
  ];
  return (
    <>
      {replacing ? <ReplaceForm test={replacing} onDone={() => setReplacing(null)} /> : null}
      <DataTable caption="Testes da carga" dense rows={tests} rowKey={(t) => t.id} columns={cols} emptyMessage="Nenhum teste registrado nesta carga." />
    </>
  );
}

function ItemsTable({ items }: { items: LoadItemDto[] }) {
  const tz = useTimeZone();
  const sectors = useCmeSectors();
  const cols: Column<LoadItemDto>[] = [
    { key: 'labelCode', label: 'Etiqueta', render: (i) => <span><span className="ig-mono">{i.labelCode}</span>{i.processId ? <> · <Link to={`/cme/processos/${i.processId}`} className="ig-small">trilha</Link></> : null}</span> },
    { key: 'description', label: 'Material', render: (i) => <span>{i.description}{i.quantity > 1 ? ` (${i.quantity})` : ''}{i.implant ? <span className="ig-small"> · implantável</span> : null}</span> },
    { key: 'packaging', label: 'Embalagem', value: (i) => PACKAGING_LABEL[i.packaging] },
    { key: 'expiresOn', label: 'Validade', value: (i) => i.expiresOn ?? '', render: (i) => (i.expiresOn ? formatDate(i.expiresOn) : 'Sem regra configurada') },
    { key: 'use', label: 'Uso', render: (i) => {
      if (!i.use) return <span className="ig-muted">Não utilizado</span>;
      const when = formatDate(i.use.usedAt, tz);
      if (i.use.patient && i.use.surgeryId) return <span>{when} · <Link to={`/cirurgias/${i.use.surgeryId}`}>{i.use.procedure}</Link> · <PatientLabel patient={i.use.patient} /></span>;
      if (i.use.procedure) return <span>{when} · {i.use.procedure} <span className="ig-small ig-muted">(paciente visível só para perfis com acesso a pacientes)</span></span>;
      return <span>{when} · {cmeSectorName(sectors.data, i.use.sectorId)} <span className="ig-small ig-muted">(sem paciente vinculado)</span></span>;
    } },
  ];
  return <DataTable caption="Pacotes da carga" rows={items} rowKey={(i) => i.id} columns={cols} />;
}

function StartForm({ load, onDone }: { load: LoadDetail; onDone: () => void }) {
  const cme = useCme()!;
  const tz = useTimeZone();
  const [startedAt, setStartedAt] = useState(nowLocal(tz));
  const m = useCmeMutation(() => cme.startCycle(load.id, { startedAt: localToIso(startedAt, tz)!, rowVersion: load.rowVersion }));
  return (
    <FormCard title="Iniciar ciclo" subtitle={`${load.itemList.length} pacote(s) na carga. Depois do início, a carga não recebe mais pacotes.`} error={m.formError} onSubmit={() => m.mutation.mutate(undefined, { onSuccess: onDone })} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Iniciar ciclo">
      <Field label="Início do ciclo" required error={m.fieldErrors.startedAt ?? null}><input type="datetime-local" value={startedAt} max={nowLocal(tz)} onChange={(e) => setStartedAt(e.target.value)} /></Field>
    </FormCard>
  );
}

function CycleForm({ load, onDone }: { load: LoadDetail; onDone: () => void }) {
  const cme = useCme()!;
  const tz = useTimeZone();
  const [d, setD] = useState({ endedAt: nowLocal(tz), temperatureC: '', pressureKpa: '', exposureMinutes: '', physicalResult: '' as '' | 'conforme' | 'nao_conforme', notes: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const num = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : null);
  const m = useCmeMutation(() => cme.finishCycle(load.id, { endedAt: localToIso(d.endedAt, tz)!, temperatureC: num(d.temperatureC), pressureKpa: num(d.pressureKpa), exposureMinutes: num(d.exposureMinutes), physicalResult: d.physicalResult as 'conforme', notes: d.notes.trim() || null, rowVersion: load.rowVersion }));
  const submit = () => {
    const e = {
      endedAt: d.endedAt && load.startedAt && localToIso(d.endedAt, tz)! > load.startedAt ? undefined : 'O término deve ser depois do início.',
      physicalResult: d.physicalResult ? undefined : 'Informe o resultado do registro físico.',
      temperatureC: d.temperatureC && !Number.isFinite(num(d.temperatureC)) ? 'Número inválido.' : undefined,
      exposureMinutes: d.exposureMinutes && !Number.isInteger(num(d.exposureMinutes)) ? 'Minutos inteiros.' : undefined,
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title="Encerrar ciclo" subtitle="Parâmetros do registro físico (impressão ou tela do equipamento)." error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Encerrar ciclo">
      <div className="ig-form-row">
        <Field label="Término" required error={err('endedAt')}><input type="datetime-local" value={d.endedAt} max={nowLocal(tz)} onChange={(e) => setD({ ...d, endedAt: e.target.value })} /></Field>
        <Field label="Temperatura (°C)" error={err('temperatureC')}><input inputMode="decimal" value={d.temperatureC} onChange={(e) => setD({ ...d, temperatureC: e.target.value })} /></Field>
        <Field label="Pressão (kPa)" error={err('pressureKpa')}><input inputMode="decimal" value={d.pressureKpa} onChange={(e) => setD({ ...d, pressureKpa: e.target.value })} /></Field>
        <Field label="Exposição (min)" error={err('exposureMinutes')}><input inputMode="numeric" value={d.exposureMinutes} onChange={(e) => setD({ ...d, exposureMinutes: e.target.value })} /></Field>
      </div>
      <Field label="Registro físico" required error={err('physicalResult')}>
        <select value={d.physicalResult} onChange={(e) => setD({ ...d, physicalResult: e.target.value as 'conforme' })}><option value="">Selecione</option>{Object.entries(PHYSICAL_RESULT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </Field>
      <Field label="Observações"><textarea value={d.notes} maxLength={1000} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
    </FormCard>
  );
}

function DecisionForm({ load, to, onDone }: { load: LoadDetail; to: LoadStatus; onDone: () => void }) {
  const cme = useCme()!;
  const [justification, setJustification] = useState(DECISION_DEFAULT[to] ?? '');
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState(false);
  const label = decisionLabel(load.status, to);
  const m = useCmeMutation(() => cme.decide(load.id, { status: to, justification: justification.trim(), rowVersion: load.rowVersion }));
  const problems = m.mutation.error instanceof ApiError ? m.mutation.error.fields.map((f) => f.message) : [];
  const recall = load.status === 'liberada';
  return (
    <>
      <FormCard title={`${label}: carga ${load.code}`} subtitle={recall ? 'Recolhimento: a carga deixa de poder ser usada e um alerta com a exposição de pacientes é enviado à CCIH.' : `Avaliação pela política: ${LOAD_STATUS_LABEL[load.evaluation.status]}.`}
        error={m.formError} busy={m.mutation.isPending} submitLabel="Continuar" onCancel={onDone}
        onSubmit={() => { const e = justificationError(justification); setError(e); if (!e) setConfirm(true); }}>
        {problems.length ? <AlertBanner tone="warn" title="Não foi possível registrar">{problems.join(' ')}</AlertBanner> : null}
        {load.evaluation.reasons.length ? <AlertBanner tone="info" title="Pendências apontadas pela política">{load.evaluation.reasons.join(' ')}</AlertBanner> : null}
        <JustificationField value={justification} onChange={setJustification} error={error ?? m.fieldErrors.justification} />
      </FormCard>
      <ConfirmDialog open={confirm} title={`${label} a carga ${load.code}?`} confirmLabel="Confirmar" tone={to === 'liberada' ? 'primary' : 'danger'} busy={m.mutation.isPending}
        onCancel={() => setConfirm(false)} onConfirm={() => m.mutation.mutate(undefined, { onSettled: () => setConfirm(false), onSuccess: onDone })}>
        A decisão entra no histórico da carga, que não pode ser alterado, com a versão da política aplicada.
      </ConfirmDialog>
    </>
  );
}

const LOAD_TEST_TYPES: RecordedTestType[] = ['IQ1', 'IQ2', 'IQ3', 'IQ4', 'IQ5', 'IQ6', 'IB'];

function TestForm({ load, onDone }: { load: LoadDetail; onDone: () => void }) {
  const cme = useCme()!;
  const tz = useTimeZone();
  const [d, setD] = useState({ type: 'IQ5' as RecordedTestType, result: 'aprovado' as TestResult, performedAt: nowLocal(tz), indicatorLot: '', indicatorExpiry: '', incubationStart: nowLocal(tz), notes: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const ib = d.type === 'IB';
  const m = useCmeMutation(() => cme.createTest({
    sterilizerId: null, loadId: load.id, type: d.type, result: ib ? 'pendente' : d.result, performedAt: localToIso(d.performedAt, tz)!, indicatorLot: d.indicatorLot.trim(),
    indicatorExpiry: d.indicatorExpiry || null, incubationStart: ib ? localToIso(d.incubationStart, tz) : null, readAt: null, controlResult: null, notes: d.notes.trim() || null,
  }));
  const submit = () => {
    const e = {
      indicatorLot: d.indicatorLot.trim() ? undefined : 'Informe o lote do indicador.',
      indicatorExpiry: !d.indicatorExpiry ? 'Informe a validade do indicador.' : d.indicatorExpiry < todayIn(tz) ? 'Indicador vencido.' : undefined,
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title="Registrar teste da carga" subtitle={ib ? 'O indicador biológico é registrado em incubação; a leitura é registrada depois, como nova versão.' : 'Indicadores químicos têm leitura imediata.'}
      error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Registrar">
      <div className="ig-form-row">
        <Field label="Teste" required><select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as RecordedTestType })}>{LOAD_TEST_TYPES.map((t) => <option key={t} value={t}>{TEST_TYPE_LABEL[t]}</option>)}</select></Field>
        {!ib ? <Field label="Resultado" required error={err('result')}><select value={d.result} onChange={(e) => setD({ ...d, result: e.target.value as TestResult })}><option value="aprovado">Aprovado</option><option value="reprovado">Reprovado</option></select></Field> : null}
        <Field label="Realizado em" required error={err('performedAt')}><input type="datetime-local" value={d.performedAt} max={nowLocal(tz)} onChange={(e) => setD({ ...d, performedAt: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Lote do indicador" required error={err('indicatorLot')}><input value={d.indicatorLot} maxLength={40} onChange={(e) => setD({ ...d, indicatorLot: e.target.value })} /></Field>
        <Field label="Validade do indicador" required error={err('indicatorExpiry')}><input type="date" value={d.indicatorExpiry} onChange={(e) => setD({ ...d, indicatorExpiry: e.target.value })} /></Field>
        {ib ? <Field label="Início da incubação" required error={err('incubationStart')}><input type="datetime-local" value={d.incubationStart} max={nowLocal(tz)} onChange={(e) => setD({ ...d, incubationStart: e.target.value })} /></Field> : null}
      </div>
      <Field label="Observações"><input value={d.notes} maxLength={1000} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
    </FormCard>
  );
}

function ReplaceForm({ test, onDone }: { test: CmeTestDto; onDone: () => void }) {
  const cme = useCme()!;
  const tz = useTimeZone();
  const reading = test.type === 'IB' && test.result === 'pendente';
  const ib = test.type === 'IB';
  const [d, setD] = useState({ result: (reading ? 'aprovado' : test.result) as TestResult, readAt: nowLocal(tz), controlResult: '' as '' | IbControl, notes: '', justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useCmeMutation(() => cme.replaceTest(test.id, { result: d.result, readAt: ib && d.result !== 'pendente' ? localToIso(d.readAt, tz) : null, controlResult: ib && d.result !== 'pendente' ? (d.controlResult || null) : null, notes: d.notes.trim() || null, justification: d.justification.trim() || null }));
  const submit = () => {
    const e = {
      controlResult: ib && d.result !== 'pendente' && !d.controlResult ? 'Informe o resultado do indicador controle.' : undefined,
      justification: reading ? undefined : justificationError(d.justification),
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title={reading ? 'Leitura do indicador biológico' : `Corrigir ${TEST_TYPE_LABEL[test.type]}`} subtitle="Uma nova versão é registrada; a anterior continua no histórico." error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Registrar">
      <div className="ig-form-row">
        <Field label="Resultado" required error={err('result')}>
          <select value={d.result} onChange={(e) => setD({ ...d, result: e.target.value as TestResult })}>
            {(['aprovado', 'reprovado'] as TestResult[]).map((r) => <option key={r} value={r}>{ib ? IB_RESULT_LABEL[r] : TEST_RESULT_LABEL[r]}</option>)}
          </select>
        </Field>
        {ib ? <Field label="Leitura em" required error={err('readAt')}><input type="datetime-local" value={d.readAt} max={nowLocal(tz)} onChange={(e) => setD({ ...d, readAt: e.target.value })} /></Field> : null}
        {ib ? (
          <Field label="Indicador controle (não processado)" required error={err('controlResult')} hint="O controle precisa crescer; sem crescimento, a leitura não vale.">
            <select value={d.controlResult} onChange={(e) => setD({ ...d, controlResult: e.target.value as IbControl })}><option value="">Selecione</option><option value="positivo">Com crescimento (válido)</option><option value="negativo">Sem crescimento</option></select>
          </Field>
        ) : null}
      </div>
      <Field label="Observações"><input value={d.notes} maxLength={1000} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
      {!reading ? <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={err('justification') ?? undefined} /> : null}
    </FormCard>
  );
}
