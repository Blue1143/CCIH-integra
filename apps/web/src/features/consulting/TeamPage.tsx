import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ASSIGNMENT_ROLE_LABEL, ROLE_LABEL, SPECIALTY_LABEL, type RoleCode, type TeamMemberDto } from '@ccih/domain';
import { DataTable, StatusBadge, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { PageHeader } from '../clinical/shared';
import { RequireConsulting, useConsulting } from './shared';

export function TeamPage() {
  return <RequireConsulting title="Equipe e carteiras"><Team /></RequireConsulting>;
}

/** Distribution of the portfolio: who answers for which clients. Accounts are managed in Administração. */
function Team() {
  const consulting = useConsulting()!;
  const session = useSession();
  const q = useQuery({ queryKey: ['consulting', 'team'], queryFn: () => consulting.team() });
  const cols: Column<TeamMemberDto>[] = [
    { key: 'name', label: 'Profissional', value: (m) => m.name, render: (m) => <span><b>{m.name}</b><br /><span className="ig-small ig-muted ig-mono">{m.login}</span></span> },
    { key: 'roles', label: 'Função', value: (m) => m.roles.map((r) => ROLE_LABEL[r as RoleCode] ?? r).join(', ') },
    { key: 'status', label: 'Conta', render: (m) => (m.active ? <StatusBadge status="ok">Ativa</StatusBadge> : <StatusBadge status="neutral">Inativa</StatusBadge>) },
    { key: 'count', label: 'Clientes', value: (m) => m.clients.length },
    { key: 'clients', label: 'Carteira', render: (m) => (m.clients.length ? (
      <ul className="consulting-portfolio">{m.clients.map((c) => <li key={c.clientId}><Link to={`/consultoria/clientes/${c.clientId}`}>{c.clientName}</Link> <span className="ig-small ig-muted">· {ASSIGNMENT_ROLE_LABEL[c.role]}{c.specialty ? ` · ${SPECIALTY_LABEL[c.specialty]}` : ''}</span></li>)}</ul>
    ) : <span className="ig-muted">—</span>) },
  ];
  return (
    <div className="page">
      <PageHeader title="Equipe e carteiras" subtitle={<>Quem atende cada cliente. A distribuição é feita na ficha de cada cliente; contas e funções ficam em {session.can('users:view', 'users:manage') ? <Link to="/admin/usuarios">Administração → Gestão de usuários</Link> : 'Administração'}.</>} />
      <DataTable caption="Equipe da consultoria" rows={q.data?.members ?? []} rowKey={(m) => m.userId} columns={cols} state={q.isPending ? 'loading' : q.isError ? 'error' : 'ready'} emptyMessage="Nenhum profissional cadastrado." />
    </div>
  );
}
