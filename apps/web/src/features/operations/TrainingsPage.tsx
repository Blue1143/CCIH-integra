import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TRAINING_STATE_LABEL, formatDate, formatNumber, todayIn, type Status, type TrainingDto, type TrainingState } from '@ccih/domain';
import { Button, Card, DataTable, ErrorState, Field, FormMessage, LoadingState, StatusBadge, SubNav, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { JustificationField, justificationError } from '../admin/shared';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, sectorName, useOrg, useTimeZone } from '../clinical/shared';
import { Attachments } from '../cme/shared';
import { RequireOps, pct, useOps, useOpsMutation, useUrlFilters } from './shared';

const STATE_TONE: Record<TrainingState, Status> = { valido: 'ok', vencendo: 'warn', vencido: 'crit', pendente: 'crit' };

export function TrainingsPage() {
  return <RequireOps title="Treinamentos"><Trainings /></RequireOps>;
}

function Trainings() {
  const f = useUrlFilters({ secao: 'cobertura' });
  const { pathname } = useLocation();
  const sections = [{ key: 'cobertura', label: 'Cobertura' }, { key: 'turmas', label: 'Turmas' }, { key: 'catalogo', label: 'Catálogo' }];
  const section = sections.find((s) => s.key === f.get('secao'))?.key ?? 'cobertura';
  return (
    <div className="page">
      <PageHeader title="Treinamentos" subtitle="Cobertura dos treinamentos obrigatórios por setor e cargo, com validade configurada por treinamento. A cobertura alimenta o indicador de treinamentos na consolidação." />
      <SubNav label="Seções" items={sections.map((s) => ({ ...s, href: `${pathname}?secao=${s.key}`, active: s.key === section }))}
        renderLink={(item, className) => <Link to={item.href} replace className={className} aria-current={item.active ? 'page' : undefined}>{item.label}</Link>} />
      {section === 'cobertura' ? <Coverage /> : section === 'turmas' ? <Sessions /> : <Catalog />}
    </div>
  );
}

function Coverage() {
  const ops = useOps()!;
  const org = useOrg();
  const f = useUrlFilters();
  const data = useQuery({ queryKey: ['trainings', 'coverage'], queryFn: () => ops.trainingCoverage() });
  const trainings = useQuery({ queryKey: ['trainings', 'list'], queryFn: () => ops.trainings() });
  if (data.isPending || trainings.isPending) return <LoadingState />;
  if (data.isError || trainings.isError) return <ErrorState onRetry={() => void data.refetch()} />;
  const title = (id: string) => trainings.data.trainings.find((t) => t.id === id)?.title ?? 'Treinamento';
  const sectorFilter = f.get('setor');
  const stateFilter = f.get('estado') || 'pendencias';
  const rows = data.data.rows.filter((r) => (!sectorFilter || r.sectorId === sectorFilter) && (stateFilter === 'todos' || (stateFilter === 'pendencias' ? r.state !== 'valido' : r.state === stateFilter)));
  const matrix = data.data.bySector.filter((r) => !sectorFilter || r.sectorId === sectorFilter);
  const mandatory = trainings.data.trainings.filter((t) => t.mandatory && t.active);
  return (
    <>
      <div className="filters">
        <div className="field">
          <label htmlFor="t-setor">Setor</label>
          <select id="t-setor" className="select" value={sectorFilter} onChange={(e) => f.set('setor', e.target.value)}>
            <option value="">Todos os meus setores</option>
            {org.data?.sectors.filter((s) => s.kind === 'uti' || s.kind === 'internacao').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="t-estado">Situação</label>
          <select id="t-estado" className="select" value={stateFilter} onChange={(e) => f.set('estado', e.target.value)}>
            <option value="pendencias">Pendências (vencendo, vencido, pendente)</option>
            {Object.entries(TRAINING_STATE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            <option value="todos">Todos</option>
          </select>
        </div>
      </div>
      <div className="ig-table-box">
        <div className="ig-table-head"><h3 className="ig-table-title">Cobertura por setor (treinamentos obrigatórios)</h3></div>
        <div className="ig-table-scroll">
          <table className="ig-table ig-dense">
            <thead><tr><th scope="col">Setor</th>{mandatory.map((t) => <th key={t.id} scope="col" className="ig-r">{t.theme}</th>)}</tr></thead>
            <tbody>
              {[...new Set(matrix.map((m) => m.sectorId))].map((sid) => (
                <tr key={sid}>
                  <th scope="row" style={{ fontWeight: 500 }}>{sectorName(org.data, sid)}</th>
                  {mandatory.map((t) => {
                    const c = matrix.find((m) => m.sectorId === sid && m.trainingId === t.id);
                    const p = c ? pct(c.covered, c.required) : null;
                    return <td key={t.id} className="ig-r ig-num">{p == null ? '—' : `${formatNumber(p)}% (${c!.covered}/${c!.required})`}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <DataTable caption="Profissionais" rows={rows} rowKey={(r) => `${r.professionalId}|${r.trainingId}`} searchable searchPlaceholder="Pesquisar profissional" pageSize={20}
        columns={[
          { key: 'professionalName', label: 'Profissional' },
          { key: 'sector', label: 'Setor', value: (r) => sectorName(org.data, r.sectorId) },
          { key: 'training', label: 'Treinamento', value: (r) => title(r.trainingId) },
          { key: 'state', label: 'Situação', value: (r) => r.state, render: (r) => <StatusBadge status={STATE_TONE[r.state]}>{TRAINING_STATE_LABEL[r.state]}</StatusBadge> },
          { key: 'lastHeldOn', label: 'Último', value: (r) => r.lastHeldOn ?? '', render: (r) => formatDate(r.lastHeldOn) },
          { key: 'expiresOn', label: 'Vence em', value: (r) => r.expiresOn ?? '', render: (r) => (r.expiresOn ? formatDate(r.expiresOn) : r.lastHeldOn ? 'Sem validade' : '—') },
        ]} />
    </>
  );
}

function Sessions() {
  const ops = useOps()!;
  const session = useSession();
  const org = useOrg();
  const data = useQuery({ queryKey: ['trainings', 'list'], queryFn: () => ops.trainings() });
  const [creating, setCreating] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  if (data.isPending) return <LoadingState />;
  if (data.isError) return <ErrorState onRetry={() => void data.refetch()} />;
  const title = (id: string) => data.data.trainings.find((t) => t.id === id)?.title ?? '—';
  return (
    <>
      {saved ? <FormMessage tone="success">{saved}</FormMessage> : null}
      {session.can('quality:training:edit') && !creating ? <div><Button variant="primary" icon="plus" onClick={() => { setCreating(true); setSaved(null); }}>Registrar turma</Button></div> : null}
      {creating ? <SessionForm trainings={data.data.trainings.filter((t) => t.active)} onDone={(msg) => { setCreating(false); if (msg) setSaved(msg); }} /> : null}
      <DataTable caption="Turmas realizadas" rows={data.data.sessions} rowKey={(s) => s.id} pageSize={20}
        columns={[
          { key: 'heldOn', label: 'Data', value: (s) => s.heldOn, render: (s) => formatDate(s.heldOn) },
          { key: 'training', label: 'Treinamento', value: (s) => title(s.trainingId) },
          { key: 'instructor', label: 'Instrutor', render: (s) => <span>{s.instructor} <DemoTag origin={s.origin} /></span>, value: (s) => s.instructor },
          { key: 'hours', label: 'Carga (h)', align: 'right', render: (s) => formatNumber(s.hours, 1) },
          { key: 'sector', label: 'Setor', value: (s) => (s.sectorId ? sectorName(org.data, s.sectorId) : 'Vários') },
          { key: 'attendees', label: 'Presentes', align: 'right' },
          { key: 'files', label: 'Evidências', render: (s) => <Attachments entity="training_session" entityId={s.id} files={s.attachments} canUpload={session.can('quality:training:edit')} refresh={['trainings']} /> },
        ]} />
    </>
  );
}

function SessionForm({ trainings, onDone }: { trainings: TrainingDto[]; onDone: (msg?: string) => void }) {
  const ops = useOps()!;
  const org = useOrg();
  const tz = useTimeZone();
  const staff = useQuery({ queryKey: ['trainings', 'staff'], queryFn: () => ops.staff() });
  const [d, setD] = useState({ trainingId: trainings[0]?.id ?? '', heldOn: todayIn(tz), instructor: '', hours: '2', sectorId: '', notes: '', filterSector: '' });
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const training = trainings.find((t) => t.id === d.trainingId);
  const candidates = useMemo(() => (staff.data?.staff ?? []).filter((p) => p.active && (!d.filterSector || p.sectorId === d.filterSector) && (!training?.targetJobRoleIds.length || (p.jobRoleId && training.targetJobRoleIds.includes(p.jobRoleId)))), [staff.data, d.filterSector, training]);
  const m = useOpsMutation(() => ops.createSession(d.trainingId, { heldOn: d.heldOn, instructor: d.instructor.trim(), hours: Number(d.hours.replace(',', '.')), sectorId: d.sectorId || null, notes: d.notes.trim() || null, attendees: selected.map((professionalId) => ({ professionalId, present: true, score: null })) }));
  const submit = () => {
    const e = { instructor: d.instructor.trim() ? undefined : 'Informe o instrutor.', hours: Number(d.hours.replace(',', '.')) > 0 ? undefined : 'Informe a carga horária.', attendees: selected.length ? undefined : 'Marque ao menos um participante presente.' };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: () => onDone(`Turma registrada com ${selected.length} participante(s).`) });
  };
  return (
    <FormCard title="Registrar turma" subtitle="Registre após a realização. A lista mostra os profissionais do público-alvo do treinamento." error={m.formError} onSubmit={submit} onCancel={() => onDone()} busy={m.mutation.isPending} submitLabel="Registrar turma">
      <div className="ig-form-row">
        <Field label="Treinamento" required><select value={d.trainingId} onChange={(e) => { setD({ ...d, trainingId: e.target.value }); setSelected([]); }}>{trainings.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
        <Field label="Data" required error={m.fieldErrors.heldOn ?? null}><input type="date" value={d.heldOn} max={todayIn(tz)} onChange={(e) => setD({ ...d, heldOn: e.target.value })} /></Field>
        <Field label="Carga horária (h)" required error={errors.hours ?? null}><input inputMode="decimal" value={d.hours} onChange={(e) => setD({ ...d, hours: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Instrutor" required error={errors.instructor ?? null}><input value={d.instructor} maxLength={160} onChange={(e) => setD({ ...d, instructor: e.target.value })} /></Field>
        <Field label="Setor da turma"><select value={d.sectorId} onChange={(e) => setD({ ...d, sectorId: e.target.value })}><option value="">Vários setores</option>{org.data?.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </div>
      <fieldset className="isolate-box">
        <legend>Participantes presentes ({selected.length})</legend>
        <div className="ig-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="ig-small" htmlFor="sess-filter">Filtrar por setor</label>
          <select id="sess-filter" className="select" value={d.filterSector} onChange={(e) => setD({ ...d, filterSector: e.target.value })}><option value="">Todos</option>{org.data?.sectors.filter((s) => s.kind === 'uti' || s.kind === 'internacao').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <Button size="sm" onClick={() => setSelected([...new Set([...selected, ...candidates.map((c) => c.id)])])}>Marcar todos da lista</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Limpar</Button>
        </div>
        {staff.isPending ? <LoadingState /> : (
          <div className="check-grid">
            {candidates.map((p) => (
              <label key={p.id}><input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />{p.name}<span className="ig-small ig-muted">{p.jobRole}</span></label>
            ))}
          </div>
        )}
        {errors.attendees ?? m.fieldErrors.attendees ? <p className="ig-field-error" role="alert">{errors.attendees ?? m.fieldErrors.attendees}</p> : null}
      </fieldset>
      <Field label="Observações"><textarea value={d.notes} maxLength={1000} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
    </FormCard>
  );
}

function Catalog() {
  const ops = useOps()!;
  const session = useSession();
  const data = useQuery({ queryKey: ['trainings', 'list'], queryFn: () => ops.trainings() });
  const staff = useQuery({ queryKey: ['trainings', 'staff'], queryFn: () => ops.staff() });
  const [editing, setEditing] = useState<TrainingDto | 'new' | null>(null);
  if (data.isPending) return <LoadingState />;
  if (data.isError) return <ErrorState onRetry={() => void data.refetch()} />;
  const roleName = (id: string) => staff.data?.jobRoles.find((r) => r.id === id)?.name ?? '—';
  const cols: Column<TrainingDto>[] = [
    { key: 'title', label: 'Treinamento', render: (t) => <span><b>{t.title}</b><br /><span className="ig-small ig-muted">{t.theme}{t.active ? '' : ' · inativo'}</span></span>, value: (t) => t.title },
    { key: 'mandatory', label: 'Obrigatório', value: (t) => (t.mandatory ? 'Sim' : 'Não') },
    { key: 'validity', label: 'Validade', value: (t) => t.validityMonths ?? 0, render: (t) => (t.validityMonths ? `${t.validityMonths} meses` : 'Sem validade') },
    { key: 'audience', label: 'Público-alvo', sortable: false, render: (t) => t.targetJobRoleIds.map(roleName).join(', ') || '—' },
    { key: 'coverage', label: 'Cobertura', align: 'right', value: (t) => pct(t.covered, t.required), render: (t) => (t.required ? `${formatNumber(pct(t.covered, t.required))}% (${t.covered}/${t.required})` : '—') },
    ...(session.can('quality:configure') ? [{ key: 'act', label: 'Ação', sortable: false, exportable: false, render: (t: TrainingDto) => <Button size="sm" onClick={() => setEditing(t)} aria-label={`Editar ${t.title}`}>Editar</Button> } as Column<TrainingDto>] : []),
  ];
  return (
    <>
      {session.can('quality:configure') && !editing ? <div><Button icon="plus" onClick={() => setEditing('new')}>Novo treinamento</Button></div> : null}
      {editing && staff.data ? <TrainingForm training={editing === 'new' ? null : editing} jobRoles={staff.data.jobRoles} onDone={() => setEditing(null)} /> : null}
      <DataTable caption="Catálogo de treinamentos" columns={cols} rows={data.data.trainings} rowKey={(t) => t.id} />
      <Card title="Sobre a validade"><p style={{ margin: 0 }}>Validade e público-alvo são definidos pela instituição. A antecedência do aviso de vencimento é o parâmetro “Alerta de vencimento de treinamento” em Administração › Parâmetros.</p></Card>
    </>
  );
}

function TrainingForm({ training, jobRoles, onDone }: { training: TrainingDto | null; jobRoles: Array<{ id: string; name: string }>; onDone: () => void }) {
  const ops = useOps()!;
  const [d, setD] = useState({ title: training?.title ?? '', theme: training?.theme ?? '', mandatory: training?.mandatory ?? true, validityMonths: training?.validityMonths != null ? String(training.validityMonths) : '12', targetJobRoleIds: training?.targetJobRoleIds ?? [], description: training?.description ?? '', active: training?.active ?? true, justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useOpsMutation(() => ops.saveTraining({ id: training?.id ?? null, title: d.title.trim(), theme: d.theme.trim(), mandatory: d.mandatory, validityMonths: d.validityMonths ? Number(d.validityMonths) : null, targetJobRoleIds: d.targetJobRoleIds, description: d.description.trim() || null, active: d.active, rowVersion: training?.rowVersion ?? null, justification: d.justification.trim() }));
  const submit = () => {
    const v = d.validityMonths ? Number(d.validityMonths) : null;
    const e = {
      title: d.title.trim() ? undefined : 'Informe o título.',
      theme: d.theme.trim() ? undefined : 'Informe o tema.',
      validityMonths: v == null || (Number.isInteger(v) && v >= 1 && v <= 120) ? undefined : 'Informe meses entre 1 e 120, ou deixe vazio.',
      targetJobRoleIds: !d.mandatory || d.targetJobRoleIds.length ? undefined : 'Treinamento obrigatório precisa de público-alvo.',
      justification: justificationError(d.justification),
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title={training ? `Editar ${training.title}` : 'Novo treinamento'} error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar treinamento">
      <div className="ig-form-row">
        <Field label="Título" required error={err('title')}><input value={d.title} maxLength={200} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
        <Field label="Tema" required error={err('theme')}><input value={d.theme} maxLength={120} onChange={(e) => setD({ ...d, theme: e.target.value })} /></Field>
        <Field label="Validade (meses)" hint="Vazio = sem vencimento." error={err('validityMonths')}><input inputMode="numeric" value={d.validityMonths} onChange={(e) => setD({ ...d, validityMonths: e.target.value })} /></Field>
      </div>
      <fieldset className="ig-checks">
        <legend>Público-alvo (cargos)</legend>
        {jobRoles.map((r) => <label key={r.id}><input type="checkbox" checked={d.targetJobRoleIds.includes(r.id)} onChange={(e) => setD({ ...d, targetJobRoleIds: e.target.checked ? [...d.targetJobRoleIds, r.id] : d.targetJobRoleIds.filter((x) => x !== r.id) })} />{r.name}</label>)}
      </fieldset>
      {err('targetJobRoleIds') ? <p className="ig-field-error" role="alert">{err('targetJobRoleIds')}</p> : null}
      <fieldset className="ig-checks">
        <legend className="ig-sr-only">Opções</legend>
        <label><input type="checkbox" checked={d.mandatory} onChange={(e) => setD({ ...d, mandatory: e.target.checked })} /> Obrigatório (entra na cobertura)</label>
        <label><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Ativo</label>
      </fieldset>
      <Field label="Descrição e conteúdo"><textarea value={d.description} maxLength={2000} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={err('justification') ?? undefined} />
    </FormCard>
  );
}
