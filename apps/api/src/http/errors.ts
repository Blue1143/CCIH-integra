import { z, type ZodTypeAny } from 'zod';

/** Errors the API returns on purpose. Anything else becomes a generic 500 without internals. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, 'nao_autenticado', 'Sessão inexistente ou expirada. Entre novamente.');
export const forbidden = () => new HttpError(403, 'sem_permissao', 'Seu perfil não tem permissão para esta ação.');
export const notFound = (what = 'Registro') => new HttpError(404, 'nao_encontrado', `${what} não encontrado.`);
export const conflict = () => new HttpError(409, 'conflito_de_versao', 'Este registro foi alterado por outra pessoa. Recarregue e tente novamente.');

/** pt-BR validation messages (messages written in the schemas take precedence). */
z.config({
  customError: (issue) => {
    switch (issue.code) {
      case 'invalid_type':
        return issue.input === undefined ? 'Campo obrigatório.' : 'Tipo de valor inválido.';
      case 'too_small':
        return issue.origin === 'string' ? `Informe ao menos ${issue.minimum} caractere(s).` : `Valor mínimo: ${issue.minimum}.`;
      case 'too_big':
        return issue.origin === 'string' ? `Informe no máximo ${issue.maximum} caracteres.` : `Valor máximo: ${issue.maximum}.`;
      case 'invalid_value':
        return `Valor inválido. Opções: ${issue.values.join(', ')}.`;
      case 'unrecognized_keys':
        return `Campo(s) não permitido(s): ${issue.keys.join(', ')}.`;
      case 'invalid_format':
        return 'Formato inválido.';
      default:
        return undefined;
    }
  },
});

/** Validates input; unknown fields are rejected by `.strict()` schemas (no mass assignment). */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new HttpError(400, 'validacao', 'Dados inválidos. Revise os campos indicados.', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}
