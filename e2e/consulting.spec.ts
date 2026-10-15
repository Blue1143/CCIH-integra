import { expect, test } from '@playwright/test';
import { login } from './support';

test.describe('Consultoria — carteira de clientes', () => {
  test('o gestor cadastra o cliente e atribui o consultor; o consultor só vê os seus clientes e registra o atendimento', async ({ page }) => {
    const name = `Hospital E2E ${Date.now()}`;
    await login(page, 'gestor.consultoria');
    await page.goto('/consultoria/clientes');
    await page.getByRole('button', { name: 'Novo cliente' }).click();
    await page.getByLabel(/^Razão social/).fill(`${name} Ltda`);
    await page.getByLabel(/^Nome fantasia/).fill(name);
    await page.getByLabel(/^Cidade/).fill('Campinas');
    await page.getByRole('button', { name: 'Cadastrar cliente' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();

    await page.getByRole('button', { name: 'Novo estabelecimento' }).click();
    await page.getByLabel(/^Nome/).fill(`${name} — Centro`);
    await page.getByLabel(/^Leitos/).fill('80');
    await page.getByRole('button', { name: 'Salvar estabelecimento' }).click();
    await expect(page.getByRole('table', { name: `Unidades de ${name} — Centro` })).toBeVisible();

    await page.getByRole('button', { name: 'Atribuir consultor' }).click();
    const assign = page.locator('form', { has: page.getByRole('button', { name: 'Atribuir' }) });
    const value = await assign.locator('option', { hasText: 'Consultor CCIH' }).getAttribute('value');
    await assign.getByRole('combobox', { name: /^Consultor/ }).selectOption(value!);
    await assign.getByLabel(/^Motivo/).fill('Distribuição da carteira (E2E)');
    await assign.getByRole('button', { name: 'Atribuir' }).click();
    await expect(page.getByRole('table', { name: 'Consultores atuais' })).toContainText('Consultor CCIH (demonstração)');
    await page.getByRole('button', { name: 'Sair' }).click();

    await login(page, 'consultor');
    await page.goto('/consultoria/clientes');
    const table = page.getByRole('table', { name: 'Clientes' });
    await expect(table).toContainText(name);
    // The synthetic client without assignment is not visible to the consultant.
    await expect(table).not.toContainText('Policlínica Exemplo Leste');
    await table.getByRole('link', { name }).click();
    await expect(page.getByRole('button', { name: 'Editar cadastro' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Registrar atendimento' }).click();
    await page.getByLabel(/^Resumo/).fill('Visita técnica inicial');
    await page.getByRole('button', { name: 'Registrar', exact: true }).click();
    await expect(page.getByText(/Atendimento — Visita técnica inicial/)).toBeVisible();
    // Direct access to a client of someone else answers as if it did not exist.
    const status = await page.evaluate(async () => {
      const list = await (await fetch('/api/consulting/clients?q=Policl')).json();
      return list.total;
    });
    expect(status).toBe(0);
  });
});
