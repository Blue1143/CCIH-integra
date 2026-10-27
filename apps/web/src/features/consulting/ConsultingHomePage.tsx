import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ORGANIZATION_TYPE_LABEL } from '@ccih/domain';
import { Card, DataTable, StatusBadge } from '@ccih/ui';
import { contractColumns } from './ContractsPage';
import { useConsulting } from './shared';
import { NAVIGATION, phaseLabel } from '../../app/navigation';
import { useSession } from '../auth/session';

/**
 * Home of a consulting organization. While the consulting modules are being delivered it states
 * plainly what is available and what is not: no indicator or number is shown without real data.
 */
export function ConsultingHomePage() {
  const session = useSession();
  const modules = NAVIGATION.flatMap((g) => g.items).filter((i) => i.models?.includes('consultoria') && i.path !== '/');
  const canUsers = session.can('users:view', 'users:manage');
  const canAudit = session.can('audit:view');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{session.info?.organization?.name ?? 'Consultoria'}</h1>
          <p className="page-sub">{ORGANIZATION_TYPE_LABEL.consultoria}: carteira de clientes, contratos, agenda, equipe, avaliações, planos de ação, relatórios e área do cliente.</p>
        </div>
      </header>
      <Card title="Disponível agora" headingLevel={2}>
        <ul className="consulting-links">
          {canUsers ? <li><Link to="/admin/usuarios">Equipe e acessos</Link> — cadastro de usuários da consultoria, com situação, validade e histórico.</li> : null}
          {canAudit ? <li><Link to="/admin/auditoria">Log de auditoria</Link> — quem fez o quê, com registro imutável.</li> : null}
          {session.can('alerts:view') ? <li><Link to="/alertas">Alertas</Link> — prazos e pendências (passam a ser gerados pelos módulos da consultoria conforme forem entregues).</li> : null}
          <li><Link to="/conta">Minha conta</Link> — senha e sessão.</li>
        </ul>
      </Card>
      {session.can('consultoria:contracts:view') ? <ExpiringContracts /> : null}
      <Card title="Módulos da consultoria" subtitle="Entregues por etapas; cada um só aparece como disponível quando registra dados reais." headingLevel={2}>
        <div className="ig-table-scroll"><table className="ig-table">
          <caption className="ig-sr-only">Situação dos módulos da consultoria</caption>
          <thead><tr><th scope="col">Módulo</th><th scope="col">O que faz</th><th scope="col">Situação</th></tr></thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.path}>
                <th scope="row"><Link to={m.path}>{m.label}</Link></th>
                <td>{m.summary}</td>
                <td>{m.phase ? <StatusBadge status="neutral">Em desenvolvimento — {phaseLabel(m.phase)}</StatusBadge> : <StatusBadge status="ok">Disponível</StatusBadge>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    </div>
  );
}

/** Signed contracts within their notice window or past the end, for who sees contracts (own scope). */
function ExpiringContracts() {
  const consulting = useConsulting();
  const q = useQuery({ queryKey: ['consulting', 'contracts', { expiring: '1' }], queryFn: () => consulting!.contracts({ expiring: '1', pageSize: 10 }), enabled: !!consulting });
  if (!consulting) return null;
  return (
    <Card title="Contratos vencendo ou vencidos" subtitle="Dentro do prazo de aviso de cada contrato. Renove por aditivo ou registre o encerramento." headingLevel={2}
      actions={<Link to="/consultoria/contratos?vencendo=1">Ver todos</Link>}>
      <DataTable caption="Contratos vencendo" dense rows={q.data?.rows ?? []} rowKey={(c) => c.id} columns={contractColumns(true).filter((c) => ['code', 'client', 'term', 'situation'].includes(c.key))}
        state={q.isPending ? 'loading' : q.isError ? 'error' : 'ready'} emptyMessage="Nenhum contrato perto do vencimento." />
    </Card>
  );
}
