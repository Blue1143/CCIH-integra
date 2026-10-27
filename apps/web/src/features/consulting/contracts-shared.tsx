import { useQuery } from '@tanstack/react-query';
import {
  CONTRACT_SITUATION_LABEL, SERVICE_KIND_LABEL, SERVICE_PERIOD_LABEL, SERVICE_UNIT_LABEL, SPECIALTY_LABEL, checkContract, fulfillment,
  type ContractDetailDto, type ContractSituation, type ContractSummaryDto, type ExpiryState, type ServiceInput, type ServiceKind, type ServicePeriod, type ServiceUnit, type Specialty, type Status,
} from '@ccih/domain';
import { Button, Field, StatusBadge } from '@ccih/ui';
import { useState } from 'react';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { blank, useConsulting, useConsultingMutation } from './shared';

export const SITUATION_TONE: Record<ContractSituation, Status> = { proposta: 'info', vigente: 'ok', suspenso: 'warn', encerrado: 'neutral', recusada: 'neutral', vencido: 'crit' };

export function SituationBadge({ situation }: { situation: ContractSituation }) {
  return <StatusBadge status={SITUATION_TONE[situation]}>{CONTRACT_SITUATION_LABEL[situation]}</StatusBadge>;
}

/** End of term in words: "vence em 12 dias", "vencido há 3 dias", "sem término". */
export function ExpiryNote({ c }: { c: Pick<ContractSummaryDto, 'expiry' | 'daysToEnd'> }) {
  const label: Record<ExpiryState, string> = {
    sem_termino: 'Sem término definido',
    em_dia: `Vence em ${c.daysToEnd} dias`,
    vencendo: c.daysToEnd === 0 ? 'Vence hoje' : `Vence em ${c.daysToEnd} dia(s)`,
    vencido: `Vencido há ${-(c.daysToEnd ?? 0)} dia(s)`,
  };
  if (!c.expiry) return null;
  const tone: Status = c.expiry === 'vencido' ? 'crit' : c.expiry === 'vencendo' ? 'warn' : 'neutral';
  return c.expiry === 'em_dia' || c.expiry === 'sem_termino' ? <span className="ig-small ig-muted">{label[c.expiry]}</span> : <StatusBadge status={tone}>{label[c.expiry]}</StatusBadge>;
}

export const qty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** "3 de 6 (50%)" with a small bar; "—" when nothing was planned yet. */
export function PlanBar({ planned, done, label }: { planned: number; done: number; label: string }) {
  const pct = fulfillment(planned, done);
  if (pct == null) return <span className="ig-muted">—</span>;
  return (
    <span aria-label={`${label}: ${qty(done)} de ${qty(planned)} (${pct}%)`}>
      <span className="bar-track" aria-hidden="true"><span className={`bar${pct < 100 ? ' bar-warn' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} /></span>
      {qty(done)} de {qty(planned)} <span className="ig-muted">({pct}%)</span>
    </span>
  );
}

/* ---------- Service lines editor ---------- */

export interface LineDraft { id: string | null; area: Specialty; kind: ServiceKind; description: string; establishmentId: string; unit: ServiceUnit; quantity: string; period: ServicePeriod }
export const EMPTY_LINE: LineDraft = { id: null, area: 'ccih', kind: 'visita_tecnica', description: '', establishmentId: '', unit: 'visitas', quantity: '1', period: 'mensal' };
export const lineInput = (l: LineDraft): ServiceInput => ({
  id: l.id, area: l.area, kind: l.kind, description: l.description.trim(), establishmentId: l.establishmentId || null, unit: l.unit, quantity: Number(l.quantity.replace(',', '.')), period: l.period,
});

export function LinesEditor({ lines, onChange, establishments, errors, prefix }: {
  lines: LineDraft[]; onChange: (l: LineDraft[]) => void; establishments: Array<{ id: string; name: string }>; errors: Record<string, string | undefined>; prefix: string;
}) {
  const set = (i: number, patch: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <fieldset className="ig-fieldset">
      <legend>Serviços e frequência prevista</legend>
      {errors[prefix] ? <p className="ig-field-error" role="alert">{errors[prefix]}</p> : null}
      {lines.map((l, i) => (
        <div key={i} className="contract-line" aria-label={`Serviço ${i + 1}`} role="group">
          <div className="ig-form-row">
            <Field label="Descrição do serviço" required error={errors[`${prefix}.${i}.description`] ?? null}><input value={l.description} maxLength={300} onChange={(e) => set(i, { description: e.target.value })} /></Field>
            <Field label="Tipo"><select value={l.kind} onChange={(e) => set(i, { kind: e.target.value as ServiceKind })}>{(Object.keys(SERVICE_KIND_LABEL) as ServiceKind[]).map((k) => <option key={k} value={k}>{SERVICE_KIND_LABEL[k]}</option>)}</select></Field>
            <Field label="Área"><select value={l.area} onChange={(e) => set(i, { area: e.target.value as Specialty })}>{(Object.keys(SPECIALTY_LABEL) as Specialty[]).map((k) => <option key={k} value={k}>{SPECIALTY_LABEL[k]}</option>)}</select></Field>
          </div>
          <div className="ig-form-row">
            <Field label="Quantidade" required error={errors[`${prefix}.${i}.quantity`] ?? null}><input value={l.quantity} inputMode="decimal" maxLength={8} onChange={(e) => set(i, { quantity: e.target.value })} /></Field>
            <Field label="Unidade"><select value={l.unit} onChange={(e) => set(i, { unit: e.target.value as ServiceUnit })}>{(Object.keys(SERVICE_UNIT_LABEL) as ServiceUnit[]).map((k) => <option key={k} value={k}>{SERVICE_UNIT_LABEL[k]}</option>)}</select></Field>
            <Field label="Período"><select value={l.period} onChange={(e) => set(i, { period: e.target.value as ServicePeriod })}>{(Object.keys(SERVICE_PERIOD_LABEL) as ServicePeriod[]).map((k) => <option key={k} value={k}>{SERVICE_PERIOD_LABEL[k]}</option>)}</select></Field>
            <Field label="Estabelecimento"><select value={l.establishmentId} onChange={(e) => set(i, { establishmentId: e.target.value })}><option value="">Todos do cliente</option>{establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          </div>
          <Button size="sm" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label={`Remover serviço ${i + 1}`}>Remover</Button>
        </div>
      ))}
      <Button size="sm" icon="plus" onClick={() => onChange([...lines, { ...EMPTY_LINE }])}>Adicionar serviço</Button>
    </fieldset>
  );
}

/* ---------- Proposal form (new or edit) ---------- */

export function ProposalForm({ clientId, contract, establishments, onDone }: {
  clientId: string; contract: ContractDetailDto | null; establishments: Array<{ id: string; name: string }>; onDone: (saved: ContractDetailDto | null) => void;
}) {
  const consulting = useConsulting()!;
  const session = useSession();
  const team = useQuery({ queryKey: ['consulting', 'team'], queryFn: () => consulting.team(), enabled: session.can('consultoria:portfolio:assign', 'consultoria:portfolio:all') });
  const [d, setD] = useState({
    title: contract?.title ?? '', startsOn: contract?.startsOn ?? '', endsOn: contract?.endsOn ?? '', autoRenew: contract?.autoRenew ?? false,
    renewalNoticeDays: String(contract?.renewalNoticeDays ?? 60), responsibleId: contract?.responsibleId ?? '', scopeNotes: contract?.scopeNotes ?? '',
    lines: contract
      ? contract.serviceLines.map((l): LineDraft => ({ id: l.id, area: l.area, kind: l.kind, description: l.description, establishmentId: l.establishmentId ?? '', unit: l.unit, quantity: String(l.quantity), period: l.period }))
      : [{ ...EMPTY_LINE }],
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const input = {
    title: d.title.trim(), startsOn: d.startsOn || null, endsOn: d.endsOn || null, autoRenew: d.autoRenew, renewalNoticeDays: Number(d.renewalNoticeDays),
    responsibleId: d.responsibleId || null, scopeNotes: blank(d.scopeNotes), services: d.lines.map(lineInput),
  };
  const m = useConsultingMutation(() => consulting.saveProposal(contract ? null : clientId, contract?.id ?? null, { ...input, rowVersion: contract?.rowVersion ?? null }));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const submit = () => {
    const e = Object.fromEntries(checkContract(input).map((p) => [p.path, p.message]));
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: (saved) => onDone(saved) });
  };
  const responsibles = (team.data?.members ?? []).filter((t) => t.active && t.roles.some((r) => ['consultor', 'gestor_consultoria', 'admin'].includes(r)));
  return (
    <FormCard title={contract ? `Editar proposta ${contract.code}` : 'Nova proposta'} subtitle="Enquanto for proposta, tudo pode ser ajustado. Depois da assinatura, mudanças só por aditivo."
      error={m.formError} onSubmit={submit} onCancel={() => onDone(null)} busy={m.mutation.isPending} submitLabel={contract ? 'Salvar proposta' : 'Cadastrar proposta'}>
      <Field label="Objeto do contrato" required error={err('title')}><input value={d.title} maxLength={200} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      <div className="ig-form-row">
        <Field label="Início da vigência" hint="Obrigatório para registrar a assinatura." error={err('startsOn')}><input type="date" value={d.startsOn} onChange={(e) => setD({ ...d, startsOn: e.target.value })} /></Field>
        <Field label="Término" hint="Em branco: sem término definido." error={err('endsOn')}><input type="date" value={d.endsOn} onChange={(e) => setD({ ...d, endsOn: e.target.value })} /></Field>
        <Field label="Aviso de vencimento (dias)" error={err('renewalNoticeDays')}><input value={d.renewalNoticeDays} inputMode="numeric" maxLength={3} onChange={(e) => setD({ ...d, renewalNoticeDays: e.target.value })} /></Field>
        {team.data ? (
          <Field label="Responsável pelo contrato" error={err('responsibleId')}>
            <select value={d.responsibleId} onChange={(e) => setD({ ...d, responsibleId: e.target.value })}><option value="">—</option>{responsibles.map((t) => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select>
          </Field>
        ) : null}
      </div>
      <div className="ig-checks"><label><input type="checkbox" checked={d.autoRenew} onChange={(e) => setD({ ...d, autoRenew: e.target.checked })} /> Renovação automática prevista em contrato</label></div>
      <Field label="Escopo e observações"><textarea value={d.scopeNotes} maxLength={4000} onChange={(e) => setD({ ...d, scopeNotes: e.target.value })} /></Field>
      <LinesEditor lines={d.lines} onChange={(lines) => setD({ ...d, lines })} establishments={establishments} errors={{ ...m.fieldErrors, ...errors }} prefix="services" />
    </FormCard>
  );
}
