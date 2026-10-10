
/**
 * Quality workflows: audits, non-conformities and 5W2H action plans. Every transition requires a
 * justification and is recorded in an append-only history by the API.
 */
export type AuditStatus = 'planejada' | 'em_andamento' | 'concluida' | 'plano_de_acao' | 'verificacao_eficacia' | 'encerrada' | 'cancelada';

export const AUDIT_STATUS_LABEL: Record<AuditStatus, string> = {
  planejada: 'Planejada', em_andamento: 'Em andamento', concluida: 'Concluída', plano_de_acao: 'Plano de ação',
  verificacao_eficacia: 'Verificação de eficácia', encerrada: 'Encerrada', cancelada: 'Cancelada',
};

export const AUDIT_TRANSITIONS: Record<AuditStatus, AuditStatus[]> = {
  planejada: ['em_andamento', 'cancelada'],
  em_andamento: ['concluida', 'cancelada'],
  concluida: ['plano_de_acao', 'encerrada'],
  plano_de_acao: ['verificacao_eficacia'],
  verificacao_eficacia: ['encerrada', 'plano_de_acao'],
  encerrada: [],
  cancelada: [],
};

export type AuditKind = 'processo' | 'estrutura' | 'documental' | 'outro';
export const AUDIT_KIND_LABEL: Record<AuditKind, string> = { processo: 'Processo', estrutura: 'Estrutura', documental: 'Documental', outro: 'Outro' };

export type NcStatus = 'aberta' | 'em_tratamento' | 'aguardando_eficacia' | 'encerrada' | 'cancelada';
export const NC_STATUS_LABEL: Record<NcStatus, string> = {
  aberta: 'Aberta', em_tratamento: 'Em tratamento', aguardando_eficacia: 'Aguardando eficácia', encerrada: 'Encerrada', cancelada: 'Cancelada',
};
export const NC_TRANSITIONS: Record<NcStatus, NcStatus[]> = {
  aberta: ['em_tratamento', 'cancelada'],
  em_tratamento: ['aguardando_eficacia', 'cancelada'],
  aguardando_eficacia: ['encerrada', 'em_tratamento'],
  encerrada: [],
  cancelada: [],
};

export type NcSeverity = 'baixa' | 'media' | 'alta';
export const NC_SEVERITY_LABEL: Record<NcSeverity, string> = { baixa: 'Baixa', media: 'Média', alta: 'Alta' };
export type NcOrigin = 'auditoria' | 'bundle' | 'higiene_maos' | 'cme' | 'notificacao' | 'outro';
export const NC_ORIGIN_LABEL: Record<NcOrigin, string> = {
  auditoria: 'Auditoria', bundle: 'Auditoria de bundle', higiene_maos: 'Higiene das mãos', cme: 'CME', notificacao: 'Notificação', outro: 'Outro',
};

export type ActionStatus = 'pendente' | 'em_andamento' | 'concluida' | 'cancelada';
export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = { pendente: 'Pendente', em_andamento: 'Em andamento', concluida: 'Concluída', cancelada: 'Cancelada' };

/** 5W2H fields of an action plan item (labels for forms and exports). */
export const FIVE_W_TWO_H = {
  what: 'O quê (ação)', why: 'Por quê', where: 'Onde', who: 'Quem (responsável)', when: 'Quando (prazo)', how: 'Como', howMuch: 'Quanto custa',
} as const;

export interface NcCloseCheck {
  actions: Array<{ status: ActionStatus }>;
  effectiveness: string | null;
}

/** Problems that block a non-conformity transition (pt-BR). */
export function checkNcTransition(from: NcStatus, to: NcStatus, input: NcCloseCheck & { justification: string }): Array<{ path: string; message: string }> {
  const p: Array<{ path: string; message: string }> = [];
  if (!NC_TRANSITIONS[from].includes(to)) p.push({ path: 'status', message: `Transição não permitida: ${NC_STATUS_LABEL[from]} → ${NC_STATUS_LABEL[to]}.` });
  if (input.justification.trim().length < 10) p.push({ path: 'justification', message: 'Descreva o motivo (mínimo 10 caracteres).' });
  if (to === 'em_tratamento' && from === 'aberta' && !input.actions.some((a) => a.status !== 'cancelada')) p.push({ path: 'actions', message: 'Cadastre ao menos uma ação do plano (5W2H).' });
  if (to === 'aguardando_eficacia' && input.actions.some((a) => a.status === 'pendente' || a.status === 'em_andamento')) p.push({ path: 'actions', message: 'Conclua ou cancele todas as ações antes de verificar a eficácia.' });
  if (to === 'encerrada' && !input.effectiveness?.trim()) p.push({ path: 'effectiveness', message: 'Registre o resultado da verificação de eficácia.' });
  return p;
}

export function checkAuditTransition(from: AuditStatus, to: AuditStatus, input: { justification: string; findings: string | null }): Array<{ path: string; message: string }> {
  const p: Array<{ path: string; message: string }> = [];
  if (!AUDIT_TRANSITIONS[from].includes(to)) p.push({ path: 'status', message: `Transição não permitida: ${AUDIT_STATUS_LABEL[from]} → ${AUDIT_STATUS_LABEL[to]}.` });
  if (input.justification.trim().length < 10) p.push({ path: 'justification', message: 'Descreva o motivo (mínimo 10 caracteres).' });
  if (to === 'concluida' && !input.findings?.trim()) p.push({ path: 'findings', message: 'Registre os achados da auditoria antes de concluí-la.' });
  return p;
}

