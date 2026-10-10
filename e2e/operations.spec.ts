import { expect, test } from '@playwright/test';
import { login, watchProblems } from './support';

test.describe('CCIH operacional', () => {
  test('alerta: assumir e encerrar com o que foi feito', async ({ page }) => {
    const problems = watchProblems(page);
    await login(page, 'enf.ccih');
    const resolution = `Tratado pela CCIH (E2E ${Date.now().toString(36)})`;
    await page.goto('/alertas');
    const item = page.locator('.alert-item').filter({ has: page.getByRole('button', { name: /^Assumir/ }) }).first();
    const title = (await item.locator('.alert-title').innerText()).trim();
    await item.getByRole('button', { name: /^Assumir/ }).click();
    const assumed = page.locator('.alert-item').filter({ hasText: title }).first();
    await expect(assumed).toContainText('Assumido por');
    await assumed.getByRole('button', { name: /^Encerrar/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Encerrar alerta?' });
    await dialog.getByLabel(/O que foi feito/).fill(resolution);
    await dialog.getByRole('button', { name: 'Encerrar' }).click();
    await expect(dialog).toHaveCount(0);
    await page.goto('/alertas?situacao=encerrado');
    await expect(page.getByText(resolution).first()).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('auditoria → achados → conclusão → não conformidade com plano 5W2H', async ({ page }) => {
    const problems = watchProblems(page);
    const title = `Auditoria E2E ${Date.now().toString(36)}`;
    // Audits are conducted by Quality (the CCIH nurse only consults them).
    await login(page, 'enf.qualidade');
    await page.goto('/auditorias');
    await page.getByRole('button', { name: 'Planejar auditoria' }).click();
    await page.getByLabel(/^Título/).fill(title);
    await page.getByLabel(/^Justificativa/).fill('Auditoria prevista no cronograma da CCIH');
    await page.getByRole('button', { name: 'Planejar', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    const step = async (label: string) => {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByLabel(/^Justificativa/).fill('Etapa registrada pela equipe da Qualidade');
      await page.getByRole('button', { name: 'Continuar' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();
    };
    await step('Em andamento');
    await expect(page.getByText('Em andamento', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Registrar achados' }).click();
    await page.getByLabel(/^Achados/).fill('Dispensador vazio no posto de enfermagem');
    await page.getByLabel(/^Justificativa/).fill('Achados da visita ao setor');
    await page.getByRole('button', { name: 'Salvar achados' }).click();
    await expect(page.getByText('Dispensador vazio no posto de enfermagem')).toBeVisible();
    await step('Concluída');

    await page.getByRole('button', { name: 'Registrar não conformidade' }).click();
    await page.getByLabel(/^Descrição/).fill('Dispensador de preparação alcoólica vazio');
    await page.getByLabel(/^Justificativa/).fill('Não conformidade encontrada na auditoria');
    await page.getByRole('button', { name: 'Registrar', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dispensador de preparação alcoólica vazio' })).toBeVisible();

    await page.getByRole('button', { name: 'Adicionar ação (5W2H)' }).click();
    await page.getByLabel(/^O quê/).fill('Instituir checklist de reposição por turno');
    await page.getByLabel(/^Por quê/).fill('Dispensador vazio');
    await page.getByLabel(/^Onde/).fill('Posto de enfermagem');
    await page.getByLabel(/^Quem/).fill('Coordenação de enfermagem');
    await page.getByLabel(/^Quando/).fill('2099-12-31');
    await page.getByLabel(/^Como/).fill('Checklist no início de cada turno');
    await page.getByRole('button', { name: 'Adicionar ação' }).click();
    await expect(page.getByRole('cell', { name: /^Instituir checklist de reposição por turno/ })).toBeVisible();
    await step('Em tratamento');
    await expect(page.getByText('Em tratamento', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Aberta → Em tratamento')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('novo usuário troca a senha temporária antes de qualquer acesso', async ({ page }) => {
    const problems = watchProblems(page);
    const loginName = `e2e.${Date.now().toString(36)}`;
    await login(page, 'admin');
    await page.goto('/admin/usuarios');
    await page.getByRole('button', { name: 'Novo usuário' }).click();
    await page.getByLabel(/^Login/).fill(loginName);
    await page.getByLabel(/^Nome completo/).fill('Usuário E2E (teste)');
    await page.getByLabel(/^Função no sistema/).selectOption({ label: 'Técnico de Enfermagem CCIH' });
    await page.getByRole('radio', { name: 'Todos os setores' }).check();
    await page.getByRole('textbox', { name: 'Justificativa da alteração' }).fill('Acesso de teste automatizado');
    await page.getByRole('button', { name: 'Criar usuário' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Criar' }).click();
    const banner = page.getByText(/^Senha temporária de /);
    await expect(banner).toBeVisible();
    const temporary = (await banner.innerText()).split(': ').at(-1)!.trim();
    await page.getByRole('button', { name: 'Sair' }).click();

    await page.goto('/entrar');
    await page.getByLabel(/Usuário/).fill(loginName);
    await page.getByLabel(/Senha/).fill(temporary);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByText('Troque sua senha para continuar')).toBeVisible();
    await page.goto('/indicadores');
    await expect(page).toHaveURL(/\/conta$/);
    const fresh = `Nova-${Date.now().toString(36)}-Aa1!`;
    await page.getByLabel(/^Senha atual/).fill(temporary);
    await page.getByLabel(/^Nova senha/).fill(fresh);
    await page.getByLabel(/^Confirme/).fill(fresh);
    await page.getByRole('button', { name: 'Trocar senha' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /Visão Geral/ })).toBeVisible();
    expect(problems.filter((p) => !p.includes('403'))).toEqual([]);
  });
});
