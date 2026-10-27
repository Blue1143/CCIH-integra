import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AMENDMENT_KIND_LABEL, CONTRACT_STATUS_LABEL, CONTRACT_TRANSITIONS, CONTRACT_TRANSITION_LABEL, FINANCIAL_BASIS_LABEL, SERVICE_KIND_LABEL, SERVICE_PERIOD_LABEL, SPECIALTY_LABEL,
  addDays, checkAmendment, checkDelivery, checkFinancial, formatDate, formatMoney, parseMoney, serviceFrequency,
  type AmendmentKind, type ContractDetailDto, type ContractServiceDto, type ContractStatus, type DeliveryDto, type FinancialBasis, type ServicePeriod,
} from '@ccih/domain';
import { Button, Card, DataTable, ErrorState, Field, LoadingState, StatusBadge, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, Timeline, useTimeZone } from '../clinical/shared';
import { EMPTY_LINE, ExpiryNote, LinesEditor, PlanBar, ProposalForm, SituationBadge, lineInput, qty, type LineDraft } from './contracts-shared';
import { RequireConsulting, blank, useConsulting, useConsultingMutation } from './shared';

export function ContractDetailPage() {
  return <RequireConsulting title="Contrato"><ContractDetail /></RequireConsulting>;
}

function ContractDetail() {
  const { id } = useParams();
  const consulting = useConsulting()!;
  const session = useSession();
  const tz = useTimeZone();
  const q = useQuery({ queryKey: ['consulting', 'contract', id], queryFn: () => consulting.contract(id!) });
  const [editing, setEditing] = useState(false);
  const [transition, setTransition] = useState<ContractStatus | null>(null);
  if (q.isPending) return <div className="page"><LoadingState /></div>;
  if (q.isError) return <div className="page"><ErrorState onRetry={() => void q.refetch()} /></div>;
  const c = q.data;
  const canEdit = session.can('consultoria:contracts:edit') && session.writable;
  const signed = c.status !== 'proposta' && c.status !== 'recusada';
  return (
    <div className="page">
      <PageHeader back={{ to: '/consultoria/contratos', label: 'Contratos' }} title={<span>{c.code} <DemoTag origin={c.dataOrigin} /></span>}
        subtitle={<>{c.title} · <Link to={`/consultoria/clientes/${c.clientId}`}>{c.clientName}</Link></>}
        actions={(
          <span className="ig-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <SituationBadge situation={c.situation} /> <ExpiryNote c={c} />
            {canEdit && c.status === 'proposta' && !editing ? <Button onClick={() => setEditing(true)}>Editar proposta</Button> : null}
            {canEdit ? CONTRACT_TRANSITIONS[c.status].map((to) => <Button key={to} onClick={() => setTransition(to)}>{CONTRACT_TRANSITION_LABEL[`${c.status}>${to}`] ?? CONTRACT_STATUS_LABEL[to]}</Button>) : null}
          </span>
        )} />
      {transition ? <StatusForm contract={c} to={transition} onDone={() => setTransition(null)} /> : null}
      {editing ? <ProposalForm clientId={c.clientId} contract={c} establishments={c.establishments} onDone={() => setEditing(false)} /> : (
        <Card title="Vigência e condições gerais" headingLevel={2}>
          <dl className="ig-facts">
            <div><dt>Vigência</dt><dd>{c.startsOn ? `${formatDate(c.startsOn)} a ${c.endsOn ? formatDate(c.endsOn) : 'sem término definido'}` : 'A definir'}</dd></div>
            <div><dt>Assinatura</dt><dd>{c.signedOn ? formatDate(c.signedOn) : '—'}</dd></div>
            <div><dt>Renovação automática</dt><dd>{c.autoRenew ? 'Sim (registrar por aditivo)' : 'Não'}</dd></div>
            <div><dt>Aviso de vencimento</dt><dd>{c.renewalNoticeDays} dias antes do término</dd></div>
            <div><dt>Responsável</dt><dd>{c.responsible ?? '—'}</dd></div>
            <div><dt>Escopo e observações</dt><dd>{c.scopeNotes ?? '—'}</dd></div>
            {c.closedOn ? <div><dt>{c.status === 'recusada' ? 'Recusa' : 'Encerramento'}</dt><dd>{formatDate(c.closedOn)} — {c.closeReason}</dd></div> : null}
          </dl>
        </Card>
      )}
      <Services contract={c} signed={signed} />
      {signed ? <Deliveries contract={c} /> : null}
      {signed ? <Amendments contract={c} canEdit={canEdit && (c.status === 'vigente' || c.status === 'suspenso')} /> : null}
      {'financial' in c ? <Financial contract={c} /> : null}
      <Card title="Histórico do contrato" subtitle="Cadastro, assinatura, aditivos, suspensões e encerramento. Os registros não podem ser alterados." headingLevel={2}>
        <Timeline timeZone={tz} items={c.history.map((h) => ({ id: h.id, at: h.at, tone: 'info' as const, title: h.summary, detail: <>{formatDate(h.occurredOn)} · {h.by}{h.detail ? ` · ${h.detail}` : ''}</> }))} />
      </Card>
    </div>
  );
}

/* ---------- Status ---------- */

function StatusForm({ contract, to, onDone }: { contract: ContractDetailDto; to: ContractStatus; onDone: () => void }) {
  const consulting = useConsulting()!;
  const signing = contract.status === 'proposta' && to === 'vigente';
  const [on, setOn] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useConsultingMutation(() => consulting.setContractStatus(contract.id, { status: to, on: on || null, reason: blank(reason), rowVersion: contract.rowVersion }));
  const label = CONTRACT_TRANSITION_LABEL[`${contract.status}>${to}`] ?? CONTRACT_STATUS_LABEL[to];
  const subtitle = signing
    ? 'A vigência começa na data de início da proposta e os serviços passam a contar no previsto × realizado. Depois disso, mudanças só por aditivo.'
    : to === 'encerrado' ? 'O contrato deixa de gerar alertas e não recebe aditivos. Entregas já feitas continuam registradas.' : 'A mudança fica no histórico do contrato e do cliente.';
  const submit = () => {
    if (!signing && reason.trim().length < 5) { setError('Informe o motivo (mínimo 5 caracteres).'); return; }
    setError(null);
    m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <FormCard title={label} subtitle={subtitle} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel={label}>
      <div className="ig-form-row">
        <Field label={signing ? 'Data da assinatura' : to === 'encerrado' || to === 'recusada' ? 'Data' : 'Data do registro'} hint="Hoje, se ficar em branco." error={m.fieldErrors.on ?? null}><input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      </div>
      {m.fieldErrors.startsOn || m.fieldErrors.services ? <p className="ig-field-error" role="alert">{m.fieldErrors.startsOn ?? m.fieldErrors.services}</p> : null}
      <Field label={signing ? 'Observação' : 'Motivo'} required={!signing} error={error ?? m.fieldErrors.reason ?? null}><textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormCard>
  );
}

/* ---------- Services and planned × done ---------- */

function Services({ contract, signed }: { contract: ContractDetailDto; signed: boolean }) {
  const session = useSession();
  const [delivering, setDelivering] = useState<ContractServiceDto | null>(null);
  const canDeliver = signed && session.can('consultoria:contracts:deliveries') && session.writable;
  const active = contract.serviceLines.filter((l) => !l.endsOn);
  const ended = contract.serviceLines.filter((l) => l.endsOn);
  const cols: Column<ContractServiceDto>[] = [
    { key: 'service', label: 'Serviço', value: (l) => l.description, render: (l) => <span><b>{l.description}</b><br /><span className="ig-small ig-muted">{SERVICE_KIND_LABEL[l.kind]} · {SPECIALTY_LABEL[l.area]}{l.establishmentName ? ` · ${l.establishmentName}` : ''}</span></span> },
    { key: 'freq', label: 'Previsto', value: (l) => serviceFrequency(l) },
    ...(signed ? [
      { key: 'term', label: 'Vigência do serviço', render: (l: ContractServiceDto) => (l.startsOn ? `${formatDate(l.startsOn)}${l.endsOn ? ` a ${formatDate(l.endsOn)}` : ' em diante'}` : '—') },
      { key: 'current', label: 'Período atual', render: (l: ContractServiceDto) => (l.plan?.current ? <span>{qty(l.plan.current.done)} de {qty(l.plan.current.planned)}<br /><span className="ig-small ig-muted">até {formatDate(lastDay(l.plan.current.end))}</span></span> : '—') },
      { key: 'closed', label: 'Períodos encerrados', render: (l: ContractServiceDto) => (l.plan ? <PlanBar planned={l.plan.plannedClosed} done={l.plan.doneClosed} label={l.description} /> : '—') },
    ] : []),
    ...(canDeliver ? [{ key: 'actions', label: 'Ações', render: (l: ContractServiceDto) => (<Button size="sm" onClick={() => setDelivering(l)} aria-label={`Registrar entrega de ${l.description}`}>Registrar entrega</Button>) }] : []),
  ];
  return (
    <Card title="Serviços e previsto × realizado" headingLevel={2}
      subtitle={signed ? 'Previsto: a quantidade de cada período do serviço, contado a partir do seu início. Realizado: as entregas registradas com data dentro do período.' : 'Serviços propostos. O previsto × realizado começa com a assinatura.'}>
      {delivering ? <DeliveryForm line={delivering} onDone={() => setDelivering(null)} /> : null}
      <DataTable caption="Serviços do contrato" dense rows={signed ? active : contract.serviceLines} rowKey={(l) => l.id} columns={cols} emptyMessage="Nenhum serviço." />
      {ended.length && signed ? (
        <details className="ig-fieldset" style={{ marginTop: 12 }}>
          <summary>Serviços encerrados ou substituídos por aditivo ({ended.length})</summary>
          <DataTable caption="Serviços encerrados" dense rows={ended} rowKey={(l) => l.id} columns={cols.filter((x) => x.key !== 'actions' && x.key !== 'current')} />
        </details>
      ) : null}
    </Card>
  );
}
/** Periods end on an exclusive date: the last day is the day before. */
const lastDay = (iso: string) => addDays(iso, -1);

function DeliveryForm({ line, onDone }: { line: ContractServiceDto; onDone: () => void }) {
  const consulting = useConsulting()!;
  const [d, setD] = useState({ occurredOn: '', quantity: '1', description: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const input = { serviceId: line.id, occurredOn: d.occurredOn || null, quantity: Number(d.quantity.replace(',', '.')), description: d.description.trim() };
  const m = useConsultingMutation(() => consulting.addDelivery(line.id, { occurredOn: input.occurredOn, quantity: input.quantity, description: input.description }));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const submit = () => {
    const e = Object.fromEntries(checkDelivery(input, line.unit).map((p) => [p.path, p.message]));
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <FormCard title={`Registrar entrega — ${line.description}`} subtitle={`Previsto: ${serviceFrequency(line)}. A entrega conta no período da data informada.`} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Registrar entrega">
      <div className="ig-form-row">
        <Field label="Data" hint="Hoje, se ficar em branco." error={err('occurredOn')}><input type="date" value={d.occurredOn} onChange={(e) => setD({ ...d, occurredOn: e.target.value })} /></Field>
        <Field label={`Quantidade (${line.unit})`} required error={err('quantity')}><input value={d.quantity} inputMode="decimal" maxLength={8} onChange={(e) => setD({ ...d, quantity: e.target.value })} /></Field>
      </div>
      <Field label="O que foi entregue" required error={err('description')}><textarea value={d.description} maxLength={1000} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
    </FormCard>
  );
}

/* ---------- Deliveries ---------- */

function Deliveries({ contract }: { contract: ContractDetailDto }) {
  const session = useSession();
  const consulting = useConsulting()!;
  const [voiding, setVoiding] = useState<DeliveryDto | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useConsultingMutation(() => consulting.voidDelivery(voiding!.id, reason.trim()));
  const canVoid = session.can('consultoria:contracts:deliveries') && session.writable;
  const lineName = new Map(contract.serviceLines.map((l) => [l.id, l.description]));
  const cols: Column<DeliveryDto>[] = [
    { key: 'date', label: 'Data', value: (d) => d.occurredOn, render: (d) => formatDate(d.occurredOn) },
    { key: 'service', label: 'Serviço', value: (d) => lineName.get(d.serviceId) ?? '—' },
    { key: 'qty', label: 'Quantidade', align: 'right', value: (d) => d.quantity, render: (d) => qty(d.quantity) },
    { key: 'desc', label: 'Descrição', render: (d) => <span>{d.description} <span className="ig-small ig-muted">({d.by})</span>{d.voidedAt ? <><br /><StatusBadge status="neutral">Anulada</StatusBadge> <span className="ig-small">{d.voidReason} ({d.voidedBy})</span></> : null}</span> },
    ...(canVoid ? [{ key: 'actions', label: 'Ações', render: (d: DeliveryDto) => (d.voidedAt ? null : <Button size="sm" onClick={() => { setVoiding(d); setReason(''); setError(null); }} aria-label={`Anular entrega de ${formatDate(d.occurredOn)}`}>Anular</Button>) }] : []),
  ];
  return (
    <Card title="Entregas registradas" subtitle="Uma entrega lançada por engano é anulada com o motivo; nada é apagado." headingLevel={2}>
      {voiding ? (
        <FormCard title={`Anular entrega de ${formatDate(voiding.occurredOn)}`} error={m.formError} busy={m.mutation.isPending} submitLabel="Anular entrega" onCancel={() => setVoiding(null)}
          onSubmit={() => { if (reason.trim().length < 5) { setError('Informe o motivo (mínimo 5 caracteres).'); return; } m.mutation.mutate(undefined, { onSuccess: () => setVoiding(null) }); }}>
          <Field label="Motivo" required error={error ?? m.fieldErrors.reason ?? null}><textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} /></Field>
        </FormCard>
      ) : null}
      <DataTable caption="Entregas" dense rows={contract.deliveries} rowKey={(d) => d.id} columns={cols} emptyMessage="Nenhuma entrega registrada." />
    </Card>
  );
}

/* ---------- Amendments ---------- */

function Amendments({ contract, canEdit }: { contract: ContractDetailDto; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title="Aditivos" subtitle="Prazo, renovação, escopo e valor. Cada aditivo guarda o que mudou; serviços alterados são encerrados e substituídos, sem perder o histórico." headingLevel={2}
      actions={canEdit && !open ? <Button icon="plus" onClick={() => setOpen(true)}>Registrar aditivo</Button> : null}>
      {open ? <AmendmentForm contract={contract} onDone={() => setOpen(false)} /> : null}
      {contract.amendmentList.length === 0 ? <p className="ig-small ig-muted">Nenhum aditivo.</p> : null}
      {contract.amendmentList.map((a) => (
        <section key={a.id} className="consulting-establishment" aria-label={`Aditivo nº ${a.number}`}>
          <h3 className="ig-card-title" style={{ fontSize: '1rem' }}>Aditivo nº {a.number} — {a.kinds.map((k) => AMENDMENT_KIND_LABEL[k]).join(', ')}</h3>
          <p className="ig-small ig-muted">Assinado em {formatDate(a.signedOn)} · efeito a partir de {formatDate(a.effectiveOn)} · registrado por {a.by}</p>
          <p>{a.description}</p>
          {a.changes.length ? <ul className="contract-changes">{a.changes.map((ch, i) => <li key={i}>{ch}</li>)}</ul> : null}
        </section>
      ))}
    </Card>
  );
}

type LineAction = { mode: 'manter' } | { mode: 'alterar'; quantity: string; period: ServicePeriod } | { mode: 'encerrar' };

function AmendmentForm({ contract, onDone }: { contract: ContractDetailDto; onDone: () => void }) {
  const consulting = useConsulting()!;
  const active = contract.serviceLines.filter((l) => !l.endsOn);
  const [d, setD] = useState({
    kinds: [] as AmendmentKind[], description: '', signedOn: '', effectiveOn: '', newEndsOn: '', noEnd: false, autoRenew: 'manter' as 'manter' | 'sim' | 'nao',
    actions: Object.fromEntries(active.map((l) => [l.id, { mode: 'manter' } as LineAction])), added: [] as LineDraft[],
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const term = d.kinds.includes('prazo') || d.kinds.includes('renovacao');
  const input = {
    kinds: d.kinds, description: d.description.trim(), signedOn: d.signedOn, effectiveOn: d.effectiveOn,
    ...(term ? { newEndsOn: d.noEnd ? null : d.newEndsOn || undefined } : {}),
    ...(d.autoRenew !== 'manter' ? { autoRenew: d.autoRenew === 'sim' } : {}),
    addServices: d.added.map(lineInput),
    changeServices: Object.entries(d.actions).flatMap(([id, a]) => (a.mode === 'alterar' ? [{ id, quantity: Number(a.quantity.replace(',', '.')), period: a.period }] : [])),
    endServices: Object.entries(d.actions).flatMap(([id, a]) => (a.mode === 'encerrar' ? [id] : [])),
  };
  const m = useConsultingMutation(() => consulting.addAmendment(contract.id, { ...input, rowVersion: contract.rowVersion }));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const submit = () => {
    const e = Object.fromEntries(checkAmendment(input, { startsOn: contract.startsOn, endsOn: contract.endsOn }).map((p) => [p.path, p.message]));
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const toggle = (k: AmendmentKind) => setD({ ...d, kinds: d.kinds.includes(k) ? d.kinds.filter((x) => x !== k) : [...d.kinds, k] });
  const setAction = (id: string, a: LineAction) => setD({ ...d, actions: { ...d.actions, [id]: a } });
  return (
    <FormCard title={`Registrar aditivo nº ${contract.amendmentList.length + 1}`} subtitle="Valores e condições financeiras são atualizados pelo perfil financeiro, na seção própria." error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Registrar aditivo">
      <fieldset className="ig-fieldset">
        <legend>O que o aditivo altera</legend>
        <div className="ig-checks">{(Object.keys(AMENDMENT_KIND_LABEL) as AmendmentKind[]).map((k) => <label key={k}><input type="checkbox" checked={d.kinds.includes(k)} onChange={() => toggle(k)} /> {AMENDMENT_KIND_LABEL[k]}</label>)}</div>
        {err('kinds') ? <p className="ig-field-error" role="alert">{err('kinds')}</p> : null}
      </fieldset>
      <div className="ig-form-row">
        <Field label="Assinatura" required error={err('signedOn')}><input type="date" value={d.signedOn} onChange={(e) => setD({ ...d, signedOn: e.target.value })} /></Field>
        <Field label="Efeito a partir de" required error={err('effectiveOn')}><input type="date" value={d.effectiveOn} onChange={(e) => setD({ ...d, effectiveOn: e.target.value })} /></Field>
        {term ? <Field label="Novo término" error={err('newEndsOn')}><input type="date" value={d.newEndsOn} disabled={d.noEnd} onChange={(e) => setD({ ...d, newEndsOn: e.target.value })} /></Field> : null}
        <Field label="Renovação automática"><select value={d.autoRenew} onChange={(e) => setD({ ...d, autoRenew: e.target.value as 'manter' | 'sim' | 'nao' })}><option value="manter">Sem alteração</option><option value="sim">Passa a ter</option><option value="nao">Deixa de ter</option></select></Field>
      </div>
      {term ? <div className="ig-checks"><label><input type="checkbox" checked={d.noEnd} onChange={(e) => setD({ ...d, noEnd: e.target.checked })} /> Passa a não ter término definido</label></div> : null}
      <Field label="Descrição do aditivo" required error={err('description')}><textarea value={d.description} maxLength={4000} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      {active.length ? (
        <fieldset className="ig-fieldset">
          <legend>Serviços atuais</legend>
          {err('changeServices') ? <p className="ig-field-error" role="alert">{err('changeServices')}</p> : null}
          {active.map((l) => {
            const a = d.actions[l.id] ?? { mode: 'manter' };
            return (
              <div key={l.id} className="contract-line" role="group" aria-label={l.description}>
                <div className="ig-form-row">
                  <Field label={`${l.description} (${serviceFrequency(l)})`}>
                    <select value={a.mode} onChange={(e) => setAction(l.id, e.target.value === 'alterar' ? { mode: 'alterar', quantity: String(l.quantity), period: l.period } : { mode: e.target.value as 'manter' | 'encerrar' })}>
                      <option value="manter">Manter</option><option value="alterar">Alterar quantidade ou período</option><option value="encerrar">Encerrar</option>
                    </select>
                  </Field>
                  {a.mode === 'alterar' ? (
                    <>
                      <Field label="Nova quantidade" required><input value={a.quantity} inputMode="decimal" maxLength={8} onChange={(e) => setAction(l.id, { ...a, quantity: e.target.value })} /></Field>
                      <Field label="Período"><select value={a.period} onChange={(e) => setAction(l.id, { ...a, period: e.target.value as ServicePeriod })}>{(Object.keys(SERVICE_PERIOD_LABEL) as ServicePeriod[]).map((k) => <option key={k} value={k}>{SERVICE_PERIOD_LABEL[k]}</option>)}</select></Field>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </fieldset>
      ) : null}
      {d.added.length ? <LinesEditor lines={d.added} onChange={(added) => setD({ ...d, added })} establishments={contract.establishments} errors={{ ...m.fieldErrors, ...errors }} prefix="addServices" />
        : <Button size="sm" icon="plus" onClick={() => setD({ ...d, added: [{ ...EMPTY_LINE }] })}>Incluir serviço novo</Button>}
    </FormCard>
  );
}

/* ---------- Financial terms ---------- */

function Financial({ contract }: { contract: ContractDetailDto }) {
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const f = contract.financial ?? null;
  const canEdit = session.can('consultoria:contracts:financial') && session.writable && contract.status !== 'recusada';
  return (
    <Card title="Condições financeiras" subtitle="Visíveis só para o financeiro e a administração. O sistema não emite cobrança nem integra com bancos." headingLevel={2}
      actions={canEdit && !editing ? <Button onClick={() => setEditing(true)}>{f ? 'Editar condições' : 'Informar condições'}</Button> : null}>
      {editing ? <FinancialForm contract={contract} onDone={() => setEditing(false)} /> : f ? (
        <dl className="ig-facts">
          <div><dt>{FINANCIAL_BASIS_LABEL[f.basis]}</dt><dd>{f.amountCents != null ? formatMoney(f.amountCents) : 'Não informado'}</dd></div>
          <div><dt>Dia de faturamento</dt><dd>{f.billingDay ?? '—'}</dd></div>
          <div><dt>Condições de pagamento</dt><dd>{f.paymentTerms ?? '—'}</dd></div>
          <div><dt>Reajuste</dt><dd>{f.adjustmentRule ?? '—'}</dd></div>
          <div><dt>Observações</dt><dd>{f.notes ?? '—'}</dd></div>
          <div><dt>Atualizado</dt><dd>{f.updatedAt ? `${formatDate(f.updatedAt.slice(0, 10))} por ${f.updatedBy}` : '—'}</dd></div>
        </dl>
      ) : <p className="ig-small ig-muted">Condições financeiras não informadas.</p>}
    </Card>
  );
}

function FinancialForm({ contract, onDone }: { contract: ContractDetailDto; onDone: () => void }) {
  const consulting = useConsulting()!;
  const f = contract.financial ?? null;
  const [d, setD] = useState({
    basis: f?.basis ?? ('mensal' as FinancialBasis), amount: f?.amountCents != null ? (f.amountCents / 100).toFixed(2).replace('.', ',') : '', billingDay: f?.billingDay != null ? String(f.billingDay) : '',
    paymentTerms: f?.paymentTerms ?? '', adjustmentRule: f?.adjustmentRule ?? '', notes: f?.notes ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const amountCents = d.amount.trim() ? parseMoney(d.amount) : null;
  const input = { basis: d.basis, amountCents, billingDay: d.billingDay.trim() ? Number(d.billingDay) : null, paymentTerms: blank(d.paymentTerms), adjustmentRule: blank(d.adjustmentRule), notes: blank(d.notes) };
  const m = useConsultingMutation(() => consulting.saveFinancial(contract.id, { ...input, rowVersion: f?.rowVersion ?? null }));
  const submit = () => {
    const e: Record<string, string> = Object.fromEntries(checkFinancial(input).map((p) => [p.path, p.message]));
    if (d.amount.trim() && amountCents == null) e.amountCents = 'Valor inválido. Use, por exemplo, 4.500,00.';
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <FormCard title="Condições financeiras" error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar condições">
      <div className="ig-form-row">
        <Field label="Base"><select value={d.basis} onChange={(e) => setD({ ...d, basis: e.target.value as FinancialBasis })}>{(Object.keys(FINANCIAL_BASIS_LABEL) as FinancialBasis[]).map((k) => <option key={k} value={k}>{FINANCIAL_BASIS_LABEL[k]}</option>)}</select></Field>
        <Field label="Valor (R$)" error={errors.amountCents ?? m.fieldErrors.amountCents ?? null}><input value={d.amount} inputMode="decimal" maxLength={16} placeholder="0,00" onChange={(e) => setD({ ...d, amount: e.target.value })} /></Field>
        <Field label="Dia de faturamento" error={errors.billingDay ?? m.fieldErrors.billingDay ?? null}><input value={d.billingDay} inputMode="numeric" maxLength={2} onChange={(e) => setD({ ...d, billingDay: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Condições de pagamento"><input value={d.paymentTerms} maxLength={1000} onChange={(e) => setD({ ...d, paymentTerms: e.target.value })} /></Field>
        <Field label="Regra de reajuste"><input value={d.adjustmentRule} maxLength={300} placeholder="Ex.: IPCA a cada 12 meses" onChange={(e) => setD({ ...d, adjustmentRule: e.target.value })} /></Field>
      </div>
      <Field label="Observações"><textarea value={d.notes} maxLength={2000} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
    </FormCard>
  );
}
