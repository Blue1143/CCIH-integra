import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ACTION_STATUS_LABEL, AUDIT_KIND_LABEL, AUDIT_STATUS_LABEL, AUDIT_TRANSITIONS, FIVE_W_TWO_H, NC_ORIGIN_LABEL, NC_SEVERITY_LABEL, NC_STATUS_LABEL, NC_TRANSITIONS, formatDate, todayIn,
  type ActionPlanDto, type ActionStatus, type AuditKind, type AuditStatus, type NcOrigin, type NcSeverity, type NcStatus, type NonconformityDto, type QualityAuditDto, type Status,
} from '@ccih/domain';
import { AlertBanner, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, LoadingState, StatusBadge, SubNav, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { ApiError } from '../../data/api/http';
import { JustificationField, justificationError } from '../admin/shared';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, Timeline, sectorName, useOrg, useTimeZone } from '../clinical/shared';
import { RequireOps, useOps, useOpsMutation, useUrlFilters } from './shared';

const AUDIT_TONE: Record<AuditStatus, Status> = { planejada: 'info', em_andamento: 'warn', concluida: 'warn', plano_de_acao: 'warn', verificacao_eficacia: 'warn', encerrada: 'ok', cancelada: 'neutral' };
const NC_TONE: Record<NcStatus, Status> = { aberta: 'crit', em_tratamento: 'warn', aguardando_eficacia: 'warn', encerrada: 'ok', cancelada: 'neutral' };
const SEVERITY_TONE: Record<NcSeverity, Status> = { alta: 'crit', media: 'warn', baixa: 'info' };
const ACTION_TONE: Record<ActionStatus, Status> = { pendente: 'warn', em_andamento: 'info', concluida: 'ok', cancelada: 'neutral' };

export function AuditsPage() {
  return <RequireOps title="Auditorias"><Audits /></RequireOps>;
}

function Audits() {
  const f = useUrlFilters({ secao: 'auditorias' });
  const { pathname } = useLocation();
  const section = f.get('secao') === 'nao-conformidades' ? 'nao-conformidades' : 'auditorias';
  return (
    <div className="page">
      <PageHeader title="Auditorias e não conformidades" subtitle="Planejada → em andamento → concluída → plano de ação → verificação de eficácia → encerrada. Cada etapa exige justificativa e fica no histórico." />
      <SubNav label="Seções" items={[{ key: 'auditorias', label: 'Auditorias' }, { key: 'nao-conformidades', label: 'Não conformidades' }].map((s) => ({ ...s, href: `${pathname}?secao=${s.key}`, active: s.key === section }))}
        renderLink={(item, className) => <Link to={item.href} replace className={className} aria-current={item.active ? 'page' : undefined}>{item.label}</Link>} />
      {section === 'auditorias' ? <AuditList /> : <NcList />}
    </div>
  );
}

function AuditList() {
  const ops = useOps()!;
  const session = useSession();
  const org = useOrg();
  const navigate = useNavigate();
  const audits = useQuery({ queryKey: ['quality', 'audits'], queryFn: () => ops.qualityAudits() });
  const [creating, setCreating] = useState(false);
  const cols: Column<QualityAuditDto>[] = [
    { key: 'plannedFor', label: 'Data prevista', value: (a) => a.plannedFor, render: (a) => <Link to={`/auditorias/${a.id}`}>{formatDate(a.plannedFor)}</Link> },
    { key: 'title', label: 'Auditoria', render: (a) => <span>{a.title} <DemoTag origin={a.origin} /></span>, value: (a) => a.title },
    { key: 'kind', label: 'Tipo', value: (a) => AUDIT_KIND_LABEL[a.kind] },
    { key: 'sector', label: 'Setor', value: (a) => (a.sectorId ? sectorName(org.data, a.sectorId) : 'Institucional') },
    { key: 'status', label: 'Situação', value: (a) => AUDIT_STATUS_LABEL[a.status], render: (a) => <StatusBadge status={AUDIT_TONE[a.status]}>{AUDIT_STATUS_LABEL[a.status]}</StatusBadge> },
    { key: 'ncs', label: 'Não conformidades', align: 'right', value: (a) => a.nonconformities, render: (a) => (a.nonconformities ? `${a.openNonconformities} aberta(s) de ${a.nonconformities}` : '0') },
  ];
  return (
    <>
      {session.can('quality:audit:manage') && !creating ? <div><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Planejar auditoria</Button></div> : null}
      {creating ? <AuditCreateForm onDone={(id) => { setCreating(false); if (id) navigate(`/auditorias/${id}`); }} /> : null}
      <DataTable caption="Auditorias" columns={cols} rows={audits.data?.audits ?? []} rowKey={(a) => a.id} searchable state={audits.isPending ? 'loading' : audits.isError ? 'error' : 'ready'} onRetry={() => void audits.refetch()} pageSize={20} />
    </>
  );
}

function AuditCreateForm({ onDone }: { onDone: (id?: string) => void }) {
  const ops = useOps()!;
  const org = useOrg();
  const tz = useTimeZone();
  const [d, setD] = useState({ title: '', kind: 'processo' as AuditKind, sectorId: '', scope: '', plannedFor: todayIn(tz), justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useOpsMutation(() => ops.createQualityAudit({ title: d.title.trim(), kind: d.kind, sectorId: d.sectorId || null, scope: d.scope.trim() || null, plannedFor: d.plannedFor, justification: d.justification.trim() }));
  const submit = () => {
    const e = { title: d.title.trim() ? undefined : 'Informe o título.', plannedFor: d.plannedFor ? undefined : 'Informe a data.', justification: justificationError(d.justification) };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: (r) => onDone(r.id) });
  };
  return (
    <FormCard title="Planejar auditoria" error={m.formError} onSubmit={submit} onCancel={() => onDone()} busy={m.mutation.isPending} submitLabel="Planejar">
      <Field label="Título" required error={errors.title ?? m.fieldErrors.title ?? null}><input value={d.title} maxLength={200} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      <div className="ig-form-row">
        <Field label="Tipo" required><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as AuditKind })}>{Object.entries(AUDIT_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Setor" error={m.fieldErrors.sectorId ?? null}><select value={d.sectorId} onChange={(e) => setD({ ...d, sectorId: e.target.value })}><option value="">Institucional (todos)</option>{org.data?.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Data prevista" required error={errors.plannedFor ?? null}><input type="date" value={d.plannedFor} onChange={(e) => setD({ ...d, plannedFor: e.target.value })} /></Field>
      </div>
      <Field label="Escopo e roteiro"><textarea value={d.scope} maxLength={1000} onChange={(e) => setD({ ...d, scope: e.target.value })} /></Field>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={errors.justification ?? m.fieldErrors.justification} />
    </FormCard>
  );
}

export function AuditDetailPage() {
  return <RequireOps title="Auditoria"><AuditDetail /></RequireOps>;
}

function AuditDetail() {
  const { id = '' } = useParams();
  const ops = useOps()!;
  const session = useSession();
  const org = useOrg();
  const tz = useTimeZone();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['quality', 'audit', id], queryFn: () => ops.qualityAudit(id) });
  const [action, setAction] = useState<null | 'findings' | 'nc' | AuditStatus>(null);
  if (q.isPending) return <div className="page"><LoadingState /></div>;
  if (q.isError) return <div className="page"><Card>{q.error instanceof ApiError && q.error.status === 404 ? <EmptyState title="Auditoria não encontrada" /> : <ErrorState onRetry={() => void q.refetch()} />}</Card></div>;
  const a = q.data;
  const canEdit = session.can('quality:audit:manage');
  const closed = a.status === 'encerrada' || a.status === 'cancelada';
  return (
    <div className="page">
      <PageHeader back={{ to: '/auditorias', label: 'Auditorias' }} title={a.title}
        subtitle={<>{AUDIT_KIND_LABEL[a.kind]} · {a.sectorId ? sectorName(org.data, a.sectorId) : 'Institucional'} · prevista para {formatDate(a.plannedFor)} · <StatusBadge status={AUDIT_TONE[a.status]}>{AUDIT_STATUS_LABEL[a.status]}</StatusBadge></>}
        actions={canEdit && !action && !closed ? <>
          <Button onClick={() => setAction('findings')}>Registrar achados</Button>
          {a.status !== 'planejada' ? <Button onClick={() => setAction('nc')}>Registrar não conformidade</Button> : null}
          {AUDIT_TRANSITIONS[a.status].map((to) => <Button key={to} variant={to === 'cancelada' ? 'danger' : 'primary'} onClick={() => setAction(to)}>{AUDIT_STATUS_LABEL[to]}</Button>)}
        </> : null} />
      {action === 'findings' ? <FindingsForm audit={a} onDone={() => setAction(null)} /> : null}
      {action === 'nc' ? <NcCreateForm auditId={a.id} sectorId={a.sectorId} onDone={(ncId) => { setAction(null); if (ncId) navigate(`/auditorias/nao-conformidades/${ncId}`); }} /> : null}
      {action && action !== 'findings' && action !== 'nc' ? <AuditStatusForm audit={a} to={action} onDone={() => setAction(null)} /> : null}
      <div className="cols-2">
        <Card title="Escopo e achados">
          <dl className="def-list"><dt>Escopo</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{a.scope ?? '—'}</dd><dt>Achados</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{a.findings ?? 'Ainda não registrados'}</dd></dl>
          <DemoTag origin={a.origin} />
        </Card>
        <Card title="Histórico"><Timeline timeZone={tz} items={[...a.history].reverse().map((h) => ({ id: h.id, at: h.at, tone: 'info', title: h.from ? `${AUDIT_STATUS_LABEL[h.from as AuditStatus]} → ${AUDIT_STATUS_LABEL[h.to as AuditStatus]}` : AUDIT_STATUS_LABEL[h.to as AuditStatus], detail: `${h.by}: ${h.justification}` }))} /></Card>
      </div>
      <NcTable rows={a.ncs} caption="Não conformidades desta auditoria" />
    </div>
  );
}

function FindingsForm({ audit, onDone }: { audit: { id: string; title: string; scope: string | null; plannedFor: string; findings: string | null; rowVersion: number }; onDone: () => void }) {
  const ops = useOps()!;
  const [findings, setFindings] = useState(audit.findings ?? '');
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string | undefined>();
  const m = useOpsMutation(() => ops.updateQualityAudit(audit.id, { title: audit.title, scope: audit.scope, plannedFor: audit.plannedFor, findings: findings.trim() || null, rowVersion: audit.rowVersion, justification: justification.trim() }));
  return (
    <FormCard title="Achados da auditoria" error={m.formError} busy={m.mutation.isPending} submitLabel="Salvar achados" onCancel={onDone}
      onSubmit={() => { const e = justificationError(justification); setError(e); if (!e) m.mutation.mutate(undefined, { onSuccess: onDone }); }}>
      <Field label="Achados"><textarea value={findings} maxLength={4000} onChange={(e) => setFindings(e.target.value)} /></Field>
      <JustificationField value={justification} onChange={setJustification} error={error ?? m.fieldErrors.justification} />
    </FormCard>
  );
}

function AuditStatusForm({ audit, to, onDone }: { audit: { id: string; rowVersion: number }; to: AuditStatus; onDone: () => void }) {
  const ops = useOps()!;
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState(false);
  const m = useOpsMutation(() => ops.changeAuditStatus(audit.id, { to, justification: justification.trim(), rowVersion: audit.rowVersion }));
  const problems = m.mutation.error instanceof ApiError ? m.mutation.error.fields.map((f) => f.message) : [];
  return (
    <>
      <FormCard title={`Mudar para: ${AUDIT_STATUS_LABEL[to]}`} error={m.formError} busy={m.mutation.isPending} submitLabel="Continuar" onCancel={onDone}
        onSubmit={() => { const e = justificationError(justification); setError(e); if (!e) setConfirm(true); }}>
        {problems.length ? <AlertBanner tone="warn" title="Pendências">{problems.join(' ')}</AlertBanner> : null}
        <JustificationField value={justification} onChange={setJustification} error={error} />
      </FormCard>
      <ConfirmDialog open={confirm} title={`Mudar para “${AUDIT_STATUS_LABEL[to]}”?`} confirmLabel="Confirmar" tone={to === 'cancelada' ? 'danger' : 'primary'} busy={m.mutation.isPending}
        onCancel={() => setConfirm(false)} onConfirm={() => m.mutation.mutate(undefined, { onSettled: () => setConfirm(false), onSuccess: onDone })}>
        A mudança e a justificativa entram no histórico da auditoria e no log de auditoria.
      </ConfirmDialog>
    </>
  );
}

function NcTable({ rows, caption, state = 'ready' }: { rows: NonconformityDto[]; caption: string; state?: 'ready' | 'loading' | 'error' }) {
  const org = useOrg();
  const cols: Column<NonconformityDto>[] = [
    { key: 'detectedOn', label: 'Detectada em', value: (n) => n.detectedOn, render: (n) => <Link to={`/auditorias/nao-conformidades/${n.id}`}>{formatDate(n.detectedOn)}</Link> },
    { key: 'description', label: 'Descrição', render: (n) => <span>{n.description} <DemoTag origin={n.dataOrigin} /></span>, value: (n) => n.description },
    { key: 'origin', label: 'Origem', value: (n) => NC_ORIGIN_LABEL[n.origin] },
    { key: 'sector', label: 'Setor', value: (n) => (n.sectorId ? sectorName(org.data, n.sectorId) : 'Institucional') },
    { key: 'severity', label: 'Gravidade', value: (n) => n.severity, render: (n) => <StatusBadge status={SEVERITY_TONE[n.severity]}>{NC_SEVERITY_LABEL[n.severity]}</StatusBadge> },
    { key: 'status', label: 'Situação', value: (n) => NC_STATUS_LABEL[n.status], render: (n) => <StatusBadge status={NC_TONE[n.status]}>{NC_STATUS_LABEL[n.status]}</StatusBadge> },
    { key: 'actions', label: 'Ações', align: 'right', value: (n) => n.actionsOpen, render: (n) => (n.actionsTotal ? <span>{n.actionsOpen} aberta(s){n.actionsOverdue ? <b style={{ color: 'var(--crit)' }}> · {n.actionsOverdue} atrasada(s)</b> : null}</span> : 'Sem plano') },
  ];
  return <DataTable caption={caption} columns={cols} rows={rows} rowKey={(n) => n.id} state={state} emptyMessage="Nenhuma não conformidade." />;
}

function NcList() {
  const ops = useOps()!;
  const session = useSession();
  const navigate = useNavigate();
  const f = useUrlFilters({ situacao: 'aberta,em_tratamento,aguardando_eficacia' });
  const list = useQuery({ queryKey: ['quality', 'ncs', f.get('situacao')], queryFn: () => ops.nonconformities(f.get('situacao') || undefined) });
  const [creating, setCreating] = useState(false);
  return (
    <>
      {session.can('nc:record', 'quality:audit:manage') && !creating ? <div><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Registrar não conformidade</Button></div> : null}
      {creating ? <NcCreateForm auditId={null} sectorId={null} onDone={(id) => { setCreating(false); if (id) navigate(`/auditorias/nao-conformidades/${id}`); }} /> : null}
      <div className="filters">
        <div className="field">
          <label htmlFor="nc-sit">Situação</label>
          <select id="nc-sit" className="select" value={f.get('situacao')} onChange={(e) => f.set('situacao', e.target.value)}>
            <option value="aberta,em_tratamento,aguardando_eficacia">Em aberto</option>
            {Object.entries(NC_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            <option value="aberta,em_tratamento,aguardando_eficacia,encerrada,cancelada">Todas</option>
          </select>
        </div>
      </div>
      <NcTable rows={list.data?.nonconformities ?? []} caption="Não conformidades" state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'} />
    </>
  );
}

/** Also used outside Quality (CME, apprentice): registering is allowed with nc:record; treating and closing stay with Quality. */
export function NcCreateForm({ auditId, sectorId, origin, onDone }: { auditId: string | null; sectorId: string | null; origin?: NcOrigin; onDone: (id?: string) => void }) {
  const ops = useOps()!;
  const org = useOrg();
  const tz = useTimeZone();
  const [d, setD] = useState({ origin: (auditId ? 'auditoria' : origin ?? 'outro') as NcOrigin, severity: 'media' as NcSeverity, sectorId: sectorId ?? '', description: '', detectedOn: todayIn(tz), justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useOpsMutation(() => ops.createNonconformity({ auditId, sectorId: d.sectorId || null, origin: d.origin, severity: d.severity, description: d.description.trim(), detectedOn: d.detectedOn, justification: d.justification.trim() }));
  const submit = () => {
    const e = { description: d.description.trim() ? undefined : 'Descreva a não conformidade.', justification: justificationError(d.justification) };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: (r) => onDone(r.id) });
  };
  return (
    <FormCard title="Registrar não conformidade" error={m.formError} onSubmit={submit} onCancel={() => onDone()} busy={m.mutation.isPending} submitLabel="Registrar">
      <Field label="Descrição" required error={errors.description ?? null}><textarea value={d.description} maxLength={2000} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      <div className="ig-form-row">
        <Field label="Origem" required><select value={d.origin} onChange={(e) => setD({ ...d, origin: e.target.value as NcOrigin })} disabled={!!auditId}>{Object.entries(NC_ORIGIN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Gravidade" required><select value={d.severity} onChange={(e) => setD({ ...d, severity: e.target.value as NcSeverity })}>{Object.entries(NC_SEVERITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Setor" error={m.fieldErrors.sectorId ?? null}><select value={d.sectorId} onChange={(e) => setD({ ...d, sectorId: e.target.value })}><option value="">Institucional</option>{org.data?.sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Detectada em" required error={m.fieldErrors.detectedOn ?? null}><input type="date" value={d.detectedOn} max={todayIn(tz)} onChange={(e) => setD({ ...d, detectedOn: e.target.value })} /></Field>
      </div>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={errors.justification ?? m.fieldErrors.justification} />
    </FormCard>
  );
}

export function NcDetailPage() {
  return <RequireOps title="Não conformidade"><NcDetail /></RequireOps>;
}

function NcDetail() {
  const { id = '' } = useParams();
  const ops = useOps()!;
  const session = useSession();
  const org = useOrg();
  const tz = useTimeZone();
  const q = useQuery({ queryKey: ['quality', 'nc', id], queryFn: () => ops.nonconformity(id) });
  const [action, setAction] = useState<null | 'plan' | NcStatus | { status: ActionPlanDto }>(null);
  if (q.isPending) return <div className="page"><LoadingState /></div>;
  if (q.isError) return <div className="page"><Card>{q.error instanceof ApiError && q.error.status === 404 ? <EmptyState title="Não conformidade não encontrada" /> : <ErrorState onRetry={() => void q.refetch()} />}</Card></div>;
  const n = q.data;
  const canEdit = session.can('quality:audit:manage');
  // Progress of a 5W2H action is recorded by whoever executes the audit; treating and closing is Quality's.
  const canExecute = session.can('quality:audit:execute', 'quality:audit:manage');
  const closed = n.status === 'encerrada' || n.status === 'cancelada';
  const actionCols: Column<ActionPlanDto>[] = [
    { key: 'what', label: FIVE_W_TWO_H.what, render: (x) => <span><b>{x.what}</b><br /><span className="ig-small ig-muted">{FIVE_W_TWO_H.why}: {x.why}</span></span>, value: (x) => x.what },
    { key: 'where', label: FIVE_W_TWO_H.where },
    { key: 'who', label: FIVE_W_TWO_H.who },
    { key: 'dueOn', label: FIVE_W_TWO_H.when, value: (x) => x.dueOn, render: (x) => <span>{formatDate(x.dueOn)}{x.overdue ? <StatusBadge status="crit">Atrasada</StatusBadge> : null}</span> },
    { key: 'how', label: FIVE_W_TWO_H.how, render: (x) => <span>{x.how}{x.howMuch ? <span className="ig-small ig-muted"> · {FIVE_W_TWO_H.howMuch}: {x.howMuch}</span> : null}</span>, value: (x) => x.how },
    { key: 'status', label: 'Situação', value: (x) => x.status, render: (x) => <StatusBadge status={ACTION_TONE[x.status]}>{ACTION_STATUS_LABEL[x.status]}{x.completedOn ? ` em ${formatDate(x.completedOn)}` : ''}</StatusBadge> },
    ...(canExecute && !closed ? [{ key: 'act', label: 'Ação', sortable: false, exportable: false, render: (x: ActionPlanDto) => (x.status === 'pendente' || x.status === 'em_andamento' ? <Button size="sm" onClick={() => setAction({ status: x })} aria-label={`Atualizar ação ${x.what}`}>Atualizar</Button> : null) } as Column<ActionPlanDto>] : []),
  ];
  return (
    <div className="page">
      <PageHeader back={{ to: '/auditorias?secao=nao-conformidades', label: 'Não conformidades' }} title={n.description}
        subtitle={<>{NC_ORIGIN_LABEL[n.origin]} · {n.sectorId ? sectorName(org.data, n.sectorId) : 'Institucional'} · detectada em {formatDate(n.detectedOn)} · <StatusBadge status={SEVERITY_TONE[n.severity]}>Gravidade {NC_SEVERITY_LABEL[n.severity].toLowerCase()}</StatusBadge> <StatusBadge status={NC_TONE[n.status]}>{NC_STATUS_LABEL[n.status]}</StatusBadge></>}
        actions={canEdit && !closed && !action ? <>
          <Button onClick={() => setAction('plan')}>Adicionar ação (5W2H)</Button>
          {NC_TRANSITIONS[n.status].map((to) => <Button key={to} variant={to === 'cancelada' ? 'danger' : 'primary'} onClick={() => setAction(to)}>{NC_STATUS_LABEL[to]}</Button>)}
        </> : null} />
      {n.auditId ? <p className="ig-small" style={{ margin: 0 }}>Auditoria de origem: <Link to={`/auditorias/${n.auditId}`}>{n.auditTitle}</Link></p> : null}
      {n.source?.entity === 'material_use' ? <p className="ig-small" style={{ margin: 0 }}>Aberta automaticamente pela regra de saída da CME (uso de pacote sem saída registrada){n.notifiedUserName ? <> · notificado: {n.notifiedUserName}</> : null}.</p> : null}
      {action === 'plan' ? <ActionForm ncId={n.id} onDone={() => setAction(null)} /> : null}
      {action && typeof action === 'object' ? <ActionStatusForm action={action.status} onDone={() => setAction(null)} /> : null}
      {typeof action === 'string' && action !== 'plan' ? <NcStatusForm nc={n} to={action} onDone={() => setAction(null)} /> : null}
      <DataTable caption="Plano de ação (5W2H)" columns={actionCols} rows={n.actions} rowKey={(x) => x.id} emptyMessage="Nenhuma ação cadastrada. Cadastre ao menos uma para iniciar o tratamento." />
      <div className="cols-2">
        <Card title="Verificação de eficácia">{n.effectiveness ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{n.effectiveness}</p> : <p className="ig-muted" style={{ margin: 0 }}>Registrada ao encerrar a não conformidade.</p>}</Card>
        <Card title="Histórico"><Timeline timeZone={tz} items={[...n.history].reverse().map((h) => ({ id: h.id, at: h.at, tone: 'info', title: h.from ? `${NC_STATUS_LABEL[h.from as NcStatus]} → ${NC_STATUS_LABEL[h.to as NcStatus]}` : NC_STATUS_LABEL[h.to as NcStatus], detail: `${h.by}: ${h.justification}` }))} /></Card>
      </div>
    </div>
  );
}

function ActionForm({ ncId, onDone }: { ncId: string; onDone: () => void }) {
  const ops = useOps()!;
  const [d, setD] = useState({ what: '', why: '', where: '', who: '', dueOn: '', how: '', howMuch: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useOpsMutation(() => ops.addAction(ncId, { what: d.what.trim(), why: d.why.trim(), where: d.where.trim(), who: d.who.trim(), dueOn: d.dueOn, how: d.how.trim(), howMuch: d.howMuch.trim() || null }));
  const submit = () => {
    const e: Record<string, string | undefined> = {};
    for (const k of ['what', 'why', 'where', 'who', 'dueOn', 'how'] as const) if (!d[k].trim()) e[k] = 'Campo obrigatório.';
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const field = (k: keyof typeof d, label: string, required = true, area = false) => (
    <Field label={label} required={required} error={errors[k] ?? m.fieldErrors[k] ?? null}>
      {area ? <textarea value={d[k]} maxLength={1000} onChange={(e) => setD({ ...d, [k]: e.target.value })} /> : <input type={k === 'dueOn' ? 'date' : 'text'} value={d[k]} maxLength={300} onChange={(e) => setD({ ...d, [k]: e.target.value })} />}
    </Field>
  );
  return (
    <FormCard title="Nova ação do plano (5W2H)" error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Adicionar ação">
      {field('what', FIVE_W_TWO_H.what)}
      {field('why', FIVE_W_TWO_H.why)}
      <div className="ig-form-row">{field('where', FIVE_W_TWO_H.where)}{field('who', FIVE_W_TWO_H.who)}{field('dueOn', FIVE_W_TWO_H.when)}</div>
      {field('how', FIVE_W_TWO_H.how, true, true)}
      {field('howMuch', FIVE_W_TWO_H.howMuch, false)}
    </FormCard>
  );
}

function ActionStatusForm({ action, onDone }: { action: ActionPlanDto; onDone: () => void }) {
  const ops = useOps()!;
  const tz = useTimeZone();
  const [d, setD] = useState({ status: (action.status === 'pendente' ? 'em_andamento' : 'concluida') as ActionStatus, completedOn: todayIn(tz), justification: '' });
  const [error, setError] = useState<string | undefined>();
  const m = useOpsMutation(() => ops.changeActionStatus(action.id, { status: d.status, completedOn: d.status === 'concluida' ? d.completedOn : null, rowVersion: action.rowVersion, justification: d.justification.trim() }));
  return (
    <FormCard title={`Atualizar ação: ${action.what}`} error={m.formError} busy={m.mutation.isPending} submitLabel="Salvar" onCancel={onDone}
      onSubmit={() => { const e = justificationError(d.justification); setError(e); if (!e) m.mutation.mutate(undefined, { onSuccess: onDone }); }}>
      <div className="ig-form-row">
        <Field label="Situação" required><select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as ActionStatus })}>{(['em_andamento', 'concluida', 'cancelada'] as ActionStatus[]).map((s) => <option key={s} value={s}>{ACTION_STATUS_LABEL[s]}</option>)}</select></Field>
        {d.status === 'concluida' ? <Field label="Concluída em" required error={m.fieldErrors.completedOn ?? null}><input type="date" value={d.completedOn} max={todayIn(tz)} onChange={(e) => setD({ ...d, completedOn: e.target.value })} /></Field> : null}
      </div>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={error} />
    </FormCard>
  );
}

function NcStatusForm({ nc, to, onDone }: { nc: { id: string; rowVersion: number; effectiveness: string | null }; to: NcStatus; onDone: () => void }) {
  const ops = useOps()!;
  const [d, setD] = useState({ effectiveness: nc.effectiveness ?? '', justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [confirm, setConfirm] = useState(false);
  const m = useOpsMutation(() => ops.changeNcStatus(nc.id, { to, effectiveness: d.effectiveness.trim() || null, justification: d.justification.trim(), rowVersion: nc.rowVersion }));
  const problems = m.mutation.error instanceof ApiError ? m.mutation.error.fields.map((f) => f.message) : [];
  return (
    <>
      <FormCard title={`Mudar para: ${NC_STATUS_LABEL[to]}`} error={m.formError} busy={m.mutation.isPending} submitLabel="Continuar" onCancel={onDone}
        onSubmit={() => {
          const e = { justification: justificationError(d.justification), effectiveness: to === 'encerrada' && !d.effectiveness.trim() ? 'Registre o resultado da verificação de eficácia.' : undefined };
          setErrors(e);
          if (!Object.values(e).some(Boolean)) setConfirm(true);
        }}>
        {problems.length ? <AlertBanner tone="warn" title="Pendências">{problems.join(' ')}</AlertBanner> : null}
        {to === 'encerrada' ? <Field label="Resultado da verificação de eficácia" required error={errors.effectiveness ?? null}><textarea value={d.effectiveness} maxLength={2000} onChange={(e) => setD({ ...d, effectiveness: e.target.value })} /></Field> : null}
        <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={errors.justification} />
      </FormCard>
      <ConfirmDialog open={confirm} title={`Mudar para “${NC_STATUS_LABEL[to]}”?`} confirmLabel="Confirmar" tone={to === 'cancelada' ? 'danger' : 'primary'} busy={m.mutation.isPending}
        onCancel={() => setConfirm(false)} onConfirm={() => m.mutation.mutate(undefined, { onSettled: () => setConfirm(false), onSuccess: onDone })}>
        A mudança e a justificativa entram no histórico da não conformidade e no log de auditoria.
      </ConfirmDialog>
    </>
  );
}
