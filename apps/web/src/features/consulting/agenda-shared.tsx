import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ACTIVITY_KIND_LABEL, ACTIVITY_MODE_LABEL, ACTIVITY_SITUATION_LABEL, TASK_STATUS_LABEL, addDays, checkActivity, checkTask, formatDate, todayIn, toLocalInput,
  type ActivityDetailDto, type ActivityKind, type ActivityMode, type ActivitySituation, type Status, type TaskDto,
} from '@ccih/domain';
import { Button, DataTable, Field, StatusBadge, type Column } from '@ccih/ui';
import { ApiError } from '../../data/api/http';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { localToIso, useTimeZone } from '../clinical/shared';
import { blank, useConsulting, useConsultingMutation } from './shared';

export const ACTIVITY_TONE: Record<ActivitySituation, Status> = { agendada: 'info', realizada: 'ok', nao_realizada: 'warn', cancelada: 'neutral', sem_registro: 'crit' };
export function ActivitySituationBadge({ situation }: { situation: ActivitySituation }) {
  return <StatusBadge status={ACTIVITY_TONE[situation]}>{ACTIVITY_SITUATION_LABEL[situation]}</StatusBadge>;
}

/** "18/11/2026 09:00–12:00" in the institution zone. */
export function timeRange(startsAt: string, endsAt: string, tz: string) {
  const s = formatDate(startsAt, tz);
  const e = formatDate(endsAt, tz);
  return s.slice(0, 10) === e.slice(0, 10) ? `${s}–${e.slice(11)}` : `${s} a ${e}`;
}

/* ---------- Activity form (new or change of a scheduled one) ---------- */

export function ActivityForm({ clientId, activity, onDone }: { clientId: string; activity: ActivityDetailDto | null; onDone: (saved: ActivityDetailDto | null) => void }) {
  const consulting = useConsulting()!;
  const session = useSession();
  const tz = useTimeZone();
  const options = useQuery({ queryKey: ['consulting', 'activity-options', clientId], queryFn: () => consulting.activityOptions(clientId) });
  const tomorrow = addDays(todayIn(tz), 1);
  const [d, setD] = useState({
    kind: activity?.kind ?? ('visita_tecnica' as ActivityKind), mode: activity?.mode ?? ('presencial' as ActivityMode), title: activity?.title ?? '', description: activity?.description ?? '',
    startsAt: activity ? toLocalInput(activity.startsAt, tz) : `${tomorrow}T09:00`, endsAt: activity ? toLocalInput(activity.endsAt, tz) : `${tomorrow}T11:00`,
    location: activity?.location ?? '', establishmentId: activity?.establishmentId ?? '', contractServiceId: activity?.contractServiceId ?? '',
    responsibleId: activity?.responsible.userId ?? session.info?.user.id ?? '', participantIds: activity?.participants.map((p) => p.userId) ?? [], reason: '',
  });
  const [allowOverlap, setAllowOverlap] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const input = {
    kind: d.kind, mode: d.mode, title: d.title.trim(), description: blank(d.description), startsAt: localToIso(d.startsAt, tz) ?? '', endsAt: localToIso(d.endsAt, tz) ?? '',
    location: blank(d.location), establishmentId: d.establishmentId || null, contractServiceId: d.contractServiceId || null, responsibleId: d.responsibleId, participantIds: d.participantIds,
  };
  const moved = !!activity && (input.startsAt !== new Date(activity.startsAt).toISOString() || input.endsAt !== new Date(activity.endsAt).toISOString());
  const m = useConsultingMutation(() => consulting.saveActivity(activity ? null : clientId, activity?.id ?? null, { ...input, allowOverlap, reason: blank(d.reason), rowVersion: activity?.rowVersion ?? null }));
  const conflicts = m.mutation.error instanceof ApiError && m.mutation.error.code === 'conflito_agenda' ? m.mutation.error.fields.map((f) => f.message) : [];
  const err = (k: string) => errors[k] ?? (conflicts.length ? undefined : m.fieldErrors[k]) ?? null;
  const people = options.data?.people ?? [];
  const submit = () => {
    const e: Record<string, string> = Object.fromEntries(checkActivity(input).map((p) => [p.path, p.message]));
    if (moved && d.reason.trim().length < 5) e.reason = 'Informe o motivo da remarcação (mínimo 5 caracteres).';
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: (saved) => onDone(saved) });
  };
  const toggle = (id: string) => setD({ ...d, participantIds: d.participantIds.includes(id) ? d.participantIds.filter((x) => x !== id) : [...d.participantIds, id] });
  return (
    <FormCard title={activity ? 'Alterar atividade' : 'Nova atividade'} subtitle={`Horários no fuso da organização (${tz}). Só a equipe com acesso a este cliente pode participar.`}
      error={conflicts.length ? null : m.formError} onSubmit={submit} onCancel={() => onDone(null)} busy={m.mutation.isPending} submitLabel={activity ? 'Salvar alteração' : 'Agendar'}>
      {conflicts.length ? (
        <div className="ig-form-msg ig-form-msg-error" role="alert">
          <b>Há outra atividade no mesmo horário:</b>
          <ul className="contract-changes">{conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <label><input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} /> Agendar mesmo assim (a sobreposição fica registrada)</label>
        </div>
      ) : null}
      <div className="ig-form-row">
        <Field label="Tipo" required><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as ActivityKind })}>{(Object.keys(ACTIVITY_KIND_LABEL) as ActivityKind[]).map((k) => <option key={k} value={k}>{ACTIVITY_KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Modalidade" required><select value={d.mode} onChange={(e) => setD({ ...d, mode: e.target.value as ActivityMode })}>{(Object.keys(ACTIVITY_MODE_LABEL) as ActivityMode[]).map((k) => <option key={k} value={k}>{ACTIVITY_MODE_LABEL[k]}</option>)}</select></Field>
        <Field label="Assunto" required error={err('title')}><input value={d.title} maxLength={200} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Início" required error={err('startsAt')}><input type="datetime-local" value={d.startsAt} onChange={(e) => setD({ ...d, startsAt: e.target.value })} /></Field>
        <Field label="Término" required error={err('endsAt')}><input type="datetime-local" value={d.endsAt} onChange={(e) => setD({ ...d, endsAt: e.target.value })} /></Field>
        <Field label="Estabelecimento" error={err('establishmentId')}>
          <select value={d.establishmentId} onChange={(e) => setD({ ...d, establishmentId: e.target.value })}><option value="">—</option>{(options.data?.establishments ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        </Field>
        <Field label="Local ou link" hint="Endereço, sala ou link da reunião remota."><input value={d.location} maxLength={300} onChange={(e) => setD({ ...d, location: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Responsável" required error={err('responsibleId')}>
          <select value={d.responsibleId} onChange={(e) => setD({ ...d, responsibleId: e.target.value, participantIds: d.participantIds.filter((p) => p !== e.target.value) })}>
            <option value="">Selecione</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Serviço do contrato" hint="Ao registrar a realização, conta como entrega deste serviço." error={err('contractServiceId')}>
          <select value={d.contractServiceId} onChange={(e) => setD({ ...d, contractServiceId: e.target.value })}>
            <option value="">Nenhum</option>{(options.data?.services ?? []).map((s) => <option key={s.id} value={s.id}>{s.contractCode} — {s.description} ({s.frequency})</option>)}
          </select>
        </Field>
      </div>
      {people.length > 1 ? (
        <fieldset className="ig-fieldset">
          <legend>Participantes da equipe</legend>
          {err('participantIds') ? <p className="ig-field-error" role="alert">{err('participantIds')}</p> : null}
          <div className="ig-checks">{people.filter((p) => p.userId !== d.responsibleId).map((p) => <label key={p.userId}><input type="checkbox" checked={d.participantIds.includes(p.userId)} onChange={() => toggle(p.userId)} /> {p.name}</label>)}</div>
        </fieldset>
      ) : null}
      <Field label="Pauta e observações"><textarea value={d.description} maxLength={4000} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      {moved ? <Field label="Motivo da remarcação" required error={err('reason')}><input value={d.reason} maxLength={500} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field> : null}
    </FormCard>
  );
}

/* ---------- Tasks ---------- */

export function TasksTable({ tasks, caption, withClient = false, withActivity = false }: { tasks: TaskDto[]; caption: string; withClient?: boolean; withActivity?: boolean }) {
  const session = useSession();
  const [closing, setClosing] = useState<TaskDto | null>(null);
  const canClose = (t: TaskDto) => session.writable && t.status === 'aberta' && (t.owner.userId === session.info?.user.id || session.can('consultoria:agenda:record'));
  const cols: Column<TaskDto>[] = [
    { key: 'desc', label: 'Pendência', value: (t) => t.description, render: (t) => <span>{t.description}{t.closedNote ? <><br /><span className="ig-small ig-muted">{t.closedNote} ({t.closedBy})</span></> : null}</span> },
    ...(withClient ? [{ key: 'client', label: 'Cliente', value: (t: TaskDto) => t.clientName, render: (t: TaskDto) => <Link to={`/consultoria/clientes/${t.clientId}`}>{t.clientName}</Link> }] : []),
    ...(withActivity ? [{ key: 'activity', label: 'Atividade', render: (t: TaskDto) => (t.activityId ? <Link to={`/consultoria/agenda/${t.activityId}`}>{t.activityTitle}</Link> : '—') }] : []),
    { key: 'owner', label: 'Responsável', value: (t) => t.owner.name },
    { key: 'due', label: 'Prazo', value: (t) => t.dueOn, render: (t) => <span>{formatDate(t.dueOn)} {t.late ? <StatusBadge status="crit">Atrasada</StatusBadge> : null}</span> },
    { key: 'status', label: 'Situação', render: (t) => <StatusBadge status={t.status === 'aberta' ? 'info' : t.status === 'concluida' ? 'ok' : 'neutral'}>{TASK_STATUS_LABEL[t.status]}</StatusBadge> },
    { key: 'actions', label: 'Ações', render: (t) => (canClose(t) ? <Button size="sm" onClick={() => setClosing(t)} aria-label={`Encerrar pendência ${t.description}`}>Encerrar</Button> : null) },
  ];
  return (
    <>
      {closing ? <CloseTaskForm task={closing} onDone={() => setClosing(null)} /> : null}
      <DataTable caption={caption} dense rows={tasks} rowKey={(t) => t.id} columns={cols} emptyMessage="Nenhuma pendência." />
    </>
  );
}

function CloseTaskForm({ task, onDone }: { task: TaskDto; onDone: () => void }) {
  const consulting = useConsulting()!;
  const [status, setStatus] = useState<'concluida' | 'cancelada'>('concluida');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useConsultingMutation(() => consulting.closeTask(task.id, { status, note: note.trim(), rowVersion: task.rowVersion }));
  return (
    <FormCard title={`Encerrar pendência: ${task.description}`} error={m.formError} busy={m.mutation.isPending} submitLabel="Encerrar pendência" onCancel={onDone}
      onSubmit={() => { if (note.trim().length < 3) { setError('Descreva o que foi feito (mínimo 3 caracteres).'); return; } m.mutation.mutate(undefined, { onSuccess: onDone }); }}>
      <div className="ig-form-row">
        <Field label="Resultado" required><select value={status} onChange={(e) => setStatus(e.target.value as 'concluida' | 'cancelada')}><option value="concluida">Concluída</option><option value="cancelada">Cancelada</option></select></Field>
      </div>
      <Field label={status === 'concluida' ? 'O que foi feito' : 'Motivo do cancelamento'} required error={error ?? m.fieldErrors.note ?? null}><textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormCard>
  );
}

/** Task drafts inside the outcome form. */
export interface TaskDraft { description: string; ownerId: string; dueOn: string }
export function TaskDrafts({ drafts, onChange, people, errors, today }: { drafts: TaskDraft[]; onChange: (d: TaskDraft[]) => void; people: Array<{ userId: string; name: string }>; errors: Record<string, string | undefined>; today: string }) {
  const set = (i: number, patch: Partial<TaskDraft>) => onChange(drafts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <fieldset className="ig-fieldset">
      <legend>Pendências da atividade</legend>
      {drafts.map((t, i) => (
        <div key={i} className="contract-line" role="group" aria-label={`Pendência ${i + 1}`}>
          <div className="ig-form-row">
            <Field label="Pendência" required error={errors[`tasks.${i}.description`] ?? null}><input value={t.description} maxLength={500} onChange={(e) => set(i, { description: e.target.value })} /></Field>
            <Field label="Responsável" required error={errors[`tasks.${i}.ownerId`] ?? null}>
              <select value={t.ownerId} onChange={(e) => set(i, { ownerId: e.target.value })}><option value="">Selecione</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</select>
            </Field>
            <Field label="Prazo" required error={errors[`tasks.${i}.dueOn`] ?? null}><input type="date" min={today} value={t.dueOn} onChange={(e) => set(i, { dueOn: e.target.value })} /></Field>
          </div>
          <Button size="sm" onClick={() => onChange(drafts.filter((_, j) => j !== i))} aria-label={`Remover pendência ${i + 1}`}>Remover</Button>
        </div>
      ))}
      <Button size="sm" icon="plus" onClick={() => onChange([...drafts, { description: '', ownerId: '', dueOn: addDays(today, 7) }])}>Adicionar pendência</Button>
    </fieldset>
  );
}
export const taskInput = (t: TaskDraft) => ({ description: t.description.trim(), ownerId: t.ownerId, dueOn: t.dueOn });
export const checkDrafts = (drafts: TaskDraft[], today: string) => drafts.flatMap((t, i) => checkTask(taskInput(t), today, `tasks.${i}.`));
