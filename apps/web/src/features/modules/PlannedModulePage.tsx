import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@ccih/ui';
import { phaseLabel, type NavItem } from '../../app/navigation';
import { useSession } from '../auth/session';

/** States plainly that a module is not built yet; shows no invented content. */
export function PlannedModulePage({ item }: { item: NavItem }) {
  const session = useSession();
  return (
    <div className="page planned">
      <header className="page-head">
        <div>
          <h1 className="page-title">{item.label}</h1>
          <p className="page-sub">{item.summary}</p>
        </div>
      </header>
      <Card title={`Em desenvolvimento — ${phaseLabel(item.phase!)}`} subtitle="Este módulo ainda não registra nem exibe dados.">
        <EmptyState title="Módulo ainda não implantado">
          {session.model === 'consultoria'
            ? <>A situação de cada módulo está no <Link to="/">Início</Link>.</>
            : <>Os indicadores agregados já disponíveis estão na <Link to="/">Visão Geral</Link> e no <Link to="/indicadores">catálogo de indicadores</Link>.</>}
        </EmptyState>
        {item.planned?.length ? (
          <>
            <p className="ig-label" style={{ margin: '8px 0 0' }}>Escopo previsto</p>
            <ul>{item.planned.map((p) => <li key={p}>{p}</li>)}</ul>
          </>
        ) : null}
      </Card>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <h1 className="page-title">Página não encontrada</h1>
      <p><Link to="/">Voltar para a Visão Geral</Link></p>
    </div>
  );
}
