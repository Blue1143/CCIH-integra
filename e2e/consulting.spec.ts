import { expect, test } from '@playwright/test';
import { localInput, login } from './support';

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

test.describe('Consultoria — contratos', () => {
  const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  test('o gestor cadastra e assina a proposta; o consultor registra a entrega; só o financeiro vê os valores', async ({ page }) => {
    const title = `Assessoria E2E ${Date.now()}`;
    await login(page, 'gestor.consultoria');
    await page.goto('/consultoria/contratos');
    await page.getByRole('button', { name: 'Nova proposta' }).click();
    const pick = page.getByRole('combobox', { name: /^Cliente da proposta/ });
    const value = await pick.locator('option', { hasText: 'Hospital Exemplo Norte' }).getAttribute('value');
    await pick.selectOption(value!);
    await page.getByLabel(/^Objeto do contrato/).fill(title);
    await page.getByLabel(/^Início da vigência/).fill(isoDay(-60));
    await page.getByLabel(/^Término/).fill(isoDay(30));
    await page.getByLabel(/^Descrição do serviço/).fill('Visita técnica mensal');
    await page.getByLabel(/^Quantidade/).fill('2');
    await page.getByRole('button', { name: 'Cadastrar proposta' }).click();
    await expect(page.getByRole('heading', { name: /CT-\d{4}-\d{3}/ })).toBeVisible();
    await expect(page.getByText(title).first()).toBeVisible();

    await page.getByRole('button', { name: 'Registrar assinatura' }).click();
    await page.locator('form').getByRole('button', { name: 'Registrar assinatura' }).click();
    await expect(page.getByText('Vence em 30 dia(s)').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Condições financeiras' })).toHaveCount(0);
    const url = page.url();
    await page.getByRole('button', { name: 'Sair' }).click();

    // The responsible consultant of Hospital Exemplo Norte records a delivery.
    await login(page, 'consultor');
    await page.goto(url);
    await page.getByRole('button', { name: 'Registrar entrega de Visita técnica mensal' }).click();
    await page.getByLabel(/^O que foi entregue/).fill('Visita de acompanhamento (E2E)');
    await page.locator('form').getByRole('button', { name: 'Registrar entrega' }).click();
    await expect(page.getByRole('table', { name: 'Entregas' })).toContainText('Visita de acompanhamento (E2E)');
    await expect(page.getByRole('button', { name: 'Registrar aditivo' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sair' }).click();

    // Only the financial profile (and the administrator) sees and fills the financial terms.
    await login(page, 'financeiro.consultoria');
    await page.goto(url);
    await page.getByRole('button', { name: 'Informar condições' }).click();
    await page.getByLabel(/^Valor/).fill('4.500,00');
    await page.getByRole('button', { name: 'Salvar condições' }).click();
    await expect(page.getByText('R$ 4.500,00')).toBeVisible();
  });
});

test.describe('Consultoria — agenda', () => {
  test('o gestor agenda a visita do consultor; o consultor registra a realização, que vira entrega do contrato, e deixa uma pendência', async ({ page }) => {
    const title = `Visita E2E ${Date.now()}`;
    await login(page, 'gestor.consultoria');
    await page.goto('/consultoria/agenda');
    await page.getByRole('button', { name: 'Nova atividade' }).click();
    const pick = page.getByRole('combobox', { name: /^Cliente/ });
    await pick.selectOption((await pick.locator('option', { hasText: 'Hospital Exemplo Norte' }).getAttribute('value'))!);
    await page.getByLabel(/^Assunto/).fill(title);
    await page.getByLabel(/^Início/).fill(localInput(-3 * 3_600_000));
    await page.getByLabel(/^Término/).fill(localInput(-1 * 3_600_000));
    await page.getByLabel(/^Local ou link/).fill('Hospital Exemplo Norte — CCIH');
    const responsible = page.getByRole('combobox', { name: /^Responsável/ });
    await responsible.selectOption((await responsible.locator('option', { hasText: 'Consultor CCIH' }).getAttribute('value'))!);
    const service = page.getByRole('combobox', { name: /^Serviço do contrato/ });
    await service.selectOption((await service.locator('option', { hasText: 'Visita técnica à CCIH' }).first().getAttribute('value'))!);
    await page.getByRole('button', { name: 'Agendar' }).click();
    // Earlier runs may have left another activity at this time: accept the overlap on purpose.
    const anyway = page.getByRole('checkbox', { name: /Agendar mesmo assim/ });
    const heading = page.getByRole('heading', { name: new RegExp(title) });
    await expect(heading.or(anyway)).toBeVisible();
    if (await anyway.isVisible()) {
      await anyway.check();
      await page.getByRole('button', { name: 'Agendar' }).click();
    }
    await expect(heading).toBeVisible();
    const url = page.url();
    await page.getByRole('button', { name: 'Sair' }).click();

    await login(page, 'consultor');
    await page.goto(url);
    await page.getByRole('button', { name: 'Registrar realização' }).click();
    const form = page.locator('form', { has: page.getByRole('button', { name: 'Registrar realização' }) });
    await form.getByLabel(/^Resumo do que foi feito/).fill('Revisão das notificações e do plano de ação (E2E)');
    await form.getByRole('button', { name: 'Adicionar pendência' }).click();
    await form.getByRole('textbox', { name: /^Pendência/ }).fill('Enviar a ata da visita (E2E)');
    const owner = form.getByRole('combobox', { name: /^Responsável/ });
    await owner.selectOption((await owner.locator('option', { hasText: 'Consultor CCIH' }).getAttribute('value'))!);
    await form.getByRole('button', { name: 'Registrar realização' }).click();
    await expect(page.getByRole('heading', { name: 'O que foi feito' })).toBeVisible();
    await expect(page.getByText(/Registrada em CT-/)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Pendências da atividade' })).toContainText('Enviar a ata da visita (E2E)');
    // The delivery is in the contract, linked to the activity.
    await page.getByText(/Registrada em CT-/).getByRole('link').click();
    await expect(page.getByRole('table', { name: 'Entregas' })).toContainText(title);
  });
});
