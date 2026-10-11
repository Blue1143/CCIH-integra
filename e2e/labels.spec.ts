import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from '@zxing/library';
import { login } from './support';

/** Reads a Code 128 symbol from a screenshot, as an image scanner would (ZXing). */
function decodePng(buffer: Buffer): string {
  const png = PNG.sync.read(buffer);
  const luminance = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < luminance.length; i++) {
    const [r, g, b] = [png.data[i * 4]!, png.data[i * 4 + 1]!, png.data[i * 4 + 2]!];
    luminance[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]], [DecodeHintType.TRY_HARDER, true]]);
  return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, png.width, png.height))), hints).getText();
}

test.describe('Etiquetas', () => {
  test('a etiqueta impressa pelo navegador é lida de volta com o mesmo código, e a reimpressão em ZPL exige motivo', async ({ browser }) => {
    // High pixel density, as a printer would render the bars (0.25 mm modules).
    const ctx = await browser.newContext({ deviceScaleFactor: 4, acceptDownloads: true });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as { print: () => void; __prints: number };
      w.__prints = 0;
      w.print = () => { w.__prints += 1; };
    });
    await login(page, 'tec.cme');
    await page.goto('/cme/materiais');
    const first = page.getByRole('button', { name: /^(Imprimir|Reimprimir) etiqueta AT-/ }).first();
    const name = (await first.getAttribute('aria-label'))!;
    const code = name.replace(/^.* etiqueta /, '');
    await first.click();
    const panel = page.locator('.ig-card', { has: page.getByRole('heading', { name: /etiquetas$/ }) }).first();
    if (name.startsWith('Reimprimir')) await panel.getByLabel(/Motivo da reimpressão/).fill('Execução do teste automatizado de etiquetas');
    await panel.getByRole('button', { name: /^(Imprimir|Reimprimir)$/ }).click();
    await expect(panel.getByText(/etiqueta\(s\) registrada\(s\)/)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);

    // Print media: only the label is printed, at the layout size.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#root')).toBeHidden();
    const label = page.locator('.label-print-root .cme-label').first();
    await expect(label).toBeVisible();
    expect(await label.getAttribute('data-label-code')).toBe(code);
    const box = (await label.boundingBox())!;
    expect(Math.round(box.width / (96 / 25.4))).toBe(50);
    expect(decodePng(await label.locator('svg').screenshot())).toBe(code);
    await page.emulateMedia({ media: 'screen' });

    // Reprint as ZPL: the label in use is replaced, with the reason; the file encodes the same code.
    await panel.getByLabel(/^Saída/).selectOption('zpl');
    await panel.getByLabel(/^Tipo/).selectOption('reimpressao');
    await panel.getByRole('button', { name: 'Reimprimir' }).click();
    await expect(panel.getByText(/Informe o motivo da reimpressão/)).toBeVisible();
    await panel.getByLabel(/Motivo da reimpressão/).fill('Etiqueta danificada no teste automatizado');
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Reimprimir' }).click();
    const zpl = readFileSync(await (await download).path(), 'utf8');
    expect(zpl).toMatch(/^\^XA/);
    expect(zpl).toContain(`^FD>:${code}^FS`);

    // History: the reprint is in use and the previous label is marked as replaced.
    await page.goto('/cme/etiquetas');
    await page.getByLabel('Buscar etiquetas pelo código').fill(code);
    const rows = page.getByRole('table', { name: 'Etiquetas emitidas' }).getByRole('row', { name: new RegExp(code) });
    await expect(rows.first()).toContainText('Reimpressão');
    await expect(rows.first()).toContainText('Ativa');
    await expect(rows.nth(1)).toContainText('Substituída');
    await ctx.close();
  });
});
