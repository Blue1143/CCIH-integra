import { useId, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { DEMO_CONSULTING_NOTICE, monthLongLabel } from '@ccih/domain';
import { DEMO_CONSULTING_SOURCE } from '@ccih/demo-data';
import { Button, ConfirmDialog, EnvironmentBanner, FormMessage, ProvenanceTag, SubNav } from '@ccih/ui';
import { DemoConsultingProvider, useDemoState, useDemoStore } from './store';
import { useDemoFilters } from './filters';
import { DEMO_BASE, demoLink, fmtDay } from './parts';

const SECTIONS = [
  { key: 'visao', label: 'Visão geral', path: '' },
  { key: 'indicadores', label: 'Indicadores', path: '/indicadores' },
  { key: 'diagnostico', label: 'Diagnóstico', path: '/diagnostico' },
  { key: 'planos', label: 'Planos de ação', path: '/planos' },
  { key: 'relatorios', label: 'Relatórios', path: '/relatorios' },
];

/** "Consultoria — Demonstração": its own data store, banner, filters and sub-navigation. */
export function DemoConsultingLayout() {
  return (
    <DemoConsultingProvider>
      <DemoShell />
    </DemoConsultingProvider>
  );
}

function DemoShell() {
  const state = useDemoState();
  const store = useDemoStore();
  const [filter, setFilter] = useDemoFilters(state);
  const { pathname } = useLocation();
  const [confirm, setConfirm] = useState(false);
  const [restored, setRestored] = useState(false);
  const ids = { inst: useId(), unit: useId(), from: useId(), to: useId() };
  const inst = state.institutions.find((i) => i.id === filter.institutionId);
  const sub = pathname.slice(DEMO_BASE.length);
  const active = (path: string) => (path === '' ? sub === '' || sub === '/' || sub.startsWith('/instituicoes') : sub.startsWith(path));

  return (
    <div className="page demo-area">
      <div className="demo-notice">
        <EnvironmentBanner>{DEMO_CONSULTING_NOTICE}</EnvironmentBanner>
      </div>
      <header className="page-head">
        <div>
          <span className="ig-label">Demonstração acadêmica do protótipo</span>
          <h1 className="page-title">Consultoria — Demonstração</h1>
          <p className="page-sub">
            Prevenção e controle de infecções · três instituições fictícias · série de {monthLongLabel(state.periods[0]!)} a {monthLongLabel(state.periods[5]!)} · data de referência {fmtDay(state.referenceDate)}{' '}
            <ProvenanceTag kind="demo" title={DEMO_CONSULTING_SOURCE}>Dados fictícios</ProvenanceTag>
          </p>
        </div>
        <div className="ig-row demo-noprint" style={{ gap: 8 }}>
          <Button icon="refresh" onClick={() => { setRestored(false); setConfirm(true); }}>Restaurar dados iniciais</Button>
        </div>
      </header>
      {restored ? <FormMessage tone="success">Dados iniciais da demonstração restaurados. Nenhum outro dado do sistema foi alterado.</FormMessage> : null}
      {!store.persistent ? <FormMessage tone="error">O navegador bloqueou o armazenamento local: as alterações valem só enquanto a página estiver aberta.</FormMessage> : null}

      <div className="demo-noprint">
        <SubNav
          label="Seções da demonstração"
          items={SECTIONS.map((s) => ({ key: s.key, label: s.label, active: active(s.path), href: demoLink(s.path, filter) }))}
          renderLink={(item, className) => <Link to={item.href} className={className} aria-current={item.active ? 'page' : undefined}>{item.label}</Link>}
        />
      </div>

      <form className="filters demo-noprint" aria-label="Filtros da demonstração" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor={ids.inst}>Instituição</label>
          <select id={ids.inst} className="select" value={filter.institutionId ?? ''} onChange={(e) => setFilter({ inst: e.target.value || null })}>
            <option value="">Todas (carteira)</option>
            {state.institutions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.unit}>Unidade</label>
          <select id={ids.unit} className="select" value={filter.unitId ?? ''} disabled={!inst} onChange={(e) => setFilter({ unidade: e.target.value || null })}>
            <option value="">{inst ? 'Todas' : 'Escolha a instituição'}</option>
            {inst?.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.from}>De</label>
          <select id={ids.from} className="select" value={filter.from} onChange={(e) => setFilter({ de: e.target.value, ...(e.target.value > filter.to ? { ate: e.target.value } : {}) })}>
            {state.periods.map((p) => <option key={p} value={p}>{monthLongLabel(p)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.to}>Até</label>
          <select id={ids.to} className="select" value={filter.to} onChange={(e) => setFilter({ ate: e.target.value, ...(e.target.value < filter.from ? { de: e.target.value } : {}) })}>
            {state.periods.map((p) => <option key={p} value={p}>{monthLongLabel(p)}</option>)}
          </select>
        </div>
        <p className="ig-small ig-muted" style={{ margin: 0, flex: '1 1 240px' }}>
          A comparação usa a janela de mesmo tamanho imediatamente anterior, quando existe na série. Taxas sempre recalculadas a partir das contagens somadas.
        </p>
      </form>

      <Outlet />

      <ConfirmDialog
        open={confirm}
        title="Restaurar os dados iniciais da demonstração?"
        confirmLabel="Restaurar"
        tone="danger"
        onCancel={() => setConfirm(false)}
        onConfirm={() => { store.reset(); setConfirm(false); setRestored(true); }}
      >
        <p>Respostas do checklist, ações e relatórios registrados nesta demonstração voltam ao estado inicial, e a data de referência passa a ser hoje.</p>
        <p>Somente os dados fictícios desta área são afetados: nenhum outro ambiente, configuração ou registro do sistema é alterado.</p>
      </ConfirmDialog>
    </div>
  );
}
