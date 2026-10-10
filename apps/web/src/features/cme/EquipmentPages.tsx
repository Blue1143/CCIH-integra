import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  EQUIPMENT_STATUS_LABEL, PACKAGING_LABEL, STERILIZER_TYPE_LABEL, addDays, formatDate, todayIn,
  type CmeTestDto, type EquipmentStatus, type InstrumentSetDto, type PackagingType, type SterilizerDto, type SterilizerType, type TestResult,
} from '@ccih/domain';
import { Button, DataTable, ErrorState, Field, LoadingState, StatusBadge, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { JustificationField, justificationError } from '../admin/shared';
import { FormCard } from '../clinical/patient-forms';
import { PageHeader, localToIso, nowLocal, useOrg, useTimeZone } from '../clinical/shared';
import { Attachments, CmeNav, RequireCme, TestResultBadge, useCme, useCmeMutation } from './shared';

const EQUIPMENT_TONE = { ativo: 'ok', manutencao: 'crit', inativo: 'neutral' } as const;
const DAYS = 14;

/* ---------- Bowie-Dick ---------- */

export function BowieDickPage() {
  return <RequireCme title="Bowie-Dick"><BowieDick /></RequireCme>;
}

function BowieDick() {
  const cme = useCme()!;
  const session = useSession();
  const tz = useTimeZone();
  const today = todayIn(tz);
  const from = addDays(today, -(DAYS - 1));
  const [adding, setAdding] = useState(false);
  const sterilizers = useQuery({ queryKey: ['cme', 'sterilizers'], queryFn: () => cme.sterilizers() });
  const tests = useQuery({ queryKey: ['cme', 'bowie-dick', from, today], queryFn: () => cme.bowieDick(from, today) });
  if (sterilizers.isPending || tests.isPending) return <div className="page"><LoadingState /></div>;
  if (sterilizers.isError || tests.isError) return <div className="page"><ErrorState onRetry={() => { void sterilizers.refetch(); void tests.refetch(); }} /></div>;
  const steam = sterilizers.data.sterilizers.filter((s) => s.bowieDickApplies);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(from, i));
  const current = tests.data.tests.filter((t) => t.current);
  const dayOf = (t: CmeTestDto) => todayIn(tz, new Date(t.performedAt));
  const cell = (s: SterilizerDto, day: string) => current.filter((t) => t.sterilizerId === s.id && dayOf(t) === day);
  const name = (id: string) => sterilizers.data.sterilizers.find((s) => s.id === id)?.name ?? 'Equipamento';
  const cols: Column<CmeTestDto>[] = [
    { key: 'performedAt', label: 'Data', value: (t) => t.performedAt, render: (t) => formatDate(t.performedAt, tz) },
    { key: 'sterilizer', label: 'Equipamento', value: (t) => name(t.sterilizerId) },
    { key: 'result', label: 'Resultado', render: (t) => <TestResultBadge type="BOWIE_DICK" result={t.result} /> },
    { key: 'lot', label: 'Pacote de teste', render: (t) => <span className="ig-mono ig-small">{t.indicatorLot}</span> },
    { key: 'notes', label: 'Observações', render: (t) => <span className="ig-small">{t.notes ?? '—'}{t.current ? '' : ' (versão substituída)'}</span> },
    { key: 'by', label: 'Registrado por', value: (t) => t.recordedBy },
    { key: 'files', label: 'Evidência', render: (t) => <Attachments entity="sterilization_test" entityId={t.id} files={t.attachments} canUpload={session.can('cme:test:record') && t.current} /> },
  ];
  return (
    <div className="page">
      <PageHeader title="Bowie-Dick" subtitle="Teste diário de remoção de ar das autoclaves a vapor com pré-vácuo, antes da primeira carga. Reprovado: bloqueie o equipamento até nova aprovação."
        actions={session.can('cme:test:record') && !adding ? <Button icon="plus" variant="primary" onClick={() => setAdding(true)}>Registrar Bowie-Dick</Button> : null} />
      <CmeNav />
      {adding ? <BowieDickForm sterilizers={steam.filter((s) => s.status !== 'inativo')} onDone={() => setAdding(false)} /> : null}
      <div className="ig-table-scroll">
        <table className="ig-table cme-bd-grid">
          <caption>Últimos {DAYS} dias (resultado vigente de cada teste do dia)</caption>
          <thead><tr><th scope="col">Equipamento</th>{days.map((d) => <th key={d} scope="col" className="ig-num">{d.slice(8)}/{d.slice(5, 7)}</th>)}</tr></thead>
          <tbody>
            {steam.map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.name}</th>
                {days.map((d) => {
                  const list = cell(s, d);
                  const last = list.at(-1);
                  return <td key={d}>{last ? <span className="ig-row" style={{ gap: 2 }}><TestResultBadge type="BOWIE_DICK" result={last.result} />{list.length > 1 ? <span className="ig-small ig-muted" title="Teste repetido no dia">×{list.length}</span> : null}</span> : <span className="ig-small ig-muted">Sem teste</span>}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DataTable caption="Registros do período" rows={[...tests.data.tests].reverse()} rowKey={(t) => t.id} columns={cols} pageSize={20} />
    </div>
  );
}

function BowieDickForm({ sterilizers, onDone }: { sterilizers: SterilizerDto[]; onDone: () => void }) {
  const cme = useCme()!;
  const tz = useTimeZone();
  const [d, setD] = useState({ sterilizerId: sterilizers[0]?.id ?? '', result: 'aprovado' as TestResult, performedAt: nowLocal(tz), indicatorLot: '', indicatorExpiry: '', notes: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useCmeMutation(() => cme.createTest({ sterilizerId: d.sterilizerId, loadId: null, type: 'BOWIE_DICK', result: d.result, performedAt: localToIso(d.performedAt, tz)!, indicatorLot: d.indicatorLot.trim(), indicatorExpiry: d.indicatorExpiry || null, incubationStart: null, readAt: null, controlResult: null, notes: d.notes.trim() || null }));
  const submit = () => {
    const e = {
      sterilizerId: d.sterilizerId ? undefined : 'Escolha o equipamento.',
      indicatorLot: d.indicatorLot.trim() ? undefined : 'Informe o lote do pacote de teste.',
      indicatorExpiry: d.indicatorExpiry ? undefined : 'Informe a validade do pacote de teste.',
      notes: d.result === 'reprovado' && !d.notes.trim() ? 'Descreva o achado e a conduta.' : undefined,
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title="Registrar Bowie-Dick" error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Registrar">
      <div className="ig-form-row">
        <Field label="Equipamento" required error={err('sterilizerId')}><select value={d.sterilizerId} onChange={(e) => setD({ ...d, sterilizerId: e.target.value })}><option value="">Selecione</option>{sterilizers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Resultado" required error={err('result')}><select value={d.result} onChange={(e) => setD({ ...d, result: e.target.value as TestResult })}><option value="aprovado">Aprovado</option><option value="reprovado">Reprovado</option></select></Field>
        <Field label="Realizado em" required error={err('performedAt')}><input type="datetime-local" value={d.performedAt} max={nowLocal(tz)} onChange={(e) => setD({ ...d, performedAt: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Lote do pacote de teste" required error={err('indicatorLot')}><input value={d.indicatorLot} maxLength={40} onChange={(e) => setD({ ...d, indicatorLot: e.target.value })} /></Field>
        <Field label="Validade" required error={err('indicatorExpiry')}><input type="date" value={d.indicatorExpiry} onChange={(e) => setD({ ...d, indicatorExpiry: e.target.value })} /></Field>
      </div>
      <Field label="Observações" required={d.result === 'reprovado'} error={err('notes')}><textarea value={d.notes} maxLength={1000} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
    </FormCard>
  );
}

/* ---------- Equipment ---------- */

export function EquipmentPage() {
  return <RequireCme title="Equipamentos da CME"><Equipment /></RequireCme>;
}

function Equipment() {
  const cme = useCme()!;
  const session = useSession();
  const [editing, setEditing] = useState<SterilizerDto | 'new' | null>(null);
  const list = useQuery({ queryKey: ['cme', 'sterilizers'], queryFn: () => cme.sterilizers() });
  const canConfigure = session.can('cme:configure');
  const cols: Column<SterilizerDto>[] = [
    { key: 'name', label: 'Equipamento', render: (s) => <span><b>{s.name}</b> <span className="ig-mono ig-small">{s.code}</span></span>, value: (s) => s.name },
    { key: 'type', label: 'Tipo', value: (s) => STERILIZER_TYPE_LABEL[s.type] },
    { key: 'serial', label: 'Série', render: (s) => <span className="ig-mono ig-small">{s.serial ?? '—'}</span> },
    { key: 'status', label: 'Situação', render: (s) => <span><StatusBadge status={EQUIPMENT_TONE[s.status]}>{EQUIPMENT_STATUS_LABEL[s.status]}</StatusBadge>{s.statusReason ? <span className="ig-small ig-muted"> {s.statusReason}</span> : null}</span>, value: (s) => EQUIPMENT_STATUS_LABEL[s.status] },
    { key: 'qualification', label: 'Qualificação vence em', value: (s) => s.qualificationDueOn ?? '', render: (s) => (s.qualificationDueOn ? formatDate(s.qualificationDueOn) : <span className="ig-muted">Não informada</span>) },
    { key: 'actions', label: 'Ações', render: (s) => (canConfigure ? <Button size="sm" onClick={() => setEditing(s)} aria-label={`Editar ${s.name}`}>Editar</Button> : null) },
  ];
  return (
    <div className="page">
      <PageHeader title="Equipamentos da CME" subtitle="Equipamentos em manutenção ficam bloqueados para novos ciclos. Mudanças de situação exigem motivo e ficam no log de auditoria."
        actions={canConfigure && !editing ? <Button icon="plus" onClick={() => setEditing('new')}>Novo equipamento</Button> : null} />
      <CmeNav />
      {editing ? <SterilizerForm sterilizer={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      <DataTable caption="Equipamentos" rows={list.data?.sterilizers ?? []} rowKey={(s) => s.id} columns={cols} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'} />
    </div>
  );
}

function SterilizerForm({ sterilizer, onDone }: { sterilizer: SterilizerDto | null; onDone: () => void }) {
  const cme = useCme()!;
  const org = useOrg();
  const cmeSectors = org.data?.sectors.filter((s) => s.kind === 'cme') ?? [];
  const [d, setD] = useState({
    code: sterilizer?.code ?? '', name: sterilizer?.name ?? '', type: (sterilizer?.type ?? 'vapor_prevacuo') as SterilizerType, serial: sterilizer?.serial ?? '',
    sectorId: sterilizer?.sectorId ?? '', status: (sterilizer?.status ?? 'ativo') as EquipmentStatus, statusReason: sterilizer?.statusReason ?? '', qualificationDueOn: sterilizer?.qualificationDueOn ?? '', justification: '',
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const sectorId = d.sectorId || cmeSectors[0]?.id || '';
  const m = useCmeMutation(() => cme.saveSterilizer(sterilizer?.id ?? null, {
    code: d.code.trim(), name: d.name.trim(), type: d.type, serial: d.serial.trim() || null, sectorId, status: d.status, statusReason: d.status === 'ativo' ? null : d.statusReason.trim(),
    qualificationDueOn: d.qualificationDueOn || null, rowVersion: sterilizer?.rowVersion ?? null, justification: d.justification.trim(),
  }));
  const submit = () => {
    const e = {
      code: /^[a-z0-9-]{2,20}$/.test(d.code.trim()) ? undefined : 'Use letras minúsculas, números e hífen.',
      name: d.name.trim() ? undefined : 'Informe o nome.',
      sectorId: sectorId ? undefined : 'Cadastre um setor do tipo CME.',
      statusReason: d.status !== 'ativo' && !d.statusReason.trim() ? 'Informe o motivo do bloqueio ou da inativação.' : undefined,
      justification: justificationError(d.justification),
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title={sterilizer ? `Editar ${sterilizer.name}` : 'Novo equipamento'} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar">
      <div className="ig-form-row">
        <Field label="Código" required error={err('code')}><input value={d.code} maxLength={20} onChange={(e) => setD({ ...d, code: e.target.value })} /></Field>
        <Field label="Nome" required error={err('name')}><input value={d.name} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Tipo" required error={err('type')} hint="Define se o Bowie-Dick se aplica."><select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as SterilizerType })}>{Object.entries(STERILIZER_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Número de série" error={err('serial')}><input value={d.serial} maxLength={60} onChange={(e) => setD({ ...d, serial: e.target.value })} /></Field>
        <Field label="Setor" required error={err('sectorId')}><select value={sectorId} onChange={(e) => setD({ ...d, sectorId: e.target.value })}>{cmeSectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Qualificação térmica vence em" error={err('qualificationDueOn')}><input type="date" value={d.qualificationDueOn} onChange={(e) => setD({ ...d, qualificationDueOn: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Situação" required><select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as EquipmentStatus })}>{Object.entries(EQUIPMENT_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {d.status !== 'ativo' ? <Field label="Motivo" required error={err('statusReason')}><input value={d.statusReason} maxLength={300} onChange={(e) => setD({ ...d, statusReason: e.target.value })} /></Field> : null}
      </div>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={err('justification') ?? undefined} />
    </FormCard>
  );
}

/* ---------- Instrument sets ---------- */

export function SetsPage() {
  return <RequireCme title="Caixas e materiais"><Sets /></RequireCme>;
}

function Sets() {
  const cme = useCme()!;
  const session = useSession();
  const [editing, setEditing] = useState<InstrumentSetDto | 'new' | null>(null);
  const list = useQuery({ queryKey: ['cme', 'sets'], queryFn: () => cme.sets() });
  const canConfigure = session.can('cme:configure');
  const cols: Column<InstrumentSetDto>[] = [
    { key: 'name', label: 'Caixa', render: (s) => <span><b>{s.name}</b> <span className="ig-mono ig-small">{s.code}</span>{s.active ? '' : <span className="ig-small ig-muted"> (inativa)</span>}</span>, value: (s) => s.name },
    { key: 'specialty', label: 'Especialidade', value: (s) => s.specialty ?? '—' },
    { key: 'itemCount', label: 'Peças', align: 'right', value: (s) => s.itemCount ?? '' },
    { key: 'packaging', label: 'Embalagem', value: (s) => PACKAGING_LABEL[s.packaging] },
    { key: 'implant', label: 'Implantável', value: (s) => (s.implant ? 'Sim' : 'Não') },
    { key: 'actions', label: 'Ações', render: (s) => (canConfigure ? <Button size="sm" onClick={() => setEditing(s)} aria-label={`Editar ${s.name}`}>Editar</Button> : null) },
  ];
  return (
    <div className="page">
      <PageHeader title="Caixas e materiais" subtitle="Catálogo usado nas cargas. Caixas com implantável seguem a regra de liberação só após o indicador biológico, quando a política exigir."
        actions={canConfigure && !editing ? <Button icon="plus" onClick={() => setEditing('new')}>Nova caixa</Button> : null} />
      <CmeNav />
      {editing ? <SetForm set={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      <DataTable caption="Caixas" rows={list.data?.sets ?? []} rowKey={(s) => s.id} columns={cols} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'} searchable />
    </div>
  );
}

function SetForm({ set, onDone }: { set: InstrumentSetDto | null; onDone: () => void }) {
  const cme = useCme()!;
  const [d, setD] = useState({ code: set?.code ?? '', name: set?.name ?? '', specialty: set?.specialty ?? '', composition: set?.composition ?? '', itemCount: set?.itemCount != null ? String(set.itemCount) : '', packaging: (set?.packaging ?? 'container_rigido') as PackagingType, implant: set?.implant ?? false, active: set?.active ?? true, justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useCmeMutation(() => cme.saveSet(set?.id ?? null, { code: d.code.trim(), name: d.name.trim(), specialty: d.specialty.trim() || null, composition: d.composition.trim() || null, itemCount: d.itemCount ? Number(d.itemCount) : null, packaging: d.packaging, implant: d.implant, active: d.active, rowVersion: set?.rowVersion ?? null, justification: d.justification.trim() }));
  const submit = () => {
    const e = {
      code: /^[a-z0-9-]{2,40}$/.test(d.code.trim()) ? undefined : 'Use letras minúsculas, números e hífen.',
      name: d.name.trim() ? undefined : 'Informe o nome.',
      itemCount: !d.itemCount || (Number.isInteger(Number(d.itemCount)) && Number(d.itemCount) > 0) ? undefined : 'Número inteiro de peças.',
      justification: justificationError(d.justification),
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title={set ? `Editar ${set.name}` : 'Nova caixa'} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar">
      <div className="ig-form-row">
        <Field label="Código" required error={err('code')}><input value={d.code} maxLength={40} onChange={(e) => setD({ ...d, code: e.target.value })} /></Field>
        <Field label="Nome" required error={err('name')}><input value={d.name} maxLength={160} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Especialidade"><input value={d.specialty} maxLength={80} onChange={(e) => setD({ ...d, specialty: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Peças" error={err('itemCount')}><input inputMode="numeric" value={d.itemCount} onChange={(e) => setD({ ...d, itemCount: e.target.value })} /></Field>
        <Field label="Embalagem" required><select value={d.packaging} onChange={(e) => setD({ ...d, packaging: e.target.value as PackagingType })}>{Object.entries(PACKAGING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <label className="inline-check"><input type="checkbox" checked={d.implant} onChange={(e) => setD({ ...d, implant: e.target.checked })} /> Contém implantável</label>
        <label className="inline-check"><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Ativa</label>
      </div>
      <Field label="Composição"><textarea value={d.composition} maxLength={2000} onChange={(e) => setD({ ...d, composition: e.target.value })} /></Field>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={err('justification') ?? undefined} />
    </FormCard>
  );
}
