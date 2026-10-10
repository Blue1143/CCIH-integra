import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { EQUIPMENT_STATUS_LABEL, LOAD_STATUS_LABEL, PACKAGING_LABEL, formatDate, type LoadStatus, type LoadSummary, type PackagingType } from '@ccih/domain';
import { Button, DataTable, ErrorState, Field, FormMessage, LoadingState, StatusBadge, type Column } from '@ccih/ui';
import { NcCreateForm } from '../operations/AuditsPages';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, Pager, localToIso, nowLocal, useTimeZone } from '../clinical/shared';
import { useUrlFilters } from '../operations/shared';
import { CmeNav, LoadStatusBadge, RequireCme, TestResultBadge, useCme, useCmeMutation } from './shared';

export function CmePage() {
  return <RequireCme title="CME"><Cme /></RequireCme>;
}

function Cme() {
  const cme = useCme()!;
  const session = useSession();
  const tz = useTimeZone();
  const [params] = useSearchParams();
  const reprocess = params.get('reprocessar');
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const [creating, setCreating] = useState(!!reprocess);
  const f = useUrlFilters({ situacao: 'pendentes' });
  const overview = useQuery({ queryKey: ['cme', 'overview'], queryFn: () => cme.overview() });
  const query = { status: f.get('situacao') === 'todas' ? undefined : f.get('situacao'), sterilizerId: f.get('equipamento') || undefined, from: f.get('de') || undefined, to: f.get('ate') || undefined, q: f.get('codigo') || undefined, page: f.page, pageSize: 25 };
  const list = useQuery({ queryKey: ['cme', 'loads', query], queryFn: () => cme.loads(query), placeholderData: (p) => p });
  const [code, setCode] = useState(f.get('codigo'));
  const o = overview.data;

  const cols: Column<LoadSummary>[] = [
    { key: 'code', label: 'Carga', render: (l) => <span><Link to={`/cme/cargas/${l.id}`} className="ig-mono">{l.code}</Link> <DemoTag origin={l.origin} /></span>, value: (l) => l.code },
    { key: 'sterilizer', label: 'Equipamento', value: (l) => l.sterilizerName },
    { key: 'startedAt', label: 'Início do ciclo', value: (l) => l.startedAt, render: (l) => formatDate(l.startedAt, tz) },
    { key: 'physical', label: 'Registro físico', render: (l) => (l.physical ? <TestResultBadge type="REGISTRO_FISICO" result={l.physical === 'conforme' ? 'aprovado' : 'reprovado'} /> : <span className="ig-muted">Ciclo em andamento</span>) },
    { key: 'items', label: 'Pacotes', align: 'right', render: (l) => `${l.items}${l.used ? ` (${l.used} usados)` : ''}${l.hasImplant ? ' · implantável' : ''}` },
    { key: 'status', label: 'Situação', render: (l) => <LoadStatusBadge status={l.status} />, value: (l) => LOAD_STATUS_LABEL[l.status] },
    { key: 'suggestion', label: 'Pela política', render: (l) => (l.status === 'aguardando' || l.status === 'retida' || l.suggestion !== l.status ? <span className="ig-small">{LOAD_STATUS_LABEL[l.suggestion]}</span> : <span className="ig-muted">—</span>) },
  ];

  return (
    <div className="page">
      <PageHeader title="CME" subtitle="Ciclos de esterilização, testes (Bowie-Dick, indicadores químicos e biológicos) e liberação de cargas pela política institucional. Toda decisão fica no histórico da carga, que não pode ser alterado."
        actions={<>
          {session.can('nc:record') && !reporting ? <Button onClick={() => { setReporting(true); setReported(false); }}>Registrar não conformidade</Button> : null}
          {session.can('cme:cycle:record') && !creating ? <Button icon="plus" variant="primary" onClick={() => setCreating(true)}>Nova carga</Button> : null}
        </>} />
      <CmeNav />
      {reported ? <FormMessage tone="success">Não conformidade registrada. A Qualidade faz o tratamento e o encerramento.</FormMessage> : null}
      {reporting ? <NcCreateForm auditId={null} sectorId={null} origin="cme" onDone={(id) => { setReporting(false); setReported(!!id); }} /> : null}
      {creating ? <NewLoadForm reprocessId={reprocess} onDone={() => setCreating(false)} /> : null}
      {overview.isError ? <ErrorState onRetry={() => void overview.refetch()} /> : null}
      {o ? (
        <>
          <dl className="cme-stats" aria-label="Situação da CME">
            <div><dt>Aguardando decisão</dt><dd className="ig-num">{o.awaiting}</dd></div>
            <div><dt>Retidas</dt><dd className="ig-num">{o.retained}</dd></div>
            <div><dt>Liberadas hoje</dt><dd className="ig-num">{o.releasedToday}</dd></div>
            <div><dt>Indicadores biológicos em incubação</dt><dd className="ig-num">{o.ibPending}</dd></div>
            <div><dt>Recolhimentos (30 dias)</dt><dd className="ig-num">{o.recalled30d}</dd></div>
          </dl>
          <ul className="cme-equipment" aria-label="Equipamentos">
            {o.sterilizers.map((s) => (
              <li key={s.id}>
                <b>{s.name}</b>
                <span className="ig-row" style={{ gap: 6 }}>
                  <StatusBadge status={s.status === 'ativo' ? 'ok' : s.status === 'manutencao' ? 'crit' : 'neutral'}>{EQUIPMENT_STATUS_LABEL[s.status]}</StatusBadge>
                  {s.bowieDickApplies ? (s.todayBowieDick ? <TestResultBadge type="BOWIE_DICK" result={s.todayBowieDick} /> : <StatusBadge status="warn">Bowie-Dick de hoje não registrado</StatusBadge>) : <span className="ig-small ig-muted">Bowie-Dick não se aplica</span>}
                </span>
                <span className="ig-small ig-muted">{s.loadsToday} carga(s) hoje</span>
              </li>
            ))}
          </ul>
        </>
      ) : overview.isPending ? <LoadingState /> : null}
      <form className="filters" role="search" onSubmit={(e) => { e.preventDefault(); f.set('codigo', code.trim().toUpperCase()); }}>
        <div className="field">
          <label htmlFor="cme-sit">Situação</label>
          <select id="cme-sit" className="select" value={f.get('situacao')} onChange={(e) => f.set('situacao', e.target.value)}>
            <option value="pendentes">Aguardando ou retidas</option>
            <option value="todas">Todas</option>
            {(Object.keys(LOAD_STATUS_LABEL) as LoadStatus[]).map((s) => <option key={s} value={s}>{LOAD_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cme-eq">Equipamento</label>
          <select id="cme-eq" className="select" value={f.get('equipamento')} onChange={(e) => f.set('equipamento', e.target.value)}>
            <option value="">Todos</option>
            {o?.sterilizers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="cme-de">De</label><input id="cme-de" type="date" className="select" value={f.get('de')} onChange={(e) => f.set('de', e.target.value)} /></div>
        <div className="field"><label htmlFor="cme-ate">Até</label><input id="cme-ate" type="date" className="select" value={f.get('ate')} onChange={(e) => f.set('ate', e.target.value)} /></div>
        <div className="field"><label htmlFor="cme-cod">Código da carga</label><input id="cme-cod" className="select" value={code} onChange={(e) => setCode(e.target.value)} placeholder="AV1-261009" /></div>
        <Button type="submit" icon="search">Buscar</Button>
      </form>
      <DataTable caption="Cargas" rows={list.data?.rows ?? []} rowKey={(l) => l.id} columns={cols} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'} pageSize={100}
        emptyMessage="Nenhuma carga com estes filtros." />
      {list.data ? <Pager page={f.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => f.set('pagina', String(p))} /> : null}
    </div>
  );
}

interface ItemRow { setId: string; description: string; quantity: string; packaging: PackagingType | ''; implant: boolean }
const emptyItem = (): ItemRow => ({ setId: '', description: '', quantity: '1', packaging: '', implant: false });

function NewLoadForm({ reprocessId, onDone }: { reprocessId: string | null; onDone: () => void }) {
  const cme = useCme()!;
  const tz = useTimeZone();
  const navigate = useNavigate();
  const sterilizers = useQuery({ queryKey: ['cme', 'sterilizers'], queryFn: () => cme.sterilizers() });
  const sets = useQuery({ queryKey: ['cme', 'sets'], queryFn: () => cme.sets() });
  const source = useQuery({ queryKey: ['cme', 'load', reprocessId], enabled: !!reprocessId, queryFn: () => cme.load(reprocessId!) });
  const [d, setD] = useState({ sterilizerId: '', program: '', startedAt: nowLocal(tz), notes: '' });
  const [items, setItems] = useState<ItemRow[]>([emptyItem()]);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    if (!source.data) return;
    setD((x) => ({ ...x, sterilizerId: source.data.sterilizerId, program: source.data.program }));
    setItems(source.data.itemList.map((i) => ({ setId: i.setId ?? '', description: i.setId ? '' : i.description, quantity: String(i.quantity), packaging: i.setId ? '' : i.packaging, implant: i.implant })));
  }, [source.data]);
  const m = useCmeMutation(() => cme.createLoad({
    sterilizerId: d.sterilizerId, program: d.program.trim(), startedAt: localToIso(d.startedAt, tz)!, notes: d.notes.trim() || null, reprocessedFromId: reprocessId,
    items: items.map((i) => ({ setId: i.setId || null, description: i.setId ? null : i.description.trim(), quantity: Number(i.quantity), packaging: i.setId ? null : (i.packaging || null), implant: i.setId ? null : i.implant })),
  }));
  const active = sterilizers.data?.sterilizers.filter((s) => s.status === 'ativo') ?? [];
  const submit = () => {
    const e: Record<string, string | undefined> = {
      sterilizerId: d.sterilizerId ? undefined : 'Escolha o equipamento.',
      program: d.program.trim() ? undefined : 'Informe o programa do ciclo.',
      startedAt: d.startedAt ? undefined : 'Informe o início do ciclo.',
    };
    items.forEach((i, idx) => {
      if (!i.setId && !i.description.trim()) e[`items.${idx}.description`] = 'Escolha uma caixa ou descreva o material.';
      if (!i.setId && !i.packaging) e[`items.${idx}.packaging`] = 'Informe a embalagem.';
      if (!(Number.isInteger(Number(i.quantity)) && Number(i.quantity) > 0)) e[`items.${idx}.quantity`] = 'Quantidade inteira.';
    });
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: (r) => { onDone(); navigate(`/cme/cargas/${r.id}`); } });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const setItem = (idx: number, patch: Partial<ItemRow>) => setItems(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  return (
    <FormCard title={reprocessId ? `Reprocessar carga ${source.data?.code ?? ''}` : 'Nova carga'} subtitle="O código da carga e as etiquetas dos pacotes são gerados na gravação. A validade da esterilização segue o parâmetro institucional."
      error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Registrar carga">
      <div className="ig-form-row">
        <Field label="Equipamento" required error={err('sterilizerId')} hint={sterilizers.data && active.length < sterilizers.data.sterilizers.length ? 'Equipamentos em manutenção ou inativos não aparecem.' : undefined}>
          <select value={d.sterilizerId} onChange={(e) => setD({ ...d, sterilizerId: e.target.value })}><option value="">Selecione</option>{active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </Field>
        <Field label="Programa" required error={err('program')}><input value={d.program} maxLength={80} placeholder="Instrumental 134 °C" onChange={(e) => setD({ ...d, program: e.target.value })} /></Field>
        <Field label="Início do ciclo" required error={err('startedAt')}><input type="datetime-local" value={d.startedAt} max={nowLocal(tz)} onChange={(e) => setD({ ...d, startedAt: e.target.value })} /></Field>
      </div>
      <fieldset className="cme-items">
        <legend>Pacotes da carga</legend>
        {items.map((it, idx) => (
          <div key={idx} className="ig-form-row cme-item-row">
            <Field label={`Pacote ${idx + 1}: caixa`} error={err(`items.${idx}.setId`)}>
              <select value={it.setId} onChange={(e) => setItem(idx, { setId: e.target.value })}><option value="">Material avulso</option>{sets.data?.sets.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}{s.implant ? ' (implantável)' : ''}</option>)}</select>
            </Field>
            {!it.setId ? (
              <>
                <Field label="Descrição" required error={err(`items.${idx}.description`)}><input value={it.description} maxLength={200} onChange={(e) => setItem(idx, { description: e.target.value })} /></Field>
                <Field label="Embalagem" required error={err(`items.${idx}.packaging`)}>
                  <select value={it.packaging} onChange={(e) => setItem(idx, { packaging: e.target.value as PackagingType })}><option value="">Selecione</option>{Object.entries(PACKAGING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </Field>
                <label className="inline-check"><input type="checkbox" checked={it.implant} onChange={(e) => setItem(idx, { implant: e.target.checked })} /> Implantável</label>
              </>
            ) : null}
            <Field label="Qtd." error={err(`items.${idx}.quantity`)}><input inputMode="numeric" value={it.quantity} onChange={(e) => setItem(idx, { quantity: e.target.value })} style={{ maxWidth: 80 }} /></Field>
            {items.length > 1 ? <Button size="sm" onClick={() => setItems(items.filter((_, i) => i !== idx))} aria-label={`Remover pacote ${idx + 1}`}>Remover</Button> : null}
          </div>
        ))}
        {items.length < 60 ? <Button size="sm" icon="plus" onClick={() => setItems([...items, emptyItem()])}>Adicionar pacote</Button> : null}
      </fieldset>
      <Field label="Observações"><textarea value={d.notes} maxLength={1000} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
    </FormCard>
  );
}
