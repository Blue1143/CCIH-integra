import { expect, test, type Page } from '@playwright/test';
import { login } from './support';

const navLinks = async (page: Page) => (await page.getByRole('navigation', { name: 'Principal' }).getByRole('link').allTextContents()).map((t) => t.replace(/\s*—.*$/, '').replace(/\d+$/, '').trim());

test.describe('Dois modelos de negócio', () => {
  test('a consultoria tem menu e início próprios e não alcança módulos hospitalares; o hospital continua igual', async ({ page }) => {
    await login(page, 'consultoria');
    await expect(page.getByRole('heading', { name: 'Consultoria de demonstração' })).toBeVisible();
    let links = await navLinks(page);
    expect(links).toEqual(expect.arrayContaining(['Início', 'Clientes', 'Contratos', 'Agenda', 'Administração']));
    for (const l of ['Visão Geral', 'Vigilância IRAS', 'CME', 'Pacientes', 'Indicadores']) expect(links).not.toContain(l);
    await page.goto('/cme');
    await expect(page.getByText('Seu perfil não tem acesso a esta área')).toBeVisible();
    await page.goto('/admin/usuarios');
    await expect(page.getByRole('table', { name: 'Usuários' })).toBeVisible();
    await expect(page.getByLabel('Setor')).toHaveCount(0);
    // The API itself refuses hospital routes to the consulting organization.
    const status = await page.evaluate(async () => (await fetch('/api/patients')).status);
    expect(status).toBe(404);
    await page.getByRole('button', { name: 'Sair' }).click();

    await login(page, 'admin');
    links = await navLinks(page);
    expect(links).toEqual(expect.arrayContaining(['Visão Geral', 'Vigilância IRAS', 'CME', 'Administração']));
    expect(links).not.toContain('Clientes');
  });
});
