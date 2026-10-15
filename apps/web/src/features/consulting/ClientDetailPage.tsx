import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ASSIGNMENT_ROLE_LABEL, CLIENT_EVENT_LABEL, CLIENT_STATUS_LABEL, CONTACT_KIND_LABEL, ESTABLISHMENT_KIND_LABEL, SPECIALTY_LABEL, UNIT_KIND_LABEL,
  checkContact, checkEstablishment, checkUnit, formatCnpj, formatDate,
  type AssignmentDto, type AssignmentRole, type ClientDetailDto, type ClientEventKind, type ContactDto, type ContactKind, type EstablishmentDto, type EstablishmentKind,
  type Specialty, type UnitDto, type UnitKind,
} from '@ccih/domain';
import { Button, Card, DataTable, ErrorState, Field, LoadingState, StatusBadge, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, Timeline, useTimeZone } from '../clinical/shared';
import { ClientForm } from './ClientsPage';
import { AddressFields, CLIENT_STATUS_TONE, EMPTY_ADDRESS, RequireConsulting, addressDraft, addressInput, addressLine, blank, useConsulting, useConsultingMutation } from './shared';

export function ClientDetailPage() {
  return <RequireConsulting title="Cliente"><ClientDetail /></RequireConsulting>;
}

const EVENT_TONE: Record<ClientEventKind, 'ok' | 'info' | 'warn' | 'neutral'> = {
  cadastro: 'info', alteracao: 'neutral', atribuicao: 'ok', substituicao: 'warn', encerramento_atribuicao: 'neutral', atendimento: 'ok', observacao: 'neutral',
};

function ClientDetail() {
  const { id } = useParams();
  const consulting = useConsulting()!;
  const session = useSession();
  const tz = useTimeZone();
  const q = useQuery({ queryKey: ['consulting', 'client', id], queryFn: () => consulting.client(id!) });
  const [editing, setEditing] = useState(false);
  const canEdit = session.can('consultoria:clients:edit') && session.writable;
  if (q.isPending) return <div className="page"><LoadingState /></div>;
  if (q.isError) return <div className="page"><ErrorState onRetry={() => void q.refetch()} /></div>;
  const c = q.data;
  return (
    <div className="page">
      <PageHeader back={{ to: '/consultoria/clientes', label: 'Clientes' }} title={<span>{c.tradeName ?? c.legalName} <DemoTag origin={c.dataOrigin} /></span>}
        subtitle={<>{c.legalName}{c.cnpj ? ` · CNPJ ${formatCnpj(c.cnpj)}` : ''} · {ESTABLISHMENT_KIND_LABEL[c.kind]}</>}
        actions={<span className="ig-row" style={{ gap: 8 }}><StatusBadge status={CLIENT_STATUS_TONE[c.status]}>{CLIENT_STATUS_LABEL[c.status]}</StatusBadge>{canEdit && !editing ? <Button onClick={() => setEditing(true)}>Editar cadastro</Button> : null}</span>} />
      {editing ? <ClientForm client={c} onDone={() => setEditing(false)} /> : (
        <Card title="Cadastro" headingLevel={2}>
          <dl className="ig-facts">
            <div><dt>E-mail</dt><dd>{c.email ?? '—'}</dd></div>
            <div><dt>Telefone</dt><dd>{c.phone ?? '—'}</dd></div>
            <div><dt>Endereço</dt><dd>{addressLine(c.address)}</dd></div>
            <div><dt>Serviços contratados</dt><dd>{c.servicesSummary ?? '—'}</dd></div>
            {'internalNotes' in c ? <div><dt>Observações internas</dt><dd>{c.internalNotes ?? '—'}</dd></div> : null}
          </dl>
        </Card>
      )}
      <Consultants client={c} />
      <Contacts client={c} canEdit={canEdit} />
      <Establishments client={c} canEdit={canEdit} />
      <History client={c} tz={tz} />
    </div>
  );
}

/* ---------- Consultants ---------- */

function Consultants({ client }: { client: ClientDetailDto }) {
  const session = useSession();
  const consulting = useConsulting()!;
  const canAssign = session.can('consultoria:portfolio:assign') && session.writable;
  const [assigning, setAssigning] = useState(false);
  const [ending, setEnding] = useState<AssignmentDto | null>(null);
  const active = client.assignments.filter((a) => !a.endsOn);
  const past = client.assignments.filter((a) => a.endsOn);
  const cols: Column<AssignmentDto>[] = [
    { key: 'user', label: 'Consultor', value: (a) => a.userName },
    { key: 'role', label: 'Papel', value: (a) => `${ASSIGNMENT_ROLE_LABEL[a.role]}${a.specialty ? ` · ${SPECIALTY_LABEL[a.specialty]}` : ''}` },
    { key: 'period', label: 'Período', value: (a) => a.startsOn, render: (a) => `${formatDate(a.startsOn)}${a.endsOn ? ` a ${formatDate(a.endsOn)}` : ' — atual'}` },
    { key: 'reason', label: 'Motivo', render: (a) => <span className="ig-small">{a.reason} <span className="ig-muted">({a.assignedBy})</span>{a.endReason ? <><br />Encerrada: {a.endReason} <span className="ig-muted">({a.endedBy})</span></> : null}</span> },
    ...(canAssign ? [{ key: 'actions', label: 'Ações', render: (a: AssignmentDto) => (a.endsOn ? null : <Button size="sm" onClick={() => setEnding(a)} aria-label={`Encerrar atribuição de ${a.userName}`}>Encerrar</Button>) }] : []),
  ];
  return (
    <Card title="Consultores" subtitle="Quem atende este cliente. Substituições e encerramentos ficam no histórico; nada é apagado." headingLevel={2}
      actions={canAssign && !assigning ? <Button icon="plus" onClick={() => setAssigning(true)}>Atribuir consultor</Button> : null}>
      {assigning ? <AssignForm client={client} onDone={() => setAssigning(false)} /> : null}
      {ending ? <EndForm assignment={ending} onDone={() => setEnding(null)} end={(input) => consulting.endAssignment(ending.id, input)} /> : null}
      {!active.some((a) => a.role === 'responsavel') ? <p className="ig-small" role="status">Este cliente está sem consultor responsável.</p> : null}
      <DataTable caption="Consultores atuais" dense rows={active} rowKey={(a) => a.id} columns={cols} emptyMessage="Nenhum consultor atribuído." />
      {past.length ? (
        <details className="ig-fieldset" style={{ marginTop: 12 }}>
          <summary>Histórico de atribuições ({past.length})</summary>
          <DataTable caption="Atribuições encerradas" dense rows={past} rowKey={(a) => a.id} columns={cols.filter((x) => x.key !== 'actions')} />
        </details>
      ) : null}
    </Card>
  );
}

function AssignForm({ client, onDone }: { client: ClientDetailDto; onDone: () => void }) {
  const consulting = useConsulting()!;
  const team = useQuery({ queryKey: ['consulting', 'team'], queryFn: () => consulting.team() });
  const [d, setD] = useState({ userId: '', role: 'responsavel' as AssignmentRole, specialty: '' as Specialty | '', reason: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useConsultingMutation(() => consulting.assign(client.id, { userId: d.userId, role: d.role, specialty: d.specialty || null, startsOn: null, reason: d.reason.trim() }));
  const current = client.assignments.find((a) => !a.endsOn && a.role === 'responsavel');
  const busyIds = new Set(client.assignments.filter((a) => !a.endsOn).map((a) => a.userId));
  const candidates = (team.data?.members ?? []).filter((t) => t.active && t.roles.some((r) => ['consultor', 'gestor_consultoria', 'admin'].includes(r)) && !busyIds.has(t.userId));
  const submit = () => {
    const e = { userId: d.userId ? undefined : 'Escolha o consultor.', reason: d.reason.trim().length >= 5 ? undefined : 'Informe o motivo (mínimo 5 caracteres).' };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <FormCard title="Atribuir consultor" subtitle={d.role === 'responsavel' && current ? `${current.userName} deixa de ser o responsável a partir de hoje (fica no histórico).` : 'A atribuição começa hoje.'}
      error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Atribuir">
      <div className="ig-form-row">
        <Field label="Consultor" required error={errors.userId ?? m.fieldErrors.userId ?? null}>
          <select value={d.userId} onChange={(e) => setD({ ...d, userId: e.target.value })}><option value="">Selecione</option>{candidates.map((t) => <option key={t.userId} value={t.userId}>{t.name} ({t.clients.length} cliente(s))</option>)}</select>
        </Field>
        <Field label="Papel" required><select value={d.role} onChange={(e) => setD({ ...d, role: e.target.value as AssignmentRole })}>{(Object.keys(ASSIGNMENT_ROLE_LABEL) as AssignmentRole[]).map((k) => <option key={k} value={k}>{ASSIGNMENT_ROLE_LABEL[k]}</option>)}</select></Field>
        <Field label="Especialidade"><select value={d.specialty} onChange={(e) => setD({ ...d, specialty: e.target.value as Specialty | '' })}><option value="">—</option>{(Object.keys(SPECIALTY_LABEL) as Specialty[]).map((k) => <option key={k} value={k}>{SPECIALTY_LABEL[k]}</option>)}</select></Field>
      </div>
      <Field label="Motivo" required error={errors.reason ?? m.fieldErrors.reason ?? null}><textarea value={d.reason} maxLength={500} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field>
    </FormCard>
  );
}

function EndForm({ assignment, onDone, end }: { assignment: AssignmentDto; onDone: () => void; end: (input: { endsOn: string | null; reason: string }) => Promise<ClientDetailDto> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useConsultingMutation(() => end({ endsOn: null, reason: reason.trim() }));
  return (
    <FormCard title={`Encerrar atribuição de ${assignment.userName}`} subtitle="O consultor deixa de ver este cliente a partir de hoje. A atribuição continua no histórico."
      error={m.formError} onSubmit={() => { if (reason.trim().length < 5) { setError('Informe o motivo (mínimo 5 caracteres).'); return; } m.mutation.mutate(undefined, { onSuccess: onDone }); }} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Encerrar atribuição">
      <Field label="Motivo" required error={error}><textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormCard>
  );
}

/* ---------- Contacts ---------- */

function Contacts({ client, canEdit }: { client: ClientDetailDto; canEdit: boolean }) {
  const [editing, setEditing] = useState<ContactDto | 'new' | null>(null);
  const cols: Column<ContactDto>[] = [
    { key: 'name', label: 'Nome', render: (c) => <span><b>{c.name}</b>{c.roleTitle ? <span className="ig-small ig-muted"><br />{c.roleTitle}</span> : null}</span>, value: (c) => c.name },
    { key: 'kind', label: 'Tipo', value: (c) => CONTACT_KIND_LABEL[c.kind] },
    { key: 'registry', label: 'Registro profissional', value: (c) => c.registry ?? '—' },
    { key: 'contact', label: 'Contato', value: (c) => [c.email, c.phone].filter(Boolean).join(' · ') },
    { key: 'active', label: 'Situação', render: (c) => (c.active ? <StatusBadge status="ok">Ativo</StatusBadge> : <StatusBadge status="neutral">Inativo</StatusBadge>) },
    ...(canEdit ? [{ key: 'actions', label: 'Ações', render: (c: ContactDto) => <Button size="sm" onClick={() => setEditing(c)} aria-label={`Editar ${c.name}`}>Editar</Button> }] : []),
  ];
  return (
    <Card title="Responsáveis e contatos" subtitle="Responsáveis técnicos e administrativos e contatos autorizados do cliente." headingLevel={2}
      actions={canEdit && !editing ? <Button icon="plus" onClick={() => setEditing('new')}>Novo contato</Button> : null}>
      {editing ? <ContactForm client={client} contact={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      <DataTable caption="Contatos" dense rows={client.contacts} rowKey={(c) => c.id} columns={cols} emptyMessage="Nenhum contato cadastrado." />
    </Card>
  );
}

function ContactForm({ client, contact, onDone }: { client: ClientDetailDto; contact: ContactDto | null; onDone: () => void }) {
  const consulting = useConsulting()!;
  const [d, setD] = useState({ kind: contact?.kind ?? ('responsavel_tecnico' as ContactKind), name: contact?.name ?? '', roleTitle: contact?.roleTitle ?? '', registry: contact?.registry ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '', active: contact?.active ?? true });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const input = { kind: d.kind, name: d.name.trim(), roleTitle: blank(d.roleTitle), registry: blank(d.registry), email: blank(d.email), phone: blank(d.phone), active: d.active };
  const m = useConsultingMutation(() => consulting.saveContact(client.id, contact?.id ?? null, { ...input, rowVersion: contact?.rowVersion ?? null }));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const submit = () => {
    const e = Object.fromEntries(checkContact(input).map((p) => [p.path, p.message]));
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <FormCard title={contact ? `Editar ${contact.name}` : 'Novo contato'} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar contato">
      <div className="ig-form-row">
        <Field label="Nome" required error={err('name')}><input value={d.name} maxLength={160} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Tipo" required><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as ContactKind })}>{(Object.keys(CONTACT_KIND_LABEL) as ContactKind[]).map((k) => <option key={k} value={k}>{CONTACT_KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Cargo ou função"><input value={d.roleTitle} maxLength={120} onChange={(e) => setD({ ...d, roleTitle: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Registro profissional" hint="Ex.: COREN, CRM."><input value={d.registry} maxLength={40} onChange={(e) => setD({ ...d, registry: e.target.value })} /></Field>
        <Field label="E-mail" error={err('email')}><input type="email" value={d.email} maxLength={160} onChange={(e) => setD({ ...d, email: e.target.value })} /></Field>
        <Field label="Telefone" error={err('phone')}><input value={d.phone} inputMode="tel" maxLength={30} onChange={(e) => setD({ ...d, phone: e.target.value })} /></Field>
      </div>
      <div className="ig-checks"><label><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Contato ativo</label></div>
    </FormCard>
  );
}

/* ---------- Establishments and units ---------- */

function Establishments({ client, canEdit }: { client: ClientDetailDto; canEdit: boolean }) {
  const [editing, setEditing] = useState<EstablishmentDto | 'new' | null>(null);
  const [unit, setUnit] = useState<{ establishment: EstablishmentDto; unit: UnitDto | null } | null>(null);
  return (
    <Card title="Estabelecimentos e unidades" subtitle="Um cliente pode ter vários estabelecimentos; cada estabelecimento tem suas unidades e setores." headingLevel={2}
      actions={canEdit && !editing ? <Button icon="plus" onClick={() => setEditing('new')}>Novo estabelecimento</Button> : null}>
      {editing ? <EstablishmentForm client={client} establishment={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      {unit ? <UnitForm establishment={unit.establishment} unit={unit.unit} onDone={() => setUnit(null)} /> : null}
      {client.establishments.length === 0 ? <p className="ig-small ig-muted">Nenhum estabelecimento cadastrado.</p> : null}
      {client.establishments.map((e) => (
        <section key={e.id} className="consulting-establishment" aria-label={e.name}>
          <h3 className="ig-card-title" style={{ fontSize: '1rem' }}>{e.name} {e.active ? null : <StatusBadge status="neutral">Inativo</StatusBadge>}</h3>
          <p className="ig-small ig-muted">{ESTABLISHMENT_KIND_LABEL[e.kind]}{e.cnes ? ` · CNES ${e.cnes}` : ''}{e.beds != null ? ` · ${e.beds} leitos` : ''} · {addressLine(e.address)}</p>
          {canEdit ? (
            <span className="ig-row" style={{ gap: 8, marginBottom: 8 }}>
              <Button size="sm" onClick={() => setEditing(e)} aria-label={`Editar ${e.name}`}>Editar estabelecimento</Button>
              <Button size="sm" icon="plus" onClick={() => setUnit({ establishment: e, unit: null })} aria-label={`Nova unidade em ${e.name}`}>Nova unidade</Button>
            </span>
          ) : null}
          <DataTable caption={`Unidades de ${e.name}`} dense rows={e.units} rowKey={(u) => u.id} emptyMessage="Nenhuma unidade cadastrada."
            columns={[
              { key: 'name', label: 'Unidade / setor', value: (u) => u.name },
              { key: 'kind', label: 'Tipo', value: (u) => UNIT_KIND_LABEL[u.kind] },
              { key: 'beds', label: 'Leitos', value: (u) => u.beds ?? '—' },
              { key: 'active', label: 'Situação', render: (u) => (u.active ? 'Ativa' : 'Inativa') },
              ...(canEdit ? [{ key: 'actions', label: 'Ações', render: (u: UnitDto) => <Button size="sm" onClick={() => setUnit({ establishment: e, unit: u })} aria-label={`Editar ${u.name}`}>Editar</Button> }] : []),
            ]} />
        </section>
      ))}
    </Card>
  );
}

function EstablishmentForm({ client, establishment, onDone }: { client: ClientDetailDto; establishment: EstablishmentDto | null; onDone: () => void }) {
  const consulting = useConsulting()!;
  const [d, setD] = useState({
    name: establishment?.name ?? '', cnes: establishment?.cnes ?? '', cnpj: establishment?.cnpj ? formatCnpj(establishment.cnpj) : '', kind: establishment?.kind ?? client.kind,
    beds: establishment?.beds != null ? String(establishment.beds) : '', active: establishment?.active ?? true, address: addressDraft(establishment?.address ?? client.address ?? EMPTY_ADDRESS),
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const input = { name: d.name.trim(), cnes: blank(d.cnes), cnpj: blank(d.cnpj), kind: d.kind, beds: d.beds.trim() ? Number(d.beds) : null, address: addressInput(d.address), active: d.active };
  const m = useConsultingMutation(() => consulting.saveEstablishment(client.id, establishment?.id ?? null, { ...input, rowVersion: establishment?.rowVersion ?? null }));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const submit = () => {
    const e = Object.fromEntries(checkEstablishment({ ...input, cnes: input.cnes?.replace(/\D/g, '') ?? null }).map((p) => [p.path, p.message]));
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <FormCard title={establishment ? `Editar ${establishment.name}` : 'Novo estabelecimento'} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar estabelecimento">
      <div className="ig-form-row">
        <Field label="Nome" required error={err('name')}><input value={d.name} maxLength={200} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Tipo" required><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as EstablishmentKind })}>{(Object.keys(ESTABLISHMENT_KIND_LABEL) as EstablishmentKind[]).map((k) => <option key={k} value={k}>{ESTABLISHMENT_KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="CNES" error={err('cnes')}><input value={d.cnes} inputMode="numeric" maxLength={9} onChange={(e) => setD({ ...d, cnes: e.target.value })} /></Field>
        <Field label="CNPJ" error={err('cnpj')}><input value={d.cnpj} inputMode="numeric" maxLength={18} onChange={(e) => setD({ ...d, cnpj: e.target.value })} /></Field>
        <Field label="Leitos" error={err('beds')}><input value={d.beds} inputMode="numeric" maxLength={5} onChange={(e) => setD({ ...d, beds: e.target.value })} /></Field>
      </div>
      <AddressFields value={d.address} onChange={(address) => setD({ ...d, address })} errors={{ ...m.fieldErrors, ...errors }} />
      <div className="ig-checks"><label><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Estabelecimento ativo</label></div>
    </FormCard>
  );
}

function UnitForm({ establishment, unit, onDone }: { establishment: EstablishmentDto; unit: UnitDto | null; onDone: () => void }) {
  const consulting = useConsulting()!;
  const [d, setD] = useState({ name: unit?.name ?? '', kind: unit?.kind ?? ('internacao' as UnitKind), beds: unit?.beds != null ? String(unit.beds) : '', active: unit?.active ?? true });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const input = { name: d.name.trim(), kind: d.kind, beds: d.beds.trim() ? Number(d.beds) : null, active: d.active };
  const m = useConsultingMutation(() => consulting.saveUnit(establishment.id, unit?.id ?? null, { ...input, rowVersion: unit?.rowVersion ?? null }));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const submit = () => {
    const e = Object.fromEntries(checkUnit(input).map((p) => [p.path, p.message]));
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <FormCard title={unit ? `Editar ${unit.name}` : `Nova unidade em ${establishment.name}`} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar unidade">
      <div className="ig-form-row">
        <Field label="Nome da unidade ou setor" required error={err('name')}><input value={d.name} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Tipo" required><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as UnitKind })}>{(Object.keys(UNIT_KIND_LABEL) as UnitKind[]).map((k) => <option key={k} value={k}>{UNIT_KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Leitos" error={err('beds')}><input value={d.beds} inputMode="numeric" maxLength={4} onChange={(e) => setD({ ...d, beds: e.target.value })} /></Field>
      </div>
      <div className="ig-checks"><label><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Unidade ativa</label></div>
    </FormCard>
  );
}

/* ---------- History ---------- */

function History({ client, tz }: { client: ClientDetailDto; tz: string }) {
  const session = useSession();
  const consulting = useConsulting()!;
  const canRecord = session.can('consultoria:clients:record') && session.writable;
  const [d, setD] = useState({ kind: 'atendimento' as 'atendimento' | 'observacao', summary: '', detail: '', occurredOn: '' });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = useConsultingMutation(() => consulting.addEvent(client.id, { kind: d.kind, summary: d.summary.trim(), detail: blank(d.detail), occurredOn: d.occurredOn || null }));
  const submit = () => {
    if (!d.summary.trim()) { setError('Descreva o atendimento.'); return; }
    setError(null);
    m.mutation.mutate(undefined, { onSuccess: () => { setOpen(false); setD({ kind: 'atendimento', summary: '', detail: '', occurredOn: '' }); } });
  };
  return (
    <Card title="Histórico do cliente" subtitle="Cadastro, alterações, consultores, atendimentos e observações em ordem cronológica. Registros não podem ser alterados." headingLevel={2}
      actions={canRecord && !open ? <Button icon="plus" onClick={() => setOpen(true)}>Registrar atendimento</Button> : null}>
      {open ? (
        <FormCard title="Registrar atendimento ou observação" error={m.formError} onSubmit={submit} onCancel={() => setOpen(false)} busy={m.mutation.isPending} submitLabel="Registrar">
          <div className="ig-form-row">
            <Field label="Tipo" required><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as 'atendimento' | 'observacao' })}><option value="atendimento">Atendimento</option><option value="observacao">Observação</option></select></Field>
            <Field label="Data" hint="Hoje, se ficar em branco." error={m.fieldErrors.occurredOn ?? null}><input type="date" value={d.occurredOn} onChange={(e) => setD({ ...d, occurredOn: e.target.value })} /></Field>
          </div>
          <Field label="Resumo" required error={error ?? m.fieldErrors.summary ?? null}><input value={d.summary} maxLength={200} onChange={(e) => setD({ ...d, summary: e.target.value })} /></Field>
          <Field label="Detalhes"><textarea value={d.detail} maxLength={4000} onChange={(e) => setD({ ...d, detail: e.target.value })} /></Field>
        </FormCard>
      ) : null}
      <Timeline timeZone={tz} items={client.events.map((e) => ({
        id: e.id, at: e.at, tone: EVENT_TONE[e.kind],
        title: `${CLIENT_EVENT_LABEL[e.kind]} — ${e.summary}`,
        detail: <>{formatDate(e.occurredOn)} · {e.by}{e.detail ? ` · ${e.detail}` : ''}</>,
      }))} />
    </Card>
  );
}
