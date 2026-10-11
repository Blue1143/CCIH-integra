import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DEFAULT_ROLE_PERMISSIONS, QUIET_ZONE_MODULES, decodeCode128, type LabelContent, type LabelLayoutDto, type LabelLayoutInput, type LabelPrintDto, type RoleCode } from '@ccih/domain';
import { DemoDataSource } from '../../data/demo/DemoDataSource';
import { DataSourceProvider } from '../../data/source';
import { ApiError } from '../../data/api/http';
import type { AuthPort, CcihDataSource, CmePort } from '../../data/port';
import { SessionProvider } from '../auth/session';
import { LabelHistory, LabelPrintPanel, LabelView } from './labels';

const LAYOUT: LabelLayoutInput = { name: 'Pacote 70×40', entity: 'pacote', widthMm: 70, heightMm: 40, marginMm: 2, dpi: 203, barHeightMm: 10, fields: ['processamento', 'validade', 'lote', 'implante'] };
const LAYOUT_DTO: LabelLayoutDto = { ...LAYOUT, id: 'ly1', isDefault: true, active: true, dataOrigin: 'demo', rowVersion: 1, updatedAt: '2026-10-10T12:00:00Z' };
const CONTENT: LabelContent = { entity: 'pacote', code: 'CME01-251009-01-02', material: 'Caixa de laparotomia', processedOn: '2026-10-09', expiresOn: '2026-11-08', lot: 'CME01-251009-01', implant: false };
const PRINT: LabelPrintDto = {
  id: 'lp1', entity: 'pacote', entityId: 'i1', code: CONTENT.code, kind: 'impressao', output: 'navegador', reason: null, layoutName: LAYOUT.name, printedAt: '2026-10-10T12:00:00Z', printedBy: 'Técnico CME',
  status: 'ativa', replacedById: null, cancelReason: null, cancelledAt: null, cancelledBy: null,
};

function setup(role: RoleCode, over: Partial<Record<keyof CmePort, unknown>> = {}) {
  const demo = new DemoDataSource(() => new Date('2026-10-10T12:00:00Z'));
  const auth: AuthPort = {
    me: async () => ({ user: { id: 'u1', login: role, displayName: 'Operador' }, roles: [role], permissions: DEFAULT_ROLE_PERMISSIONS[role], scope: null, isFounder: false, session: { expiresAt: '2026-10-10T23:00:00Z', idleExpiresAt: '2026-10-10T13:00:00Z', idleMinutes: 30 } }),
    login: async () => undefined, logout: async () => undefined, changePassword: async () => undefined,
  };
  const cme = {
    labelLayouts: vi.fn(async () => ({ layouts: [LAYOUT_DTO] })),
    labelPrints: vi.fn(async () => ({ prints: [PRINT] })),
    printLabels: vi.fn(async () => ({ labels: [{ printId: 'lp2', layout: LAYOUT, content: CONTENT }], zpl: null, prints: [] })),
    cancelLabel: vi.fn(async () => ({ ...PRINT, status: 'cancelada' })),
    ...over,
  } as unknown as CmePort & Record<string, ReturnType<typeof vi.fn>>;
  const source: CcihDataSource = { origin: 'real', auth, cme, getInstitution: () => demo.getInstitution(), getFacts: (q) => demo.getFacts(q) };
  const wrap = (ui: ReactNode) => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DataSourceProvider source={source}><SessionProvider>{ui}</SessionProvider></DataSourceProvider>
    </QueryClientProvider>,
  );
  return { cme, wrap };
}

/** Reads the rendered SVG back into modules and decodes it (what a scanner would read). */
function decodeRendered(container: HTMLElement): string | null {
  const svg = container.querySelector('svg.cme-label-bars')!;
  const total = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
  const modules = new Array<boolean>(total).fill(false);
  svg.querySelectorAll('g rect').forEach((r) => { for (let k = 0; k < Number(r.getAttribute('width')); k++) modules[Number(r.getAttribute('x')) + k] = true; });
  expect(modules.slice(0, QUIET_ZONE_MODULES).some(Boolean)).toBe(false);
  return decodeCode128(modules);
}

let print: ReturnType<typeof vi.fn>;
beforeEach(() => { print = vi.fn(); vi.stubGlobal('print', print); });
afterEach(() => vi.unstubAllGlobals());

describe('labels (interface)', () => {
  it('renders the label at its size in mm with a barcode that decodes back to the code, and no patient data', () => {
    const { wrap } = setup('tec_cme');
    const { container } = wrap(<LabelView layout={LAYOUT} content={CONTENT} />);
    const label = container.querySelector('.cme-label') as HTMLElement;
    expect(label.style.width).toBe('70mm');
    expect(label.style.height).toBe('40mm');
    expect(decodeRendered(container)).toBe(CONTENT.code);
    expect(label.textContent).toContain('Val. 08/11/2026');
    expect(label.textContent).not.toContain('IMPLANTÁVEL');
  });

  it('prints through the browser with the default layout and opens the print dialog', async () => {
    const user = userEvent.setup();
    const { cme, wrap } = setup('tec_cme');
    wrap(<LabelPrintPanel entity="pacote" targets={[{ id: 'i1', code: CONTENT.code, hasActive: false }]} onClose={() => undefined} />);
    await screen.findByRole('option', { name: /Pacote 70×40 \(padrão\)/ });
    await user.click(screen.getByRole('button', { name: 'Imprimir' }));
    await waitFor(() => expect(cme.printLabels).toHaveBeenCalledWith({ entity: 'pacote', ids: ['i1'], layoutId: 'ly1', output: 'navegador', mode: 'impressao', reason: null }));
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(document.querySelector('.label-print-root .cme-label')).not.toBeNull();
    expect(screen.getByText(/1 etiqueta\(s\) registrada\(s\)/)).toBeInTheDocument();
    // What was just printed is now in use: a new print of it is a reprint.
    await user.selectOptions(screen.getByLabelText(/^Tipo/), 'reimpressao');
    expect(screen.getByText(CONTENT.code, { selector: 'p' })).toBeInTheDocument();
  });

  it('switches to reprint when the server says a label is in use, and asks the reason', async () => {
    const user = userEvent.setup();
    const reject = vi.fn().mockRejectedValueOnce(new ApiError(409, 'etiqueta_ja_impressa', 'Já existe etiqueta em uso para CME01-251009-01-02. Use a reimpressão, com o motivo.', [{ path: 'ids', message: 'CME01-251009-01-02' }]))
      .mockResolvedValueOnce({ labels: [{ printId: 'lp3', layout: LAYOUT, content: CONTENT }], zpl: '^XA\n^XZ', prints: [] });
    const { cme, wrap } = setup('tec_cme', { printLabels: reject });
    const created = vi.fn(() => 'blob:zpl');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    wrap(<LabelPrintPanel entity="pacote" targets={[{ id: 'i1', code: CONTENT.code, hasActive: false }]} onClose={() => undefined} />);
    await screen.findByRole('option', { name: /Pacote 70×40/ });
    await user.selectOptions(screen.getByLabelText(/^Saída/), 'zpl');
    await user.click(screen.getByRole('button', { name: 'Imprimir' }));
    expect(await screen.findByText(/Use a reimpressão/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reimprimir' }));
    expect(await screen.findByText(/Informe o motivo da reimpressão/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Motivo da reimpressão/), 'Etiqueta ilegível após o transporte');
    await user.click(screen.getByRole('button', { name: 'Reimprimir' }));
    await waitFor(() => expect(cme.printLabels).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'reimpressao', reason: 'Etiqueta ilegível após o transporte', output: 'zpl' })));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(clicked).toHaveBeenCalled();
    clicked.mockRestore();
    expect(screen.getByText(/arquivo ZPL gerado/)).toBeInTheDocument();
    expect(print).not.toHaveBeenCalled();
  });

  it('cancels the label in use only with a reason, and only for who records cycles', async () => {
    const user = userEvent.setup();
    const { cme, wrap } = setup('tec_cme');
    wrap(<LabelHistory entity="pacote" entityId="i1" />);
    await user.click(await screen.findByRole('button', { name: `Cancelar etiqueta ${CONTENT.code}` }));
    const area = screen.getByLabelText(/Motivo do cancelamento/).closest('.ig-stack') as HTMLElement;
    await user.click(within(area).getByRole('button', { name: 'Cancelar etiqueta' }));
    expect(await screen.findByText(/mínimo 10 caracteres/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Motivo do cancelamento/), 'Etiqueta rasgada na embalagem');
    await user.click(within(area).getByRole('button', { name: 'Cancelar etiqueta' }));
    await waitFor(() => expect(cme.cancelLabel).toHaveBeenCalledWith('lp1', 'Etiqueta rasgada na embalagem'));
  });

  it('shows the history without cancel action to who only consults the CME', async () => {
    const { wrap } = setup('enf_ccih');
    wrap(<LabelHistory entity="pacote" entityId="i1" />);
    expect(await screen.findByText(CONTENT.code)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancelar etiqueta/ })).toBeNull();
  });
});
