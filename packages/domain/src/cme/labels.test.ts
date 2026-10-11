import { describe, expect, it } from 'vitest';
import { BitArray, Code128Reader } from '@zxing/library';
import { code128Modules, code128Segments, code128Svg, code128Values, decodeCode128, modulesFromSvg, QUIET_ZONE_MODULES } from './barcode';
import { barcodeFit, checkLabelLayout, labelContentProblems, labelLines, labelPrintRefusal, labelPrintStatus, labelZpl, zplText, type LabelContent, type LabelLayoutInput } from './labels';
import { issueCode } from './codes';
import { itemLabel } from './cme';

/** Independent reader (ZXing) over a single row of modules with quiet zones. */
function zxingRead(modules: boolean[]): string {
  const row = new BitArray(modules.length + 2 * QUIET_ZONE_MODULES);
  modules.forEach((dark, i) => { if (dark) row.set(i + QUIET_ZONE_MODULES); });
  return new Code128Reader().decodeRow(0, row, new Map()).getText();
}

let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const SAMPLES = [
  'AT-K7M2Q9X4', 'PR-ABCDEFG7', 'CME01-251009-01-02', 'CME-251009-03', '1234', '12', '123', '12345', 'A1234567B', 'X-000000-00-00',
  'ab cd/ef.gh+$%', '9876543210', 'LOT 2026 10 11',
  ...Array.from({ length: 30 }, () => issueCode(random() < 0.5 ? 'ativo' : 'processo', random)),
  ...Array.from({ length: 20 }, (_, i) => itemLabel(`CME${i}-2610${String(i).padStart(2, '0')}-0${i % 10}`, i + 1)),
];

describe('Code 128', () => {
  it('round-trips through the own decoder and through an independent reader (ZXing)', () => {
    for (const text of SAMPLES) {
      const modules = code128Modules(text);
      expect(decodeCode128(modules)).toBe(text);
      expect(zxingRead(modules)).toBe(text);
    }
  });

  it('reads the SVG back to the same code (automatic check of the image)', () => {
    for (const text of SAMPLES) {
      const svg = code128Svg(text, { moduleMm: 0.25, heightMm: 10 });
      expect(decodeCode128(modulesFromSvg(svg))).toBe(text);
      expect(svg).toContain(`data-code="${text.replace(/&/g, '&amp;')}"`);
    }
  });

  it('packs digit runs in subset C and keeps the check symbol', () => {
    expect(code128Segments('CME01-251009-01-02')).toEqual([{ subset: 'B', data: 'CME01-' }, { subset: 'C', data: '251009' }, { subset: 'B', data: '-01-02' }]);
    expect(code128Segments('12345')).toEqual([{ subset: 'C', data: '1234' }, { subset: 'B', data: '5' }]);
    expect(code128Segments('A12345')).toEqual([{ subset: 'B', data: 'A1' }, { subset: 'C', data: '2345' }]);
    // Known vector: "PJJ123C" in subset B → check symbol 55.
    expect(code128Values('PJJ123C').slice(-2)).toEqual([55, 106]);
  });

  it('rejects damaged symbols and characters outside printable ASCII', () => {
    const modules = code128Modules('AT-K7M2Q9X4');
    const broken = [...modules];
    broken[40] = !broken[40];
    expect(decodeCode128(broken)).toBeNull();
    expect(() => code128Modules('ÇÃO')).toThrow(/não aceito/);
    expect(() => code128Modules('')).toThrow();
  });
});

const PKG: LabelLayoutInput = { name: 'Pacote 70×40', entity: 'pacote', widthMm: 70, heightMm: 40, marginMm: 2, dpi: 203, barHeightMm: 10, fields: ['processamento', 'validade', 'lote', 'equipamento', 'implante'] };
const CONTENT: LabelContent = { entity: 'pacote', code: 'CME01-251009-01-02', material: 'Caixa de laparotomia', processedOn: '2026-10-09', expiresOn: '2026-11-08', lot: 'CME01-251009-01', equipment: 'Autoclave 1 · 134 °C', implant: true };

describe('label layouts', () => {
  it('accepts a layout that holds the fields and a typical code', () => {
    expect(checkLabelLayout(PKG)).toEqual([]);
  });

  it('refuses sizes that do not hold the code or the fields, and sterile packages without expiry', () => {
    expect(checkLabelLayout({ ...PKG, widthMm: 25 }).map((p) => p.path)).toContain('widthMm');
    expect(checkLabelLayout({ ...PKG, heightMm: 20 }).map((p) => p.path)).toContain('heightMm');
    expect(checkLabelLayout({ ...PKG, fields: ['lote'] })[0]!.message).toMatch(/validade/);
    expect(checkLabelLayout({ ...PKG, entity: 'ativo', fields: ['validade'] })[0]!.message).toMatch(/não se aplicam/);
    expect(checkLabelLayout({ ...PKG, dpi: 150 }).map((p) => p.path)).toContain('dpi');
  });

  it('snaps the module to whole printer dots', () => {
    const fit = barcodeFit(PKG, CONTENT.code);
    expect(fit.problem).toBeNull();
    expect(Number.isInteger(fit.moduleDots)).toBe(true);
    expect(fit.moduleMm).toBeCloseTo(fit.moduleDots / (203 / 25.4), 6);
    expect(fit.widthMm).toBeLessThanOrEqual(PKG.widthMm - 2 * PKG.marginMm);
  });

  it('prints lines in layout order, shows the implant warning only for implants, and never patient data', () => {
    expect(labelLines(PKG, CONTENT).map((l) => l.text)).toEqual(['Proc. 09/10/2026', 'Val. 08/11/2026', 'Lote CME01-251009-01', 'Equip. Autoclave 1 · 134 °C', 'IMPLANTÁVEL']);
    expect(labelLines(PKG, { ...CONTENT, implant: false }).map((l) => l.field)).not.toContain('implante');
  });

  it('refuses a package without expiry and a code that does not fit', () => {
    expect(labelContentProblems(PKG, { ...CONTENT, expiresOn: null })[0]).toMatch(/validade/);
    expect(labelContentProblems({ ...PKG, widthMm: 22, marginMm: 1 }, CONTENT)[0]).toMatch(/não cabe/);
    expect(labelContentProblems(PKG, CONTENT)).toEqual([]);
  });
});

describe('ZPL', () => {
  it('encodes the same subset sequence as the SVG, escapes text and sets the size in dots', () => {
    const zpl = labelZpl(PKG, CONTENT);
    expect(zpl.startsWith('^XA\n^CI28\n^PW559\n^LL320')).toBe(true);
    expect(zpl).toContain('^FD>:CME01->5251009>6-01-02^FS');
    expect(zpl).toContain(`^BY${barcodeFit(PKG, CONTENT.code).moduleDots}^BCN,80,N,N,N,N`);
    expect(zpl).toContain('IMPLANT_C3_81VEL');
    expect(zpl.trim().endsWith('^XZ')).toBe(true);
  });

  it('never lets data inject ZPL commands', () => {
    expect(zplText('A^XZ~JA_b')).toBe('A_5EXZ_7EJA_5Fb');
    expect(labelZpl(PKG, { ...CONTENT, material: 'Caixa ^XA^FDhack' })).not.toContain('^FDhack');
  });
});

describe('print rules', () => {
  it('refuses labels for rejected loads, written-off assets and closed processes', () => {
    expect(labelPrintRefusal({ entity: 'pacote', loadStatus: 'rejeitada' })).toMatch(/nova etiqueta/);
    expect(labelPrintRefusal({ entity: 'pacote', loadStatus: 'aguardando' })).toBeNull();
    expect(labelPrintRefusal({ entity: 'ativo', assetStatus: 'baixado' })).toMatch(/baixado/);
    expect(labelPrintRefusal({ entity: 'processo', processClosed: true })).toMatch(/encerrado/);
  });

  it('derives the status from replacement and cancellation', () => {
    expect(labelPrintStatus({ replacedById: null, cancelledAt: null })).toBe('ativa');
    expect(labelPrintStatus({ replacedById: 'x', cancelledAt: null })).toBe('substituida');
    expect(labelPrintStatus({ replacedById: null, cancelledAt: '2026-10-11T10:00:00Z' })).toBe('cancelada');
  });
});
