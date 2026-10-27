import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, effectivePermissions, type ContractDetailDto, type RoleCode } from '@ccih/domain';
import { DemoDataSource } from '../../data/demo/DemoDataSource';
import { DataSourceProvider } from '../../data/source';
import type { AuthPort, CcihDataSource, ConsultingPort } from '../../data/port';
import { routes } from '../../app/routes';
import { SessionProvider } from '../auth/session';

const plan = { current: { start: '2026-10-15', end: '2026-11-15', planned: 2, done: 1 }, closedPeriods: 3, plannedClosed: 6, doneClosed: 5, lastClosed: { start: '2026-09-15', end: '2026-10-15', planned: 2, done: 1 }, doneTotal: 6 };
const DETAIL: ContractDetailDto = {
  id: 'k1', code: 'CT-2026-001', title: 'Assessoria em CCIH', clientId: 'c1', clientName: 'Hospital São Lucas', status: 'vigente', situation: 'vigente',
  startsOn: '2026-07-15', endsOn: '2026-11-20', autoRenew: false, renewalNoticeDays: 60, expiry: 'vencendo', daysToEnd: 24, services: 1, amendments: 0, responsible: 'Gestora',
  plannedClosed: 6, doneClosed: 5, dataOrigin: 'real', scopeNotes: null, signedOn: '2026-07-10', closedOn: null, closeReason: null, responsibleId: 'p1', rowVersion: 3,
  createdAt: '2026-07-01T12:00:00Z', updatedAt: '2026-07-10T12:00:00Z',
  serviceLines: [{ id: 's1', area: 'ccih', kind: 'visita_tecnica', description: 'Visita técnica à CCIH', establishmentId: null, establishmentName: null, unit: 'visitas', quantity: 2, period: 'mensal', startsOn: '2026-07-15', endsOn: null, replacesId: null, amendmentId: null, plan }],
  deliveries: [{ id: 'd1', serviceId: 's1', occurredOn: '2026-10-16', quantity: 1, description: 'Visita mensal', by: 'Consultor', at: '2026-10-16T12:00:00Z', voidedAt: null, voidedBy: null, voidReason: null }],
  amendmentList: [], history: [{ id: 'h1', summary: 'Contrato CT-2026-001 assinado.', detail: null, occurredOn: '2026-07-10', by: 'Gestora', at: '2026-07-10T12:00:00Z' }],
  establishments: [],
};

function setup(role: RoleCode, detail: ContractDetailDto = DETAIL, path = '/consultoria/contratos/k1') {
  const demo = new DemoDataSource(() => new Date('2026-10-27T12:00:00Z'));
  const auth: AuthPort = {
    me: async () => ({
      user: { id: 'u1', login: role, displayName: 'Pessoa' }, roles: [role], permissions: effectivePermissions(DEFAULT_ROLE_PERMISSIONS[role], 'consultoria'), scope: null, isFounder: false,
      organization: { type: 'consultoria', name: 'Consultoria Exemplo' }, session: { expiresAt: '2026-10-27T23:00:00Z', idleExpiresAt: '2026-10-27T13:00:00Z', idleMinutes: 30 },
    }),
    login: async () => undefined, logout: async () => undefined, changePassword: async () => undefined,
  };
  const consulting = {
    contract: vi.fn(async () => detail),
    contracts: vi.fn(async () => ({ rows: [detail], total: 1, page: 1, pageSize: 25 })),
    team: vi.fn(async () => ({ members: [] })),
    addAmendment: vi.fn(async () => detail),
    addDelivery: vi.fn(async () => detail),
    saveFinancial: vi.fn(async () => detail),
    setContractStatus: vi.fn(async () => detail),
  } as unknown as ConsultingPort & Record<string, ReturnType<typeof vi.fn>>;
  const source: CcihDataSource = { origin: 'real', auth, consulting, getInstitution: () => demo.getInstitution(), getFacts: (q) => demo.getFacts(q) };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DataSourceProvider source={source}><SessionProvider><RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} /></SessionProvider></DataSourceProvider>
    </QueryClientProvider>,
  );
  return { consulting };
}

describe('consulting contracts (interface)', () => {
  it('lists contracts with the end of term and the planned × done of closed periods', async () => {
    setup('gestor_consultoria', DETAIL, '/consultoria/contratos');
    const table = await screen.findByRole('table', { name: 'Contratos' });
    expect(within(table).getByRole('link', { name: 'CT-2026-001' })).toHaveAttribute('href', '/consultoria/contratos/k1');
    expect(within(table).getByText('Vence em 24 dia(s)')).toBeInTheDocument();
    expect(within(table).getByLabelText('Entregas de CT-2026-001: 5 de 6 (83%)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nova proposta' })).toBeInTheDocument();
  });

  it('shows the consultant the scope and deliveries, without financial terms, amendments or status changes', async () => {
    const user = userEvent.setup();
    const { consulting } = setup('consultor');
    expect(await screen.findByRole('heading', { name: /CT-2026-001/ })).toBeInTheDocument();
    expect(screen.getByText('2 visitas por mês')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Condições financeiras' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Registrar aditivo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Encerrar contrato' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Registrar entrega de Visita técnica à CCIH' }));
    await user.click(screen.getByRole('button', { name: 'Registrar entrega' }));
    expect(await screen.findByText('Descreva o que foi entregue.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^O que foi entregue/), 'Visita de acompanhamento');
    await user.click(screen.getByRole('button', { name: 'Registrar entrega' }));
    await waitFor(() => expect(consulting.addDelivery).toHaveBeenCalledWith('s1', { occurredOn: null, quantity: 1, description: 'Visita de acompanhamento' }));
  });

  it('keeps the financial terms to the financial profile, validating the amount', async () => {
    const user = userEvent.setup();
    const { consulting } = setup('financeiro_consultoria', { ...DETAIL, financial: null });
    expect(await screen.findByText('Condições financeiras não informadas.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Registrar entrega/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Informar condições' }));
    await user.type(screen.getByLabelText(/^Valor/), 'abc');
    await user.click(screen.getByRole('button', { name: 'Salvar condições' }));
    expect(await screen.findByText(/Valor inválido/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Valor/));
    await user.type(screen.getByLabelText(/^Valor/), '4.500,00');
    await user.click(screen.getByRole('button', { name: 'Salvar condições' }));
    await waitFor(() => expect(consulting.saveFinancial).toHaveBeenCalledWith('k1', expect.objectContaining({ basis: 'mensal', amountCents: 450000, rowVersion: null })));
  });

  it('records an amendment that renews the term and changes the frequency of a service', async () => {
    const user = userEvent.setup();
    const { consulting } = setup('gestor_consultoria');
    expect(screen.queryByRole('heading', { name: 'Condições financeiras' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Registrar aditivo' }));
    await user.click(screen.getByRole('checkbox', { name: 'Renovação' }));
    await user.click(screen.getByRole('button', { name: 'Registrar aditivo' }));
    expect(await screen.findByText('Informe o novo término (prazo ou renovação).')).toBeInTheDocument();
    const form = within(screen.getByRole('button', { name: 'Registrar aditivo' }).closest('form')!);
    await user.type(form.getByLabelText(/^Assinatura/), '2026-10-27');
    await user.type(form.getByLabelText(/^Efeito a partir de/), '2026-11-21');
    await user.type(form.getByLabelText(/^Novo término/), '2027-11-20');
    await user.type(form.getByLabelText(/^Descrição do aditivo/), 'Renovação anual com mais visitas');
    await user.selectOptions(form.getByRole('combobox', { name: /^Visita técnica à CCIH/ }), 'alterar');
    await user.clear(form.getByLabelText(/^Nova quantidade/));
    await user.type(form.getByLabelText(/^Nova quantidade/), '4');
    await user.click(screen.getByRole('button', { name: 'Registrar aditivo' }));
    await waitFor(() => expect(consulting.addAmendment).toHaveBeenCalledWith('k1', {
      kinds: ['renovacao'], description: 'Renovação anual com mais visitas', signedOn: '2026-10-27', effectiveOn: '2026-11-21', newEndsOn: '2027-11-20',
      addServices: [], changeServices: [{ id: 's1', quantity: 4, period: 'mensal' }], endServices: [], rowVersion: 3,
    }));
  });

  it('asks for the reason before suspending or closing', async () => {
    const user = userEvent.setup();
    const { consulting } = setup('gestor_consultoria');
    await user.click(await screen.findByRole('button', { name: 'Suspender' }));
    const submit = screen.getAllByRole('button', { name: 'Suspender' }).at(-1)!;
    await user.click(submit);
    expect(await screen.findByText('Informe o motivo (mínimo 5 caracteres).')).toBeInTheDocument();
    expect(consulting.setContractStatus).not.toHaveBeenCalled();
  });
});
