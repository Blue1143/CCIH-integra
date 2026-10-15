import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, effectivePermissions, type ClientDetailDto, type RoleCode } from '@ccih/domain';
import { DemoDataSource } from '../../data/demo/DemoDataSource';
import { DataSourceProvider } from '../../data/source';
import type { AuthPort, CcihDataSource, ConsultingPort } from '../../data/port';
import { routes } from '../../app/routes';
import { SessionProvider } from '../auth/session';

const ADDRESS = { street: null, number: null, district: null, city: 'Campinas', state: 'SP' as const, zip: null };
const DETAIL: ClientDetailDto = {
  id: 'c1', legalName: 'Hospital São Lucas Ltda', tradeName: 'Hospital São Lucas', cnpj: '11444777000161', kind: 'hospital', status: 'ativo', email: null, phone: null, address: ADDRESS,
  servicesSummary: 'CCIH e CME', rowVersion: 1, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', dataOrigin: 'real',
  contacts: [{ id: 'k1', kind: 'responsavel_tecnico', name: 'Dra. Ana Souza', roleTitle: 'Presidente da CCIH', registry: 'CRM-SP 1', email: 'ana@exemplo.com', phone: null, active: true, rowVersion: 1 }],
  establishments: [{ id: 'e1', name: 'Unidade Centro', cnes: '1234567', cnpj: null, kind: 'hospital', beds: 120, address: ADDRESS, active: true, rowVersion: 1, units: [{ id: 'u1', name: 'UTI Adulto', kind: 'uti_adulto', beds: 10, active: true, rowVersion: 1 }] }],
  assignments: [
    { id: 'a1', userId: 'p1', userName: 'Consultora Bia', role: 'responsavel', specialty: 'ccih', startsOn: '2026-10-01', endsOn: null, assignedBy: 'Gestora', reason: 'Início', endedBy: null, endReason: null },
    { id: 'a0', userId: 'p0', userName: 'Consultor Antigo', role: 'responsavel', specialty: null, startsOn: '2026-01-01', endsOn: '2026-10-01', assignedBy: 'Gestora', reason: 'Início', endedBy: 'Gestora', endReason: 'Substituído por Consultora Bia' },
  ],
  events: [{ id: 'v1', kind: 'atendimento', summary: 'Reunião com a CCIH', detail: null, occurredOn: '2026-10-10', by: 'Consultora Bia', at: '2026-10-10T12:00:00Z' }],
};

function setup(role: RoleCode, over: Partial<Record<keyof ConsultingPort, unknown>> = {}, path = '/consultoria/clientes/c1') {
  const demo = new DemoDataSource(() => new Date('2026-10-15T12:00:00Z'));
  const auth: AuthPort = {
    me: async () => ({
      user: { id: 'u1', login: role, displayName: 'Pessoa' }, roles: [role], permissions: effectivePermissions(DEFAULT_ROLE_PERMISSIONS[role], 'consultoria'), scope: null, isFounder: false,
      organization: { type: 'consultoria', name: 'Consultoria Exemplo' }, session: { expiresAt: '2026-10-15T23:00:00Z', idleExpiresAt: '2026-10-15T13:00:00Z', idleMinutes: 30 },
    }),
    login: async () => undefined, logout: async () => undefined, changePassword: async () => undefined,
  };
  const consulting = {
    clients: vi.fn(async () => ({ rows: [{ id: 'c1', legalName: DETAIL.legalName, tradeName: DETAIL.tradeName, cnpj: DETAIL.cnpj, kind: 'hospital', status: 'ativo', city: 'Campinas', state: 'SP', establishments: 1, responsible: { userId: 'p1', name: 'Consultora Bia' }, consultants: 1, updatedAt: DETAIL.updatedAt, dataOrigin: 'real' }], total: 1, page: 1, pageSize: 25 })),
    client: vi.fn(async () => DETAIL),
    team: vi.fn(async () => ({ members: [{ userId: 'p2', name: 'Consultor Caio', login: 'caio', roles: ['consultor'], active: true, clients: [] }, { userId: 'p1', name: 'Consultora Bia', login: 'bia', roles: ['consultor'], active: true, clients: [{ clientId: 'c1', clientName: 'Hospital São Lucas', role: 'responsavel', specialty: 'ccih' }] }] })),
    assign: vi.fn(async () => DETAIL),
    addEvent: vi.fn(async () => DETAIL),
    saveClient: vi.fn(async () => DETAIL),
    ...over,
  } as unknown as ConsultingPort & Record<string, ReturnType<typeof vi.fn>>;
  const source: CcihDataSource = { origin: 'real', auth, consulting, getInstitution: () => demo.getInstitution(), getFacts: (q) => demo.getFacts(q) };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DataSourceProvider source={source}><SessionProvider><RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} /></SessionProvider></DataSourceProvider>
    </QueryClientProvider>,
  );
  return { consulting };
}

describe('consulting portfolio (interface)', () => {
  it('lists the portfolio with the responsible consultant', async () => {
    setup('gestor_consultoria', {}, '/consultoria/clientes');
    const table = await screen.findByRole('table', { name: 'Clientes' });
    expect(within(table).getByRole('link', { name: 'Hospital São Lucas' })).toHaveAttribute('href', '/consultoria/clientes/c1');
    expect(within(table).getByText('Consultora Bia')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Novo cliente' })).toBeInTheDocument();
    expect(screen.getByLabelText('Consultor')).toBeInTheDocument();
  });

  it('shows the client record to the consultant without editing, assignment or internal notes', async () => {
    setup('consultor');
    expect(await screen.findByRole('heading', { name: /Hospital São Lucas/ })).toBeInTheDocument();
    expect(screen.getByText('Dra. Ana Souza')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Unidades de Unidade Centro' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar cadastro' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Atribuir consultor' })).toBeNull();
    expect(screen.queryByText('Observações internas')).toBeNull();
    expect(screen.getByRole('button', { name: 'Registrar atendimento' })).toBeInTheDocument();
    expect(screen.getByText(/Atendimento — Reunião com a CCIH/)).toBeInTheDocument();
  });

  it('lets the manager replace the responsible consultant, explaining the replacement and requiring a reason', async () => {
    const user = userEvent.setup();
    const { consulting } = setup('gestor_consultoria');
    await user.click(await screen.findByRole('button', { name: 'Atribuir consultor' }));
    expect(screen.getByText(/Consultora Bia deixa de ser o responsável a partir de hoje/)).toBeInTheDocument();
    const form = within(screen.getByRole('button', { name: 'Atribuir' }).closest('form')!);
    const select = form.getByRole('combobox', { name: /^Consultor/ });
    expect(within(select).queryByRole('option', { name: /Consultora Bia/ })).toBeNull();
    await user.selectOptions(select, 'p2');
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(await screen.findByText('Informe o motivo (mínimo 5 caracteres).')).toBeInTheDocument();
    await user.type(form.getByLabelText(/^Motivo/), 'Redistribuição da carteira');
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    await waitFor(() => expect(consulting.assign).toHaveBeenCalledWith('c1', { userId: 'p2', role: 'responsavel', specialty: null, startsOn: null, reason: 'Redistribuição da carteira' }));
    // History of assignments stays visible.
    expect(screen.getByText(/Histórico de atribuições \(1\)/)).toBeInTheDocument();
  });

  it('validates the client registration before sending it', async () => {
    const user = userEvent.setup();
    const { consulting } = setup('assistente_consultoria', {}, '/consultoria/clientes');
    await user.click(await screen.findByRole('button', { name: 'Novo cliente' }));
    await user.type(screen.getByLabelText(/^CNPJ/), '11.444.777/0001-60');
    await user.click(screen.getByRole('button', { name: 'Cadastrar cliente' }));
    expect(await screen.findByText('Informe a razão social (mínimo 3 caracteres).')).toBeInTheDocument();
    expect(screen.getByText(/dígitos verificadores/)).toBeInTheDocument();
    expect(consulting.saveClient).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Observações administrativas internas/)).toBeInTheDocument();
  });
});
