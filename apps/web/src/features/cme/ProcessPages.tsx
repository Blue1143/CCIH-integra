import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  INPUT_METHOD_LABEL, LOAD_STATUS_LABEL, PROCESS_STATE_LABEL, PROCESS_STEP_LABEL, SCAN_RESULT_LABEL, SCANNABLE_STEPS, formatDate,
  type ProcessState, type ProcessSummaryDto, type Status,
} from '@ccih/domain';
import { Button, Card, DataTable, ErrorState, LoadingState, StatusBadge, type Column } from '@ccih/ui';
import { DemoTag, PageHeader, Pager, Timeline, useTimeZone } from '../clinical/shared';
import { useUrlFilters } from '../operations/shared';
import { CmeNav, RequireCme, cmeSectorName, useCme, useCmeSectors } from './shared';
import { RESULT_TONE } from './StationPage';
import { LabelHistory, LabelPrintPanel, useActiveLabels } from './labels';
import { useSession } from '../auth/session';

const STATE_TONE: Record<ProcessState, Status> = { em_processo: 'info', bloqueado: 'crit', liberado: 'ok', distribuido: 'ok', devolvido: 'neutral', encerrado: 'neutral', descartado: 'warn' };

export function ProcessesPage() {
  return <RequireCme title="Processos da CME"><Processes /></RequireCme>;
}

function Processes() {
  const cme = useCme()!;
  const tz = useTimeZone();
  const f = useUrlFilters({ situacao: 'abertos' });
  const [q, setQ] = useState(f.get('q'));
  const query = { situacao: f.get('situacao'), etapa: f.get('etapa') || undefined, q: f.get('q') || undefined, page: f.page, pageSize: 25 };
  const list = useQuery({ queryKey: ['cme', 'processes', query], queryFn: () => cme.processes(query), placeholderData: (p) => p });
  const cols: Column<ProcessSummaryDto>[] = [
    { key: 'description', label: 'Material', render: (p) => <span><Link to={`/cme/processos/${p.id}`}>{p.description}</Link> <DemoTag origin={p.origin} />{p.legacy ? <span className="ig-small ig-muted"> (rastreio iniciado no ciclo)</span> : null}</span>, value: (p) => p.description },
    { key: 'code', label: 'Código', render: (p) => <span className="ig-mono scan-code">{p.code}</span> },
    { key: 'step', label: 'Etapa atual', value: (p) => PROCESS_STEP_LABEL[p.currentStep] },
    { key: 'state', label: 'Situação', render: (p) => <StatusBadge status={STATE_TONE[p.state]}>{PROCESS_STATE_LABEL[p.state]}</StatusBadge>, value: (p) => PROCESS_STATE_LABEL[p.state] },
    { key: 'next', label: 'Próxima etapa', value: (p) => p.nextSteps.map((s) => PROCESS_STEP_LABEL[s]).join(' ou ') || '—' },
    { key: 'package', label: 'Pacote / carga', render: (p) => (p.packageLabel ? <span><span className="ig-mono">{p.packageLabel}</span>{p.loadStatus ? ` · ${LOAD_STATUS_LABEL[p.loadStatus]}` : ''}</span> : '—') },
    { key: 'openedAt', label: 'Recebido em', value: (p) => p.openedAt, render: (p) => formatDate(p.openedAt, tz) },
  ];
  return (
    <div className="page">
      <PageHeader title="Processos da CME" subtitle="Cada processo é uma rodada de reprocessamento de um material, da recepção à distribuição ou devolução, com a trilha de todas as leituras." />
      <CmeNav />
      <form className="filters" role="search" onSubmit={(e) => { e.preventDefault(); f.set('q', q.trim()); }}>
        <div className="field"><label htmlFor="pr-sit">Situação</label>
          <select id="pr-sit" className="select" value={f.get('situacao')} onChange={(e) => f.set('situacao', e.target.value)}><option value="abertos">Em andamento</option><option value="encerrados">Encerrados</option><option value="todos">Todos</option></select>
        </div>
        <div className="field"><label htmlFor="pr-et">Etapa atual</label>
          <select id="pr-et" className="select" value={f.get('etapa')} onChange={(e) => f.set('etapa', e.target.value)}><option value="">Todas</option>{SCANNABLE_STEPS.map((s) => <option key={s} value={s}>{PROCESS_STEP_LABEL[s]}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="pr-q">Código ou material</label><input id="pr-q" className="select" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Button type="submit" icon="search">Buscar</Button>
      </form>
      <DataTable caption="Processos" rows={list.data?.rows ?? []} rowKey={(p) => p.id} columns={cols} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'} pageSize={100} emptyMessage="Nenhum processo com estes filtros." />
      {list.data ? <Pager page={f.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => f.set('pagina', String(p))} /> : null}
    </div>
  );
}

export function ProcessDetailPage() {
  return <RequireCme title="Processo"><ProcessDetailView /></RequireCme>;
}

function ProcessDetailView() {
  const { id } = useParams();
  const cme = useCme()!;
  const tz = useTimeZone();
  const sectors = useCmeSectors();
  const q = useQuery({ queryKey: ['cme', 'process', id], queryFn: () => cme.process(id!) });
  if (q.isPending) return <div className="page"><LoadingState /></div>;
  if (q.isError) return <div className="page"><ErrorState onRetry={() => void q.refetch()} /></div>;
  const p = q.data;
  const loose = p.code.startsWith('PR-');
  return (
    <div className="page">
      <PageHeader back={{ to: '/cme/processos', label: 'Processos' }} title={<span>{p.description} <span className="ig-mono" style={{ fontSize: '0.6em' }}>{p.code}</span> <DemoTag origin={p.origin} /></span>}
        subtitle={<>Recebido em {formatDate(p.openedAt, tz)}{p.closedAt ? ` · encerrado em ${formatDate(p.closedAt, tz)}` : ''}{p.legacy ? ' · rastreio iniciado no ciclo (pacote anterior ao fluxo por leitura)' : ''}</>}
        actions={<StatusBadge status={STATE_TONE[p.state]}>{PROCESS_STATE_LABEL[p.state]}</StatusBadge>} />
      <CmeNav />
      <Card title="Situação" headingLevel={2}>
        <dl className="ig-facts">
          <div><dt>Etapa atual</dt><dd>{PROCESS_STEP_LABEL[p.currentStep]}</dd></div>
          <div><dt>Próxima etapa</dt><dd>{p.nextSteps.map((s) => PROCESS_STEP_LABEL[s]).join(' ou ') || '—'}</dd></div>
          <div><dt>Pacote</dt><dd>{p.packageLabel ? <span className="ig-mono">{p.packageLabel}</span> : '—'}</dd></div>
          <div><dt>Carga</dt><dd>{p.loadId ? <Link to={`/cme/cargas/${p.loadId}`} className="ig-mono">{p.loadCode}</Link> : '—'}{p.loadStatus ? ` · ${LOAD_STATUS_LABEL[p.loadStatus]}` : ''}</dd></div>
          <div><dt>Destino</dt><dd>{p.destinationSectorId ? cmeSectorName(sectors.data, p.destinationSectorId) : '—'}</dd></div>
        </dl>
        <p className="ig-small" style={{ marginBottom: 0 }}>
          {p.previousProcessId ? <Link to={`/cme/processos/${p.previousProcessId}`}>Rodada anterior deste material</Link> : null}
          {p.previousProcessId && p.nextProcessId ? ' · ' : null}
          {p.nextProcessId ? <Link to={`/cme/processos/${p.nextProcessId}`}>Rodada seguinte</Link> : null}
        </p>
      </Card>
      {loose ? <ReceptionLabel processId={p.id} code={p.code} closed={!!p.closedAt} /> : null}
      <Card title="Trilha de leituras" subtitle="Inclui leituras recusadas. Registros não podem ser alterados." headingLevel={2}>
        <Timeline timeZone={tz} items={[...p.events].reverse().map((e) => ({
          id: e.id, at: e.serverAt, tone: RESULT_TONE[e.result],
          title: `${PROCESS_STEP_LABEL[e.step]} — ${SCAN_RESULT_LABEL[e.result]}`,
          detail: <>{e.message} · {e.userName}{e.stationName ? ` · ${e.stationName}` : ''}{e.device ? ` (${e.device})` : ''} · {INPUT_METHOD_LABEL[e.inputMethod]}{e.destinationSectorId ? ` · destino: ${cmeSectorName(sectors.data, e.destinationSectorId)}` : ''}{e.justification ? ` · justificativa: ${e.justification}` : ''}{e.deviceAt ? ` · hora do dispositivo: ${formatDate(e.deviceAt, tz)}` : ''}</>,
        }))} />
      </Card>
    </div>
  );
}

/** Material without a permanent asset code gets a reception label with its process code. */
function ReceptionLabel({ processId, code, closed }: { processId: string; code: string; closed: boolean }) {
  const session = useSession();
  const active = useActiveLabels('processo', code);
  const [printing, setPrinting] = useState(false);
  const canPrint = !closed && session.can('cme:scan', 'cme:cycle:record') && session.writable;
  return (
    <>
      {canPrint && !printing ? (
        <div className="ig-row" style={{ gap: 8 }}>
          <Button icon="printer" onClick={() => setPrinting(true)}>{active.has(processId) ? 'Reimprimir etiqueta de recepção' : 'Imprimir etiqueta de recepção'}</Button>
        </div>
      ) : null}
      {printing ? <LabelPrintPanel entity="processo" targets={[{ id: processId, code, hasActive: active.has(processId) }]} onClose={() => setPrinting(false)} /> : null}
      <LabelHistory title="Etiqueta de recepção" entity="processo" entityId={processId} />
    </>
  );
}
