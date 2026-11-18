import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ACTIVITY_KIND_LABEL, ACTIVITY_MODE_LABEL, ACTIVITY_SITUATION_LABEL, addDays, formatDate, todayIn, zonedInstant,
  type ActivityKind, type ActivitySituation, type ActivitySummaryDto,
} from '@ccih/domain';
import { Button, Card, EmptyState, ErrorState, Field, LoadingState } from '@ccih/ui';
import { useSession } from '../auth/session';
import { DemoTag, PageHeader, useTimeZone } from '../clinical/shared';
import { useUrlFilters } from '../operations/shared';
import { ActivityForm, ActivitySituationBadge, TasksTable, timeRange } from './agenda-shared';
import { RequireConsulting, useConsulting } from './shared';

export function AgendaPage() {
  return <RequireConsulting title="Agenda"><Agenda /></RequireConsulting>;
}

const WEEKDAY = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const weekday = (iso: string) => WEEKDAY[new Date(`${iso}T12:00:00Z`).getUTCDay()]!;
/** Monday of the week of `iso`. */
const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7));

function Agenda() {
  const consulting = useConsulting()!;
  const session = useSession();
  const tz = useTimeZone();
  const navigate = useNavigate();
  const f = useUrlFilters();
  const today = todayIn(tz);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(f.get('semana')) ? mondayOf(f.get('semana')) : mondayOf(today);
  const days = Number(f.get('dias')) === 28 ? 28 : 7;
  const end = addDays(start, days);
  const [creating, setCreating] = useState(false);
  const canTeam = session.can('consultoria:portfolio:assign', 'consultoria:portfolio:all');
  const team = useQuery({ queryKey: ['consulting', 'team'], queryFn: () => consulting.team(), enabled: canTeam });
  const query = {
    from: zonedInstant(start, 0, tz).toISOString(), to: zonedInstant(end, 0, tz).toISOString(), mine: f.get('minha') === '1' ? '1' : undefined,
    userId: f.get('pessoa') || undefined, kind: f.get('tipo') || undefined, status: f.get('situacao') || undefined, pageSize: 100,
  };
  const list = useQuery({ queryKey: ['consulting', 'activities', query], queryFn: () => consulting.activities(query) });
  const pending = useQuery({ queryKey: ['consulting', 'tasks', { mine: f.get('minha') }], queryFn: () => consulting.tasks({ status: 'aberta', mine: f.get('minha') === '1' ? '1' : undefined, pageSize: 50 }) });
  const late = useQuery({ queryKey: ['consulting', 'activities', 'late'], queryFn: () => consulting.activities({ status: 'sem_registro', pageSize: 50 }) });
  const canEdit = session.can('consultoria:agenda:edit') && session.writable;
  const byDay = new Map<string, ActivitySummaryDto[]>();
  for (const a of list.data?.rows ?? []) {
    const day = formatDate(a.startsAt, tz).slice(0, 10).split('/').reverse().join('-');
    byDay.set(day, [...(byDay.get(day) ?? []), a]);
  }
  return (
    <div className="page">
      <PageHeader title="Agenda" subtitle="Visitas, reuniões, auditorias, inspeções, treinamentos e entregas com os clientes visíveis para você."
        actions={(
          <span className="ig-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <a className="ig-btn" href={consulting.agendaIcsUrl({ mine: true })} download>Exportar minha agenda (.ics)</a>
            {canEdit && !creating ? <Button icon="plus" onClick={() => setCreating(true)}>Nova atividade</Button> : null}
          </span>
        )} />
      {creating ? <NewActivity onDone={(id) => { setCreating(false); if (id) navigate(`/consultoria/agenda/${id}`); }} /> : null}
      {late.data && late.data.total > 0 ? (
        <Card title={`Atividades sem registro (${late.data.total})`} subtitle="Já terminaram e ainda não têm registro de realização, não realização ou cancelamento." headingLevel={2}>
          <ul className="consulting-links">{late.data.rows.map((a) => <li key={a.id}><Link to={`/consultoria/agenda/${a.id}`}>{a.title}</Link> — {a.clientName} · {timeRange(a.startsAt, a.endsAt, tz)} · {a.responsible.name}</li>)}</ul>
        </Card>
      ) : null}
      <div className="filters" role="search">
        <div className="field"><label htmlFor="ag-sem">Semana de</label><input id="ag-sem" type="date" className="select" value={start} onChange={(e) => f.set('semana', e.target.value)} /></div>
        <div className="field"><label htmlFor="ag-dias">Período</label><select id="ag-dias" className="select" value={String(days)} onChange={(e) => f.set('dias', e.target.value)}><option value="7">1 semana</option><option value="28">4 semanas</option></select></div>
        <div className="field"><label htmlFor="ag-tp">Tipo</label><select id="ag-tp" className="select" value={f.get('tipo')} onChange={(e) => f.set('tipo', e.target.value)}><option value="">Todos</option>{(Object.keys(ACTIVITY_KIND_LABEL) as ActivityKind[]).map((k) => <option key={k} value={k}>{ACTIVITY_KIND_LABEL[k]}</option>)}</select></div>
        <div className="field"><label htmlFor="ag-st">Situação</label><select id="ag-st" className="select" value={f.get('situacao')} onChange={(e) => f.set('situacao', e.target.value)}><option value="">Todas</option>{(Object.keys(ACTIVITY_SITUATION_LABEL) as ActivitySituation[]).map((k) => <option key={k} value={k}>{ACTIVITY_SITUATION_LABEL[k]}</option>)}</select></div>
        {team.data ? (
          <div className="field"><label htmlFor="ag-ps">Profissional</label><select id="ag-ps" className="select" value={f.get('pessoa')} onChange={(e) => f.set('pessoa', e.target.value)}><option value="">Toda a equipe</option>{team.data.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></div>
        ) : null}
        <div className="field"><label><input type="checkbox" checked={f.get('minha') === '1'} onChange={(e) => f.set('minha', e.target.checked ? '1' : '')} /> Só a minha agenda</label></div>
      </div>
      <nav className="ig-row" style={{ gap: 8, marginBottom: 12 }} aria-label="Período da agenda">
        <Button size="sm" onClick={() => f.set('semana', addDays(start, -days))}>Anterior</Button>
        <Button size="sm" onClick={() => f.set('semana', today)}>Hoje</Button>
        <Button size="sm" onClick={() => f.set('semana', addDays(start, days))}>Próxima</Button>
        <span className="ig-small ig-muted" aria-live="polite">{formatDate(start)} a {formatDate(addDays(end, -1))}</span>
      </nav>
      {list.isPending ? <LoadingState /> : list.isError ? <ErrorState onRetry={() => void list.refetch()} /> : byDay.size === 0 ? <EmptyState title="Nenhuma atividade neste período." /> : (
        <div className="agenda-days">
          {[...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, items]) => (
            <section key={day} className="agenda-day" aria-label={`${weekday(day)}, ${formatDate(day)}`}>
              <h2 className="agenda-day-title">{weekday(day)}, {formatDate(day)}{day === today ? ' · hoje' : ''}</h2>
              <ul className="agenda-items">
                {items.map((a) => (
                  <li key={a.id} className="agenda-item">
                    <span className="agenda-time ig-mono">{formatDate(a.startsAt, tz).slice(11)}–{formatDate(a.endsAt, tz).slice(11)}</span>
                    <span>
                      <Link to={`/consultoria/agenda/${a.id}`}><b>{a.title}</b></Link> <ActivitySituationBadge situation={a.situation} /> <DemoTag origin={a.dataOrigin} />
                      <br /><span className="ig-small ig-muted">{ACTIVITY_KIND_LABEL[a.kind]} · {ACTIVITY_MODE_LABEL[a.mode]} · <Link to={`/consultoria/clientes/${a.clientId}`}>{a.clientName}</Link>{a.establishmentName ? ` · ${a.establishmentName}` : ''} · {a.responsible.name}{a.participants.length ? ` + ${a.participants.map((p) => p.name).join(', ')}` : ''}{a.openTasks ? ` · ${a.openTasks} pendência(s)` : ''}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {list.data && list.data.total > list.data.rows.length ? <p className="ig-small ig-muted">Mostrando {list.data.rows.length} de {list.data.total}: use os filtros para ver as demais.</p> : null}
      <Card title={f.get('minha') === '1' ? 'Minhas pendências abertas' : 'Pendências abertas'} subtitle="Deixadas pelas atividades; encerradas pelo responsável com o que foi feito." headingLevel={2}>
        <TasksTable tasks={pending.data?.rows ?? []} caption="Pendências abertas" withClient withActivity />
      </Card>
    </div>
  );
}

/** New activity from the agenda: choose the client, then fill the activity. */
function NewActivity({ onDone }: { onDone: (id: string | null) => void }) {
  const consulting = useConsulting()!;
  const [clientId, setClientId] = useState('');
  const clients = useQuery({ queryKey: ['consulting', 'clients', { pageSize: 100 }], queryFn: () => consulting.clients({ pageSize: 100 }) });
  const options = (clients.data?.rows ?? []).filter((c) => c.status !== 'encerrado');
  return (
    <Card title="Nova atividade" headingLevel={2}>
      <Field label="Cliente" required>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Selecione</option>{options.map((c) => <option key={c.id} value={c.id}>{c.tradeName ?? c.legalName}</option>)}</select>
      </Field>
      {!clientId ? <Button onClick={() => onDone(null)}>Cancelar</Button> : <ActivityForm key={clientId} clientId={clientId} activity={null} onDone={(saved) => onDone(saved?.id ?? null)} />}
    </Card>
  );
}
