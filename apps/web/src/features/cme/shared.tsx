import { useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ATTACHMENT_SCAN_LABEL, LOAD_STATUS_LABEL, attachmentAvailability, attachmentCanRescan, attachmentScanStatus, testResultLabel, type AttachmentDto, type AttachmentScanStatus, type CmeSectorDto, type LoadStatus, type SterilizationTestType, type Status, type TestResult } from '@ccih/domain';
import { AlertBanner, Button, FormMessage, LOAD_TONE, StatusBadge, SubNav } from '@ccih/ui';
import { useDataSource } from '../../data/source';
import type { AttachmentEntity, CmePort } from '../../data/port';
import { ApiError } from '../../data/api/http';
import { useAdminMutation } from '../admin/shared';
import { useSession } from '../auth/session';
import { PageHeader } from '../clinical/shared';

export function useCme(): CmePort | undefined {
  return useDataSource().cme;
}

/** Every sector of the institution (names only): destinations and use places are hospital-wide. */
export function useCmeSectors() {
  const cme = useCme();
  return useQuery({ queryKey: ['cme', 'sectors'], queryFn: () => cme!.sectors(), enabled: !!cme, staleTime: 5 * 60_000 });
}

export const cmeSectorName = (sectors: { sectors: CmeSectorDto[] } | undefined, id: string | null | undefined) => (id ? (sectors?.sectors.find((s) => s.id === id)?.name ?? 'Setor') : '—');

/** Refreshed after any CME change (alerts and indicators depend on the records). */
export const CME_KEYS = ['cme', 'alerts', 'surgery', 'facts'];

export function useCmeMutation<I, O = unknown>(run: (input: I) => Promise<O>) {
  return useAdminMutation<I, O>(run, CME_KEYS);
}

/** CME actions that change records: without any of them the user only consults the CME. */
const CME_WRITE = ['cme:scan', 'cme:cycle:record', 'cme:test:record', 'cme:release', 'cme:configure', 'cme:stations:configure'] as const;

export function RequireCme({ title, children }: { title: string; children: ReactNode }) {
  const session = useSession();
  const readOnly = session.status === 'authenticated' && !session.can(...CME_WRITE);
  if (useCme()) {
    return (
      <>
        {readOnly ? (
          <div className="page" style={{ paddingBottom: 0 }}>
            <AlertBanner tone="info" title="Modo consulta">Seu perfil consulta a CME e a rastreabilidade, mas não altera registros, ciclos, testes ou cargas. A API recusa qualquer alteração, mesmo por acesso direto.</AlertBanner>
          </div>
        ) : null}
        {children}
      </>
    );
  }
  return (
    <div className="page">
      <PageHeader title={title} />
      <AlertBanner tone="info" title="Módulo disponível com o backend">
        Ciclos, testes, liberação de cargas e rastreabilidade exigem a API, com controle de acesso, histórico imutável e auditoria (VITE_DATA_SOURCE=api).
      </AlertBanner>
    </div>
  );
}

export function CmeNav() {
  const { pathname } = useLocation();
  const session = useSession();
  const items = [
    ...(session.status !== 'authenticated' || session.can('cme:scan') ? [{ key: 'estacao', label: 'Estação de leitura', href: '/cme/estacao' }] : []),
    { key: 'processos', label: 'Processos', href: '/cme/processos' },
    { key: 'cargas', label: 'Cargas e liberação', href: '/cme' },
    { key: 'bd', label: 'Bowie-Dick', href: '/cme/bowie-dick' },
    { key: 'equip', label: 'Equipamentos', href: '/cme/equipamentos' },
    { key: 'caixas', label: 'Caixas', href: '/cme/caixas' },
    { key: 'materiais', label: 'Materiais', href: '/cme/materiais' },
    { key: 'etiquetas', label: 'Etiquetas', href: '/cme/etiquetas' },
    { key: 'estacoes', label: 'Estações e fluxo', href: '/cme/estacoes' },
  ].map((i) => ({ ...i, active: i.href === '/cme' ? pathname === '/cme' || pathname.startsWith('/cme/cargas') : pathname === i.href || pathname.startsWith(`${i.href}/`) }));
  return <SubNav label="Seções da CME" items={items} renderLink={(item, className) => <Link to={item.href} className={className} aria-current={item.active ? 'page' : undefined}>{item.label}</Link>} />;
}

export function LoadStatusBadge({ status }: { status: LoadStatus }) {
  return <StatusBadge status={LOAD_TONE[status]}>{LOAD_STATUS_LABEL[status]}</StatusBadge>;
}

const RESULT_TONE: Record<TestResult, Status> = { aprovado: 'ok', reprovado: 'crit', pendente: 'warn' };
export function TestResultBadge({ type, result }: { type: SterilizationTestType; result: TestResult }) {
  return <StatusBadge status={RESULT_TONE[result]}>{testResultLabel(type, result)}</StatusBadge>;
}

const sizeLabel = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

/** Evidence files of a record: downloads are same-origin links; uploads are checked by the server. */
export function Attachments({ entity, entityId, files, canUpload, refresh = CME_KEYS }: { entity: AttachmentEntity; entityId: string; files: AttachmentDto[]; canUpload: boolean; refresh?: string[] }) {
  const cme = useCme()!;
  const session = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const m = useAdminMutation((file: File) => cme.upload(entity, entityId, file), refresh);
  const policy = useQuery({ queryKey: ['attachments', 'policy'], queryFn: () => cme.attachmentPolicy(), staleTime: 5 * 60_000 });
  const rescan = useAdminMutation((id: string) => cme.rescanAttachment(id), refresh);
  const antivirus = policy.data?.antivirus ?? 'off';
  const pick = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) { setError('Envie PDF, PNG ou JPEG.'); return; }
    m.mutation.mutate(file, { onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível enviar o arquivo.') });
    if (input.current) input.current.value = '';
  };
  return (
    <div className="cme-files">
      {files.length ? (
        <ul className="cme-file-list">
          {files.map((f) => {
            const status = attachmentScanStatus(f.scan, antivirus);
            const { downloadable, reason } = attachmentAvailability(status, antivirus);
            return (
              <li key={f.id}>
                {downloadable && policy.isSuccess ? <a href={cme.attachmentUrl(f.id)} download>{f.fileName}</a> : <span>{f.fileName}</span>}{' '}
                <span className="ig-small ig-muted">{sizeLabel(f.size)} · {f.uploadedBy}</span>{' '}
                {policy.isSuccess ? <StatusBadge status={SCAN_TONE[status]}>{ATTACHMENT_SCAN_LABEL[status]}</StatusBadge> : null}
                {reason ? <span className="ig-small ig-muted"> {reason}</span> : null}
                {canUpload && session.writable && attachmentCanRescan(status, antivirus) ? (
                  <> <Button size="sm" disabled={rescan.mutation.isPending} onClick={() => rescan.mutation.mutate(f.id)} aria-label={`Verificar novamente ${f.fileName}`}>Verificar novamente</Button></>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {canUpload && session.writable ? (
        <>
          <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg" hidden onChange={(e) => pick(e.target.files?.[0])} aria-label="Arquivo de evidência" />
          <Button size="sm" icon="plus" disabled={m.mutation.isPending} onClick={() => input.current?.click()}>{m.mutation.isPending ? 'Enviando…' : 'Anexar evidência'}</Button>
        </>
      ) : null}
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      {rescan.formError ? <FormMessage tone="error">{rescan.formError}</FormMessage> : null}
    </div>
  );
}

const SCAN_TONE: Record<AttachmentScanStatus, Status> = { limpo: 'ok', nao_verificado: 'neutral', pendente: 'warn', erro: 'warn', infectado: 'crit' };
