import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LOAD_STATUS_LABEL, formatDate, type TraceRow, type UseRecorded } from '@ccih/domain';
import { AlertBanner, Button, DataTable, Field, TraceTimeline, type Column, type TraceStep } from '@ccih/ui';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { PageHeader, PatientLabel, localToIso, nowLocal, useTimeZone } from '../clinical/shared';
import { useUrlFilters } from '../operations/shared';
import { LoadStatusBadge, RequireCme, cmeSectorName, useCme, useCmeMutation, useCmeSectors } from './shared';

export function TracePage() {
  return <RequireCme title="Rastreabilidade"><Trace /></RequireCme>;
}

function Trace() {
  const cme = useCme()!;
  const session = useSession();
  const tz = useTimeZone();
  const sectors = useCmeSectors();
  const f = useUrlFilters();
  const q = f.get('q');
  const [term, setTerm] = useState(q);
  const [loose, setLoose] = useState(false);
  const [withoutExit, setWithoutExit] = useState(false);
  const result = useQuery({ queryKey: ['cme', 'trace', q], enabled: q.length >= 3, queryFn: () => cme.trace(q) });
  const usage = (r: TraceRow) => {
    if (!r.use) return <span className="ig-muted">Não utilizado</span>;
    const when = formatDate(r.use.usedAt, tz);
    if (r.use.patient && r.use.surgeryId) return <span>{when} · <Link to={`/cirurgias/${r.use.surgeryId}`}>{r.use.procedure}</Link> · <PatientLabel patient={r.use.patient} /></span>;
    if (r.use.procedure) return <span>{when} · {r.use.procedure} <span className="ig-small ig-muted">(paciente visível só para perfis com acesso a pacientes)</span></span>;
    return <span>{when} · {cmeSectorName(sectors.data, r.use.sectorId)} <span className="ig-small ig-muted">(sem paciente vinculado)</span></span>;
  };
  const cols: Column<TraceRow>[] = [
    { key: 'labelCode', label: 'Etiqueta', render: (r) => <span><span className="ig-mono">{r.labelCode}</span>{r.processId ? <> · <Link to={`/cme/processos/${r.processId}`} className="ig-small">trilha</Link></> : null}</span> },
    { key: 'description', label: 'Material', render: (r) => <span>{r.description}{r.implant ? <span className="ig-small"> · implantável</span> : null}</span> },
    { key: 'load', label: 'Carga', render: (r) => <span><Link to={`/cme/cargas/${r.loadId}`} className="ig-mono">{r.loadCode}</Link> <LoadStatusBadge status={r.loadStatus} /></span>, value: (r) => r.loadCode },
    { key: 'cycle', label: 'Ciclo', render: (r) => <span className="ig-small">{r.sterilizerName} · {formatDate(r.cycleStartedAt, tz)}</span> },
    { key: 'expiresOn', label: 'Validade', value: (r) => r.expiresOn ?? '', render: (r) => (r.expiresOn ? formatDate(r.expiresOn) : '—') },
    { key: 'use', label: 'Uso', render: usage },
  ];
  const single = result.data?.rows.length === 1 ? result.data.rows[0]! : null;
  return (
    <div className="page">
      <PageHeader title="Rastreabilidade" subtitle="Do pacote ao ciclo e ao paciente, e do paciente aos pacotes usados. Pesquise pela etiqueta do pacote, pelo código da carga, pelo código da caixa ou pelo prontuário."
        actions={session.can('cme:cycle:record') && !loose ? <Button onClick={() => setLoose(true)}>Registrar uso sem cirurgia</Button> : null} />
      {loose ? <LooseUseForm onDone={(r) => { setLoose(false); setWithoutExit(!!r?.withoutExit); }} /> : null}
      {withoutExit ? <AlertBanner tone="warn" title="Não conformidade aberta">Uso registrado. O pacote não tinha saída registrada do CME: foi aberta uma não conformidade e você recebeu uma notificação.</AlertBanner> : null}
      <form className="filters" role="search" onSubmit={(e) => { e.preventDefault(); f.set('q', term.trim()); }}>
        <div className="field" style={{ flex: '1 1 260px' }}>
          <label htmlFor="trace-q">Etiqueta, carga, caixa ou prontuário</label>
          <input id="trace-q" className="select" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="AV1-261009-01-03" />
        </div>
        <Button type="submit" icon="search">Pesquisar</Button>
      </form>
      {!session.can('patient:view') ? <p className="ig-small ig-muted">Seu perfil não vê pacientes: a pesquisa por prontuário e a identificação do paciente ficam com a CCIH.</p> : null}
      {q.length > 0 && q.length < 3 ? <AlertBanner tone="info">Informe ao menos 3 caracteres.</AlertBanner> : null}
      {result.data?.truncated ? <AlertBanner tone="warn" title="Muitos resultados">Mostrando os 200 mais recentes. Refine a pesquisa.</AlertBanner> : null}
      {single ? (
        <TraceTimeline timeZone={tz} heading={`Pacote ${single.labelCode}`} subtitle={<span>{single.description}</span>} steps={traceSteps(single)} />
      ) : null}
      {q.length >= 3 ? (
        <DataTable caption={`Resultados para “${q}”`} rows={result.data?.rows ?? []} rowKey={(r) => r.itemId} columns={cols} state={result.isPending ? 'loading' : result.isError ? 'error' : 'ready'} pageSize={25}
          emptyMessage="Nada encontrado. Confira o código impresso na etiqueta." />
      ) : null}
    </div>
  );
}

function traceSteps(r: TraceRow): TraceStep[] {
  const released = r.loadStatus === 'liberada';
  return [
    { id: 'ciclo', title: `Ciclo ${r.loadCode}`, ...(r.cycleStartedAt ? { at: r.cycleStartedAt } : {}), detail: r.cycleStartedAt ? r.sterilizerName : `${r.sterilizerName} · carga em montagem`, status: r.cycleStartedAt ? 'ok' : 'neutral' },
    { id: 'liberacao', title: `Carga ${LOAD_STATUS_LABEL[r.loadStatus].toLowerCase()}`, ...(r.statusAt ? { at: r.statusAt } : {}), detail: released ? 'Testes exigidos pela política aprovados' : 'Material não pode ser usado', status: released ? 'ok' : r.loadStatus === 'rejeitada' || r.loadStatus === 'reprocessamento' ? 'crit' : 'warn' },
    { id: 'uso', title: r.use ? (r.use.procedure ?? 'Uso sem cirurgia') : 'Uso', ...(r.use ? { at: r.use.usedAt } : {}), detail: r.use ? `Registrado por ${r.use.recordedBy}` : 'Ainda não utilizado', status: r.use ? 'ok' : 'neutral' },
    { id: 'paciente', title: 'Paciente', ...(r.use ? { at: r.use.usedAt } : {}), detail: r.use?.patient ? `${r.use.patient.initials} · ${r.use.patient.recordNumber}` : r.use?.procedure ? 'Vinculado (visível para perfis com acesso a pacientes)' : r.use ? 'Sem paciente vinculado' : '—', status: r.use?.procedure ? 'ok' : r.use ? 'warn' : 'neutral' },
  ];
}

function LooseUseForm({ onDone }: { onDone: (recorded?: UseRecorded) => void }) {
  const cme = useCme()!;
  const sectors = useCmeSectors();
  const tz = useTimeZone();
  const [d, setD] = useState({ labelCode: '', sectorId: '', usedAt: nowLocal(tz) });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useCmeMutation(() => cme.addLooseUse({ labelCode: d.labelCode.trim().toUpperCase(), sectorId: d.sectorId, usedAt: localToIso(d.usedAt, tz)! }));
  const submit = () => {
    const e = { labelCode: d.labelCode.trim().length >= 3 ? undefined : 'Informe a etiqueta.', sectorId: d.sectorId ? undefined : 'Informe o setor.' };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: (r) => onDone(r) });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title="Registrar uso sem cirurgia" subtitle="Para materiais usados no setor (ex.: kit de curativo). Sem paciente vinculado, o uso conta como lacuna no indicador de rastreabilidade."
      error={m.formError} onSubmit={submit} onCancel={() => onDone()} busy={m.mutation.isPending} submitLabel="Registrar uso">
      <div className="ig-form-row">
        <Field label="Etiqueta do pacote" required error={err('labelCode')}><input value={d.labelCode} maxLength={60} onChange={(e) => setD({ ...d, labelCode: e.target.value })} /></Field>
        <Field label="Setor" required error={err('sectorId')}><select value={d.sectorId} onChange={(e) => setD({ ...d, sectorId: e.target.value })}><option value="">Selecione</option>{sectors.data?.sectors.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Usado em" required error={err('usedAt')}><input type="datetime-local" value={d.usedAt} max={nowLocal(tz)} onChange={(e) => setD({ ...d, usedAt: e.target.value })} /></Field>
      </div>
    </FormCard>
  );
}
