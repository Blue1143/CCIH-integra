import { expect, test, type Page } from '@playwright/test';
import { login, watchProblems } from './support';

const navLinks = async (page: Page) => (await page.getByRole('navigation', { name: 'Principal' }).getByRole('link').allTextContents()).map((t) => t.replace(/\d+$/, '').trim());

test.describe('Funções e permissões', () => {
  test('cada função vê só os seus módulos, e o acesso direto por URL é barrado', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Técnico de Enfermagem CME: CME operacional, sem painel geral, CCIH, Qualidade ou Administração.
    await login(page, 'tec.cme');
    let links = await navLinks(page);
    expect(links).toEqual(expect.arrayContaining(['CME', 'Estação de leitura']));
    for (const l of ['Visão Geral', 'Vigilância IRAS', 'Auditorias', 'Administração']) expect(links).not.toContain(l);
    await page.goto('/cme');
    await expect(page.getByRole('button', { name: 'Nova carga' })).toBeVisible();
    await expect(page.getByText('Modo consulta')).toHaveCount(0);
    await page.goto('/admin/usuarios');
    await expect(page.getByText('Seu perfil não tem acesso a esta área')).toBeVisible();
    await page.getByRole('button', { name: 'Sair' }).click();

    // Enfermeira CCIH: vê a CME em modo consulta, sem ações de alteração.
    await login(page, 'enf.ccih');
    links = await navLinks(page);
    expect(links).toEqual(expect.arrayContaining(['Visão Geral', 'Vigilância IRAS', 'CME']));
    expect(links).not.toContain('Estação de leitura');
    await page.goto('/cme');
    await expect(page.getByText('Modo consulta')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nova carga' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sair' }).click();

    // Enfermeira da Qualidade: indicadores e auditorias, sem CME nem pacientes.
    await login(page, 'enf.qualidade');
    links = await navLinks(page);
    expect(links).toEqual(expect.arrayContaining(['Auditorias', 'Indicadores']));
    for (const l of ['CME', 'Pacientes', 'Vigilância IRAS']) expect(links).not.toContain(l);
    await page.goto('/pacientes');
    await expect(page.getByText('Seu perfil não tem acesso a esta área')).toBeVisible();
    await page.getByRole('button', { name: 'Sair' }).click();

    // ADM CME: gestão de usuários só com as contas da CME e só funções da CME para atribuir.
    const problems = watchProblems(page);
    await login(page, 'adm.cme');
    await page.goto('/admin/usuarios');
    await expect(page.getByRole('cell', { name: /Técnico de Enfermagem CME \(demonstração\)/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: /Enfermeira CCIH \(demonstração\)/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Novo usuário' }).click();
    const options = await page.getByLabel(/^Função no sistema/).locator('option').allTextContents();
    expect(options).toEqual(['Selecione', 'Enfermeiro CME', 'Técnico de Enfermagem CME', 'Jovem Aprendiz']);
    await expect(page.getByRole('button', { name: 'Criar administrador do sistema' })).toHaveCount(0);
    expect(problems).toEqual([]);
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Sair' }).click();

    // Jovem Aprendiz: apenas o que o gestor concedeu (consulta e registro na CME).
    await login(page, 'aprendiz');
    links = await navLinks(page);
    expect(links).toEqual(expect.arrayContaining(['CME', 'Estação de leitura']));
    for (const l of ['Visão Geral', 'Administração', 'Auditorias', 'Alertas']) expect(links).not.toContain(l);
    await ctx.close();
  });
});
