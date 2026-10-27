import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CONTRACT_STATUS_LABEL, formatDate, type ContractStatus, type ContractSummaryDto } from '@ccih/domain';
import { Button, Card, DataTable, Field, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { DemoTag, PageHeader, Pager } from '../clinical/shared';
import { useUrlFilters } from '../operations/shared';
import { ExpiryNote, PlanBar, ProposalForm, SituationBadge } from './contracts-shared';
import { RequireConsulting, useConsulting } from './shared';

export function ContractsPage() {
  return <RequireConsulting title="Contratos"><Contracts /></RequireConsulting>;
}

/** Contract columns shared by this page and the client record. */
export function contractColumns(withClient: boolean): Column<ContractSummaryDto>[] {
  return [
    { key: 'code', label: 'Contrato', value: (c) => c.code, render: (c) => <span><Link to={`/consultoria/contratos/${c.id}`}><b>{c.code}</b></Link> <DemoTag origin={c.dataOrigin} /><br /><span className="ig-small ig-muted">{c.title}</span></span> },
    ...(withClient ? [{ key: 'client', label: 'Cliente', value: (c: ContractSummaryDto) => c.clientName, render: (c: ContractSummaryDto) => <Link to={`/consultoria/clientes/${c.clientId}`}>{c.clientName}</Link> }] : []),
    { key: 'term', label: 'Vigência', value: (c) => c.startsOn ?? '', render: (c) => (c.startsOn ? <span>{formatDate(c.startsOn)} a {c.endsOn ? formatDate(c.endsOn) : 'sem término'}<br /><ExpiryNote c={c} /></span> : <span className="ig-muted">A definir</span>) },
    { key: 'situation', label: 'Situação', value: (c) => c.situation, render: (c) => <SituationBadge situation={c.situation} /> },
    { key: 'services', label: 'Serviços', align: 'right', value: (c) => c.services },
    { key: 'plan', label: 'Previsto × realizado (períodos encerrados)', render: (c) => <PlanBar planned={c.plannedClosed} done={c.doneClosed} label={`Entregas de ${c.code}`} /> },
    { key: 'responsible', label: 'Responsável', value: (c) => c.responsible ?? '—' },
  ];
}

function Contracts() {
  const consulting = useConsulting()!;
  const session = useSession();
  const navigate = useNavigate();
  const f = useUrlFilters();
  const [creating, setCreating] = useState(false);
  const query = { q: f.get('q') || undefined, status: f.get('situacao') || undefined, expiring: f.get('vencendo') || undefined, page: f.page, pageSize: 25 };
  const list = useQuery({ queryKey: ['consulting', 'contracts', query], queryFn: () => consulting.contracts(query) });
  const canEdit = session.can('consultoria:contracts:edit') && session.writable;
  return (
    <div className="page">
      <PageHeader title="Contratos" subtitle="Propostas e contratos dos clientes visíveis para você: serviços contratados, vigência, aditivos e previsto × realizado."
        actions={canEdit && !creating ? <Button icon="plus" onClick={() => setCreating(true)}>Nova proposta</Button> : null} />
      {creating ? <NewProposal onDone={(id) => { setCreating(false); if (id) navigate(`/consultoria/contratos/${id}`); }} /> : null}
      <div className="filters" role="search">
        <div className="field"><label htmlFor="ct-q">Pesquisar</label><input id="ct-q" className="select" value={f.get('q')} placeholder="Código, objeto ou cliente" onChange={(e) => f.set('q', e.target.value)} /></div>
        <div className="field"><label htmlFor="ct-st">Situação</label>
          <select id="ct-st" className="select" value={f.get('situacao')} onChange={(e) => f.set('situacao', e.target.value)}><option value="">Todas</option>{(Object.keys(CONTRACT_STATUS_LABEL) as ContractStatus[]).map((k) => <option key={k} value={k}>{CONTRACT_STATUS_LABEL[k]}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="ct-vc">Vencimento</label>
          <select id="ct-vc" className="select" value={f.get('vencendo')} onChange={(e) => f.set('vencendo', e.target.value)}><option value="">Todos</option><option value="1">Vencendo ou vencidos</option></select>
        </div>
      </div>
      <DataTable caption="Contratos" rows={list.data?.rows ?? []} rowKey={(c) => c.id} columns={contractColumns(true)} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'}
        emptyMessage="Nenhum contrato com estes filtros." />
      {list.data ? <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => f.set('pagina', String(p))} /> : null}
      <p className="ig-small ig-muted">Previsto × realizado conta os períodos já encerrados de cada serviço (por exemplo, os meses completos de uma visita mensal), com as entregas registradas no período.</p>
    </div>
  );
}

/** New proposal from the contract list: choose the client, then fill the proposal. */
function NewProposal({ onDone }: { onDone: (id: string | null) => void }) {
  const consulting = useConsulting()!;
  const [clientId, setClientId] = useState('');
  const clients = useQuery({ queryKey: ['consulting', 'clients', { pageSize: 100 }], queryFn: () => consulting.clients({ pageSize: 100 }) });
  const client = useQuery({ queryKey: ['consulting', 'client', clientId], queryFn: () => consulting.client(clientId), enabled: !!clientId });
  const options = (clients.data?.rows ?? []).filter((c) => c.status !== 'encerrado');
  return (
    <Card title="Nova proposta" headingLevel={2}>
      <Field label="Cliente da proposta" required>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Selecione</option>{options.map((c) => <option key={c.id} value={c.id}>{c.tradeName ?? c.legalName}</option>)}</select>
      </Field>
      {!clientId ? <Button onClick={() => onDone(null)}>Cancelar</Button> : null}
      {client.data ? <ProposalForm key={clientId} clientId={clientId} contract={null} establishments={client.data.establishments.map((e) => ({ id: e.id, name: e.name }))} onDone={(saved) => onDone(saved?.id ?? null)} /> : null}
    </Card>
  );
}
