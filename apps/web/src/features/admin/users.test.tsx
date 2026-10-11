import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, ROLE_LABEL, assignableRoles, type RoleCode, type UserAccountDto } from '@ccih/domain';
import { DemoDataSource } from '../../data/demo/DemoDataSource';
import { DataSourceProvider } from '../../data/source';
import type { AdminPort, AuthPort, CcihDataSource } from '../../data/port';
import { routes } from '../../app/routes';
import { SessionProvider } from '../auth/session';

const TEC: UserAccountDto = {
  id: 'u2', login: 'tec.cme', displayName: 'Técnico CME (teste)', email: null, registration: null, category: 'tecnico_enfermagem', functionRole: 'tec_cme', roles: ['tec_cme'],
  status: 'ativo', statusReason: null, scopeAll: true, sectorIds: [], isFounder: false, createdAt: '2026-10-01T12:00:00Z', createdByName: 'ADM CME', authorizedByName: 'ADM CME',
  permissionsChangedAt: '2026-10-01T12:00:00Z', validFrom: null, validUntil: null, supervisorId: null, supervisorName: null, lockedUntil: null, lastLoginAt: null, grants: [], manageable: true, rowVersion: 1,
};

function fakeSource(role: RoleCode, isFounder = false) {
  const demo = new DemoDataSource(() => new Date('2026-10-09T12:00:00Z'));
  const permissions = DEFAULT_ROLE_PERMISSIONS[role];
  const auth: AuthPort = {
    me: async () => ({ user: { id: 'u1', login: role, displayName: 'Gestor' }, roles: [role], permissions, scope: null, isFounder, session: { expiresAt: '2026-10-09T23:00:00Z', idleExpiresAt: '2026-10-09T13:00:00Z', idleMinutes: 30 } }),
    login: async () => undefined, logout: async () => undefined, changePassword: async () => undefined,
  };
  const admin = {
    users: vi.fn(async () => ({ users: [TEC] })),
    usersMeta: vi.fn(async () => ({ assignableRoles: assignableRoles({ permissions, isFounder }), modules: null, supervisors: [{ id: 's1', name: 'Enfermeira CME' }] })),
    roles: vi.fn(async () => ({ roles: (Object.keys(DEFAULT_ROLE_PERMISSIONS) as RoleCode[]).map((code) => ({ code, name: ROLE_LABEL[code], permissions: DEFAULT_ROLE_PERMISSIONS[code], module: 'sistema' })), permissions: {} })),
    createUser: vi.fn(async () => ({ id: 'n1', temporaryPassword: 'Tmp-x' })),
    updateUser: vi.fn(async () => undefined),
    userHistory: vi.fn(async () => ({ entries: [{ id: 'h1', at: '2026-10-02T12:00:00Z', by: 'adm.cme', action: 'update', entity: 'app_user_access', before: { functionRole: 'tec_cme', permissions: ['cme:view'] }, after: { functionRole: 'tec_cme', permissions: ['cme:view', 'cme:release'] }, justification: 'Autorização expressa da RT' }] })),
  } as unknown as AdminPort & Record<string, ReturnType<typeof vi.fn>>;
  const source: CcihDataSource = { origin: 'real', auth, admin, getInstitution: () => demo.getInstitution(), getFacts: (q) => demo.getFacts(q) };
  return { source, admin };
}

function renderAt(source: CcihDataSource, path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DataSourceProvider source={source}><SessionProvider><RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} /></SessionProvider></DataSourceProvider>
    </QueryClientProvider>,
  );
}

/** The open account form (the closed reset-password dialog also has a "Justificativa" field). */
const form = () => within(screen.getByRole('button', { name: /^(Criar usuário|Criar administrador|Salvar acesso)$/ }).closest('form')!);
const functionOptions = () => within(screen.getByLabelText(/Função no sistema/)).getAllByRole('option').map((o) => o.textContent);

describe('user management', () => {
  it('offers a module administrator only the functions of its module, and requires the function', async () => {
    const user = userEvent.setup();
    const { source, admin } = fakeSource('adm_cme');
    renderAt(source, '/admin/usuarios');
    await user.click(await screen.findByRole('button', { name: 'Novo usuário' }));
    expect(functionOptions()).toEqual(['Selecione', 'Enfermeiro CME', 'Técnico de Enfermagem CME', 'Jovem Aprendiz']);
    expect(screen.queryByRole('button', { name: 'Criar administrador do sistema' })).toBeNull();
    await user.type(screen.getByLabelText(/Nome completo/), 'Novo Técnico (teste)');
    await user.type(screen.getByLabelText(/^Login/), 'novo.tec');
    await user.type(form().getByLabelText(/Justificativa/), 'Admissão na equipe da CME');
    await user.click(screen.getByRole('button', { name: 'Criar usuário' }));
    expect(await screen.findByText('Informe a função no sistema.')).toBeInTheDocument();
    expect(admin.createUser).not.toHaveBeenCalled();
  });

  it('asks the apprentice permissions, supervisor and expiry before activating, from the allowed packages only', async () => {
    const user = userEvent.setup();
    const { source, admin } = fakeSource('adm_cme');
    renderAt(source, '/admin/usuarios');
    await user.click(await screen.findByRole('button', { name: 'Novo usuário' }));
    await user.selectOptions(screen.getByLabelText(/Função no sistema/), 'aprendiz');
    const section = screen.getByRole('group', { name: 'Permissões do Jovem Aprendiz' });
    expect(within(section).getByLabelText('CME: Registro/edição')).toBeInTheDocument();
    expect(within(section).queryByLabelText('CCIH — vigilância: Consulta')).toBeNull();
    expect(within(section).queryByLabelText(/Liberar, reter ou rejeitar/)).toBeNull();
    // Pending by default; activating without grants is refused before sending.
    await user.selectOptions(screen.getByLabelText(/Situação da conta/), 'ativo');
    await user.type(screen.getByLabelText(/Nome completo/), 'Aprendiz (teste)');
    await user.type(screen.getByLabelText(/^Login/), 'aprendiz.novo');
    await user.type(form().getByLabelText(/Justificativa/), 'Programa Jovem Aprendiz na CME');
    await user.click(screen.getByRole('button', { name: 'Criar usuário' }));
    expect(await screen.findByText('Defina as permissões do Jovem Aprendiz antes de ativar a conta.')).toBeInTheDocument();
    await user.click(within(section).getByLabelText('CME: Registro/edição'));
    expect(within(section).getByLabelText('CME: Consulta')).toBeChecked();
    await user.click(screen.getByLabelText('Todos os setores'));
    await user.selectOptions(screen.getByLabelText(/Responsável pela supervisão/), 's1');
    await user.type(screen.getByLabelText(/Expiração ou revisão/), '2027-03-31');
    await user.click(screen.getByRole('button', { name: 'Criar usuário' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(admin.createUser).toHaveBeenCalled());
    const sent = vi.mocked(admin.createUser).mock.calls[0]![0];
    expect(sent).toMatchObject({ login: 'aprendiz.novo', functionRole: 'aprendiz', status: 'ativo', supervisorId: 's1', validUntil: '2027-03-31' });
    expect(sent.grants.map((g) => g.permission).sort()).toEqual(['cme:scan', 'cme:view', 'nc:record']);
  });

  it('shows "Criar administrador do sistema" only to the creator account', async () => {
    const admin = fakeSource('admin', false);
    renderAt(admin.source, '/admin/usuarios');
    expect(await screen.findByRole('button', { name: 'Novo usuário' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Criar administrador do sistema' })).toBeNull();
  });

  it('lets the creator account create a system administrator', async () => {
    const user = userEvent.setup();
    const { source, admin } = fakeSource('admin', true);
    renderAt(source, '/admin/usuarios');
    await user.click(await screen.findByRole('button', { name: 'Criar administrador do sistema' }));
    expect(functionOptions()).toEqual(['Selecione', 'Administrador do sistema']);
    await user.type(screen.getByLabelText(/Nome completo/), 'Segundo Administrador');
    await user.type(screen.getByLabelText(/^Login/), 'admin.dois');
    await user.type(form().getByLabelText(/Justificativa/), 'Cobertura da administração do sistema');
    await user.click(screen.getByRole('button', { name: 'Criar administrador' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(admin.createUser).toHaveBeenCalledWith(expect.objectContaining({ functionRole: 'admin', login: 'admin.dois' })));
  });

  it('shows the history with previous and new permissions and the justification', async () => {
    const user = userEvent.setup();
    const { source } = fakeSource('adm_cme');
    renderAt(source, '/admin/usuarios');
    await user.click(await screen.findByRole('button', { name: 'Histórico de tec.cme' }));
    expect(await screen.findByText(/Permissões novas: Liberar, reter ou rejeitar cargas/)).toBeInTheDocument();
    expect(screen.getByText('Justificativa: Autorização expressa da RT')).toBeInTheDocument();
  });
});
