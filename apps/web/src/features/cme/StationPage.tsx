import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INPUT_METHOD_LABEL, INSPECTION_OUTCOME_LABEL, PACKAGING_LABEL, PROCESS_STATE_LABEL, PROCESS_STEP_LABEL, RETURN_OUTCOME_LABEL, SCAN_RESULT_LABEL, formatDate,
  type InputMethod, type PackagingType, type ProcessStep, type ProcessSummaryDto, type ScanEventDto, type ScanResponse, type ScanResult, type Status, type StationDto,
} from '@ccih/domain';
import { AlertBanner, Button, Card, DataTable, Field, FormMessage, StatusBadge, type Column } from '@ccih/ui';
import { ApiError } from '../../data/api/http';
import type { ScanInput as ScanRequest } from '../../data/port';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { PageHeader, useTimeZone } from '../clinical/shared';
import { CmeNav, RequireCme, useCme, useCmeSectors } from './shared';
import { ScanInput, type CapturedCode } from './scan/ScanInput';

export function StationPage() {
  return <RequireCme title="Estação de leitura"><Station /></RequireCme>;
}

export const RESULT_TONE: Record<ScanResult, Status> = {
  aceita: 'ok', excecao_autorizada: 'warn', duplicada: 'info', requer_conferencia: 'warn', codigo_desconhecido: 'crit', etapa_incorreta: 'crit',
  bloqueado: 'crit', carga_nao_liberada: 'crit', destino_incompativel: 'crit', estacao_invalida: 'crit',
};

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9-]/g, '');

function Station() {
  const cme = useCme()!;
  const session = useSession();
  const sectors = useCmeSectors();
  const tz = useTimeZone();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const stations = useQuery({ queryKey: ['cme', 'stations'], queryFn: () => cme.stations() });
  const paired = useQuery({ queryKey: ['cme', 'stations', 'this'], queryFn: () => cme.thisStation() });
  const usable = (stations.data?.stations ?? []).filter((s) => s.enabled);
  const stationId = params.get('estacao') ?? paired.data?.station?.id ?? '';
  const station = usable.find((s) => s.id === stationId) ?? null;
  const step = (station?.steps.includes(params.get('etapa') as ProcessStep) ? params.get('etapa') : station?.steps[0]) as ProcessStep | undefined;
  // One URL update per change (two consecutive updates would read stale parameters).
  const setParam = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };

  const [outcome, setOutcome] = useState<string>('');
  const [packaging, setPackaging] = useState<PackagingType | ''>('');
  const [destination, setDestination] = useState('');
  const [loadId, setLoadId] = useState(params.get('carga') ?? '');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ response: ScanResponse; code: string; method: InputMethod } | null>(null);
  const [offline, setOffline] = useState<ScanRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOutcome(step === 'inspecao' ? 'aprovado' : step === 'devolucao' ? 'retorno_estoque' : ''); }, [step]);

  const events = useQuery({ queryKey: ['cme', 'scan-events', station?.id], enabled: !!station, queryFn: () => cme.scanEvents({ stationId: station!.id, limit: 20 }) });
  const assembling = useQuery({ queryKey: ['cme', 'loads', 'montagem'], enabled: step === 'esterilizacao', queryFn: () => cme.loads({ status: 'aguardando', pageSize: 100 }) });
  const openLoads = (assembling.data?.rows ?? []).filter((l) => !l.startedAt);
  const destinations = (sectors.data?.sectors ?? []).filter((s) => s.active && s.kind !== 'cme');

  const send = async (req: ScanRequest) => {
    setBusy(true);
    setError(null);
    try {
      const response = await cme.scan(req);
      setOffline(null);
      setLast({ response, code: req.code, method: req.inputMethod });
      if (response.load) setLoadId(response.load.id);
      await Promise.all(['cme', 'alerts'].map((k) => client.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      // No offline queue (institutional decision): the reading is not recorded and the operator is told so.
      if (e instanceof ApiError && e.status === 0) setOffline(req);
      else setError(e instanceof ApiError ? e.message : 'Não foi possível registrar a leitura.');
    } finally {
      setBusy(false);
    }
  };

  const onCode = (c: CapturedCode, override?: { justification: string }) => {
    if (!station || !step) return;
    void send({
      stationId: station.id, code: c.code, inputMethod: c.method, step, clientEventId: newId(), deviceAt: new Date().toISOString(),
      outcome: step === 'inspecao' || step === 'devolucao' ? outcome || null : null, destinationSectorId: step === 'separacao' || step === 'distribuicao' ? destination || null : null,
      originSectorId: null, loadId: step === 'esterilizacao' ? loadId || null : null, packaging: step === 'embalagem' ? packaging || null : null,
      justification: override?.justification ?? null, override: !!override,
    });
  };

  if (stations.isPending) return <div className="page"><PageHeader title="Estação de leitura" /></div>;
  return (
    <div className="page">
      <PageHeader title="Estação de leitura" subtitle="Entrada, processamento e saída do CME por leitura do código de barras. O servidor valida cada leitura; só leituras aceitas movem o material." />
      <CmeNav />
      <div className="filters">
        <div className="field">
          <label htmlFor="st-sel">Estação</label>
          <select id="st-sel" className="select" value={station?.id ?? ''} onChange={(e) => { setParam({ estacao: e.target.value, etapa: '' }); setLast(null); }}>
            <option value="">Selecione</option>
            {usable.map((s) => <option key={s.id} value={s.id}>{s.name}{s.location ? ` — ${s.location}` : ''}</option>)}
          </select>
        </div>
        <p className="ig-small" style={{ margin: 0, alignSelf: 'center' }}>
          {paired.data?.station ? <>Este computador está pareado com <b>{paired.data.station.name}</b>.</> : 'Este computador não está pareado com nenhuma estação.'}
          {station?.requirePairing && paired.data?.station?.id !== station.id ? <span className="ig-muted"> Esta estação exige pareamento.</span> : null}
        </p>
      </div>
      {!station ? <AlertBanner tone="info" title="Escolha a estação">Selecione a estação em que você está. Estações e pareamentos são configurados em “Estações e fluxo”.</AlertBanner> : (
        <>
          <div className="step-tabs" role="group" aria-label="Etapa registrada">
            {station.steps.map((s) => <button key={s} type="button" className="ig-btn" aria-pressed={s === step} onClick={() => setParam({ etapa: s })}>{PROCESS_STEP_LABEL[s]}</button>)}
          </div>
          {step ? (
            <Card title={PROCESS_STEP_LABEL[step]} headingLevel={2}>
              <div className="ig-form-row">
                {step === 'inspecao' ? <Field label="Resultado da inspeção"><select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{Object.entries(INSPECTION_OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field> : null}
                {step === 'devolucao' ? <Field label="Condição do material devolvido"><select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{Object.entries(RETURN_OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field> : null}
                {step === 'embalagem' ? <Field label="Embalagem" hint="Em branco: a embalagem cadastrada na caixa."><select value={packaging} onChange={(e) => setPackaging(e.target.value as PackagingType)}><option value="">Da caixa</option>{Object.entries(PACKAGING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field> : null}
                {step === 'separacao' || step === 'distribuicao' ? (
                  <Field label="Setor de destino" required><select value={destination} onChange={(e) => setDestination(e.target.value)}><option value="">Selecione</option>{destinations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                ) : null}
                {step === 'esterilizacao' ? (
                  <Field label="Carga em montagem" hint="Leia o código da carga ou escolha aqui; depois leia os pacotes.">
                    <select value={loadId} onChange={(e) => setLoadId(e.target.value)}><option value="">Selecione</option>{openLoads.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.sterilizerName} · {l.items} pacote(s)</option>)}</select>
                  </Field>
                ) : null}
              </div>
              {step === 'esterilizacao' && session.can('cme:cycle:record') ? <AssemblyActions loadId={loadId} onCreated={setLoadId} /> : null}
              {station.inputMethods.some((m) => m !== 'manual') ? (
                <ScanInput config={station.scanConfig} allowCamera={station.inputMethods.includes('camera')} busy={busy} onCode={onCode} />
              ) : <AlertBanner tone="info" title="Estação sem leitor">Esta estação usa conferência manual no sistema.</AlertBanner>}
              {offline ? (
                <AlertBanner tone="crit" title="Sem conexão: a leitura NÃO foi registrada" actions={<Button onClick={() => void send(offline)}>Repetir envio</Button>}>
                  Leituras não são guardadas para envio posterior. Repita quando a conexão voltar (o mesmo envio não é registrado duas vezes).
                </AlertBanner>
              ) : null}
              {error ? <FormMessage tone="error">{error}</FormMessage> : null}
              {last ? <ScanResultPanel last={last} tz={tz} stationSteps={station.steps} step={step} onContinue={(s) => setParam({ etapa: s })} onOverride={session.can('cme:override') ? (justification) => onCode({ code: last.code, method: last.method }, { justification }) : undefined} /> : null}
            </Card>
          ) : null}
          {step && station.inputMethods.includes('manual') ? <ManualConference station={station} step={step} busy={busy} onConfirm={(code) => onCode({ code, method: 'manual' })} /> : null}
          {step === 'recepcao' && station.inputMethods.includes('manual') && session.can('cme:scan') ? <LooseReception station={station} onDone={(r) => setLast({ response: r, code: r.process?.code ?? '', method: 'manual' })} /> : null}
          <RecentReadings events={events.data?.events ?? []} state={events.isPending ? 'loading' : events.isError ? 'error' : 'ready'} />
        </>
      )}
    </div>
  );
}

function ScanResultPanel({ last, tz, stationSteps, step, onContinue, onOverride }: {
  last: { response: ScanResponse; code: string }; tz: string; stationSteps: ProcessStep[]; step: ProcessStep | undefined; onContinue: (step: ProcessStep) => void; onOverride?: ((justification: string) => void) | undefined;
}) {
  const { response: r } = last;
  const [justification, setJustification] = useState('');
  const [asking, setAsking] = useState(false);
  const p = r.process;
  const overridable = r.result === 'etapa_incorreta' || r.result === 'destino_incompativel';
  // After a reading or a manual conference the material can go straight on to its next step when this station handles it.
  const continueHere = p && (r.result === 'aceita' || r.result === 'excecao_autorizada') ? p.nextSteps.filter((s) => s !== step && stationSteps.includes(s)) : [];
  useEffect(() => { setAsking(false); setJustification(''); }, [r.eventId]);
  return (
    <div className={`scan-result scan-${RESULT_TONE[r.result]}`} role="status" aria-live="assertive">
      <div className="ig-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <StatusBadge status={RESULT_TONE[r.result]}>{SCAN_RESULT_LABEL[r.result]}</StatusBadge>
        <span className="ig-mono">{last.code}</span>
        {r.replay ? <span className="ig-small ig-muted">(leitura já registrada antes; nada foi repetido)</span> : null}
      </div>
      <p className="scan-message">{r.message}</p>
      {p ? (
        <p className="ig-small" style={{ margin: 0 }}>
          <Link to={`/cme/processos/${p.id}`}>{p.description}</Link> · <span className="ig-mono">{p.code}</span> · {PROCESS_STEP_LABEL[p.currentStep]} · {PROCESS_STATE_LABEL[p.state]}
          {p.packageLabel ? <> · pacote <span className="ig-mono">{p.packageLabel}</span></> : null}
          {p.nextSteps.length ? <> · próxima: {p.nextSteps.map((s) => PROCESS_STEP_LABEL[s]).join(' ou ')}</> : null}
        </p>
      ) : null}
      {continueHere.length ? (
        <div className="ig-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {continueHere.map((s) => <Button key={s} size="sm" variant="primary" onClick={() => onContinue(s)}>Continuar: {PROCESS_STEP_LABEL[s]}</Button>)}
        </div>
      ) : null}
      {r.load ? <p className="ig-small" style={{ margin: 0 }}>Carga <Link to={`/cme/cargas/${r.load.id}`} className="ig-mono">{r.load.code}</Link>: {r.load.packages} pacote(s).</p> : null}
      {overridable && onOverride ? (
        asking ? (
          <form className="ig-row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (justification.trim().length >= 10) onOverride(justification.trim()); }}>
            <Field label="Justificativa da exceção" required hint="Fica no evento e no log de auditoria; gera alerta."><input value={justification} maxLength={500} onChange={(e) => setJustification(e.target.value)} /></Field>
            <Button type="submit" disabled={justification.trim().length < 10}>Autorizar exceção</Button>
          </form>
        ) : <Button size="sm" onClick={() => setAsking(true)}>Autorizar exceção de sequência…</Button>
      ) : null}
      <span className="ig-small ig-muted">Registrado em {formatDate(new Date().toISOString(), tz)}.</span>
    </div>
  );
}

function AssemblyActions({ loadId, onCreated }: { loadId: string; onCreated: (id: string) => void }) {
  const cme = useCme()!;
  const client = useQueryClient();
  const sterilizers = useQuery({ queryKey: ['cme', 'sterilizers'], queryFn: () => cme.sterilizers() });
  const [open, setOpen] = useState(false);
  const [d, setD] = useState({ sterilizerId: '', program: '' });
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    if (!d.sterilizerId || !d.program.trim()) { setError('Escolha o equipamento e o programa.'); return; }
    try {
      const r = await cme.createLoad({ sterilizerId: d.sterilizerId, program: d.program.trim(), startedAt: null, notes: null, reprocessedFromId: null, items: [] });
      await client.invalidateQueries({ queryKey: ['cme'] });
      onCreated(r.id);
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível criar a carga.');
    }
  };
  return (
    <div className="ig-row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      {loadId ? <Link className="ig-btn ig-btn-sm" to={`/cme/cargas/${loadId}`}>Abrir carga (iniciar ciclo)</Link> : null}
      {!open ? <Button size="sm" icon="plus" onClick={() => setOpen(true)}>Nova carga em montagem</Button> : (
        <>
          <select aria-label="Equipamento da nova carga" className="select" value={d.sterilizerId} onChange={(e) => setD({ ...d, sterilizerId: e.target.value })}>
            <option value="">Equipamento</option>{sterilizers.data?.sterilizers.filter((s) => s.status === 'ativo').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input aria-label="Programa da nova carga" className="select" placeholder="Programa" value={d.program} maxLength={80} onChange={(e) => setD({ ...d, program: e.target.value })} />
          <Button size="sm" variant="primary" onClick={() => void create()}>Criar</Button>
          <Button size="sm" onClick={() => setOpen(false)}>Cancelar</Button>
        </>
      )}
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  );
}

/** No reader (or unreadable label): the operator finds the material and confirms it; the server applies the same rules. */
function ManualConference({ station, step, busy, onConfirm }: { station: StationDto; step: ProcessStep; busy: boolean; onConfirm: (code: string) => void }) {
  const cme = useCme()!;
  const [q, setQ] = useState('');
  const query = useMemo(() => (step === 'recepcao' ? null : { aguardando: step, ...(q.trim() ? { q: q.trim() } : {}), pageSize: 25 }), [step, q]);
  const waiting = useQuery({ queryKey: ['cme', 'processes', 'aguardando', station.id, query], enabled: !!query, queryFn: () => cme.processes(query!) });
  const assets = useQuery({ queryKey: ['cme', 'assets', q], enabled: step === 'recepcao' && q.trim().length >= 2, queryFn: () => cme.assets({ q: q.trim() }) });
  const rows: Array<{ id: string; code: string; label: string; detail: string }> = step === 'recepcao'
    ? (assets.data?.assets ?? []).map((a) => ({ id: a.id, code: a.code, label: a.setName, detail: a.openProcess ? `Em processo: ${PROCESS_STEP_LABEL[a.openProcess.step]}` : 'Sem processo aberto' }))
    : (waiting.data?.rows ?? []).map((p: ProcessSummaryDto) => ({ id: p.id, code: p.packageLabel ?? p.code, label: p.description, detail: `${PROCESS_STEP_LABEL[p.currentStep]} · ${PROCESS_STATE_LABEL[p.state]}` }));
  return (
    <Card title="Conferência manual no sistema" subtitle="Para quando não há leitor ou a etiqueta não lê. A confirmação fica registrada como conferência manual." headingLevel={2}>
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="mc-q">{step === 'recepcao' ? 'Procurar material (código ou nome)' : 'Filtrar materiais aguardando esta etapa'}</label>
        <input id="mc-q" className="select" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="manual-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span><b>{r.label}</b> <span className="ig-mono ig-small">{r.code}</span> <span className="ig-small ig-muted">{r.detail}</span></span>
            <Button size="sm" disabled={busy} onClick={() => onConfirm(r.code)} aria-label={`Confirmar ${r.label} ${r.code}`}>Confirmar</Button>
          </li>
        ))}
        {!rows.length ? <li className="ig-muted ig-small">{step === 'recepcao' && q.trim().length < 2 ? 'Digite ao menos 2 caracteres.' : 'Nenhum material aguardando.'}</li> : null}
      </ul>
    </Card>
  );
}

function LooseReception({ station, onDone }: { station: StationDto; onDone: (r: ScanResponse) => void }) {
  const cme = useCme()!;
  const client = useQueryClient();
  const sets = useQuery({ queryKey: ['cme', 'sets'], queryFn: () => cme.sets() });
  const [open, setOpen] = useState(false);
  const [d, setD] = useState({ description: '', setId: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <div><Button onClick={() => setOpen(true)}>Receber material sem etiqueta (avulso)</Button></div>;
  return (
    <FormCard title="Material sem etiqueta" subtitle="O sistema emite um código de processo para identificar o material nas próximas etapas." error={error} busy={busy} submitLabel="Registrar recepção" onCancel={() => setOpen(false)}
      onSubmit={async () => {
        if (!d.setId && !d.description.trim()) { setError('Descreva o material ou escolha a caixa.'); return; }
        setBusy(true);
        try {
          const r = await cme.receiveLoose({ stationId: station.id, description: d.description.trim() || 'Material avulso', setId: d.setId || null, originSectorId: null, clientEventId: newId() });
          await client.invalidateQueries({ queryKey: ['cme'] });
          onDone(r);
          setOpen(false);
          setD({ description: '', setId: '' });
        } catch (e) {
          setError(e instanceof ApiError ? e.message : 'Não foi possível registrar.');
        } finally {
          setBusy(false);
        }
      }}>
      <div className="ig-form-row">
        <Field label="Caixa (se houver)"><select value={d.setId} onChange={(e) => setD({ ...d, setId: e.target.value })}><option value="">Material avulso</option>{sets.data?.sets.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        {!d.setId ? <Field label="Descrição" required><input value={d.description} maxLength={200} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field> : null}
      </div>
    </FormCard>
  );
}

function RecentReadings({ events, state }: { events: ScanEventDto[]; state: 'ready' | 'loading' | 'error' }) {
  const tz = useTimeZone();
  const cols: Column<ScanEventDto>[] = [
    { key: 'serverAt', label: 'Hora (servidor)', value: (e) => e.serverAt, render: (e) => formatDate(e.serverAt, tz) },
    { key: 'code', label: 'Código', render: (e) => <span className="ig-mono scan-code">{e.rawCode}</span> },
    { key: 'step', label: 'Etapa', value: (e) => PROCESS_STEP_LABEL[e.step] },
    { key: 'result', label: 'Resultado', render: (e) => <StatusBadge status={RESULT_TONE[e.result]}>{SCAN_RESULT_LABEL[e.result]}</StatusBadge>, value: (e) => SCAN_RESULT_LABEL[e.result] },
    { key: 'message', label: 'Detalhe', render: (e) => <span className="ig-small">{e.message}</span> },
    { key: 'method', label: 'Entrada', value: (e) => INPUT_METHOD_LABEL[e.inputMethod] },
    { key: 'user', label: 'Usuário', value: (e) => e.userName },
  ];
  return <DataTable caption="Últimas leituras desta estação" dense rows={events} rowKey={(e) => e.id} columns={cols} state={state} emptyMessage="Nenhuma leitura registrada nesta estação." />;
}
