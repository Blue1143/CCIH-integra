import { z } from 'zod';

/** Shared input schemas (pt-BR messages come from the error map in errors.ts). */
// Any 8-4-4-4-12 hexadecimal identifier (as before zod 4, which made .uuid() check the RFC version bits).
export const Uuid = z.guid('Identificador inválido.');
export const RowVersion = z.number().int().min(1);
export const Justification = z.string().trim().min(10, 'Descreva o motivo (mínimo 10 caracteres).').max(500);
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD.');
export const MonthStart = z.string().regex(/^\d{4}-\d{2}-01$/, 'Use o primeiro dia do mês (AAAA-MM-01).');
/** Date-time with offset (the browser sends ISO strings in UTC). */
export const Instant = z.string().datetime({ offset: true, message: 'Data e hora inválidas.' }).transform((v) => new Date(v));
export const Text = (max: number) => z.string().trim().min(1).max(max);
export const OptionalText = (max: number) => z.string().trim().max(max).nullable().transform((v) => (v ? v : null));

export const PageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
};

/** Not in the future (5 minutes of clock tolerance). */
export const notFuture = (d: Date) => d.getTime() <= Date.now() + 5 * 60_000;
