import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ROLE_LABEL, type RoleCode } from '@ccih/domain';
import { EnvironmentBanner, Icon } from '@ccih/ui';
import { useDataSource, useInstitution } from '../data/source';
import { REALTIME_LABEL, useRealtimeSync } from '../data/realtime';
import { useSession } from '../features/auth/session';
import { IdleWarning } from '../features/auth/IdleWarning';
import { useAlertCount } from '../features/operations/AlertsPage';
import { useUnreadNotifications } from '../features/inbox/NotificationsPage';
import { ErrorBoundary } from './ErrorBoundary';
import { NAVIGATION, navItemVisible, phaseLabel } from './navigation';
import { THEME_LABEL, useTheme } from './theme';

export function AppShell() {
  const source = useDataSource();
  const session = useSession();
  const institution = useInstitution();
  const [theme, cycleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setMenuOpen(false), [pathname]);

  // The banner follows the data, not only the source: an API backed by a demo database is still demo.
  const demo = source.origin === 'demo' || institution.data?.provenance.origin === 'demo';
  const roles = (session.info?.roles ?? []).map((r) => ROLE_LABEL[r as RoleCode] ?? r).join(', ');
  const alertCount = useAlertCount();
  const urgent = (alertCount.data?.byPriority.critica ?? 0) + (alertCount.data?.byPriority.alta ?? 0);
  const unread = useUnreadNotifications().data?.unread ?? 0;
  const forced = !!session.info?.mustChangePassword;
  const realtime = useRealtimeSync(session.status === 'authenticated' && !forced);
  const groups = (forced ? [] : NAVIGATION).map((g) => ({ ...g, items: g.items.filter((i) => navItemVisible(i, session.model, session.can)) })).filter((g) => g.items.length);

  return (
    <div className="app ig-root">
      <a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
      {demo ? <EnvironmentBanner /> : null}
      <header className="topbar">
        <button type="button" className="ig-btn ig-btn-ghost ig-btn-sm topbar-menu" aria-expanded={menuOpen} aria-controls="menu-principal" onClick={() => setMenuOpen((o) => !o)}>
          <Icon name={menuOpen ? 'close' : 'menu'} size={18} />
          <span className="ig-sr-only">Menu</span>
        </button>
        <div className="brand">
          <span className="brand-name">CCIH Integra</span>
          <span className="brand-inst">{institution.data?.data.config.institutionName ?? ' '}</span>
        </div>
        <div className="topbar-tools">
          <button type="button" className="ig-btn ig-btn-ghost ig-btn-sm" onClick={cycleTheme} aria-label={`${THEME_LABEL[theme]}. Alternar tema`}>
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} />
            <span className="hide-sm">{THEME_LABEL[theme]}</span>
          </button>
          {realtime !== 'desligado' ? (
            <span className={`rt-status rt-${realtime}`} role="status" title={REALTIME_LABEL[realtime].title}>
              <span className="rt-dot" aria-hidden="true" />
              <span className="hide-sm">{REALTIME_LABEL[realtime].text}</span>
              <span className="ig-sr-only">{REALTIME_LABEL[realtime].title}</span>
            </span>
          ) : null}
          {session.info ? (
            <>
              {source.inbox && !forced ? (
                <Link to="/notificacoes" className="ig-btn ig-btn-ghost ig-btn-sm bell-link" aria-label={unread ? `Notificações: ${unread} não lida${unread > 1 ? 's' : ''}` : 'Notificações'}>
                  <Icon name="bell" size={16} />
                  {unread ? <span className="nav-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span> : null}
                </Link>
              ) : null}
              <Link to="/conta" className="user-chip hide-sm" title={`${roles} — Minha conta`}>
                <b>{session.info.user.displayName}</b>
                <span>{roles}</span>
              </Link>
              <button type="button" className="ig-btn ig-btn-sm" onClick={() => void session.logout('saida')}>
                Sair
              </button>
            </>
          ) : null}
        </div>
      </header>
      <div className="layout">
        <nav id="menu-principal" className={menuOpen ? 'sidebar open' : 'sidebar'} aria-label="Principal">
          {groups.map((group, gi) => (
            <div key={gi} className="nav-group">
              {group.label ? <p className="nav-group-label">{group.label}</p> : null}
              <ul>
                {group.items.map((item) => (
                  <li key={item.path}>
                    <NavLink to={item.path} end={item.path === '/'} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                      <span>{item.label}</span>
                      {item.phase ? <span className="nav-phase"><span className="ig-sr-only"> — em desenvolvimento, </span>{phaseLabel(item.phase)}</span> : null}
                      {item.path === '/alertas' && urgent ? <span className="nav-count" title="Alertas abertos de gravidade crítica ou alta"><span className="ig-sr-only"> — </span>{urgent}<span className="ig-sr-only"> de gravidade crítica ou alta</span></span> : null}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main id="conteudo" className="main" tabIndex={-1}>
          <IdleWarning />
          <ErrorBoundary resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
