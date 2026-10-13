import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@ccih/domain';
import { Card, EmptyState, ErrorState, LoadingState } from '@ccih/ui';
import { ALL_NAV_ITEMS, navItemVisible, type NavItem } from '../../app/navigation';
import { useSession } from './session';

export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session.status === 'loading') return <div className="ig-root" style={{ padding: 24 }}><LoadingState label="Verificando sessão…" /></div>;
  if (session.status === 'error') return <div className="ig-root" style={{ padding: 24 }}><ErrorState onRetry={() => void session.refresh()} /></div>;
  if (session.status === 'anonymous') {
    const back = location.pathname + location.search;
    const params = new URLSearchParams();
    if (session.exitReason) params.set('motivo', session.exitReason);
    // After an explicit logout the next person starts from the home page (shared workstations).
    if (session.exitReason !== 'saida' && back !== '/') params.set('voltar', back);
    const qs = params.toString();
    return <Navigate to={`/entrar${qs ? `?${qs}` : ''}`} replace />;
  }
  // Temporary or expired password: only "Minha conta" is reachable (the API enforces the same).
  if (session.info?.mustChangePassword && location.pathname !== '/conta') return <Navigate to="/conta" replace />;
  return <>{children}</>;
}

/** Hides an area the profile cannot use. The API enforces the same rule on every request. */
export function Guard({ anyOf, children }: { anyOf: Permission[]; children: ReactNode }) {
  const session = useSession();
  if (session.can(...anyOf)) return <>{children}</>;
  return (
    <div className="page">
      <Card title="Sem acesso">
        <EmptyState title="Seu perfil não tem acesso a esta área">Se precisar dela, solicite ao administrador do sistema a revisão do seu perfil.</EmptyState>
      </Card>
    </div>
  );
}

/** A planned module of the menu: only in its model, and for the profiles it names. */
export function NavGuard({ item, children }: { item: NavItem; children: ReactNode }) {
  const session = useSession();
  if (navItemVisible(item, session.model, session.can)) return <>{children}</>;
  return <Guard anyOf={[]}>{null}</Guard>;
}

/** Home: the model's home; in a hospital, the dashboard for who can see it, otherwise the first permitted module. */
export function HomeRoute({ dashboard, consulting }: { dashboard: ReactNode; consulting: ReactNode }) {
  const session = useSession();
  if (session.model === 'consultoria') return <>{consulting}</>;
  if (session.can('dashboard:view')) return <>{dashboard}</>;
  const first = ALL_NAV_ITEMS.find((i) => i.path !== '/' && navItemVisible(i, session.model, session.can));
  return first ? <Navigate to={first.path} replace /> : <Guard anyOf={['dashboard:view']}>{null}</Guard>;
}
