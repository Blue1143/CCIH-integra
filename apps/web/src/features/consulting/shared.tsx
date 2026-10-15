import type { ReactNode } from 'react';
import { AlertBanner, Field } from '@ccih/ui';
import { UF, type Address, type ClientStatus, type Status } from '@ccih/domain';
import { useDataSource } from '../../data/source';
import type { ConsultingPort } from '../../data/port';
import { useAdminMutation } from '../admin/shared';
import { PageHeader } from '../clinical/shared';

export function useConsulting(): ConsultingPort | undefined {
  return useDataSource().consulting;
}

/** Refreshed after any change in the portfolio. */
export const CONSULTING_KEYS = ['consulting'];
export function useConsultingMutation<I, O = unknown>(run: (input: I) => Promise<O>) {
  return useAdminMutation<I, O>(run, CONSULTING_KEYS);
}

export function RequireConsulting({ title, children }: { title: string; children: ReactNode }) {
  if (useConsulting()) return <>{children}</>;
  return (
    <div className="page">
      <PageHeader title={title} />
      <AlertBanner tone="info" title="Módulo disponível com o backend">A carteira da consultoria exige a API, com controle de acesso por cliente e histórico (VITE_DATA_SOURCE=api).</AlertBanner>
    </div>
  );
}

export const CLIENT_STATUS_TONE: Record<ClientStatus, Status> = { prospecto: 'info', ativo: 'ok', suspenso: 'warn', encerrado: 'neutral' };

export const EMPTY_ADDRESS: Address = { street: null, number: null, district: null, city: null, state: null, zip: null };
export const blank = (v: string) => (v.trim() ? v.trim() : null);

export type AddressDraft = Record<keyof Address, string>;
export const addressDraft = (a: Address): AddressDraft => ({ street: a.street ?? '', number: a.number ?? '', district: a.district ?? '', city: a.city ?? '', state: a.state ?? '', zip: a.zip ?? '' });
export const addressInput = (d: AddressDraft): Address => ({ street: blank(d.street), number: blank(d.number), district: blank(d.district), city: blank(d.city), state: (blank(d.state) as Address['state']) ?? null, zip: blank(d.zip) });
export const addressLine = (a: Address) => [a.street && `${a.street}${a.number ? `, ${a.number}` : ''}`, a.district, a.city && `${a.city}${a.state ? `/${a.state}` : ''}`, a.zip && `CEP ${a.zip.replace(/^(\d{5})(\d{3})$/, '$1-$2')}`].filter(Boolean).join(' · ') || '—';

export function AddressFields({ value, onChange, errors }: { value: AddressDraft; onChange: (v: AddressDraft) => void; errors: Record<string, string | undefined> }) {
  const set = (k: keyof AddressDraft) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <>
      <div className="ig-form-row">
        <Field label="Logradouro"><input value={value.street} maxLength={160} onChange={set('street')} /></Field>
        <Field label="Número"><input value={value.number} maxLength={20} onChange={set('number')} /></Field>
        <Field label="Bairro"><input value={value.district} maxLength={80} onChange={set('district')} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Cidade"><input value={value.city} maxLength={80} onChange={set('city')} /></Field>
        <Field label="UF" error={errors['address.state'] ?? null}><select value={value.state} onChange={set('state')}><option value="">—</option>{UF.map((u) => <option key={u} value={u}>{u}</option>)}</select></Field>
        <Field label="CEP" error={errors['address.zip'] ?? null}><input value={value.zip} inputMode="numeric" maxLength={9} onChange={set('zip')} /></Field>
      </div>
    </>
  );
}
