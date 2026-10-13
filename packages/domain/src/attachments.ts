/**
 * Evidence files: whether a file may be opened depends on the antivirus check. With a scanner
 * configured, a file is available only after a "clean" result; without one (institutional decision
 * of 09/10/2026), files stay "not verified": available, but always flagged, never shown as approved.
 */
export type AttachmentScanStatus = 'nao_verificado' | 'pendente' | 'limpo' | 'infectado' | 'erro';
export type AntivirusMode = 'off' | 'clamav';

export const ATTACHMENT_SCAN_LABEL: Record<AttachmentScanStatus, string> = {
  nao_verificado: 'Não verificado (sem antivírus)',
  pendente: 'Aguardando verificação',
  limpo: 'Verificado pelo antivírus',
  infectado: 'Ameaça detectada — conteúdo descartado',
  erro: 'Falha na verificação',
};

/** Status from the latest check (null: never checked). */
export function attachmentScanStatus(latest: 'limpo' | 'infectado' | 'erro' | null, antivirus: AntivirusMode): AttachmentScanStatus {
  if (latest) return latest;
  return antivirus === 'off' ? 'nao_verificado' : 'pendente';
}

export function attachmentAvailability(status: AttachmentScanStatus, antivirus: AntivirusMode): { downloadable: boolean; reason: string | null } {
  if (status === 'limpo') return { downloadable: true, reason: null };
  if (status === 'infectado') return { downloadable: false, reason: 'O antivírus detectou ameaça; o conteúdo foi descartado.' };
  if (antivirus === 'off' && status === 'nao_verificado') return { downloadable: true, reason: null };
  if (status === 'erro') return { downloadable: false, reason: 'A verificação falhou: o arquivo fica indisponível até nova verificação.' };
  return { downloadable: false, reason: 'O arquivo fica disponível depois da verificação pelo antivírus.' };
}

/** A check can be requested for anything not yet clean (and never for discarded content). */
export const attachmentCanRescan = (status: AttachmentScanStatus, antivirus: AntivirusMode) => antivirus !== 'off' && status !== 'limpo' && status !== 'infectado';

export interface AttachmentPolicyDto { antivirus: AntivirusMode; storage: 'local' | 's3'; encrypted: boolean; maxMb: number }
