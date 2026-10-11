import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LABEL_DPI, LABEL_ENTITY_LABEL, LABEL_FIELDS, LABEL_SAMPLE_CODE, checkLabelLayout,
  type LabelContent, type LabelEntity, type LabelField, type LabelLayoutDto, type LabelLayoutInput,
} from '@ccih/domain';
import { AlertBanner, Button, Card, DataTable, Field, StatusBadge, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { JustificationField, justificationError } from '../admin/shared';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader } from '../clinical/shared';
import { CmeNav, RequireCme, useCme, useCmeMutation } from './shared';
import { LabelHistory, LabelView } from './labels';

export function LabelsPage() {
  return <RequireCme title="Etiquetas"><Labels /></RequireCme>;
}

/** Example content for the layout preview (clearly not a real record). */
const SAMPLE: Record<LabelEntity, LabelContent> = {
  pacote: { entity: 'pacote', code: LABEL_SAMPLE_CODE.pacote, material: 'Exemplo — caixa de laparotomia', processedOn: '2026-10-09', expiresOn: '2026-11-08', lot: 'CME01-251009-01', equipment: 'Autoclave 1 · 134 °C', release: 'Liberada', packaging: 'SMS', implant: true, setName: 'Laparotomia' },
  ativo: { entity: 'ativo', code: LABEL_SAMPLE_CODE.ativo, material: 'Exemplo — caixa de laparotomia', setName: 'Laparotomia', tag: 'LAP-1' },
  processo: { entity: 'processo', code: LABEL_SAMPLE_CODE.processo, material: 'Exemplo — material avulso', processedOn: '2026-10-09', setName: null },
};

function Labels() {
  const cme = useCme()!;
  const session = useSession();
  const canConfigure = session.can('cme:stations:configure') && session.writable;
  const layouts = useQuery({ queryKey: ['cme', 'label-layouts'], queryFn: () => cme.labelLayouts() });
  const [editing, setEditing] = useState<LabelLayoutDto | 'new' | null>(null);
  const [q, setQ] = useState('');
  const cols: Column<LabelLayoutDto>[] = [
    { key: 'name', label: 'Layout', render: (l) => <span>{l.name} <DemoTag origin={l.dataOrigin} /></span> },
    { key: 'entity', label: 'Etiqueta de', value: (l) => LABEL_ENTITY_LABEL[l.entity] },
    { key: 'size', label: 'Tamanho', value: (l) => `${l.widthMm} × ${l.heightMm} mm · ${l.dpi} dpi` },
    { key: 'fields', label: 'Campos', value: (l) => l.fields.map((f) => LABEL_FIELDS[f].label).join(', ') || '—' },
    { key: 'state', label: 'Situação', render: (l) => (!l.active ? <StatusBadge status="neutral">Inativo</StatusBadge> : l.isDefault ? <StatusBadge status="ok">Padrão</StatusBadge> : <StatusBadge status="info">Ativo</StatusBadge>) },
    ...(canConfigure ? [{ key: 'actions', label: 'Ações', render: (l: LabelLayoutDto) => <Button size="sm" onClick={() => setEditing(l)} aria-label={`Editar ${l.name}`}>Editar</Button> }] : []),
  ];
  return (
    <div className="page">
      <PageHeader title="Etiquetas" subtitle="Layouts de impressão (tamanho, margens, resolução e campos) e histórico de impressões, reimpressões e cancelamentos. Código de barras Code 128, conferido automaticamente antes de cada impressão."
        actions={canConfigure && !editing ? <Button icon="plus" onClick={() => setEditing('new')}>Novo layout</Button> : null} />
      <CmeNav />
      <AlertBanner tone="info" title="Validação física pendente">
        A geração do código é verificada automaticamente (o código impresso é lido de volta). A impressão e a leitura com a impressora e o leitor da CME ainda precisam do roteiro de validação física com o equipamento real.
      </AlertBanner>
      {editing ? <LayoutForm layout={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      <Card title="Layouts" headingLevel={2}>
        <DataTable caption="Layouts de etiqueta" rows={layouts.data?.layouts ?? []} rowKey={(l) => l.id} columns={cols} state={layouts.isPending ? 'loading' : layouts.isError ? 'error' : 'ready'} emptyMessage="Nenhum layout cadastrado: cadastre o layout conforme a impressora adotada." />
      </Card>
      <div className="field" style={{ maxWidth: 360 }}><label htmlFor="lb-q">Buscar etiquetas pelo código</label><input id="lb-q" className="select" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} placeholder="Ex.: CME01-251009 ou AT-" /></div>
      <LabelHistory title="Etiquetas emitidas" {...(q.trim().length >= 2 ? { q: q.trim() } : {})} />
    </div>
  );
}

function LayoutForm({ layout, onDone }: { layout: LabelLayoutDto | null; onDone: () => void }) {
  const cme = useCme()!;
  const [d, setD] = useState({
    name: layout?.name ?? '', entity: layout?.entity ?? ('pacote' as LabelEntity), widthMm: String(layout?.widthMm ?? ''), heightMm: String(layout?.heightMm ?? ''),
    marginMm: String(layout?.marginMm ?? '2'), dpi: String(layout?.dpi ?? ''), barHeightMm: String(layout?.barHeightMm ?? '10'),
    fields: layout?.fields ?? (['processamento', 'validade', 'lote'] as LabelField[]), isDefault: layout?.isDefault ?? false, active: layout?.active ?? true, justification: '',
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const input: LabelLayoutInput = { name: d.name.trim(), entity: d.entity, widthMm: Number(d.widthMm), heightMm: Number(d.heightMm), marginMm: Number(d.marginMm), dpi: Number(d.dpi), barHeightMm: Number(d.barHeightMm), fields: d.fields };
  const problems = checkLabelLayout(input);
  const m = useCmeMutation(() => cme.saveLabelLayout(layout?.id ?? null, { ...input, isDefault: d.isDefault, active: d.active, rowVersion: layout?.rowVersion ?? null, justification: d.justification.trim() }));
  const applicable = (Object.keys(LABEL_FIELDS) as LabelField[]).filter((f) => LABEL_FIELDS[f].entities.includes(d.entity));
  const submit = () => {
    const e: Record<string, string | undefined> = Object.fromEntries(problems.map((p) => [p.path, p.message]));
    e.justification = justificationError(d.justification);
    if (d.isDefault && !d.active) e.isDefault = 'Um layout inativo não pode ser o padrão.';
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const num = (key: 'widthMm' | 'heightMm' | 'marginMm' | 'barHeightMm', label: string) => (
    <Field label={label} required error={errors[key] ?? m.fieldErrors[key] ?? null}><input inputMode="decimal" value={d[key]} onChange={(e) => setD({ ...d, [key]: e.target.value.replace(',', '.') })} /></Field>
  );
  return (
    <FormCard title={layout ? `Editar layout: ${layout.name}` : 'Novo layout de etiqueta'} subtitle="Use as medidas da etiqueta e a resolução da impressora adotada pela CME. A pré-visualização mostra o tamanho real."
      error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar layout">
      <div className="ig-form-row">
        <Field label="Nome" required error={errors.name ?? m.fieldErrors.name ?? null}><input value={d.name} maxLength={60} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Etiqueta de" required hint={layout ? 'Não muda depois de criado.' : undefined}>
          <select value={d.entity} disabled={!!layout} onChange={(e) => { const entity = e.target.value as LabelEntity; setD({ ...d, entity, fields: d.fields.filter((f) => LABEL_FIELDS[f].entities.includes(entity)) }); }}>
            {(Object.keys(LABEL_ENTITY_LABEL) as LabelEntity[]).map((k) => <option key={k} value={k}>{LABEL_ENTITY_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Resolução da impressora" required error={errors.dpi ?? null}>
          <select value={d.dpi} onChange={(e) => setD({ ...d, dpi: e.target.value })}><option value="">Selecione</option>{LABEL_DPI.map((x) => <option key={x} value={x}>{x} dpi</option>)}</select>
        </Field>
      </div>
      <div className="ig-form-row">
        {num('widthMm', 'Largura (mm)')}
        {num('heightMm', 'Altura (mm)')}
        {num('marginMm', 'Margem (mm)')}
        {num('barHeightMm', 'Altura das barras (mm)')}
      </div>
      <fieldset className="ig-fieldset">
        <legend>Campos impressos (o material e o código sempre são impressos)</legend>
        <div className="ig-checks">
          {applicable.map((f) => (
            <label key={f} title={LABEL_FIELDS[f].hint}>
              <input type="checkbox" checked={d.fields.includes(f)} onChange={(e) => setD({ ...d, fields: e.target.checked ? [...d.fields, f] : d.fields.filter((x) => x !== f) })} />
              {LABEL_FIELDS[f].label}
            </label>
          ))}
        </div>
        {errors.fields ? <p className="ig-small" style={{ color: 'var(--crit)' }}>{errors.fields}</p> : null}
        {d.fields.includes('liberacao') ? <p className="ig-small ig-muted">{LABEL_FIELDS.liberacao.hint}</p> : null}
      </fieldset>
      <div className="ig-checks">
        <label><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked, isDefault: e.target.checked && d.isDefault })} />Ativo</label>
        <label><input type="checkbox" checked={d.isDefault} onChange={(e) => setD({ ...d, isDefault: e.target.checked })} />Padrão para {LABEL_ENTITY_LABEL[d.entity].toLowerCase()}</label>
      </div>
      <div className="cme-label-preview" aria-label="Pré-visualização do layout">
        {problems.length ? <p className="ig-small ig-muted">{problems[0]!.message}</p> : <LabelView layout={input} content={SAMPLE[d.entity]} />}
      </div>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={errors.justification} />
    </FormCard>
  );
}
