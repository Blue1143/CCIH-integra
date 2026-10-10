import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MOVEMENT_LABEL, SUPPLY_CATEGORY_LABEL, formatDate, formatNumber, type MovementKind, type SupplyCategory, type SupplyDto } from '@ccih/domain';
import { Button, Card, DataTable, ErrorState, Field, FormMessage, LoadingState, StatusBadge, SupplyStock } from '@ccih/ui';
import { useSession } from '../auth/session';
import { JustificationField, justificationError } from '../admin/shared';
import { FormCard } from '../clinical/patient-forms';
import { PageHeader, localToIso, nowLocal, sectorName, useOrg, useTimeZone } from '../clinical/shared';
import { RequireOps, useOps, useOpsMutation } from './shared';

export function SuppliesPage() {
  return <RequireOps title="Insumos"><Supplies /></RequireOps>;
}

function Supplies() {
  const ops = useOps()!;
  const session = useSession();
  const list = useQuery({ queryKey: ['supplies', 'list'], queryFn: () => ops.supplies() });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<SupplyDto | 'new' | null>(null);
  if (list.isPending) return <div className="page"><LoadingState /></div>;
  if (list.isError) return <div className="page"><ErrorState onRetry={() => void list.refetch()} /></div>;
  const supply = list.data.supplies.find((s) => s.id === selected) ?? null;
  return (
    <div className="page">
      <PageHeader title="Insumos" subtitle="Estoque por lote a partir de um livro de movimentos que não pode ser alterado: entradas, consumo por setor, ajustes e descartes com motivo. Cobertura e validade avaliadas pelos parâmetros da instituição."
        actions={session.can('quality:configure') && !editing ? <Button icon="plus" onClick={() => setEditing('new')}>Novo insumo</Button> : null} />
      {editing ? <SupplyForm supply={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      <SupplyStock rows={list.data.supplies.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, unit: s.unit, quantity: s.quantity, dailyConsumption: s.dailyConsumption, evaluation: s.evaluation, expiresOn: s.lots.find((l) => l.quantity > 0)?.expiresOn ?? undefined }))} />
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="sup-sel">Detalhar insumo</label>
        <select id="sup-sel" className="select" value={selected ?? ''} onChange={(e) => setSelected(e.target.value || null)}>
          <option value="">Selecione</option>
          {list.data.supplies.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (inativo)'}</option>)}
        </select>
      </div>
      {supply ? <SupplyDetail supply={supply} onEdit={session.can('quality:configure') ? () => setEditing(supply) : undefined} /> : null}
    </div>
  );
}

function SupplyDetail({ supply, onEdit }: { supply: SupplyDto; onEdit?: () => void }) {
  const ops = useOps()!;
  const session = useSession();
  const org = useOrg();
  const tz = useTimeZone();
  const movements = useQuery({ queryKey: ['supplies', 'movements', supply.id], queryFn: () => ops.supplyMovements(supply.id) });
  const [moving, setMoving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <>
      <Card title={supply.name} subtitle={`${SUPPLY_CATEGORY_LABEL[supply.category]} · unidade: ${supply.unit} · cobertura mínima: ${supply.minCoverageDays != null ? `${supply.minCoverageDays} dias (própria)` : 'padrão institucional'}`}
        actions={<div className="ig-row" style={{ gap: 8 }}>
          {session.can('quality:supplies:edit') && !moving ? <Button variant="primary" onClick={() => { setMoving(true); setSaved(null); }}>Registrar movimento</Button> : null}
          {onEdit ? <Button onClick={onEdit}>Editar cadastro</Button> : null}
        </div>}>
        <p style={{ margin: 0 }}><StatusBadge status={supply.evaluation.status}>{supply.evaluation.label}</StatusBadge> Estoque {formatNumber(supply.quantity, supply.unit === 'mL' ? 0 : 1)} {supply.unit} · consumo médio {formatNumber(supply.dailyConsumption, 1)}/dia</p>
        {saved ? <FormMessage tone="success">{saved}</FormMessage> : null}
        <div className="ig-section">
          <DataTable caption="Lotes" dense rows={supply.lots} rowKey={(l) => l.id}
            columns={[{ key: 'lot', label: 'Lote', render: (l) => <span className="ig-mono">{l.lot}</span> }, { key: 'expiresOn', label: 'Validade', value: (l) => l.expiresOn ?? '', render: (l) => formatDate(l.expiresOn) }, { key: 'quantity', label: 'Saldo', align: 'right', render: (l) => `${formatNumber(l.quantity, supply.unit === 'mL' ? 0 : 1)} ${supply.unit}` }]} />
        </div>
      </Card>
      {moving ? <MovementForm supply={supply} onDone={(msg) => { setMoving(false); if (msg) setSaved(msg); }} /> : null}
      <DataTable caption="Últimos movimentos" rows={movements.data?.movements ?? []} rowKey={(m) => m.id} state={movements.isPending ? 'loading' : movements.isError ? 'error' : 'ready'} pageSize={15}
        columns={[
          { key: 'occurredAt', label: 'Data', value: (m) => m.occurredAt, render: (m) => formatDate(m.occurredAt, tz) },
          { key: 'kind', label: 'Tipo', value: (m) => MOVEMENT_LABEL[m.kind] },
          { key: 'lot', label: 'Lote', render: (m) => <span className="ig-mono">{m.lot}</span> },
          { key: 'delta', label: 'Quantidade', align: 'right', render: (m) => `${m.delta > 0 ? '+' : ''}${formatNumber(m.delta, supply.unit === 'mL' ? 0 : 1)}` },
          { key: 'sector', label: 'Setor', value: (m) => (m.sectorId ? sectorName(org.data, m.sectorId) : '—') },
          { key: 'reason', label: 'Motivo' },
          { key: 'by', label: 'Registrado por' },
        ]} />
    </>
  );
}

function MovementForm({ supply, onDone }: { supply: SupplyDto; onDone: (msg?: string) => void }) {
  const ops = useOps()!;
  const org = useOrg();
  const tz = useTimeZone();
  const [d, setD] = useState({ kind: 'consumo' as MovementKind, lot: supply.lots.find((l) => l.quantity > 0)?.lot ?? '', expiresOn: '', quantity: '', sectorId: '', occurredAt: nowLocal(tz), reason: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useOpsMutation(() => ops.addMovement(supply.id, { kind: d.kind, lot: d.lot.trim(), expiresOn: d.kind === 'entrada' ? d.expiresOn || null : null, quantity: Number(d.quantity.replace(',', '.')), sectorId: d.sectorId || null, occurredAt: localToIso(d.occurredAt, tz)!, reason: d.reason.trim() || null }));
  const submit = () => {
    const q = Number(d.quantity.replace(',', '.'));
    const e = {
      lot: d.lot.trim() ? undefined : 'Informe o lote.',
      quantity: Number.isFinite(q) && q !== 0 && (d.kind === 'ajuste' || q > 0) ? undefined : d.kind === 'ajuste' ? 'Informe a diferença (positiva ou negativa).' : 'Informe uma quantidade positiva.',
      sectorId: d.kind === 'consumo' && !d.sectorId ? 'Informe o setor que consumiu.' : undefined,
      reason: (d.kind === 'ajuste' || d.kind === 'descarte') && !d.reason.trim() ? 'Informe o motivo.' : undefined,
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: () => onDone(`${MOVEMENT_LABEL[d.kind]} registrado.`) });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title="Registrar movimento" subtitle="Movimentos não podem ser editados; para corrigir, registre um ajuste com motivo." error={m.formError} onSubmit={submit} onCancel={() => onDone()} busy={m.mutation.isPending} submitLabel="Registrar">
      <div className="ig-form-row">
        <Field label="Tipo" required><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as MovementKind })}>{Object.entries(MOVEMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Lote" required hint={d.kind === 'entrada' ? 'Lote novo ou existente.' : undefined} error={err('lot')}>
          {d.kind === 'entrada' ? <input value={d.lot} maxLength={40} onChange={(e) => setD({ ...d, lot: e.target.value })} /> : (
            <select value={d.lot} onChange={(e) => setD({ ...d, lot: e.target.value })}><option value="">Selecione</option>{supply.lots.map((l) => <option key={l.id} value={l.lot}>{l.lot} · saldo {formatNumber(l.quantity, 1)}{l.expiresOn ? ` · validade ${formatDate(l.expiresOn)}` : ''}</option>)}</select>
          )}
        </Field>
        {d.kind === 'entrada' ? <Field label="Validade do lote" error={err('expiresOn')}><input type="date" value={d.expiresOn} onChange={(e) => setD({ ...d, expiresOn: e.target.value })} /></Field> : null}
      </div>
      <div className="ig-form-row">
        <Field label={`Quantidade (${supply.unit})`} required error={err('quantity')}><input inputMode="decimal" value={d.quantity} onChange={(e) => setD({ ...d, quantity: e.target.value })} /></Field>
        {d.kind === 'consumo' || d.kind === 'descarte' ? (
          <Field label="Setor" required={d.kind === 'consumo'} error={err('sectorId')}><select value={d.sectorId} onChange={(e) => setD({ ...d, sectorId: e.target.value })}><option value="">Selecione</option>{org.data?.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        ) : null}
        <Field label="Data e hora" required error={err('occurredAt')}><input type="datetime-local" value={d.occurredAt} max={nowLocal(tz)} onChange={(e) => setD({ ...d, occurredAt: e.target.value })} /></Field>
      </div>
      {d.kind === 'ajuste' || d.kind === 'descarte' ? <Field label="Motivo" required error={err('reason')}><input value={d.reason} maxLength={300} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field> : null}
    </FormCard>
  );
}

function SupplyForm({ supply, onDone }: { supply: SupplyDto | null; onDone: () => void }) {
  const ops = useOps()!;
  const [d, setD] = useState({ code: supply?.code ?? '', name: supply?.name ?? '', category: (supply?.category ?? 'epi') as SupplyCategory, unit: supply?.unit ?? 'unidade', minCoverageDays: supply?.minCoverageDays != null ? String(supply.minCoverageDays) : '', active: supply?.active ?? true, justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useOpsMutation(() => ops.saveSupply({ code: d.code.trim(), name: d.name.trim(), category: d.category, unit: d.unit.trim(), minCoverageDays: d.minCoverageDays ? Number(d.minCoverageDays) : null, active: d.active, rowVersion: supply?.rowVersion ?? null, justification: d.justification.trim() }));
  const submit = () => {
    const e = {
      code: /^[a-z0-9-]{2,40}$/.test(d.code.trim()) ? undefined : 'Use letras minúsculas, números e hífen.',
      name: d.name.trim() ? undefined : 'Informe o nome.',
      unit: d.unit.trim() ? undefined : 'Informe a unidade.',
      minCoverageDays: !d.minCoverageDays || (Number.isInteger(Number(d.minCoverageDays)) && Number(d.minCoverageDays) > 0) ? undefined : 'Informe dias inteiros, ou deixe vazio para o padrão.',
      justification: justificationError(d.justification),
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title={supply ? `Editar ${supply.name}` : 'Novo insumo'} subtitle="Preparações alcoólicas medidas em mL alimentam o indicador de consumo por paciente-dia." error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar">
      <div className="ig-form-row">
        <Field label="Código" required error={err('code')}><input value={d.code} disabled={!!supply} onChange={(e) => setD({ ...d, code: e.target.value })} /></Field>
        <Field label="Nome" required error={err('name')}><input value={d.name} maxLength={200} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Categoria" required><select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value as SupplyCategory })}>{Object.entries(SUPPLY_CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Unidade" required error={err('unit')}><input value={d.unit} maxLength={30} onChange={(e) => setD({ ...d, unit: e.target.value })} /></Field>
        <Field label="Cobertura mínima (dias)" hint="Vazio = parâmetro institucional." error={err('minCoverageDays')}><input inputMode="numeric" value={d.minCoverageDays} onChange={(e) => setD({ ...d, minCoverageDays: e.target.value })} /></Field>
      </div>
      <label className="ig-row" style={{ gap: 8 }}><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Ativo</label>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={err('justification') ?? undefined} />
    </FormCard>
  );
}
