import { expect, test, type Page } from '@playwright/test';
import { localInput, login, watchProblems } from './support';

/**
 * A keyboard-wedge reader "types" the code very fast and ends with Enter. This simulates it in the
 * browser; validation with the physical reader models is still pending (see docs/cme-integracao).
 */
async function scanAs(page: Page, code: string) {
  const field = page.getByLabel('Leitura do código de barras');
  // The field is cleared and enabled again only after the previous reading was answered.
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('');
  await field.focus();
  await page.keyboard.type(code, { delay: 4 });
  await page.keyboard.press('Enter');
}

/** The result panel of the last reading. */
const result = (page: Page) => page.locator('.scan-result');

async function station(page: Page, name: RegExp, step?: string) {
  const select = page.getByLabel('Estação', { exact: true });
  await expect(select.locator('option', { hasText: name })).toHaveCount(1);
  const option = (await select.locator('option').allTextContents()).find((t) => name.test(t))!;
  await select.selectOption({ label: option });
  if (step) await page.getByRole('button', { name: step, exact: true }).click();
}

test.describe('CME por leitura de código de barras', () => {
  test('recepção → limpeza → inspeção → preparo → embalagem → montagem → liberação → saída', async ({ page }) => {
    const problems = watchProblems(page);
    await login(page, 'cme');

    // A new physical asset gets an issued code.
    await page.goto('/cme/materiais');
    await page.getByRole('button', { name: 'Cadastrar materiais' }).click();
    await page.getByLabel(/^Caixa/).selectOption({ label: 'Ótica 30° 10 mm' });
    await page.getByLabel(/^Justificativa/).fill('Novo material rastreável (teste E2E)');
    await page.getByRole('button', { name: 'Emitir códigos' }).click();
    const issued = (await page.getByText(/^AT-[2-9A-HJKMNP-Z]{7}[0-9A-Z]\./).innerText()).slice(0, 11);

    await page.goto('/cme/estacao');
    await station(page, /^Expurgo/);
    await scanAs(page, issued);
    await expect(result(page).getByText('Recepção registrada.')).toBeVisible();
    await expect(result(page).getByText('Leitura aceita')).toBeVisible();

    await station(page, /^Limpeza/);
    await scanAs(page, issued);
    await expect(result(page).getByText('Limpeza registrada.')).toBeVisible();
    await scanAs(page, issued);
    await expect(result(page).getByText('Leitura duplicada')).toBeVisible();

    await station(page, /^Inspeção e preparo/, 'Preparo e montagem');
    await scanAs(page, issued);
    await expect(result(page).getByText('Etapa obrigatória pendente: Inspeção.')).toBeVisible();
    await page.getByRole('button', { name: 'Inspeção', exact: true }).click();
    await scanAs(page, issued);
    await expect(result(page).getByText('Inspeção aprovada.')).toBeVisible();
    await page.getByRole('button', { name: 'Preparo e montagem', exact: true }).click();
    await scanAs(page, issued);
    await expect(result(page).getByText('Preparo e montagem registrados.')).toBeVisible();

    await station(page, /^Embalagem/);
    await scanAs(page, issued);
    await expect(result(page).getByText('Embalagem registrada.')).toBeVisible();

    // Assembly: a load "em montagem" receives the package and issues its label.
    await station(page, /^Montagem de carga/);
    await page.getByRole('button', { name: 'Nova carga em montagem' }).click();
    await page.getByLabel('Equipamento da nova carga').selectOption({ label: 'Esterilizador a plasma (demonstração)' });
    await page.getByLabel('Programa da nova carga').fill('Plasma — ciclo padrão');
    await page.getByRole('button', { name: 'Criar' }).click();
    await expect(page.getByLabel('Carga em montagem')).not.toHaveValue('');
    await scanAs(page, issued);
    const packed = result(page).getByText(/Pacote incluído na carga\. Etiqueta PL1-\d{6}-\d{2}-\d{2}\./);
    await expect(packed).toBeVisible();
    const label = /PL1-\d{6}-\d{2}-\d{2}/.exec(await packed.innerText())![0];

    // Nothing leaves before the cycle and the release.
    await station(page, /^Expedição/);
    await page.getByLabel(/^Setor de destino/).selectOption({ label: 'Centro Cirúrgico' });
    await scanAs(page, label);
    await expect(result(page).getByText('Carga não liberada')).toBeVisible();

    await station(page, /^Montagem de carga/);
    await page.getByRole('link', { name: 'Abrir carga (iniciar ciclo)' }).click();
    await expect(page.getByText('Carga em montagem', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Iniciar ciclo' }).click();
    await page.getByRole('button', { name: 'Iniciar ciclo' }).last().click();
    await page.getByRole('button', { name: 'Encerrar ciclo' }).click();
    await page.getByLabel(/^Término/).fill(localInput(2 * 60_000));
    await page.getByLabel(/^Registro físico/).selectOption('conforme');
    await page.getByRole('button', { name: 'Encerrar ciclo' }).click();
    await page.getByRole('button', { name: 'Registrar teste' }).click();
    await page.getByLabel(/^Lote do indicador/).fill('IQ5-E2E');
    await page.getByLabel(/^Validade do indicador/).fill('2099-12-31');
    await page.getByRole('button', { name: 'Registrar', exact: true }).click();
    await page.getByRole('button', { name: 'Liberar' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.locator('.page-head').getByText('Liberada', { exact: true })).toBeVisible();

    await page.goto('/cme/estacao');
    await station(page, /^Expedição/);
    await page.getByLabel(/^Setor de destino/).selectOption({ label: 'Centro Cirúrgico' });
    await scanAs(page, label);
    await expect(result(page).getByText('Saída do CME registrada.')).toBeVisible();

    // The process trail shows every accepted and refused reading, with station and reader.
    await result(page).getByRole('link', { name: 'Ótica 30° 10 mm' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /Ótica 30° 10 mm/ })).toBeVisible();
    for (const step of ['Recepção de material contaminado — Leitura aceita', 'Limpeza — Leitura duplicada', 'Preparo e montagem — Etapa incorreta', 'Distribuição e saída do CME — Carga não liberada', 'Distribuição e saída do CME — Leitura aceita']) {
      await expect(page.getByText(step, { exact: true })).toBeVisible();
    }
    await expect(page.getByText(/Leitor de código de barras/).first()).toBeVisible();
    expect(problems).toEqual([]);
  });
});
