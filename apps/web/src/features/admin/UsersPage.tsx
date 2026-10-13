import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ACCOUNT_STATUS_LABEL, ADDITIONAL_ROLES, rolesOfModel, APPRENTICE_AREAS, APPRENTICE_LEVEL_LABEL, FUNCTION_ROLES, PERMISSIONS, PROFESSIONAL_CATEGORY_LABEL, ROLE_LABEL,
  apprenticeMarkerPermissions, apprenticeMarkersOf, checkAccess, formatDate, grantableApprenticeAreas, grantablePermissions, todayIn,
  type AccountStatus, type ApprenticeArea, type ApprenticeLevel, type Grantor, type Permission, type ProfessionalCategory, type RoleCode, type Status, type UserAccessInput,
} from '@ccih/domain';
import { AlertBanner, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, FormMessage, LoadingState, StatusBadge, type Column } from '@ccih/ui';
import { useInstitution } from '../../data/source';
import type { AdminUser, UsersMeta } from '../../data/port';
import { useSession } from '../auth/session';
import { EditAvailability, JustificationField, UnsavedChangesGuard, justificationError, useAdmin, useAdminMutation } from './shared';

const STATUS_TONE: Record<AccountStatus, Status> = { ativo: 'ok', pendente: 'warn', suspenso: 'crit', desativado: 'neutral' };
const MANAGE: Permission[] = ['users:manage', 'users:manage:ccih', 'users:manage:cme'];

interface Filters { q: string; role: string; status: string; sectorId: string; createdFrom: string; createdTo: string }
const NO_FILTERS: Filters = { q: '', role: '', status: '', sectorId: '', createdFrom: '', createdTo: '' };

export function UsersPage() {
  const admin = useAdmin();
  const session = useSession();
  const institution = useInstitution();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>;
  const users = useQuery({ queryKey: ['users', query], enabled: !!admin, queryFn: () => admin!.users(query), placeholderData: (p) => p });
  const meta = useQuery({ queryKey: ['users', 'meta'], enabled: !!admin, queryFn: () => admin!.usersMeta() });
  const roles = useQuery({ queryKey: ['roles'], enabled: !!admin, queryFn: () => admin!.roles() });
  const [editing, setEditing] = useState<AdminUser | 'new' | 'new-admin' | null>(null);
  const [history, setHistory] = useState<AdminUser | null>(null);
  const [temporary, setTemporary] = useState<{ login: string; password: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [resetReason, setResetReason] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState<AdminUser | null>(null);
  const reset = useAdminMutation((d: { id: string; justification: string }) => admin!.resetPassword(d.id, d.justification), ['users']);
  const unlock = useAdminMutation((id: string) => admin!.unlockUser(id), ['users']);
  const canManage = session.writable && session.can(...MANAGE);
  const isFounder = !!session.info?.isFounder;

  if (!admin) {
    return <Card title="Gestão de usuários"><EmptyState title="Disponível com o backend">O cadastro de usuários, funções e permissões exige a API (VITE_DATA_SOURCE=api).</EmptyState></Card>;
  }
  if (users.isPending || institution.isPending) return <LoadingState />;
  if (users.isError || institution.isError) return <ErrorState onRetry={() => void users.refetch()} />;
  const tz = institution.data.data.config.timezone;
  const sectors = institution.data.data.sectors;
  const sectorName = (id: string) => sectors.find((s) => s.id === id)?.name ?? 'Setor fora do seu escopo';
  const roleName = (code: string | null) => (code ? (ROLE_LABEL[code as RoleCode] ?? code) : '—');
  const setFilter = (k: keyof Filters, v: string) => setFilters({ ...filters, [k]: v });
  const hospital = session.model === 'hospitalar';
  const filterRoles: RoleCode[] = hospital ? [...FUNCTION_ROLES, 'admin', ...ADDITIONAL_ROLES] : rolesOfModel(session.model);

  const columns: Column<AdminUser>[] = [
    { key: 'name', label: 'Profissional', value: (u) => u.displayName, render: (u) => <span><b>{u.displayName}</b><br /><span className="ig-small ig-muted"><span className="ig-mono">{u.login}</span>{u.email ? ` · ${u.email}` : ''}{u.registration ? ` · ${u.registration}` : ''}</span></span> },
    { key: 'function', label: 'Função', value: (u) => roleName(u.functionRole), render: (u) => (
      <span>{roleName(u.functionRole)}{u.isFounder ? <> <StatusBadge status="info">Conta criadora</StatusBadge></> : null}
        {u.roles.filter((r) => r !== u.functionRole).length ? <span className="ig-small ig-muted"><br />+ {u.roles.filter((r) => r !== u.functionRole).map(roleName).join(', ')}</span> : null}
        {u.grants.length ? <span className="ig-small ig-muted"><br />{u.grants.length} autorização(ões) individual(is)</span> : null}
      </span>
    ) },
    // Sector scope is a hospital concept; consulting organizations get client scope in their own module.
    ...(hospital ? [{ key: 'scope', label: 'Setor de atuação', value: (u: AdminUser) => (u.scopeAll ? 'Todos os setores' : u.sectorIds.map(sectorName).join(', ')) }] : []),
    { key: 'status', label: 'Situação', value: (u) => u.status, render: (u) => (
      <span>{u.lockedUntil ? <StatusBadge status="crit">Bloqueada até {formatDate(u.lockedUntil, tz)}</StatusBadge> : <StatusBadge status={STATUS_TONE[u.status]}>{ACCOUNT_STATUS_LABEL[u.status]}</StatusBadge>}
        {u.validUntil ? <span className="ig-small ig-muted"><br />até {formatDate(u.validUntil)}</span> : null}</span>
    ) },
    { key: 'authorizedBy', label: 'Autorizado por', value: (u) => u.authorizedByName ?? '—' },
    { key: 'createdAt', label: 'Criada em', value: (u) => u.createdAt, render: (u) => formatDate(u.createdAt, tz) },
    { key: 'permissionsChangedAt', label: 'Permissões alteradas em', value: (u) => u.permissionsChangedAt ?? '', render: (u) => formatDate(u.permissionsChangedAt, tz) },
    { key: 'action', label: 'Ações', sortable: false, exportable: false, render: (u) => (
      <span className="ig-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {canManage && u.manageable ? <Button size="sm" onClick={() => { setEditing(u); setSaved(null); }} aria-label={`Editar acesso de ${u.login}`}>Editar acesso</Button> : null}
        {canManage && u.manageable && u.lockedUntil ? <Button size="sm" onClick={() => setUnlocking(u)} aria-label={`Desbloquear ${u.login}`}>Desbloquear</Button> : null}
        {canManage && u.manageable ? <Button size="sm" variant="ghost" onClick={() => { setResetting(u); setResetReason(''); setResetError(null); }} aria-label={`Redefinir senha de ${u.login}`}>Redefinir senha</Button> : null}
        <Button size="sm" variant="ghost" onClick={() => setHistory(u)} aria-label={`Histórico de ${u.login}`}>Histórico</Button>
      </span>
    ) },
  ];

  return (
    <div className="ig-stack" style={{ gap: 16 }}>
      <EditAvailability permissionLabel="Gerenciar usuários" allowed={session.can(...MANAGE)} />
      {saved ? <FormMessage tone="success">{saved}</FormMessage> : null}
      {temporary ? (
        <AlertBanner tone="warn" title={`Senha temporária de ${temporary.login}: ${temporary.password}`} actions={<Button size="sm" onClick={() => setTemporary(null)}>Já entreguei a senha</Button>}>
          Entregue ao usuário por canal seguro. Ela não será exibida novamente, não fica no log e precisa ser trocada no primeiro acesso.
        </AlertBanner>
      ) : null}
      {isFounder && session.writable && !editing ? (
        <Card title="Administradores do sistema" subtitle="Somente a conta criadora cria ou altera Administradores do sistema. A operação fica registrada no log de auditoria.">
          <Button icon="plus" onClick={() => { setEditing('new-admin'); setSaved(null); }}>Criar administrador do sistema</Button>
        </Card>
      ) : null}
      {canManage && !editing ? <div><Button icon="plus" variant="primary" onClick={() => { setEditing('new'); setSaved(null); }}>Novo usuário</Button></div> : null}
      {editing && meta.data && roles.data ? (
        <UserForm
          user={typeof editing === 'string' ? null : editing} adminOnly={editing === 'new-admin'} meta={meta.data} roles={roles.data.roles} sectors={sectors} tz={tz}
          grantor={{ permissions: session.info?.permissions ?? [], isFounder }}
          onDone={(r) => { setEditing(null); if (r?.temporary) setTemporary(r.temporary); if (r?.message) setSaved(r.message); }}
        />
      ) : null}
      {history ? <HistoryCard user={history} tz={tz} onClose={() => setHistory(null)} /> : null}
      <div className="filters" role="search">
        <div className="field"><label htmlFor="u-q">Pesquisar</label><input id="u-q" className="select" value={filters.q} placeholder="Nome, login ou e-mail" onChange={(e) => setFilter('q', e.target.value)} /></div>
        <div className="field"><label htmlFor="u-role">Função</label>
          <select id="u-role" className="select" value={filters.role} onChange={(e) => setFilter('role', e.target.value)}><option value="">Todas</option>{filterRoles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
        </div>
        {hospital ? (
          <div className="field"><label htmlFor="u-sector">Setor</label>
          <select id="u-sector" className="select" value={filters.sectorId} onChange={(e) => setFilter('sectorId', e.target.value)}><option value="">Todos</option>{sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </div>
        ) : null}
        <div className="field"><label htmlFor="u-status">Situação</label>
          <select id="u-status" className="select" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}><option value="">Todas</option>{Object.entries(ACCOUNT_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="u-from">Criadas de</label><input id="u-from" className="select" type="date" value={filters.createdFrom} onChange={(e) => setFilter('createdFrom', e.target.value)} /></div>
        <div className="field"><label htmlFor="u-to">até</label><input id="u-to" className="select" type="date" value={filters.createdTo} onChange={(e) => setFilter('createdTo', e.target.value)} /></div>
      </div>
      <DataTable caption="Usuários" columns={columns} rows={users.data.users} rowKey={(u) => u.id} emptyMessage="Nenhum usuário com estes filtros." />
      <ConfirmDialog open={!!unlocking} title={`Desbloquear ${unlocking?.login ?? ''}?`} confirmLabel="Desbloquear" busy={unlock.mutation.isPending}
        onCancel={() => setUnlocking(null)}
        onConfirm={() => unlocking && unlock.mutation.mutate(unlocking.id, { onSettled: () => setUnlocking(null), onSuccess: () => setSaved('Conta desbloqueada.') })}>
        Confirme que a identidade do usuário foi verificada. O desbloqueio fica registrado no log de auditoria.
      </ConfirmDialog>
      <ConfirmDialog open={!!resetting} title={`Redefinir a senha de ${resetting?.login ?? ''}?`} confirmLabel="Gerar senha temporária" tone="danger" busy={reset.mutation.isPending}
        onCancel={() => setResetting(null)}
        onConfirm={() => {
          const e = justificationError(resetReason);
          if (e) { setResetError(e); return; }
          const u = resetting!;
          reset.mutation.mutate({ id: u.id, justification: resetReason.trim() }, { onSuccess: (r) => { setTemporary({ login: u.login, password: r.temporaryPassword }); setResetting(null); } });
        }}>
        <p style={{ marginTop: 0 }}>As sessões do usuário serão encerradas e ele deverá trocar a senha no próximo acesso. Confirme a identidade antes.</p>
        <Field label="Justificativa" required error={resetError ?? reset.formError}><textarea value={resetReason} onChange={(e) => setResetReason(e.target.value)} maxLength={500} /></Field>
      </ConfirmDialog>
    </div>
  );
}

interface Draft {
  login: string; displayName: string; email: string; registration: string; category: ProfessionalCategory | ''; functionRole: RoleCode | ''; extraRoles: RoleCode[];
  scopeAll: boolean; sectorIds: string[]; status: AccountStatus; statusReason: string; validFrom: string; validUntil: string; supervisorId: string;
  grants: Permission[]; grantsUntil: string; justification: string;
}

function draftOf(u: AdminUser | null, adminOnly: boolean): Draft {
  const extra = u ? u.roles.filter((r) => r !== u.functionRole) : [];
  return {
    login: u?.login ?? '', displayName: u?.displayName ?? '', email: u?.email ?? '', registration: u?.registration ?? '', category: u?.category ?? (adminOnly ? 'administrativo' : ''),
    functionRole: u?.functionRole ?? (adminOnly ? 'admin' : ''), extraRoles: extra, scopeAll: u?.scopeAll ?? adminOnly, sectorIds: u?.sectorIds ?? [],
    status: u?.status ?? 'ativo', statusReason: u?.statusReason ?? '', validFrom: u?.validFrom ?? '', validUntil: u?.validUntil ?? '', supervisorId: u?.supervisorId ?? '',
    grants: (u?.grants.map((g) => g.permission) ?? []) as Permission[], grantsUntil: u?.grants[0]?.validUntil ?? '', justification: '',
  };
}

function UserForm({ user, adminOnly, meta, roles, sectors, tz, grantor, onDone }: {
  user: AdminUser | null; adminOnly: boolean; meta: UsersMeta; roles: Array<{ code: string; permissions: string[] }>; sectors: Array<{ id: string; name: string }>; tz: string;
  grantor: Grantor; onDone: (r?: { temporary?: { login: string; password: string }; message?: string }) => void;
}) {
  const admin = useAdmin()!;
  const [d, setD] = useState<Draft>(() => draftOf(user, adminOnly));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [confirming, setConfirming] = useState(false);
  const create = useAdminMutation((input: UserAccessInput & { login: string }) => admin.createUser(input), ['users']);
  const update = useAdminMutation((input: UserAccessInput & { rowVersion: number }) => admin.updateUser(user!.id, input), ['users']);
  const m = user ? update : create;

  const assignable = meta.assignableRoles;
  const hospital = useSession().model === 'hospitalar';
  const functions = adminOnly ? (['admin'] as RoleCode[]) : hospital ? FUNCTION_ROLES.filter((r) => assignable.includes(r)) : assignable.filter((r) => r !== 'admin');
  const additional = adminOnly ? [] : ADDITIONAL_ROLES.filter((r) => assignable.includes(r));
  const allRoles = [d.functionRole, ...d.extraRoles].filter(Boolean) as RoleCode[];
  const isApprentice = d.functionRole === 'aprendiz';
  const grantable = grantablePermissions(grantor, allRoles);
  const areas = isApprentice ? grantableApprenticeAreas(grantor) : [];
  const fromRoles = new Set(roles.filter((r) => allRoles.includes(r.code as RoleCode)).flatMap((r) => r.permissions));
  const effective = [...new Set([...fromRoles, ...d.grants])].sort() as Permission[];

  const input = (): UserAccessInput => ({
    displayName: d.displayName.trim(), email: d.email.trim() || null, registration: d.registration.trim() || null, category: d.category || null,
    functionRole: d.functionRole as RoleCode, extraRoles: d.extraRoles, scopeAll: hospital ? d.scopeAll : true, sectorIds: hospital && !d.scopeAll ? d.sectorIds : [], status: d.status,
    statusReason: d.statusReason.trim() || null, validFrom: d.validFrom || null, validUntil: d.validUntil || null, supervisorId: d.supervisorId || null,
    grants: d.grants.map((permission) => ({ permission, validUntil: (isApprentice ? d.validUntil : d.grantsUntil) || null })), justification: d.justification.trim(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problems = checkAccess(input(), grantor, todayIn(tz));
    const errs: Record<string, string | undefined> = {};
    for (const p of problems) errs[p.path] ??= p.message;
    if (!user && !/^[a-z0-9._-]{3,60}$/.test(d.login.trim().toLowerCase())) errs.login = 'Use 3 a 60 letras minúsculas, números, ponto, hífen ou sublinhado.';
    if (d.displayName.trim().length < 3) errs.displayName = 'Informe o nome completo.';
    errs.justification ??= justificationError(d.justification) ?? undefined;
    setErrors(errs);
    if (!Object.values(errs).some(Boolean)) setConfirming(true);
  };
  const save = () => {
    const body = input();
    if (user) update.mutation.mutate({ ...body, rowVersion: user.rowVersion }, { onSettled: () => setConfirming(false), onSuccess: () => onDone({ message: `Acesso de ${user.login} atualizado. As sessões abertas foram encerradas.` }) });
    else {
      const login = d.login.trim().toLowerCase();
      create.mutation.mutate({ ...body, login }, { onSettled: () => setConfirming(false), onSuccess: (r) => onDone({ temporary: { login, password: r.temporaryPassword }, message: `Usuário ${login} criado.` }) });
    }
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  /** Markers per area and level; recording or exporting implies consulting, and unticking consultation clears the area. */
  const LEVELS: ApprenticeLevel[] = ['consulta', 'registro', 'exportacao'];
  const markerUniverse = new Set((Object.keys(APPRENTICE_AREAS) as ApprenticeArea[]).flatMap((a) => LEVELS.flatMap((l) => apprenticeMarkerPermissions(a, l))));
  const markers = apprenticeMarkersOf(d.grants);
  const hasMarker = (a: ApprenticeArea, l: ApprenticeLevel) => markers.some(([ma, ml]) => ma === a && ml === l);
  const toggleMarker = (area: ApprenticeArea, level: ApprenticeLevel, on: boolean) => {
    let next = markers.filter(([a, l]) => !(a === area && (l === level || (!on && level === 'consulta'))));
    if (on) next = [...next, [area, level], ...(level !== 'consulta' ? [[area, 'consulta'] as [ApprenticeArea, ApprenticeLevel]] : [])];
    const extras = d.grants.filter((p) => !markerUniverse.has(p));
    const fromMarkers = next.flatMap(([a, l]) => apprenticeMarkerPermissions(a, l)).filter((p) => grantable.includes(p));
    setD({ ...d, grants: [...new Set([...extras, ...fromMarkers])] });
  };

  const title = adminOnly ? 'Criar administrador do sistema' : user ? `Acesso de ${user.displayName}` : 'Novo usuário';
  return (
    <Card title={title} subtitle={user ? 'Qualquer alteração de função, setor, situação ou permissão encerra as sessões abertas do usuário e fica no histórico.' : 'O sistema gera uma senha temporária, exibida uma única vez; o usuário a troca no primeiro acesso. O autorizador é você.'}>
      <form className="ig-form" onSubmit={submit} noValidate>
        {m.formError ? <FormMessage tone="error">{m.formError}</FormMessage> : null}
        <div className="ig-form-row">
          <Field label="Nome completo do profissional" required error={err('displayName')}><input value={d.displayName} maxLength={120} onChange={(e) => setD({ ...d, displayName: e.target.value })} /></Field>
          {!user ? <Field label="Login" required error={err('login')}><input value={d.login} maxLength={60} onChange={(e) => setD({ ...d, login: e.target.value })} autoComplete="off" /></Field> : null}
        </div>
        <div className="ig-form-row">
          <Field label="E-mail institucional" error={err('email')}><input type="email" value={d.email} maxLength={160} onChange={(e) => setD({ ...d, email: e.target.value })} autoComplete="off" /></Field>
          <Field label="Identificador profissional" hint="Ex.: COREN, CRM ou matrícula." error={err('registration')}><input value={d.registration} maxLength={40} onChange={(e) => setD({ ...d, registration: e.target.value })} /></Field>
          <Field label="Categoria profissional" error={err('category')}>
            <select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value as ProfessionalCategory | '' })}><option value="">Selecione</option>{Object.entries(PROFESSIONAL_CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
        </div>
        <Field label="Função no sistema" required hint="Define as permissões iniciais. Só aparecem as funções que você pode atribuir." error={err('functionRole')}>
          <select value={d.functionRole} disabled={adminOnly} onChange={(e) => {
            const r = e.target.value as RoleCode;
            setD({ ...d, functionRole: r, extraRoles: r === 'aprendiz' ? [] : d.extraRoles, grants: [], status: r === 'aprendiz' && !user ? 'pendente' : d.status, category: r === 'aprendiz' ? 'aprendiz' : d.category });
          }}>
            <option value="">Selecione</option>
            {functions.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </Field>
        {additional.length && !isApprentice ? (
          <fieldset className="ig-checks">
            <legend>Perfis adicionais (opcional)</legend>
            {additional.filter((r) => r !== d.functionRole).map((r) => <label key={r}><input type="checkbox" checked={d.extraRoles.includes(r)} onChange={(e) => setD({ ...d, extraRoles: toggle(d.extraRoles, r, e.target.checked) })} />{ROLE_LABEL[r]}</label>)}
          </fieldset>
        ) : null}
        {err('extraRoles') ? <p className="ig-field-error" role="alert">{err('extraRoles')}</p> : null}
        {hospital ? <>
        <fieldset className="ig-checks">
          <legend>Setor de atuação *</legend>
          <label><input type="radio" name="u-scope" checked={d.scopeAll} onChange={() => setD({ ...d, scopeAll: true })} />Todos os setores</label>
          <label><input type="radio" name="u-scope" checked={!d.scopeAll} onChange={() => setD({ ...d, scopeAll: false })} />Setores selecionados</label>
        </fieldset>
        {!d.scopeAll ? (
          <fieldset className="ig-checks">
            <legend>Setores</legend>
            {sectors.map((s) => <label key={s.id}><input type="checkbox" checked={d.sectorIds.includes(s.id)} onChange={(e) => setD({ ...d, sectorIds: toggle(d.sectorIds, s.id, e.target.checked) })} />{s.name}</label>)}
          </fieldset>
        ) : null}
        {err('sectorIds') ? <p className="ig-field-error" role="alert">{err('sectorIds')}</p> : null}
        </> : null}
        <div className="ig-form-row">
          <Field label="Situação da conta" error={err('status')}>
            <select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as AccountStatus })}>
              {(user ? (['ativo', 'pendente', 'suspenso', 'desativado'] as AccountStatus[]) : (['ativo', 'pendente'] as AccountStatus[])).map((s) => <option key={s} value={s}>{ACCOUNT_STATUS_LABEL[s]}</option>)}
            </select>
          </Field>
          {d.status === 'suspenso' || d.status === 'desativado' ? <Field label="Motivo" required error={err('statusReason')}><input value={d.statusReason} maxLength={500} onChange={(e) => setD({ ...d, statusReason: e.target.value })} /></Field> : null}
        </div>
        {isApprentice ? (
          <fieldset className="ig-fieldset">
            <legend>Permissões do Jovem Aprendiz</legend>
            <p className="ig-small ig-muted" style={{ marginTop: 0 }}>Só o necessário às atividades supervisionadas. Sem administração, liberação de cargas, decisões, dados identificados de pacientes ou concessão a terceiros.</p>
            <div className="ig-table-scroll">
              <table className="ig-table marker-grid">
                <caption className="ig-sr-only">Marcadores de acesso por área</caption>
                <thead><tr><th scope="col">Área</th>{LEVELS.map((l) => <th key={l} scope="col">{APPRENTICE_LEVEL_LABEL[l]}</th>)}</tr></thead>
                <tbody>
                  {areas.map((a) => (
                    <tr key={a}>
                      <th scope="row"><b>{APPRENTICE_AREAS[a].label}</b>{LEVELS.filter((l) => APPRENTICE_AREAS[a].levels[l]).map((l) => <span key={l} className="ig-small ig-muted"><br />{APPRENTICE_LEVEL_LABEL[l]}: {APPRENTICE_AREAS[a].levels[l]!.hint}</span>)}</th>
                      {LEVELS.map((l) => (
                        <td key={l}>{APPRENTICE_AREAS[a].levels[l] ? (
                          <input type="checkbox" aria-label={`${APPRENTICE_AREAS[a].label}: ${APPRENTICE_LEVEL_LABEL[l]}`} checked={hasMarker(a, l)} onChange={(e) => toggleMarker(a, l, e.target.checked)} />
                        ) : <span className="ig-muted" aria-label="Não se aplica">—</span>}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details>
              <summary>Ajuste fino por permissão</summary>
              <GrantChecks grantable={grantable} value={d.grants} onChange={(grants) => setD({ ...d, grants })} legend="Permissões permitidas ao Jovem Aprendiz" />
            </details>
            <div className="ig-form-row">
              <Field label="Início" error={err('validFrom')}><input type="date" value={d.validFrom} onChange={(e) => setD({ ...d, validFrom: e.target.value })} /></Field>
              <Field label="Expiração ou revisão" required error={err('validUntil')}><input type="date" value={d.validUntil} onChange={(e) => setD({ ...d, validUntil: e.target.value })} /></Field>
              <Field label="Responsável pela supervisão" required error={err('supervisorId')}>
                <select value={d.supervisorId} onChange={(e) => setD({ ...d, supervisorId: e.target.value })}><option value="">Selecione</option>{meta.supervisors.filter((s) => s.id !== user?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </Field>
            </div>
          </fieldset>
        ) : !adminOnly && grantable.length ? (
          <details className="ig-fieldset">
            <summary>Autorizações individuais (opcional)</summary>
            <p className="ig-small ig-muted">Para autorização institucional expressa (p. ex. liberação de cargas por um técnico). Só aparecem as permissões que você pode conceder.</p>
            <GrantChecks grantable={grantable} value={d.grants} onChange={(grants) => setD({ ...d, grants })} legend="Permissões concedidas" />
            <Field label="Válidas até" hint="Em branco: até serem revogadas."><input type="date" value={d.grantsUntil} onChange={(e) => setD({ ...d, grantsUntil: e.target.value })} /></Field>
          </details>
        ) : null}
        {err('grants') ? <p className="ig-field-error" role="alert">{err('grants')}</p> : null}
        <details>
          <summary>Permissões resultantes ({effective.length})</summary>
          <ul className="ig-small" style={{ columns: 2, marginBottom: 0 }}>{effective.map((p) => <li key={p}>{PERMISSIONS[p] ?? p}</li>)}</ul>
        </details>
        <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={err('justification') ?? undefined} />
        <div className="ig-form-actions">
          <Button type="submit" variant="primary" disabled={m.mutation.isPending}>{user ? 'Salvar acesso' : adminOnly ? 'Criar administrador' : 'Criar usuário'}</Button>
          <Button onClick={() => onDone()}>Cancelar</Button>
        </div>
      </form>
      <UnsavedChangesGuard when={d.justification !== ''} />
      <ConfirmDialog open={confirming} title={user ? 'Alterar o acesso do usuário?' : adminOnly ? 'Criar um Administrador do sistema?' : 'Criar o usuário?'} confirmLabel={user ? 'Salvar acesso' : 'Criar'} busy={m.mutation.isPending}
        onCancel={() => setConfirming(false)} onConfirm={save}>
        {adminOnly ? 'O novo administrador terá acesso a todas as áreas e configurações, exceto criar ou alterar outros administradores. Você ficará registrado como autorizador.' : user ? 'As permissões passam a valer imediatamente e as sessões abertas do usuário serão encerradas.' : 'Você ficará registrado como responsável pela autorização da conta.'}
      </ConfirmDialog>
    </Card>
  );
}

function GrantChecks({ grantable, value, onChange, legend }: { grantable: Permission[]; value: Permission[]; onChange: (v: Permission[]) => void; legend: string }) {
  return (
    <fieldset className="ig-checks">
      <legend>{legend}</legend>
      {grantable.map((p) => <label key={p}><input type="checkbox" checked={value.includes(p)} onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))} />{PERMISSIONS[p]}</label>)}
    </fieldset>
  );
}

function HistoryCard({ user, tz, onClose }: { user: AdminUser; tz: string; onClose: () => void }) {
  const admin = useAdmin()!;
  const q = useQuery({ queryKey: ['users', 'history', user.id], queryFn: () => admin.userHistory(user.id) });
  const roleName = (r: unknown) => (typeof r === 'string' ? (ROLE_LABEL[r as RoleCode] ?? r) : '—');
  const perms = (v: unknown) => ((v as { permissions?: string[] } | null)?.permissions ?? []);
  return (
    <Card title={`Histórico de ${user.displayName}`} actions={<Button size="sm" onClick={onClose}>Fechar</Button>}>
      {q.isPending ? <LoadingState /> : q.isError ? <ErrorState onRetry={() => void q.refetch()} /> : !q.data.entries.length ? <EmptyState title="Sem alterações registradas" /> : (
        <ol className="ig-stack" style={{ gap: 12, paddingLeft: 18 }}>
          {q.data.entries.map((e) => {
            const before = e.before as { functionRole?: string } | null;
            const after = e.after as { functionRole?: string } | null;
            const added = perms(e.after).filter((p) => !perms(e.before).includes(p));
            const removed = perms(e.before).filter((p) => !perms(e.after).includes(p));
            return (
              <li key={e.id}>
                <b>{formatDate(e.at, tz)}</b> · {e.by ?? 'sistema'} · {e.entity === 'app_user_password' ? 'senha redefinida' : e.action === 'create' ? 'conta criada' : e.action === 'unlock' ? 'desbloqueio' : 'acesso alterado'}
                {before?.functionRole !== after?.functionRole && after?.functionRole ? <div className="ig-small">Função: {roleName(before?.functionRole)} → {roleName(after.functionRole)}</div> : null}
                {added.length ? <div className="ig-small">Permissões novas: {added.map((p) => PERMISSIONS[p as Permission] ?? p).join('; ')}</div> : null}
                {removed.length ? <div className="ig-small">Permissões retiradas: {removed.map((p) => PERMISSIONS[p as Permission] ?? p).join('; ')}</div> : null}
                {e.justification ? <div className="ig-small ig-muted">Justificativa: {e.justification}</div> : null}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
