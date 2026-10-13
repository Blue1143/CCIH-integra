import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ROLE_PERMISSIONS, type AttachmentDto, type AttachmentPolicyDto } from '@ccih/domain';
import { DemoDataSource } from '../../data/demo/DemoDataSource';
import { DataSourceProvider } from '../../data/source';
import type { AuthPort, CcihDataSource, CmePort } from '../../data/port';
import { SessionProvider } from '../auth/session';
import { Attachments } from './shared';

const file = (over: Partial<AttachmentDto>): AttachmentDto => ({ id: 'a1', fileName: 'bowie-dick.pdf', mime: 'application/pdf', size: 2048, uploadedBy: 'Enfermeira CME', uploadedAt: '2026-10-12T12:00:00Z', scan: null, scannedAt: null, ...over });

function setup(policy: AttachmentPolicyDto) {
  const demo = new DemoDataSource(() => new Date('2026-10-12T12:00:00Z'));
  const auth: AuthPort = {
    me: async () => ({ user: { id: 'u1', login: 'cme', displayName: 'Enfermeira CME' }, roles: ['cme'], permissions: DEFAULT_ROLE_PERMISSIONS.cme, scope: null, isFounder: false, session: { expiresAt: '2026-10-12T23:00:00Z', idleExpiresAt: '2026-10-12T13:00:00Z', idleMinutes: 30 } }),
    login: async () => undefined, logout: async () => undefined, changePassword: async () => undefined,
  };
  const cme = {
    attachmentPolicy: vi.fn(async () => policy),
    rescanAttachment: vi.fn(async () => file({ scan: 'limpo' })),
    attachmentUrl: (id: string) => `/api/attachments/${id}`,
    upload: vi.fn(),
  } as unknown as CmePort & Record<string, ReturnType<typeof vi.fn>>;
  const source: CcihDataSource = { origin: 'real', auth, cme, getInstitution: () => demo.getInstitution(), getFacts: (q) => demo.getFacts(q) };
  const wrap = (files: AttachmentDto[]) => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DataSourceProvider source={source}><SessionProvider><Attachments entity="sterilization_test" entityId="t1" files={files} canUpload /></SessionProvider></DataSourceProvider>
    </QueryClientProvider>,
  );
  return { cme, wrap };
}

describe('evidence files and antivirus', () => {
  it('without antivirus, the file opens but is flagged as not verified', async () => {
    const { wrap } = setup({ antivirus: 'off', storage: 'local', encrypted: false, maxMb: 5 });
    wrap([file({})]);
    expect(await screen.findByText('Não verificado (sem antivírus)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'bowie-dick.pdf' })).toHaveAttribute('href', '/api/attachments/a1');
    expect(screen.queryByRole('button', { name: /Verificar novamente/ })).toBeNull();
  });

  it('with antivirus, a failed check hides the link and offers a new check', async () => {
    const user = userEvent.setup();
    const { cme, wrap } = setup({ antivirus: 'clamav', storage: 'local', encrypted: true, maxMb: 5 });
    wrap([file({ scan: 'erro' }), file({ id: 'a2', fileName: 'ciclo.pdf', scan: 'limpo', scannedAt: '2026-10-12T12:01:00Z' }), file({ id: 'a3', fileName: 'antigo.pdf', scan: 'infectado' })]);
    expect(await screen.findByText('Falha na verificação')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'bowie-dick.pdf' })).toBeNull();
    expect(screen.getByRole('link', { name: 'ciclo.pdf' })).toBeInTheDocument();
    expect(screen.getByText('Verificado pelo antivírus')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'antigo.pdf' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verificar novamente antigo.pdf' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Verificar novamente bowie-dick.pdf' }));
    await waitFor(() => expect(cme.rescanAttachment).toHaveBeenCalledWith('a1'));
  });
});
