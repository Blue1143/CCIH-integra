import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, effectivePermissions, type OrganizationType } from '@ccih/domain';
import { DemoDataSource } from '../../data/demo/DemoDataSource';
import { DataSourceProvider } from '../../data/source';
import type { AuthPort, CcihDataSource } from '../../data/port';
import { routes } from '../../app/routes';
import { SessionProvider } from '../auth/session';

function renderAs(model: OrganizationType, path: string) {
  const demo = new DemoDataSource(() => new Date('2026-10-13T12:00:00Z'));
  const auth: AuthPort = {
    me: async () => ({
      user: { id: 'u1', login: 'dono', displayName: 'Responsável' }, roles: ['admin'], permissions: effectivePermissions(DEFAULT_ROLE_PERMISSIONS.admin, model), scope: null, isFounder: true,
      organization: { type: model, name: model === 'consultoria' ? 'Consultoria Exemplo' : 'Hospital Exemplo' },
      session: { expiresAt: '2026-10-13T23:00:00Z', idleExpiresAt: '2026-10-13T13:00:00Z', idleMinutes: 30 },
    }),
    login: async () => undefined, logout: async () => undefined, changePassword: async () => undefined,
  };
  const source: CcihDataSource = { origin: 'real', auth, getInstitution: () => demo.getInstitution(), getFacts: (q) => demo.getFacts(q) };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DataSourceProvider source={source}><SessionProvider><RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} /></SessionProvider></DataSourceProvider>
    </QueryClientProvider>,
  );
}

const menu = async () => within(await screen.findByRole('navigation', { name: 'Principal' })).getAllByRole('link').map((l) => l.textContent ?? '');

describe('menus and home by business model', () => {
  it('a consulting organization sees its own menu and home, without hospital modules', async () => {
    renderAs('consultoria', '/');
    expect(await screen.findByRole('heading', { name: 'Consultoria Exemplo' })).toBeInTheDocument();
    const links = await menu();
    expect(links.some((l) => l.startsWith('Clientes'))).toBe(true);
    expect(links.some((l) => l.startsWith('Administração'))).toBe(true);
    for (const hospitalOnly of ['Visão Geral', 'Vigilância IRAS', 'CME', 'Pacientes', 'Bundles']) expect(links.some((l) => l.startsWith(hospitalOnly))).toBe(false);
    expect(screen.getByRole('row', { name: /Clientes .* Disponível/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Contratos .* Etapa M4/ })).toBeInTheDocument();
  });

  it('a consulting user reaching a hospital page by URL gets no access', async () => {
    renderAs('consultoria', '/pacientes');
    expect(await screen.findByText('Seu perfil não tem acesso a esta área')).toBeInTheDocument();
  });

  it('a planned consulting module says so plainly, and does not exist for hospitals', async () => {
    renderAs('consultoria', '/consultoria/contratos');
    expect(await screen.findByText('Em desenvolvimento — Etapa M4')).toBeInTheDocument();
  });

  it('a hospital keeps its menu and has no consulting module', async () => {
    renderAs('hospitalar', '/consultoria/clientes');
    expect(await screen.findByText('Seu perfil não tem acesso a esta área')).toBeInTheDocument();
    const links = await menu();
    expect(links.some((l) => l.startsWith('Visão Geral'))).toBe(true);
    expect(links.some((l) => l.startsWith('Clientes'))).toBe(false);
  });
});
