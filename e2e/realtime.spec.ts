import { expect, test } from '@playwright/test';
import { login, watchProblems } from './support';

test.describe('Tempo real', () => {
  test('uma leitura registrada numa sessão aparece na outra sem recarregar a página', async ({ browser }) => {
    const watcher = await browser.newContext();
    const operator = await browser.newContext();
    const a = await watcher.newPage();
    const b = await operator.newPage();
    const problems = watchProblems(a);
    await login(a, 'cme');
    await login(b, 'admin');
    await expect(a.getByRole('status').filter({ hasText: 'Tempo real' })).toBeVisible();

    const station = async (page: typeof a) => {
      await page.goto('/cme/estacao');
      const select = page.getByLabel('Estação', { exact: true });
      await expect(select.locator('option', { hasText: /^Devoluções/ })).toHaveCount(1);
      const option = (await select.locator('option').allTextContents()).find((t) => t.startsWith('Devoluções'))!;
      await select.selectOption({ label: option });
    };
    await station(a);
    await station(b);
    const code = 'AT-QQQQQQQQ';
    await expect(a.getByRole('cell', { name: code })).toHaveCount(0);

    const field = b.getByLabel('Leitura do código de barras');
    await field.focus();
    await b.keyboard.type(code, { delay: 4 });
    await b.keyboard.press('Enter');
    await expect(b.locator('.scan-result')).toBeVisible();

    // The watcher's list updates by itself (no reload, no navigation).
    await expect(a.getByRole('cell', { name: code }).first()).toBeVisible({ timeout: 10_000 });
    expect(problems).toEqual([]);
    await watcher.close();
    await operator.close();
  });
});
