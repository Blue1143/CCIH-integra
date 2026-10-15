import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CLIENT_STATUS_LABEL, ESTABLISHMENT_KIND_LABEL, checkClient, formatCnpj,
  type ClientDetailDto, type ClientStatus, type ClientSummaryDto, type EstablishmentKind,
} from '@ccih/domain';
import { Button, DataTable, Field, StatusBadge, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, Pager } from '../clinical/shared';
import { useUrlFilters } from '../operations/shared';
import { AddressFields, CLIENT_STATUS_TONE, EMPTY_ADDRESS, RequireConsulting, addressDraft, addressInput, blank, useConsulting, useConsultingMutation } from './shared';

export function ClientsPage() {
  return <RequireConsulting title="Clientes"><Clients /></RequireConsulting>;
}

function Clients() {
  const consulting = useConsulting()!;
  const session = useSession();
  const navigate = useNavigate();
  const f = useUrlFilters();
  const [creating, setCreating] = useState(false);
  const allPortfolio = session.can('consultoria:portfolio:all');
  const team = useQuery({ queryKey: ['consulting', 'team'], queryFn: () => consulting.team(), enabled: session.can('consultoria:portfolio:assign', 'consultoria:portfolio:all') });
  const query = { q: f.get('q') || undefined, status: f.get('situacao') || undefined, kind: f.get('tipo') || undefined, consultantId: f.get('consultor') || undefined, page: f.page, pageSize: 25 };
  const list = useQuery({ queryKey: ['consulting', 'clients', query], queryFn: () => consulting.clients(query) });
  const cols: Column<ClientSummaryDto>[] = [
    { key: 'name', label: 'Cliente', value: (c) => c.tradeName ?? c.legalName, render: (c) => <span><Link to={`/consultoria/clientes/${c.id}`}><b>{c.tradeName ?? c.legalName}</b></Link> <DemoTag origin={c.dataOrigin} /><br /><span className="ig-small ig-muted">{c.legalName}{c.cnpj ? ` · ${formatCnpj(c.cnpj)}` : ''}</span></span> },
    { key: 'kind', label: 'Tipo', value: (c) => ESTABLISHMENT_KIND_LABEL[c.kind] },
    { key: 'city', label: 'Cidade', value: (c) => (c.city ? `${c.city}${c.state ? `/${c.state}` : ''}` : '—') },
    { key: 'establishments', label: 'Estabelecimentos', value: (c) => c.establishments },
    { key: 'responsible', label: 'Consultor responsável', value: (c) => c.responsible?.name ?? '—', render: (c) => (c.responsible ? c.responsible.name : <span className="ig-muted">Sem responsável</span>) },
    { key: 'status', label: 'Situação', value: (c) => c.status, render: (c) => <StatusBadge status={CLIENT_STATUS_TONE[c.status]}>{CLIENT_STATUS_LABEL[c.status]}</StatusBadge> },
  ];
  return (
    <div className="page">
      <PageHeader title="Clientes" subtitle={allPortfolio ? 'Carteira completa da consultoria: clientes, estabelecimentos e consultores responsáveis.' : 'Os clientes atribuídos a você. Outros clientes da carteira não aparecem para o seu perfil.'}
        actions={session.can('consultoria:clients:edit') && session.writable && !creating ? <Button icon="plus" onClick={() => setCreating(true)}>Novo cliente</Button> : null} />
      {creating ? <ClientForm client={null} onDone={(created) => { setCreating(false); if (created) navigate(`/consultoria/clientes/${created.id}`); }} /> : null}
      <div className="filters" role="search">
        <div className="field"><label htmlFor="cl-q">Pesquisar</label><input id="cl-q" className="select" value={f.get('q')} placeholder="Nome, cidade ou CNPJ" onChange={(e) => f.set('q', e.target.value)} /></div>
        <div className="field"><label htmlFor="cl-st">Situação</label>
          <select id="cl-st" className="select" value={f.get('situacao')} onChange={(e) => f.set('situacao', e.target.value)}><option value="">Todas</option>{(Object.keys(CLIENT_STATUS_LABEL) as ClientStatus[]).map((k) => <option key={k} value={k}>{CLIENT_STATUS_LABEL[k]}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="cl-tp">Tipo</label>
          <select id="cl-tp" className="select" value={f.get('tipo')} onChange={(e) => f.set('tipo', e.target.value)}><option value="">Todos</option>{(Object.keys(ESTABLISHMENT_KIND_LABEL) as EstablishmentKind[]).map((k) => <option key={k} value={k}>{ESTABLISHMENT_KIND_LABEL[k]}</option>)}</select>
        </div>
        {team.data ? (
          <div className="field"><label htmlFor="cl-co">Consultor</label>
            <select id="cl-co" className="select" value={f.get('consultor')} onChange={(e) => f.set('consultor', e.target.value)}><option value="">Todos</option>{team.data.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>
          </div>
        ) : null}
      </div>
      <DataTable caption="Clientes" rows={list.data?.rows ?? []} rowKey={(c) => c.id} columns={cols} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'}
        emptyMessage={allPortfolio ? 'Nenhum cliente cadastrado com estes filtros.' : 'Nenhum cliente atribuído a você. O gestor da consultoria distribui a carteira.'} />
      {list.data ? <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => f.set('pagina', String(p))} /> : null}
    </div>
  );
}

/** Registration of a client (new or edit). Internal notes only for the profiles allowed to see them. */
export function ClientForm({ client, onDone }: { client: ClientDetailDto | null; onDone: (saved: ClientDetailDto | null) => void }) {
  const consulting = useConsulting()!;
  const session = useSession();
  const notes = session.can('consultoria:clients:internal_notes');
  const [d, setD] = useState({
    legalName: client?.legalName ?? '', tradeName: client?.tradeName ?? '', cnpj: client?.cnpj ? formatCnpj(client.cnpj) : '', kind: client?.kind ?? ('hospital' as EstablishmentKind),
    status: client?.status ?? ('ativo' as ClientStatus), email: client?.email ?? '', phone: client?.phone ?? '', servicesSummary: client?.servicesSummary ?? '',
    internalNotes: client?.internalNotes ?? '', address: addressDraft(client?.address ?? EMPTY_ADDRESS),
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const input = { legalName: d.legalName.trim(), tradeName: blank(d.tradeName), cnpj: blank(d.cnpj), kind: d.kind, status: d.status, email: blank(d.email), phone: blank(d.phone), address: addressInput(d.address), servicesSummary: blank(d.servicesSummary) };
  const m = useConsultingMutation(() => consulting.saveClient(client?.id ?? null, { ...input, ...(notes ? { internalNotes: blank(d.internalNotes) } : {}), rowVersion: client?.rowVersion ?? null }));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const submit = () => {
    const e = Object.fromEntries(checkClient(input).map((p) => [p.path, p.message]));
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: (saved) => onDone(saved) });
  };
  return (
    <FormCard title={client ? 'Editar cadastro do cliente' : 'Novo cliente'} subtitle="Dados institucionais e de contato. Estabelecimentos, contatos e consultores são cadastrados na ficha do cliente."
      error={m.formError} onSubmit={submit} onCancel={() => onDone(null)} busy={m.mutation.isPending} submitLabel={client ? 'Salvar cadastro' : 'Cadastrar cliente'}>
      <div className="ig-form-row">
        <Field label="Razão social" required error={err('legalName')}><input value={d.legalName} maxLength={200} onChange={(e) => setD({ ...d, legalName: e.target.value })} /></Field>
        <Field label="Nome fantasia"><input value={d.tradeName} maxLength={200} onChange={(e) => setD({ ...d, tradeName: e.target.value })} /></Field>
        <Field label="CNPJ" error={err('cnpj')}><input value={d.cnpj} inputMode="numeric" maxLength={18} placeholder="00.000.000/0000-00" onChange={(e) => setD({ ...d, cnpj: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Tipo de estabelecimento" required><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as EstablishmentKind })}>{(Object.keys(ESTABLISHMENT_KIND_LABEL) as EstablishmentKind[]).map((k) => <option key={k} value={k}>{ESTABLISHMENT_KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Situação do relacionamento" required><select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as ClientStatus })}>{(Object.keys(CLIENT_STATUS_LABEL) as ClientStatus[]).map((k) => <option key={k} value={k}>{CLIENT_STATUS_LABEL[k]}</option>)}</select></Field>
        <Field label="E-mail institucional" error={err('email')}><input type="email" value={d.email} maxLength={160} onChange={(e) => setD({ ...d, email: e.target.value })} /></Field>
        <Field label="Telefone" error={err('phone')}><input value={d.phone} inputMode="tel" maxLength={30} onChange={(e) => setD({ ...d, phone: e.target.value })} /></Field>
      </div>
      <AddressFields value={d.address} onChange={(address) => setD({ ...d, address })} errors={{ ...m.fieldErrors, ...errors }} />
      <Field label="Serviços contratados (resumo)" hint="O detalhamento por contrato chega no módulo de contratos."><textarea value={d.servicesSummary} maxLength={2000} onChange={(e) => setD({ ...d, servicesSummary: e.target.value })} /></Field>
      {notes ? <Field label="Observações administrativas internas" hint="Visíveis só para gestão, administração, assistente e financeiro. Nunca aparecem para consultores nem para o cliente."><textarea value={d.internalNotes} maxLength={4000} onChange={(e) => setD({ ...d, internalNotes: e.target.value })} /></Field> : null}
    </FormCard>
  );
}
