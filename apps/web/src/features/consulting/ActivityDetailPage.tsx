import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ACTIVITY_KIND_LABEL, ACTIVITY_MODE_LABEL, checkOutcome, checkTask, formatDate, todayIn, type ActivityDetailDto } from '@ccih/domain';
import { Button, Card, ErrorState, Field, LoadingState } from '@ccih/ui';
import { useSession } from '../auth/session';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, Timeline, useTimeZone } from '../clinical/shared';
import { ActivityForm, ActivitySituationBadge, TaskDrafts, TasksTable, taskInput, timeRange, type TaskDraft } from './agenda-shared';
import { RequireConsulting, blank, useConsulting, useConsultingMutation } from './shared';

export function ActivityDetailPage() {
  return <RequireConsulting title="Atividade"><ActivityDetail /></RequireConsulting>;
}

type Outcome = 'realizada' | 'nao_realizada' | 'cancelada';

function ActivityDetail() {
  const { id } = useParams();
  const consulting = useConsulting()!;
  const session = useSession();
  const tz = useTimeZone();
  const q = useQuery({ queryKey: ['consulting', 'activity', id], queryFn: () => consulting.activity(id!) });
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  if (q.isPending) return <div className="page"><LoadingState /></div>;
  if (q.isError) return <div className="page"><ErrorState onRetry={() => void q.refetch()} /></div>;
  const a = q.data;
  const open = a.status === 'agendada';
  const started = new Date(a.startsAt).getTime() <= Date.now();
  const canEdit = session.can('consultoria:agenda:edit') && session.writable;
  const canRecord = session.can('consultoria:agenda:record') && session.writable;
  return (
    <div className="page">
      <PageHeader back={{ to: '/consultoria/agenda', label: 'Agenda' }} title={<span>{a.title} <DemoTag origin={a.dataOrigin} /></span>}
        subtitle={<>{ACTIVITY_KIND_LABEL[a.kind]} · {ACTIVITY_MODE_LABEL[a.mode]} · <Link to={`/consultoria/clientes/${a.clientId}`}>{a.clientName}</Link> · {timeRange(a.startsAt, a.endsAt, tz)}</>}
        actions={(
          <span className="ig-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <ActivitySituationBadge situation={a.situation} />
            {open && canEdit && !editing ? <Button onClick={() => setEditing(true)}>Alterar ou remarcar</Button> : null}
            {open && canRecord && started ? <Button onClick={() => setOutcome('realizada')}>Registrar realização</Button> : null}
            {open && canRecord && started ? <Button onClick={() => setOutcome('nao_realizada')}>Não realizada</Button> : null}
            {open && canEdit ? <Button onClick={() => setOutcome('cancelada')}>Cancelar</Button> : null}
          </span>
        )} />
      {open && canRecord && !started ? <p className="ig-small ig-muted" role="note">A realização é registrada a partir do início da atividade.</p> : null}
      {outcome ? <OutcomeForm activity={a} status={outcome} onDone={() => setOutcome(null)} /> : null}
      {editing ? <ActivityForm clientId={a.clientId} activity={a} onDone={() => setEditing(false)} /> : (
        <Card title="Atividade" headingLevel={2}>
          <dl className="ig-facts">
            <div><dt>Quando</dt><dd>{timeRange(a.startsAt, a.endsAt, tz)}</dd></div>
            <div><dt>Onde</dt><dd>{[a.establishmentName, a.location].filter(Boolean).join(' · ') || '—'}</dd></div>
            <div><dt>Responsável</dt><dd>{a.responsible.name}</dd></div>
            <div><dt>Participantes</dt><dd>{a.participants.map((p) => p.name).join(', ') || '—'}</dd></div>
            <div><dt>Serviço do contrato</dt><dd>{a.contractId ? <><Link to={`/consultoria/contratos/${a.contractId}`}>{a.contractCode}</Link> — {a.serviceDescription}</> : '—'}</dd></div>
            <div><dt>Pauta e observações</dt><dd>{a.description ?? '—'}</dd></div>
          </dl>
        </Card>
      )}
      {!open ? (
        <Card title={a.status === 'realizada' ? 'O que foi feito' : a.status === 'cancelada' ? 'Cancelamento' : 'Não realização'} headingLevel={2}>
          <dl className="ig-facts">
            {a.status === 'realizada' ? (
              <>
                <div><dt>Resumo</dt><dd>{a.outcomeSummary}</dd></div>
                {a.outcomeDetail ? <div><dt>Detalhes</dt><dd>{a.outcomeDetail}</dd></div> : null}
                <div><dt>Duração realizada</dt><dd>{Math.floor((a.actualMinutes ?? 0) / 60)}h{String((a.actualMinutes ?? 0) % 60).padStart(2, '0')}</dd></div>
                <div><dt>Entrega no contrato</dt><dd>{a.deliveryId ? <>Registrada em <Link to={`/consultoria/contratos/${a.contractId}`}>{a.contractCode}</Link></> : 'Não registrada'}</dd></div>
              </>
            ) : <div><dt>Motivo</dt><dd>{a.closeReason}</dd></div>}
            <div><dt>Registrado por</dt><dd>{a.recordedBy} em {formatDate(a.recordedAt, tz)}</dd></div>
          </dl>
        </Card>
      ) : null}
      <Card title="Pendências" subtitle="O que a atividade deixou para fazer, com responsável e prazo." headingLevel={2}
        actions={canRecord && a.status !== 'cancelada' && !addingTask ? <Button icon="plus" onClick={() => setAddingTask(true)}>Nova pendência</Button> : null}>
        {addingTask ? <AddTaskForm activity={a} onDone={() => setAddingTask(false)} /> : null}
        <TasksTable tasks={a.tasks} caption="Pendências da atividade" />
      </Card>
      <Card title="Histórico da atividade" subtitle="Agendamento, alterações, remarcações, registro e pendências. Os registros não podem ser alterados." headingLevel={2}>
        <Timeline timeZone={tz} items={a.events.map((e) => ({ id: e.id, at: e.at, tone: 'info' as const, title: e.summary, detail: <>{e.by}{e.detail ? ` · ${e.detail}` : ''}</> }))} />
      </Card>
    </div>
  );
}

function OutcomeForm({ activity, status, onDone }: { activity: ActivityDetailDto; status: Outcome; onDone: () => void }) {
  const consulting = useConsulting()!;
  const session = useSession();
  const tz = useTimeZone();
  const today = todayIn(tz);
  const planned = Math.round((new Date(activity.endsAt).getTime() - new Date(activity.startsAt).getTime()) / 60_000);
  const options = useQuery({ queryKey: ['consulting', 'activity-options', activity.clientId], queryFn: () => consulting.activityOptions(activity.clientId), enabled: status === 'realizada' });
  const canDeliver = !!activity.contractServiceId && session.can('consultoria:contracts:deliveries');
  const [d, setD] = useState({ summary: '', detail: '', hours: String(Math.floor(planned / 60)), minutes: String(planned % 60), reason: '', registerDelivery: canDeliver, tasks: [] as TaskDraft[] });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const actualMinutes = status === 'realizada' ? Number(d.hours || 0) * 60 + Number(d.minutes || 0) : null;
  const input = {
    status, summary: blank(d.summary), detail: blank(d.detail), actualMinutes, reason: blank(d.reason),
    registerDelivery: status === 'realizada' && d.registerDelivery, tasks: status === 'realizada' ? d.tasks.map(taskInput) : [],
  };
  const m = useConsultingMutation(() => consulting.activityOutcome(activity.id, { ...input, rowVersion: activity.rowVersion }));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const submit = () => {
    const e = Object.fromEntries(checkOutcome(input, today).map((p) => [p.path, p.message]));
    setErrors(e);
    if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const title = { realizada: 'Registrar realização', nao_realizada: 'Registrar que não foi realizada', cancelada: 'Cancelar atividade' }[status];
  return (
    <FormCard title={title} subtitle="O registro é definitivo: a atividade não é mais alterada (pendências podem ser acrescentadas depois)." error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel={title}>
      {status === 'realizada' ? (
        <>
          <Field label="Resumo do que foi feito" required error={err('summary')}><textarea value={d.summary} maxLength={1000} onChange={(e) => setD({ ...d, summary: e.target.value })} /></Field>
          <Field label="Detalhes"><textarea value={d.detail} maxLength={8000} onChange={(e) => setD({ ...d, detail: e.target.value })} /></Field>
          <div className="ig-form-row">
            <Field label="Duração realizada — horas" required error={err('actualMinutes')}><input value={d.hours} inputMode="numeric" maxLength={2} onChange={(e) => setD({ ...d, hours: e.target.value })} /></Field>
            <Field label="Minutos"><input value={d.minutes} inputMode="numeric" maxLength={2} onChange={(e) => setD({ ...d, minutes: e.target.value })} /></Field>
          </div>
          {canDeliver ? (
            <div className="ig-checks">
              <label><input type="checkbox" checked={d.registerDelivery} onChange={(e) => setD({ ...d, registerDelivery: e.target.checked })} /> Registrar como entrega de {activity.contractCode} — {activity.serviceDescription}</label>
              {err('registerDelivery') ? <p className="ig-field-error" role="alert">{err('registerDelivery')}</p> : null}
            </div>
          ) : null}
          <TaskDrafts drafts={d.tasks} onChange={(tasks) => setD({ ...d, tasks })} people={options.data?.people ?? []} errors={{ ...m.fieldErrors, ...errors }} today={today} />
        </>
      ) : (
        <Field label="Motivo" required error={err('reason')}><textarea value={d.reason} maxLength={1000} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field>
      )}
    </FormCard>
  );
}

function AddTaskForm({ activity, onDone }: { activity: ActivityDetailDto; onDone: () => void }) {
  const consulting = useConsulting()!;
  const tz = useTimeZone();
  const today = todayIn(tz);
  const options = useQuery({ queryKey: ['consulting', 'activity-options', activity.clientId], queryFn: () => consulting.activityOptions(activity.clientId) });
  const [d, setD] = useState<TaskDraft>({ description: '', ownerId: activity.responsible.userId, dueOn: today });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useConsultingMutation(() => consulting.addTask(activity.id, taskInput(d)));
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title="Nova pendência" error={m.formError} busy={m.mutation.isPending} submitLabel="Registrar pendência" onCancel={onDone}
      onSubmit={() => { const e = Object.fromEntries(checkTask(taskInput(d), today).map((p) => [p.path, p.message])); setErrors(e); if (!Object.keys(e).length) m.mutation.mutate(undefined, { onSuccess: onDone }); }}>
      <div className="ig-form-row">
        <Field label="Pendência" required error={err('description')}><input value={d.description} maxLength={500} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
        <Field label="Responsável" required error={err('ownerId')}>
          <select value={d.ownerId} onChange={(e) => setD({ ...d, ownerId: e.target.value })}><option value="">Selecione</option>{(options.data?.people ?? []).map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</select>
        </Field>
        <Field label="Prazo" required error={err('dueOn')}><input type="date" min={today} value={d.dueOn} onChange={(e) => setD({ ...d, dueOn: e.target.value })} /></Field>
      </div>
    </FormCard>
  );
}
