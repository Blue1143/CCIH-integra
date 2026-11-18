import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConsultingDemo } from '@ccih/demo-data';
import { routes } from '../../app/routes';
import { ALL_NAV_ITEMS, navItemVisible } from '../../app/navigation';
import { DataSourceProvider } from '../../data/source';
import { SessionProvider } from '../auth/session';
import { DemoDataSource } from '../../data/demo/DemoDataSource';
import { DEMO_STORAGE_KEY, DemoConsultingStore } from './store';

const NOW = new Date('2026-11-17T15:00:00Z');

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DataSourceProvider source={new DemoDataSource(() => NOW)}>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </DataSourceProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  window.localStorage.clear();
  // Fixed reference date: series May–October 2026.
  window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(createConsultingDemo(NOW)));
});

const card = (name: string) => screen.getByRole('article', { name });

describe('Consultoria — Demonstração', () => {
  it('shows the permanent notice, the portfolio summary and the three institutions', async () => {
    renderAt('/demo/consultoria');
    expect(await screen.findByRole('heading', { level: 1, name: 'Consultoria — Demonstração' })).toBeInTheDocument();
    expect(screen.getByText('Ambiente demonstrativo — dados fictícios, sem uso assistencial.')).toBeInTheDocument();
    for (const n of ['Hospital Alfa (fictício)', 'Hospital Beta (fictício)', 'Instituto Gama de Retaguarda (fictício)']) expect(screen.getByRole('heading', { name: n })).toBeInTheDocument();
    const stats = screen.getByRole('heading', { name: 'Resumo da carteira' }).parentElement!;
    expect(within(stats).getByText('Planos de ação').nextElementSibling).toHaveTextContent('12');
    expect(within(stats).getByText('Relatórios emitidos').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByRole('link', { name: 'Consultoria — Demonstração' })).toBeInTheDocument();
  });

  it('opens the individual panel of an institution', async () => {
    const user = userEvent.setup();
    const router = renderAt('/demo/consultoria');
    const links = await screen.findAllByRole('link', { name: 'Abrir painel da instituição' });
    await user.click(links[1]!);
    expect(router.state.location.pathname).toBe('/demo/consultoria/instituicoes/beta');
    expect(await screen.findByRole('heading', { name: /Hospital Beta \(fictício\) · Toda a instituição/ })).toBeInTheDocument();
    expect(card('Densidade de incidência de PAV')).toHaveTextContent('8,0');
  });

  it('shows numerator, denominator, formula, unit and the comparison that respects the denominators', async () => {
    renderAt('/demo/consultoria/indicadores?inst=beta&de=2026-08-01&ate=2026-10-01');
    const pav = await screen.findByRole('article', { name: 'Densidade de incidência de PAV' });
    expect(pav).toHaveTextContent('11,0‰');
    expect(pav).toHaveTextContent('14 PAV confirmadas');
    expect(pav).toHaveTextContent('1.274 Ventilação mecânica-dia');
    expect(pav).toHaveTextContent('(PAV confirmadas ÷ Ventilação mecânica-dia) × 1.000');
    expect(pav).toHaveTextContent('4,6 ‰');
    expect(pav).toHaveTextContent('5 PAV confirmadas / 1.097 Ventilação mecânica-dia');
    expect(pav).toHaveTextContent('+6,4 ‰ (piora)');
    expect(pav).toHaveTextContent('Meta fictícia');
    expect(within(pav).getByText('Fora da meta')).toBeInTheDocument();
  });

  it('never turns a zero denominator or a missing month into a rate', async () => {
    renderAt('/demo/consultoria/indicadores?inst=gama');
    const pav = await screen.findByRole('article', { name: 'Densidade de incidência de PAV' });
    expect(pav).toHaveTextContent('Denominador zero');
    const itu = card('Densidade de incidência de ITU-AC');
    expect(itu).toHaveTextContent('Dados incompletos');
    expect(itu).toHaveTextContent('Unidade de Transição — ago/26');
  });

  it('filters by institution, unit and period through the URL', async () => {
    const user = userEvent.setup();
    const router = renderAt('/demo/consultoria/indicadores');
    await screen.findByRole('heading', { name: 'Comparação entre as instituições' });
    await user.selectOptions(screen.getByLabelText('Instituição'), 'alfa');
    expect(router.state.location.search).toContain('inst=alfa');
    await user.selectOptions(screen.getByLabelText('Unidade'), 'alfa-uti');
    await user.selectOptions(screen.getByLabelText('De'), '2026-10-01');
    expect(router.state.location.search).toContain('unidade=alfa-uti');
    expect(router.state.location.search).toContain('de=2026-10-01');
    // October in the Alfa ICU: 0 IPCS / 170 catheter-days.
    expect(card('Densidade de incidência de IPCS')).toHaveTextContent('0 IPCS confirmadas');
    expect(card('Densidade de incidência de IPCS')).toHaveTextContent('170 Cateter central-dia');
  });

  it('the report shows the same numbers as the indicator cards and separates observed data from hypotheses', async () => {
    renderAt('/demo/consultoria/relatorios?inst=beta&de=2026-08-01&ate=2026-10-01');
    const report = await screen.findByRole('article', { name: 'Relatório de consultoria — demonstração' });
    const table = within(report).getByRole('table', { name: 'Indicadores do período' });
    const pavRow = within(table).getByText('Densidade de incidência de PAV').closest('tr')!;
    expect(pavRow).toHaveTextContent('14');
    expect(pavRow).toHaveTextContent('1.274');
    expect(pavRow).toHaveTextContent('11,0 ‰');
    expect(within(report).getByRole('heading', { name: '5. Dados observados' })).toBeInTheDocument();
    const hyp = within(report).getByRole('heading', { name: '6. Hipóteses que exigiriam investigação' }).parentElement!;
    expect(hyp).toHaveTextContent('PAV passou de 4,6 ‰ para 11,0 ‰');
    expect(report).toHaveTextContent('não gerado por inteligência artificial');
    expect(screen.getByRole('button', { name: 'Imprimir ou salvar em PDF' })).toBeInTheDocument();
  });

  it('classifies the checklist and records observations', async () => {
    const user = userEvent.setup();
    renderAt('/demo/consultoria/diagnostico?inst=beta');
    expect(await screen.findByText(/não representa certificação, acreditação nem avaliação regulatória/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Concluir avaliação' })).toBeDisabled();
    const group = screen.getByRole('radiogroup', { name: 'Avaliação de aprendizagem aplicada após as capacitações' });
    await user.click(within(group).getByLabelText('Não se aplica'));
    expect(screen.getByText('2 item(ns) sem resposta: responda todos para concluir a avaliação.')).toBeInTheDocument();
    const saved = JSON.parse(window.localStorage.getItem(DEMO_STORAGE_KEY)!);
    expect(saved.assessments.find((a: { id: string }) => a.id === 'beta-2').responses.find((r: { itemId: string }) => r.itemId === 'c4').answer).toBe('nao_se_aplica');
  });

  it('shows pending, in progress, completed and overdue actions, each linked to its finding', async () => {
    const user = userEvent.setup();
    renderAt('/demo/consultoria/planos');
    const tiles = await screen.findByRole('group', { name: 'Filtrar por situação' });
    expect(within(tiles).getByRole('button', { name: /Atrasadas\s*3/ })).toBeInTheDocument();
    await user.click(within(tiles).getByRole('button', { name: /Atrasadas/ }));
    const table = screen.getByRole('table', { name: 'Ações' });
    expect(within(table).getAllByText('Atrasada')).toHaveLength(3);
    expect(within(table).getByRole('link', { name: 'Busca ativa de infecções associadas a dispositivos realizada com periodicidade definida' })).toBeInTheDocument();
  });

  it('creates an action from a finding', async () => {
    const user = userEvent.setup();
    renderAt('/demo/consultoria/planos?inst=beta&nova=beta-2:c3');
    expect(await screen.findByLabelText(/^Problema identificado/)).toHaveValue('Equipes das unidades críticas capacitadas nos protocolos de dispositivos — Equipe noturna da UTI Coronariana sem capacitação registrada.');
    await user.click(screen.getByRole('button', { name: 'Registrar ação' }));
    expect(screen.getByText('Descreva a ação.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Ação/), 'Capacitar a equipe noturna');
    await user.type(screen.getByLabelText(/^Responsável/), 'Enf. Teste Fictício');
    await user.type(screen.getByLabelText(/^Prazo/), '2026-12-10');
    await user.click(screen.getByRole('button', { name: 'Registrar ação' }));
    expect(await screen.findByText('Ação registrada na demonstração e vinculada ao achado.')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Ações' })).toHaveTextContent('Capacitar a equipe noturna');
  });

  it('restores only the demonstration data', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('outra-chave', 'intocada');
    renderAt('/demo/consultoria/diagnostico?inst=beta');
    const group = await screen.findByRole('radiogroup', { name: 'Avaliação de aprendizagem aplicada após as capacitações' });
    await user.click(within(group).getByLabelText('Conforme'));
    await user.click(screen.getByRole('button', { name: 'Restaurar dados iniciais' }));
    await user.click(screen.getByRole('button', { name: 'Restaurar' }));
    expect(await screen.findByText(/Dados iniciais da demonstração restaurados/)).toBeInTheDocument();
    expect(window.localStorage.getItem('outra-chave')).toBe('intocada');
    const saved = JSON.parse(window.localStorage.getItem(DEMO_STORAGE_KEY)!);
    expect(saved.assessments.find((a: { id: string }) => a.id === 'beta-2').responses.find((r: { itemId: string }) => r.itemId === 'c4').answer).toBeNull();
  });

  it('generates the rule-based summary, identified as such', async () => {
    const user = userEvent.setup();
    renderAt('/demo/consultoria/indicadores?inst=gama');
    await user.click(await screen.findByRole('button', { name: 'Gerar resumo por regras' }));
    expect(screen.getByText('Resumo automático por regras (modelo de texto) — não gerado por inteligência artificial')).toBeInTheDocument();
    const missing = screen.getByRole('heading', { name: 'Dados ausentes ou incompletos' }).parentElement!;
    expect(missing).toHaveTextContent('PAV: denominador zero (Ventilação mecânica-dia = 0)');
    expect(missing).toHaveTextContent('Unidade de Transição — ago/26');
  });
});

describe('Consultoria — Demonstração: availability and isolation', () => {
  it('is offered to consulting organizations and on the demo source, not to hospitals on the API', () => {
    const item = ALL_NAV_ITEMS.find((i) => i.path === '/demo/consultoria')!;
    const can = () => true;
    expect(navItemVisible(item, 'consultoria', can)).toBe(true);
    expect(navItemVisible(item, 'hospitalar', can, true)).toBe(true);
    expect(navItemVisible(item, 'hospitalar', can, false)).toBe(false);
  });

  it('keeps working in memory when the browser blocks storage, and rejects foreign data', () => {
    const memory = new DemoConsultingStore(() => NOW, null);
    expect(memory.persistent).toBe(false);
    expect(memory.getState().periods[0]).toBe('2026-05-01');
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ version: 99 }));
    const store = new DemoConsultingStore(() => NOW);
    expect(store.getState().version).toBe(1);
    expect(store.getState().institutions).toHaveLength(3);
  });
});
