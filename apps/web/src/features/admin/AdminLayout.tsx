import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Permission } from '@ccih/domain';
import { SubNav } from '@ccih/ui';
import { useSession } from '../auth/session';

export const ADMIN_SECTIONS: Array<{ key: string; label: string; path: string; permissions: Permission[] }> = [
  { key: 'metas', label: 'Metas', path: '/admin/metas', permissions: ['config:view'] },
  { key: 'parametros', label: 'Parâmetros', path: '/admin/parametros', permissions: ['config:view'] },
  { key: 'referencias', label: 'Referências', path: '/admin/referencias', permissions: ['config:view'] },
  { key: 'cme', label: 'Política da CME', path: '/admin/cme', permissions: ['config:view'] },
  { key: 'setores', label: 'Unidades e setores', path: '/admin/setores', permissions: ['config:view'] },
  { key: 'usuarios', label: 'Gestão de usuários', path: '/admin/usuarios', permissions: ['users:view', 'users:manage', 'users:manage:ccih', 'users:manage:cme'] },
  { key: 'auditoria', label: 'Log de auditoria', path: '/admin/auditoria', permissions: ['audit:view', 'audit:view:module'] },
];

export function AdminLayout() {
  const session = useSession();
  const { pathname } = useLocation();
  const sections = ADMIN_SECTIONS.filter((s) => session.can(...s.permissions));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Administração</h1>
          <p className="page-sub">Configuração institucional, acessos e trilha de auditoria. Toda alteração exige justificativa e fica registrada.</p>
        </div>
      </header>
      <SubNav
        label="Seções da administração"
        items={sections.map((s) => ({ key: s.key, label: s.label, href: s.path, active: pathname.startsWith(s.path) }))}
        renderLink={(item, className) => <Link to={item.href} className={className} aria-current={item.active ? 'page' : undefined}>{item.label}</Link>}
      />
      <Outlet />
    </div>
  );
}

export function AdminIndex() {
  const session = useSession();
  const first = ADMIN_SECTIONS.find((s) => session.can(...s.permissions));
  return first ? <Navigate to={first.path} replace /> : null;
}
