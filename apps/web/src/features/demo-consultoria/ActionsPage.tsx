import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ACTION_PRIORITY_LABEL, ACTION_SITUATION_LABEL, CHECKLIST_ANSWER_LABEL, DEMO_ACTION_STATUSES, DEMO_ACTION_STATUS_LABEL, actionsIn, countByStatus, demoActionStatus, findingById, findingsOf, latestAssessment,
  type ActionPriority, type ActionSituation, type DemoAction, type DemoActionStatus, type DemoConsultingState, type DemoFilter, type Finding,
} from '@ccih/domain';
import { Button, DataTable, Field, FormMessage, StatusBadge, type Column } from '@ccih/ui';
import { useDemoState, useDemoStore } from './store';
import { useDemoFilters } from './filters';
import { ActionStatusBadge, InstitutionLink, SectionCard, demoLink, fmtDay } from './parts';

const PRIORITIES: ActionPriority[] = ['alta', 'media', 'baixa'];
const SITUATIONS: ActionSituation[] = ['pendente', 'em_andamento', 'concluida'];
const PRIORITY_TONE = { alta: 'crit', media: 'warn', baixa: 'neutral' } as const;
const STATUS_PLURAL: Record<DemoActionStatus, string> = { pendente: 'Pendentes', em_andamento: 'Em andamento', atrasada: 'Atrasadas', concluida: 'Concluídas' };

export function DemoActionsPage() {
  const state = useDemoState();
  const [filter] = useDemoFilters(state);
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const status = DEMO_ACTION_STATUSES.find((s) => s === params.get('situacao')) ?? null;
  const newFinding = params.get('nova');
  const all = actionsIn(state, filter);
  const counts = countByStatus(all, state.referenceDate);
  const rows = status ? all.filter((a) => demoActionStatus(a, state.referenceDate) === status) : all;
  const setParam = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

  const cols: Column<DemoAction>[] = [
    { key: 'priority', label: 'Prioridade', value: (a) => ACTION_PRIORITY_LABEL[a.priority], render: (a) => <StatusBadge status={PRIORITY_TONE[a.priority]}>{ACTION_PRIORITY_LABEL[a.priority]}</StatusBadge> },
    { key: 'action', label: 'Ação' },
    { key: 'problem', label: 'Problema identificado' },
    { key: 'finding', label: 'Achado de origem', value: (a) => findingById(state, a.findingId)?.item.text ?? 'Achado não está mais na avaliação',
      render: (a) => {
        const f = findingById(state, a.findingId);
        const [assessmentId] = a.findingId.split(':');
        return (
          <span className="demo-cell">
            <Link to={demoLink('/diagnostico', { ...filter, institutionId: a.institutionId, unitId: null }, { avaliacao: assessmentId! })}>{f ? f.item.text : 'Ver avaliação de origem'}</Link>
            <span className="ig-small ig-muted">{f ? `${CHECKLIST_ANSWER_LABEL[f.answer]} em ${fmtDay(f.assessmentDate)}` : 'O item foi marcado como conforme depois da ação'}</span>
          </span>
        );
      } },
    { key: 'inst', label: 'Instituição', value: (a) => state.institutions.find((i) => i.id === a.institutionId)?.name, render: (a) => <InstitutionLink state={state} f={filter} id={a.institutionId} /> },
    { key: 'responsible', label: 'Responsável (fictício)' },
    { key: 'deadline', label: 'Prazo', value: (a) => a.deadline, render: (a) => fmtDay(a.deadline) },
    { key: 'status', label: 'Situação', value: (a) => DEMO_ACTION_STATUS_LABEL[demoActionStatus(a, state.referenceDate)], render: (a) => <ActionStatusBadge action={a} state={state} /> },
    { key: 'edit', label: 'Editar', exportable: false, render: (a) => <Button size="sm" variant="ghost" onClick={() => { setEditing(a.id); setMessage(null); }} aria-label={`Editar ação: ${a.action}`}>Editar</Button> },
  ];
  const editingAction = state.actions.find((a) => a.id === editing);

  return (
    <>
      <section aria-labelledby="h-sit">
        <h2 id="h-sit" className="section-title">Situação das ações</h2>
        <p className="ig-small ig-muted" style={{ marginTop: 0 }}>“Atrasada” é calculada: ação não concluída com prazo anterior à data de referência da demonstração ({fmtDay(state.referenceDate)}).</p>
        <div className="status-tiles" role="group" aria-label="Filtrar por situação">
          <button type="button" className={status == null ? 'status-tile active' : 'status-tile'} aria-pressed={status == null} onClick={() => setParam('situacao', null)}>
            <span className="ig-label">Todas</span><span className="status-tile-value">{all.length}</span>
          </button>
          {DEMO_ACTION_STATUSES.map((s) => (
            <button key={s} type="button" className={status === s ? 'status-tile active' : 'status-tile'} aria-pressed={status === s} onClick={() => setParam('situacao', s)}>
              <span className="ig-label">{STATUS_PLURAL[s]}</span><span className="status-tile-value">{counts[s]}</span>
            </button>
          ))}
        </div>
      </section>

      {message ? <FormMessage tone="success">{message}</FormMessage> : null}

      {newFinding !== null ? (
        <NewActionForm state={state} filter={filter} initialFinding={newFinding} onDone={(msg) => { setParam('nova', null); if (msg) setMessage(msg); }} />
      ) : (
        <p className="ig-row demo-noprint"><Button variant="primary" icon="plus" onClick={() => { setParam('nova', ''); setMessage(null); }}>Nova ação a partir de um achado</Button></p>
      )}

      {editingAction ? <EditActionForm key={editingAction.id} action={editingAction} onDone={(msg) => { setEditing(null); if (msg) setMessage(msg); }} /> : null}

      <SectionCard title="Planos de ação" subtitle={status ? `Filtrado: ${DEMO_ACTION_STATUS_LABEL[status as DemoActionStatus].toLowerCase()}` : 'Ações ativas no período: criadas até o fim do período e não concluídas antes do início.'}>
        <DataTable caption="Ações" columns={cols} rows={rows} rowKey={(a) => a.id} dense searchable pageSize={10} columnPicker emptyMessage="Nenhuma ação para os filtros." />
      </SectionCard>
    </>
  );
}

function candidateFindings(state: DemoConsultingState, f: DemoFilter, initial: string): Finding[] {
  const insts = f.institutionId ? [f.institutionId] : state.institutions.map((i) => i.id);
  const list = insts.flatMap((id) => { const a = latestAssessment(state, id, f.unitId); return a ? findingsOf(state, a) : []; });
  const extra = initial ? findingById(state, initial) : undefined;
  return extra && !list.some((x) => x.id === extra.id) ? [extra, ...list] : list;
}

function NewActionForm({ state, filter, initialFinding, onDone }: { state: DemoConsultingState; filter: DemoFilter; initialFinding: string; onDone: (msg?: string) => void }) {
  const store = useDemoStore();
  const findings = candidateFindings(state, filter, initialFinding);
  const start = findings.find((x) => x.id === initialFinding);
  const problemOf = (x: Finding | undefined) => (x ? `${x.item.text}${x.observation ? ` — ${x.observation}` : ''}` : '');
  const [draft, setDraft] = useState({ findingId: start?.id ?? '', problem: problemOf(start), action: '', responsible: '', deadline: '', priority: 'media' as ActionPriority });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err: Record<string, string> = {};
    if (!draft.findingId) err.findingId = 'Escolha o achado que originou a ação.';
    if (!draft.problem.trim()) err.problem = 'Descreva o problema identificado.';
    if (!draft.action.trim()) err.action = 'Descreva a ação.';
    if (!draft.responsible.trim()) err.responsible = 'Informe um responsável fictício.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.deadline)) err.deadline = 'Informe o prazo.';
    setErrors(err);
    if (Object.keys(err).length) return;
    const f = findings.find((x) => x.id === draft.findingId)!;
    store.addAction({ institutionId: f.institutionId, unitId: f.unitId, findingId: f.id, problem: draft.problem.trim(), action: draft.action.trim(), responsible: draft.responsible.trim(), deadline: draft.deadline, priority: draft.priority });
    onDone('Ação registrada na demonstração e vinculada ao achado.');
  };

  return (
    <SectionCard title="Nova ação" subtitle="Toda ação nasce de um achado do diagnóstico. Use apenas nomes fictícios.">
      <form className="ig-stack" onSubmit={submit} noValidate>
        <Field label="Achado de origem" required error={errors.findingId ?? null}>
          <select className="select" value={draft.findingId} onChange={(e) => { const x = findings.find((y) => y.id === e.target.value); setDraft((d) => ({ ...d, findingId: e.target.value, problem: problemOf(x) })); }}>
            <option value="">Escolha…</option>
            {findings.map((x) => <option key={x.id} value={x.id}>{state.institutions.find((i) => i.id === x.institutionId)?.name} — {x.item.text} ({CHECKLIST_ANSWER_LABEL[x.answer]})</option>)}
          </select>
        </Field>
        <Field label="Problema identificado" required error={errors.problem ?? null}><textarea rows={2} maxLength={300} value={draft.problem} onChange={set('problem')} /></Field>
        <Field label="Ação" required error={errors.action ?? null}><input maxLength={200} value={draft.action} onChange={set('action')} /></Field>
        <div className="ig-form-row">
          <Field label="Responsável (fictício)" required error={errors.responsible ?? null}><input maxLength={80} value={draft.responsible} onChange={set('responsible')} /></Field>
          <Field label="Prazo" required error={errors.deadline ?? null}><input type="date" value={draft.deadline} onChange={set('deadline')} /></Field>
          <Field label="Prioridade" required><select className="select" value={draft.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{ACTION_PRIORITY_LABEL[p]}</option>)}</select></Field>
        </div>
        <div className="ig-row"><Button type="submit" variant="primary">Registrar ação</Button><Button onClick={() => onDone()}>Cancelar</Button></div>
      </form>
    </SectionCard>
  );
}

function EditActionForm({ action, onDone }: { action: DemoAction; onDone: (msg?: string) => void }) {
  const store = useDemoStore();
  const [draft, setDraft] = useState({ action: action.action, responsible: action.responsible, deadline: action.deadline, priority: action.priority, situation: action.situation });
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const valid = draft.action.trim() && draft.responsible.trim() && /^\d{4}-\d{2}-\d{2}$/.test(draft.deadline);
  return (
    <SectionCard title="Editar ação" subtitle={action.problem}>
      <form className="ig-stack" onSubmit={(e) => { e.preventDefault(); if (!valid) return; store.updateAction(action.id, { ...draft, action: draft.action.trim(), responsible: draft.responsible.trim() }); onDone('Ação atualizada.'); }}>
        <Field label="Ação" required><input maxLength={200} value={draft.action} onChange={set('action')} /></Field>
        <div className="ig-form-row">
          <Field label="Situação" required><select className="select" value={draft.situation} onChange={set('situation')}>{SITUATIONS.map((s) => <option key={s} value={s}>{ACTION_SITUATION_LABEL[s]}</option>)}</select></Field>
          <Field label="Responsável (fictício)" required><input maxLength={80} value={draft.responsible} onChange={set('responsible')} /></Field>
          <Field label="Prazo" required><input type="date" value={draft.deadline} onChange={set('deadline')} /></Field>
          <Field label="Prioridade" required><select className="select" value={draft.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{ACTION_PRIORITY_LABEL[p]}</option>)}</select></Field>
        </div>
        <div className="ig-row"><Button type="submit" variant="primary" disabled={!valid}>Salvar</Button><Button onClick={() => onDone()}>Cancelar</Button></div>
      </form>
    </SectionCard>
  );
}
