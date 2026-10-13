import { describe, expect, it } from 'vitest';
import { attachmentAvailability, attachmentCanRescan, attachmentScanStatus } from './attachments';

describe('attachment availability', () => {
  it('without antivirus, files are "not verified": available but never shown as approved', () => {
    const status = attachmentScanStatus(null, 'off');
    expect(status).toBe('nao_verificado');
    expect(attachmentAvailability(status, 'off')).toEqual({ downloadable: true, reason: null });
    expect(attachmentCanRescan(status, 'off')).toBe(false);
  });

  it('with antivirus, only a clean result makes a file available', () => {
    expect(attachmentScanStatus(null, 'clamav')).toBe('pendente');
    expect(attachmentAvailability('pendente', 'clamav').downloadable).toBe(false);
    expect(attachmentAvailability('nao_verificado', 'clamav').downloadable).toBe(false);
    expect(attachmentAvailability('erro', 'clamav').reason).toMatch(/falhou/);
    expect(attachmentAvailability('limpo', 'clamav').downloadable).toBe(true);
    expect(attachmentCanRescan('erro', 'clamav')).toBe(true);
  });

  it('a threat is never available nor checked again', () => {
    for (const mode of ['off', 'clamav'] as const) expect(attachmentAvailability('infectado', mode).downloadable).toBe(false);
    expect(attachmentCanRescan('infectado', 'clamav')).toBe(false);
  });
});
