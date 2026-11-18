import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, effectivePermissions, type ActivityDetailDto, type RoleCode } from '@ccih/domain';
import { DemoDataSource } from '../../data/demo/DemoDataSource';
import { DataSourceProvider } from '../../data/source';
import { ApiError } from '../../data/api/http';
import type { AuthPort, CcihDataSource, ConsultingPort } from '../../data/port';
import { routes } from '../../app/routes';
import { SessionProvider } from '../auth/session';

const NOW = new Date('2026-11-12T15:00:00Z');
const PAST: ActivityDetailDto = {
  id: 'a1', kind: 'visita_tecnica', mode: 'presencial', title: 'Visita mensal à CCIH', clientId: 'c1', clientName: 'Hospital São Lucas', establishmentName: 'Unidade Centro',
  startsAt: '2026-11-10T12:00:00Z', endsAt: '2026-11-10T14:00:00Z', location: null, status: 'agendada', situation: 'sem_registro',
  responsible: { userId: 'u1', name: 'Consultora Bia' }, participants: [], serviceDescription: 'Visita técnica mensal', openTasks: 0, dataOrigin: 'real',
  description: null, establishmentId: 'e1', contractServiceId: 's1', contractId: 'k1', contractCode: 'CT-2026-001', outcomeSummary: null, outcomeDetail: null, actualMinutes: null,
  closeReason: null, recordedBy: null, recordedAt: null, deliveryId: null, tasks: [], events: [{ id: 'v1', kind: 'agendada', summary: 'Visita técnica agendada.', detail: null, by: 'Gestora', at: '2026-11-10T12:00:00Z' }],
  rowVersion: 2, createdBy: 'Gestora', createdAt: '2026-11-10T12:00:00Z',
};
const OPTIONS = { establishments: [{ id: 'e1', name: 'Unidade Centro' }], services: [{ id: 's1', contractCode: 'CT-2026-001', description: 'Visita técnica mensal', unit: 'visitas' as const, frequency: '2 visitas por mês' }], people: [{ userId: 'u1', name: 'Consultora Bia' }, { userId: 'u2', name: 'Gestora' }] };

function setup(role: RoleCode, path: string, over: Record<string, unknown> = {}) {
  const demo = new DemoDataSource(() => NOW);
  const auth: AuthPort = {
    me: async () => ({
      user: { id: 'u1', login: role, displayName: 'Consultora Bia' }, roles: [role], permissions: effectivePermissions(DEFAULT_ROLE_PERMISSIONS[role], 'consultoria'), scope: null, isFounder: false,
      organization: { type: 'consultoria', name: 'Consultoria Exemplo' }, session: { expiresAt: '2026-11-18T23:00:00Z', idleExpiresAt: '2026-11-18T16:00:00Z', idleMinutes: 30 },
    }),
    login: async () => undefined, logout: async () => undefined, changePassword: async () => undefined,
  };
  const consulting = {
    activities: vi.fn(async () => ({ rows: [PAST], total: 1, page: 1, pageSize: 100 })),
    activity: vi.fn(async () => PAST),
    activityOptions: vi.fn(async () => OPTIONS),
    tasks: vi.fn(async () => ({ rows: [{ id: 't1', description: 'Enviar a ata', clientId: 'c1', clientName: 'Hospital São Lucas', activityId: 'a1', activityTitle: 'Visita mensal à CCIH', owner: { userId: 'u1', name: 'Consultora Bia' }, dueOn: '2026-11-17', status: 'aberta', late: true, closedNote: null, closedBy: null, closedAt: null, createdBy: 'Gestora', createdAt: '2026-11-10T12:00:00Z', rowVersion: 1 }], total: 1, page: 1, pageSize: 50 })),
    team: vi.fn(async () => ({ members: [] })),
    clients: vi.fn(async () => ({ rows: [{ id: 'c1', legalName: 'Hospital São Lucas Ltda', tradeName: 'Hospital São Lucas', status: 'ativo' }], total: 1, page: 1, pageSize: 100 })),
    saveActivity: vi.fn(async () => PAST),
    activityOutcome: vi.fn(async () => PAST),
    closeTask: vi.fn(async () => ({})),
    agendaIcsUrl: () => '/api/consulting/agenda.ics?mine=1',
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

describe('consulting agenda (interface)', () => {
  it('shows the week grouped by day, the activities without record, open tasks and the calendar export', async () => {
    setup('consultor', '/consultoria/agenda?semana=2026-11-10');
    const day = await screen.findByRole('region', { name: /terça-feira, 10\/11\/2026/ });
    expect(within(day).getByRole('link', { name: 'Visita mensal à CCIH' })).toHaveAttribute('href', '/consultoria/agenda/a1');
    expect(within(day).getByText('Sem registro')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Atividades sem registro (1)' })).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Pendências abertas' })).getByText('Atrasada')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Exportar minha agenda (.ics)' })).toHaveAttribute('href', '/api/consulting/agenda.ics?mine=1');
  });

  it('records a realization with duration, delivery of the contracted service and a follow-up task', async () => {
    const user = userEvent.setup();
    const { consulting } = setup('consultor', '/consultoria/agenda/a1');
    await user.click(await screen.findByRole('button', { name: 'Registrar realização' }));
    const form = within(screen.getAllByRole('button', { name: 'Registrar realização' }).at(-1)!.closest('form')!);
    expect(form.getByRole('checkbox', { name: /Registrar como entrega de CT-2026-001/ })).toBeChecked();
    await user.click(form.getByRole('button', { name: 'Registrar realização' }));
    expect(await screen.findByText('Resuma o que foi feito (mínimo 10 caracteres).')).toBeInTheDocument();
    await user.type(form.getByLabelText(/^Resumo do que foi feito/), 'Revisão do plano de ação da CCIH');
    await user.click(form.getByRole('button', { name: 'Adicionar pendência' }));
    await user.type(form.getByRole('textbox', { name: /^Pendência/ }), 'Enviar a ata da visita');
    await user.selectOptions(form.getByRole('combobox', { name: /^Responsável/ }), 'u1');
    await user.click(form.getByRole('button', { name: 'Registrar realização' }));
    await waitFor(() => expect(consulting.activityOutcome).toHaveBeenCalledWith('a1', expect.objectContaining({
      status: 'realizada', summary: 'Revisão do plano de ação da CCIH', actualMinutes: 120, registerDelivery: true, rowVersion: 2,
      tasks: [expect.objectContaining({ description: 'Enviar a ata da visita', ownerId: 'u1' })],
    })));
  });

  it('shows the schedule conflict and lets the person schedule anyway on purpose', async () => {
    const user = userEvent.setup();
    const conflict = new ApiError(409, 'conflito_agenda', 'Há outra atividade agendada no mesmo horário.', [{ path: 'startsAt', message: 'Gestora: Reunião (Hospital B), 19/11/2026 09:00–10:00' }]);
    const saveActivity = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue(PAST);
    setup('gestor_consultoria', '/consultoria/agenda', { saveActivity });
    await user.click(await screen.findByRole('button', { name: 'Nova atividade' }));
    await user.selectOptions(screen.getByRole('combobox', { name: /^Cliente/ }), 'c1');
    await user.type(await screen.findByLabelText(/^Assunto/), 'Visita de diagnóstico');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Estabelecimento/ }), 'e1');
    await user.click(screen.getByRole('button', { name: 'Agendar' }));
    expect(await screen.findByText(/Gestora: Reunião \(Hospital B\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Agendar mesmo assim/ }));
    await user.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(saveActivity).toHaveBeenLastCalledWith('c1', null, expect.objectContaining({ allowOverlap: true, title: 'Visita de diagnóstico', establishmentId: 'e1' })));
  });

  it('does not offer the financial profile any agenda', async () => {
    setup('financeiro_consultoria', '/consultoria/agenda');
    expect(await screen.findByText('Seu perfil não tem acesso a esta área')).toBeInTheDocument();
  });
});
