import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_SCAN_CONFIG, INPUT_METHOD_LABEL, PROCESS_STEP_LABEL, SCANNABLE_STEPS, SYMBOLOGY_LABEL, formatDate,
  type AssetDto, type FlowConfigDto, type InputMethod, type ProcessStep, type StationDto, type Symbology,
} from '@ccih/domain';
import { AlertBanner, Button, Card, DataTable, ErrorState, Field, FormMessage, LoadingState, StatusBadge, type Column } from '@ccih/ui';
import { ApiError } from '../../data/api/http';
import { useSession } from '../auth/session';
import { JustificationField, justificationError } from '../admin/shared';
import { FormCard } from '../clinical/patient-forms';
import { PageHeader, sectorName, useOrg, useTimeZone } from '../clinical/shared';
import { CmeNav, RequireCme, useCme, useCmeMutation } from './shared';
import { LabelPrintPanel, useActiveLabels, type LabelTarget } from './labels';

export function FlowSetupPage() {
  return <RequireCme title="Estações e fluxo"><FlowSetup /></RequireCme>;
}

function FlowSetup() {
  const cme = useCme()!;
  const session = useSession();
  const tz = useTimeZone();
  const org = useOrg();
  const config = useQuery({ queryKey: ['cme', 'flow-config'], queryFn: () => cme.flowConfig() });
  const stations = useQuery({ queryKey: ['cme', 'stations'], queryFn: () => cme.stations() });
  const paired = useQuery({ queryKey: ['cme', 'stations', 'this'], queryFn: () => cme.thisStation() });
  const [editing, setEditing] = useState<StationDto | 'new' | null>(null);
  const [editingFlow, setEditingFlow] = useState(false);
  const canConfigure = session.can('cme:stations:configure');
  if (config.isPending || stations.isPending) return <div className="page"><LoadingState /></div>;
  if (config.isError || stations.isError) return <div className="page"><ErrorState onRetry={() => { void config.refetch(); void stations.refetch(); }} /></div>;
  const c = config.data;
  const cols: Column<StationDto>[] = [
    { key: 'name', label: 'Estação', render: (s) => <span><b>{s.name}</b>{s.location ? <span className="ig-small ig-muted"> · {s.location}</span> : null}</span>, value: (s) => s.name },
    { key: 'sector', label: 'Setor', value: (s) => sectorName(org.data, s.sectorId) },
    { key: 'steps', label: 'Etapas', value: (s) => s.steps.map((x) => PROCESS_STEP_LABEL[x]).join(', ') },
    { key: 'methods', label: 'Entrada', value: (s) => s.inputMethods.map((m) => METHOD_SHORT[m]).join(', ') },
    { key: 'codes', label: 'Códigos', value: (s) => s.symbologies.map((x) => SYMBOLOGY_LABEL[x]).join(', ') || '—' },
    { key: 'pairing', label: 'Pareamento', render: (s) => <span className="ig-small">{s.requirePairing ? 'Exigido' : 'Não exigido'} · {s.devices.filter((d) => !d.revoked).length} computador(es)</span> },
    { key: 'status', label: 'Situação', render: (s) => <StatusBadge status={s.enabled ? 'ok' : 'neutral'}>{s.enabled ? 'Habilitada' : 'Desabilitada'}</StatusBadge>, value: (s) => (s.enabled ? 'Habilitada' : 'Desabilitada') },
    { key: 'seen', label: 'Último contato', value: (s) => s.lastSeenAt ?? '', render: (s) => (s.lastSeenAt ? formatDate(s.lastSeenAt, tz) : '—') },
    { key: 'actions', label: 'Ações', render: (s) => (canConfigure ? <Button size="sm" onClick={() => setEditing(s)} aria-label={`Configurar ${s.name}`}>Configurar</Button> : null) },
  ];
  return (
    <div className="page">
      <PageHeader title="Estações e fluxo" subtitle="Pontos de leitura da CME (unidade, setor, localização, etapas, métodos aceitos e pareamento) e as regras institucionais do fluxo."
        actions={canConfigure && !editing ? <Button icon="plus" onClick={() => setEditing('new')}>Nova estação</Button> : null} />
      <CmeNav />
      <Card title="Regras do fluxo" subtitle="Decisões institucionais. Alterações exigem justificativa e ficam no log de auditoria." headingLevel={2}
        actions={canConfigure && !editingFlow ? <Button size="sm" onClick={() => setEditingFlow(true)}>Alterar</Button> : null}>
        {editingFlow ? <FlowForm config={c} onDone={() => setEditingFlow(false)} /> : (
          <dl className="ig-facts">
            <div><dt>Armazenamento</dt><dd>{c.storageRequired ? 'Obrigatório' : 'Opcional'}</dd></div>
            <div><dt>Separação e conferência</dt><dd>{c.separationRequired ? 'Obrigatória' : 'Opcional'}</dd></div>
            <div><dt>Uso sem saída registrada</dt><dd>Não bloqueia: abre não conformidade e notifica quem registrou o uso</dd></div>
            <div><dt>Conferência manual</dt><dd>Sem justificativa; o material segue para a próxima etapa</dd></div>
          </dl>
        )}
      </Card>
      {editing ? <StationForm station={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      <DataTable caption="Estações de leitura" rows={stations.data.stations} rowKey={(s) => s.id} columns={cols} />
      <PairingCard stations={stations.data.stations} paired={paired.data?.station ?? null} canConfigure={canConfigure} />
    </div>
  );
}

function FlowForm({ config, onDone }: { config: FlowConfigDto; onDone: () => void }) {
  const cme = useCme()!;
  const [d, setD] = useState({ ...config, justification: '' });
  const [error, setError] = useState<string | undefined>();
  const m = useCmeMutation(() => cme.saveFlowConfig({ storageRequired: d.storageRequired, separationRequired: d.separationRequired, rowVersion: config.rowVersion, justification: d.justification.trim() }));
  return (
    <form className="ig-form" noValidate onSubmit={(e) => { e.preventDefault(); const j = justificationError(d.justification); setError(j); if (!j) m.mutation.mutate(undefined, { onSuccess: onDone }); }}>
      {m.formError ? <FormMessage tone="error">{m.formError}</FormMessage> : null}
      <label className="inline-check"><input type="checkbox" checked={d.storageRequired} onChange={(e) => setD({ ...d, storageRequired: e.target.checked })} /> Armazenamento obrigatório</label>
      <label className="inline-check"><input type="checkbox" checked={d.separationRequired} onChange={(e) => setD({ ...d, separationRequired: e.target.checked })} /> Separação e conferência obrigatórias</label>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={error} />
      <div className="ig-form-actions"><Button type="submit" variant="primary" disabled={m.mutation.isPending}>Salvar</Button><Button onClick={onDone}>Cancelar</Button></div>
    </form>
  );
}

function StationForm({ station, onDone }: { station: StationDto | null; onDone: () => void }) {
  const cme = useCme()!;
  const org = useOrg();
  const sectors = org.data?.sectors.filter((s) => s.active) ?? [];
  const [d, setD] = useState({
    sectorId: station?.sectorId ?? sectors.find((s) => s.kind === 'cme')?.id ?? '', name: station?.name ?? '', location: station?.location ?? '', steps: station?.steps ?? ([] as ProcessStep[]),
    inputMethods: station?.inputMethods ?? (['leitor', 'manual'] as InputMethod[]), symbologies: station?.symbologies ?? (['code128'] as Symbology[]), deviceLabel: station?.deviceLabel ?? '',
    requirePairing: station?.requirePairing ?? true, scanConfig: station?.scanConfig ?? DEFAULT_SCAN_CONFIG, enabled: station?.enabled ?? true, justification: '',
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useCmeMutation(() => cme.saveStation(station?.id ?? null, {
    sectorId: d.sectorId, name: d.name.trim(), location: d.location.trim() || null, steps: d.steps, inputMethods: d.inputMethods, symbologies: d.symbologies, deviceLabel: d.deviceLabel.trim() || null,
    responsibleUserId: station?.responsibleUserId ?? null, requirePairing: d.requirePairing, scanConfig: d.scanConfig, enabled: d.enabled, rowVersion: station?.rowVersion ?? null, justification: d.justification.trim(),
  }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const submit = () => {
    const e = {
      name: d.name.trim() ? undefined : 'Informe o nome.',
      steps: d.steps.length ? undefined : 'Escolha ao menos uma etapa.',
      inputMethods: d.inputMethods.length ? undefined : 'Escolha ao menos um método de entrada.',
      symbologies: d.inputMethods.some((x) => x !== 'manual') && !d.symbologies.length ? 'Escolha a simbologia do leitor.' : undefined,
      justification: justificationError(d.justification),
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title={station ? `Configurar ${station.name}` : 'Nova estação'} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar">
      <div className="ig-form-row">
        <Field label="Nome" required error={err('name')}><input value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <Field label="Setor" required error={err('sectorId')}><select value={d.sectorId} onChange={(e) => setD({ ...d, sectorId: e.target.value })}>{sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Localização"><input value={d.location} maxLength={120} onChange={(e) => setD({ ...d, location: e.target.value })} /></Field>
      </div>
      <fieldset className="cme-items"><legend>Etapas registradas aqui</legend>
        <div className="check-grid">{SCANNABLE_STEPS.map((s) => <label key={s}><input type="checkbox" checked={d.steps.includes(s)} onChange={() => setD({ ...d, steps: toggle(d.steps, s) })} />{PROCESS_STEP_LABEL[s]}</label>)}</div>
        {err('steps') ? <FormMessage tone="error">{err('steps')}</FormMessage> : null}
      </fieldset>
      <div className="ig-form-row">
        <fieldset className="cme-items"><legend>Métodos de entrada</legend>
          {(Object.keys(INPUT_METHOD_LABEL) as InputMethod[]).map((x) => <label key={x} className="inline-check"><input type="checkbox" checked={d.inputMethods.includes(x)} onChange={() => setD({ ...d, inputMethods: toggle(d.inputMethods, x) })} /> {INPUT_METHOD_LABEL[x]}</label>)}
          {err('inputMethods') ? <FormMessage tone="error">{err('inputMethods')}</FormMessage> : null}
        </fieldset>
        <fieldset className="cme-items"><legend>Códigos aceitos</legend>
          {(['code128', 'code39'] as Symbology[]).map((x) => <label key={x} className="inline-check"><input type="checkbox" checked={d.symbologies.includes(x)} onChange={() => setD({ ...d, symbologies: toggle(d.symbologies, x) })} /> {SYMBOLOGY_LABEL[x]}{x === 'code39' ? ' (legado)' : ''}</label>)}
          {err('symbologies') ? <FormMessage tone="error">{err('symbologies')}</FormMessage> : null}
        </fieldset>
      </div>
      <div className="ig-form-row">
        <Field label="Identificação do leitor ou do computador" hint="Opcional: nem todo leitor tem número de série."><input value={d.deviceLabel} maxLength={80} onChange={(e) => setD({ ...d, deviceLabel: e.target.value })} /></Field>
        <Field label="Intervalo máximo entre teclas do leitor (ms)" hint="Abaixo dele, a entrada é tratada como leitura."><input inputMode="numeric" value={d.scanConfig.maxKeyIntervalMs} onChange={(e) => setD({ ...d, scanConfig: { ...d.scanConfig, maxKeyIntervalMs: Number(e.target.value) || 0 } })} /></Field>
        <Field label="Final da leitura"><select value={d.scanConfig.terminator} onChange={(e) => setD({ ...d, scanConfig: { ...d.scanConfig, terminator: e.target.value as 'enter' } })}><option value="enter">Enter</option><option value="tab">Tab</option><option value="nenhum">Sem terminador</option></select></Field>
      </div>
      <label className="inline-check"><input type="checkbox" checked={d.requirePairing} onChange={(e) => setD({ ...d, requirePairing: e.target.checked })} /> Exigir computador pareado</label>
      <label className="inline-check"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> Habilitada</label>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={err('justification') ?? undefined} />
    </FormCard>
  );
}

function PairingCard({ stations, paired, canConfigure }: { stations: StationDto[]; paired: StationDto | null; canConfigure: boolean }) {
  const cme = useCme()!;
  const client = useQueryClient();
  const tz = useTimeZone();
  const [stationId, setStationId] = useState('');
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const pair = async () => {
    if (!stationId || label.trim().length < 2) { setMessage({ tone: 'error', text: 'Escolha a estação e identifique este computador.' }); return; }
    try {
      await cme.pairStation(stationId, label.trim());
      await client.invalidateQueries({ queryKey: ['cme'] });
      setMessage({ tone: 'success', text: 'Computador pareado. As leituras feitas aqui passam a identificar este computador.' });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof ApiError ? e.message : 'Não foi possível parear.' });
    }
  };
  const revoke = async (id: string) => {
    await cme.revokeDevice(id);
    await client.invalidateQueries({ queryKey: ['cme'] });
  };
  const devices = stations.flatMap((s) => s.devices.map((d) => ({ ...d, station: s.name })));
  return (
    <Card title="Pareamento de computadores" subtitle="O servidor identifica a estação de cada leitura pelo computador pareado (credencial guardada em cookie protegido)." headingLevel={2}>
      <p style={{ marginTop: 0 }}>{paired ? <>Este computador está pareado com <b>{paired.name}</b>.</> : 'Este computador não está pareado.'}</p>
      {canConfigure ? (
        <div className="ig-row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Estação"><select value={stationId} onChange={(e) => setStationId(e.target.value)}><option value="">Selecione</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Identificação deste computador"><input value={label} maxLength={80} placeholder="Ex.: PC expurgo 1" onChange={(e) => setLabel(e.target.value)} /></Field>
          <Button variant="primary" onClick={() => void pair()}>Parear este computador</Button>
        </div>
      ) : <AlertBanner tone="info">O pareamento é feito por quem configura as estações.</AlertBanner>}
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      {devices.length === 0 ? <p className="ig-small ig-muted" style={{ marginBottom: 0 }}>Nenhum computador pareado.</p> : <DataTable caption="Computadores pareados" dense rows={devices} rowKey={(d) => d.id}
        columns={[
          { key: 'station', label: 'Estação' }, { key: 'label', label: 'Computador' }, { key: 'pairedBy', label: 'Pareado por' },
          { key: 'pairedAt', label: 'Em', value: (d) => d.pairedAt, render: (d) => formatDate(d.pairedAt, tz) },
          { key: 'lastSeenAt', label: 'Último contato', value: (d) => d.lastSeenAt ?? '', render: (d) => (d.lastSeenAt ? formatDate(d.lastSeenAt, tz) : '—') },
          { key: 'state', label: 'Situação', render: (d) => (d.revoked ? <StatusBadge status="neutral">Revogado</StatusBadge> : canConfigure ? <Button size="sm" onClick={() => void revoke(d.id)} aria-label={`Revogar ${d.label}`}>Revogar</Button> : <StatusBadge status="ok">Ativo</StatusBadge>) },
        ]} />}
    </Card>
  );
}

/** Short names for the stations table (the form uses the full labels). */
const METHOD_SHORT: Record<InputMethod, string> = { leitor: 'Leitor', camera: 'Câmera', manual: 'Manual' };

/* ---------- Physical assets ---------- */

export function AssetsPage() {
  return <RequireCme title="Materiais rastreáveis"><Assets /></RequireCme>;
}

function Assets() {
  const cme = useCme()!;
  const session = useSession();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<AssetDto[]>([]);
  const list = useQuery({ queryKey: ['cme', 'assets', q], queryFn: () => cme.assets(q.trim() ? { q: q.trim() } : {}) });
  const active = useActiveLabels('ativo');
  const [printing, setPrinting] = useState<LabelTarget[] | null>(null);
  const canPrint = session.can('cme:scan', 'cme:cycle:record') && session.writable;
  const cols: Column<AssetDto>[] = [
    { key: 'code', label: 'Código', render: (a) => <span className="ig-mono">{a.code}</span> },
    { key: 'set', label: 'Caixa', value: (a) => a.setName },
    { key: 'tag', label: 'Identificação física', value: (a) => a.tag ?? '—' },
    { key: 'status', label: 'Situação', render: (a) => <StatusBadge status={a.status === 'ativo' ? 'ok' : a.status === 'manutencao' ? 'warn' : 'neutral'}>{a.status === 'ativo' ? 'Em uso' : a.status === 'manutencao' ? 'Em manutenção' : 'Baixado'}</StatusBadge> },
    { key: 'process', label: 'Processo atual', value: (a) => (a.openProcess ? PROCESS_STEP_LABEL[a.openProcess.step] : '—') },
    { key: 'label', label: 'Etiqueta', render: (a) => (canPrint && a.status !== 'baixado'
      ? <Button size="sm" onClick={() => setPrinting([{ id: a.id, code: a.code, hasActive: active.has(a.id) }])} aria-label={`${active.has(a.id) ? 'Reimprimir' : 'Imprimir'} etiqueta ${a.code}`}>{active.has(a.id) ? 'Reimprimir' : 'Imprimir'}</Button>
      : active.has(a.id) ? 'Em uso' : '—') },
  ];
  return (
    <div className="page">
      <PageHeader title="Materiais rastreáveis" subtitle="Caixas e instrumentais físicos com código permanente (Code 128 com dígito verificador). O código acompanha o material em todas as rodadas de reprocessamento."
        actions={session.can('cme:configure') && !creating ? <Button icon="plus" onClick={() => setCreating(true)}>Cadastrar materiais</Button> : null} />
      <CmeNav />
      {creating ? <AssetForm onDone={(a) => { setCreating(false); setCreated(a); }} /> : null}
      {created.length ? (
        <AlertBanner tone="ok" title={`${created.length} código(s) emitido(s)`} actions={canPrint ? <Button size="sm" icon="printer" onClick={() => setPrinting(created.map((a) => ({ id: a.id, code: a.code, hasActive: false })))}>Imprimir etiquetas</Button> : undefined}>
          {created.map((a) => a.code).join(', ')}. Identifique cada material com a etiqueta do código.
        </AlertBanner>
      ) : null}
      {printing ? <LabelPrintPanel key={printing.map((t) => t.id).join()} entity="ativo" targets={printing} onClose={() => setPrinting(null)} /> : null}
      <div className="field" style={{ maxWidth: 360 }}><label htmlFor="as-q">Código, caixa ou identificação</label><input id="as-q" className="select" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <DataTable caption="Materiais" rows={list.data?.assets ?? []} rowKey={(a) => a.id} columns={cols} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'} pageSize={25} />
    </div>
  );
}

function AssetForm({ onDone }: { onDone: (a: AssetDto[]) => void }) {
  const cme = useCme()!;
  const sets = useQuery({ queryKey: ['cme', 'sets'], queryFn: () => cme.sets() });
  const [d, setD] = useState({ setId: '', count: '1', tag: '', justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useCmeMutation(() => cme.createAssets({ setId: d.setId, count: Number(d.count), tag: d.tag.trim() || null, justification: d.justification.trim() }));
  const submit = () => {
    const e = { setId: d.setId ? undefined : 'Escolha a caixa.', count: Number.isInteger(Number(d.count)) && Number(d.count) >= 1 && Number(d.count) <= 50 ? undefined : 'De 1 a 50.', justification: justificationError(d.justification) };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: (r) => onDone(r.assets) });
  };
  return (
    <FormCard title="Cadastrar materiais" subtitle="Um código é emitido para cada unidade física." error={m.formError} onSubmit={submit} onCancel={() => onDone([])} busy={m.mutation.isPending} submitLabel="Emitir códigos">
      <div className="ig-form-row">
        <Field label="Caixa" required error={errors.setId ?? null}><select value={d.setId} onChange={(e) => setD({ ...d, setId: e.target.value })}><option value="">Selecione</option>{sets.data?.sets.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Quantidade" required error={errors.count ?? null}><input inputMode="numeric" value={d.count} onChange={(e) => setD({ ...d, count: e.target.value })} /></Field>
        <Field label="Identificação física (opcional)"><input value={d.tag} maxLength={60} onChange={(e) => setD({ ...d, tag: e.target.value })} /></Field>
      </div>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={errors.justification} />
    </FormCard>
  );
}
