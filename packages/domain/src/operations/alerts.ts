import { addDays, dayDiff, type IsoDate } from '../dates';
import type { Permission } from '../permissions';
import type { StockEvaluation } from '../rules/operations';

/**
 * Alert center. Candidates are derived from the records with institutional thresholds; the API
 * deduplicates them by key (one open alert per key) and suppresses re-creation for a configured
 * period after closure, to limit alert fatigue. Training alerts are aggregated per training and sector.
 */
export type AlertKind =
  | 'iras_investigacao_atrasada' | 'dispositivo_prolongado' | 'mdr_novo' | 'treinamento_vencido'
  | 'insumo_critico' | 'plano_acao_atrasado' | 'isc_contato_pendente'
  | 'cme_carga_recolhida' | 'cme_uso_sem_saida' | 'cme_liberada_com_falha' | 'cme_bowie_dick_reprovado' | 'cme_ib_leitura_atrasada' | 'cme_qualificacao'
  | 'cme_etapa_atrasada' | 'cme_carga_aguardando_decisao' | 'cme_leituras_recusadas' | 'cme_estacao_incompativel' | 'cme_saida_sem_liberacao'
  // Consulting model.
  | 'contrato_vencendo' | 'contrato_vencido' | 'contrato_entregas_abaixo';

/** Severity (kept under the historical name "priority"). */
export type AlertPriority = 'critica' | 'alta' | 'media' | 'baixa';
export type AlertStatus = 'aberto' | 'reconhecido' | 'assumido' | 'resolvido' | 'encerrado';
export type AlertCategory = 'erro_operacional' | 'violacao_sequencia' | 'pendencia_tempo' | 'falha_integracao' | 'informacao_obrigatoria' | 'nao_conformidade' | 'seguranca';
export type AlertClosedReason = 'manual' | 'automatico' | 'excecao';
export type AlertActionKind = 'criado' | 'visualizado' | 'reconhecido' | 'assumido' | 'comentado' | 'resolvido' | 'encerrado' | 'encerrado_automatico' | 'excecao';

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  iras_investigacao_atrasada: 'Investigação de IRAS sem conclusão',
  dispositivo_prolongado: 'Dispositivo em uso prolongado',
  mdr_novo: 'Novo microrganismo multirresistente',
  treinamento_vencido: 'Treinamento obrigatório vencido ou pendente',
  insumo_critico: 'Insumo em situação crítica',
  plano_acao_atrasado: 'Ação de plano 5W2H atrasada',
  isc_contato_pendente: 'Vigilância pós-alta de ISC sem contato',
  cme_carga_recolhida: 'Carga da CME recolhida após uso',
  cme_liberada_com_falha: 'Carga liberada com teste reprovado',
  cme_uso_sem_saida: 'Pacote usado sem saída registrada do CME',
  cme_bowie_dick_reprovado: 'Bowie-Dick reprovado com equipamento em uso',
  cme_ib_leitura_atrasada: 'Indicador biológico sem leitura no prazo',
  cme_qualificacao: 'Qualificação de equipamento da CME',
  cme_etapa_atrasada: 'Material parado numa etapa da CME além do prazo',
  cme_carga_aguardando_decisao: 'Carga aguardando decisão de liberação além do prazo',
  cme_leituras_recusadas: 'Leituras recusadas repetidas numa estação',
  cme_estacao_incompativel: 'Leitura em estação incompatível com a etapa',
  cme_saida_sem_liberacao: 'Tentativa de saída de material sem liberação',
  contrato_vencendo: 'Contrato perto do vencimento',
  contrato_vencido: 'Contrato vencido sem renovação ou encerramento',
  contrato_entregas_abaixo: 'Entregas abaixo do previsto no contrato',
};
export const ALERT_PRIORITY_LABEL: Record<AlertPriority, string> = { critica: 'Crítica', alta: 'Alta', media: 'Média', baixa: 'Baixa' };
export const ALERT_PRIORITY_ORDER: AlertPriority[] = ['critica', 'alta', 'media', 'baixa'];
export const ALERT_STATUS_LABEL: Record<AlertStatus, string> = { aberto: 'Aberto', reconhecido: 'Reconhecido', assumido: 'Assumido', resolvido: 'Resolvido', encerrado: 'Encerrado' };
export const ALERT_CATEGORY_LABEL: Record<AlertCategory, string> = {
  erro_operacional: 'Erro operacional', violacao_sequencia: 'Violação de sequência', pendencia_tempo: 'Pendência de tempo', falha_integracao: 'Falha de integração',
  informacao_obrigatoria: 'Informação obrigatória ausente', nao_conformidade: 'Não conformidade', seguranca: 'Segurança do paciente',
};
export const ALERT_CLOSED_REASON_LABEL: Record<AlertClosedReason, string> = { manual: 'Encerrado manualmente', automatico: 'Condição resolvida no registro de origem', excecao: 'Exceção formal autorizada' };
export const ALERT_ACTION_LABEL: Record<AlertActionKind, string> = {
  criado: 'Criado', visualizado: 'Visualizado', reconhecido: 'Reconhecido', assumido: 'Assumido', comentado: 'Comentário', resolvido: 'Resolvido',
  encerrado: 'Encerrado', encerrado_automatico: 'Encerrado automaticamente', excecao: 'Exceção formal',
};

/** Category of each kind (stored on the alert so it can be filtered). */
export const ALERT_KIND_CATEGORY: Record<AlertKind, AlertCategory> = {
  iras_investigacao_atrasada: 'pendencia_tempo', dispositivo_prolongado: 'pendencia_tempo', mdr_novo: 'seguranca', treinamento_vencido: 'pendencia_tempo',
  insumo_critico: 'seguranca', plano_acao_atrasado: 'nao_conformidade', isc_contato_pendente: 'pendencia_tempo',
  cme_carga_recolhida: 'seguranca', cme_uso_sem_saida: 'violacao_sequencia', cme_liberada_com_falha: 'seguranca', cme_bowie_dick_reprovado: 'seguranca',
  cme_ib_leitura_atrasada: 'pendencia_tempo', cme_qualificacao: 'pendencia_tempo',
  cme_etapa_atrasada: 'pendencia_tempo', cme_carga_aguardando_decisao: 'pendencia_tempo', cme_leituras_recusadas: 'erro_operacional', cme_estacao_incompativel: 'erro_operacional',
  cme_saida_sem_liberacao: 'violacao_sequencia',
  contrato_vencendo: 'pendencia_tempo', contrato_vencido: 'pendencia_tempo', contrato_entregas_abaixo: 'pendencia_tempo',
};

/**
 * Blocking (safety) alerts cannot be closed by hand while their condition persists: the way out is to
 * fix the cause in the record (the alert then closes by itself) or a formal exception (alerts:exception).
 */
export const ALERT_KIND_BLOCKING: Record<AlertKind, boolean> = {
  iras_investigacao_atrasada: false, dispositivo_prolongado: false, mdr_novo: false, treinamento_vencido: false, insumo_critico: false, plano_acao_atrasado: false,
  isc_contato_pendente: false, cme_carga_recolhida: false, cme_uso_sem_saida: false, cme_liberada_com_falha: true, cme_bowie_dick_reprovado: true,
  cme_ib_leitura_atrasada: false, cme_qualificacao: false, cme_etapa_atrasada: false, cme_carga_aguardando_decisao: false, cme_leituras_recusadas: false,
  cme_estacao_incompativel: false, cme_saida_sem_liberacao: false, contrato_vencendo: false, contrato_vencido: false, contrato_entregas_abaixo: false,
};

/** Statuses still requiring work (everything but closed). */
export const ALERT_OPEN_STATUSES: AlertStatus[] = ['aberto', 'reconhecido', 'assumido', 'resolvido'];

/** What a user may do next on an alert (the API enforces the same rules). */
export function alertActions(a: { status: AlertStatus; blocking: boolean }): { acknowledge: boolean; assume: boolean; resolve: boolean; close: boolean; exception: boolean } {
  const open = a.status !== 'encerrado';
  return {
    acknowledge: a.status === 'aberto',
    assume: a.status === 'aberto' || a.status === 'reconhecido',
    resolve: open && a.status !== 'resolvido',
    close: open && !a.blocking,
    exception: open && a.blocking,
  };
}

/** Who may see each kind of alert (besides alerts:view). */
export const ALERT_KIND_PERMISSION: Record<AlertKind, Permission> = {
  iras_investigacao_atrasada: 'iras:view', dispositivo_prolongado: 'patient:view', mdr_novo: 'micro:view', treinamento_vencido: 'quality:view',
  insumo_critico: 'quality:view', plano_acao_atrasado: 'quality:view', isc_contato_pendente: 'surgery:view',
  cme_carga_recolhida: 'cme:view', cme_liberada_com_falha: 'cme:view', cme_uso_sem_saida: 'cme:view', cme_bowie_dick_reprovado: 'cme:view', cme_ib_leitura_atrasada: 'cme:view', cme_qualificacao: 'cme:view',
  cme_etapa_atrasada: 'cme:view', cme_carga_aguardando_decisao: 'cme:view', cme_leituras_recusadas: 'cme:view', cme_estacao_incompativel: 'cme:view', cme_saida_sem_liberacao: 'cme:view',
  contrato_vencendo: 'consultoria:contracts:view', contrato_vencido: 'consultoria:contracts:view', contrato_entregas_abaixo: 'consultoria:contracts:view',
};

export interface AlertCandidate {
  kind: AlertKind;
  dedupKey: string;
  priority: AlertPriority;
  title: string;
  detail: string;
  entity: string;
  entityId: string | null;
  sectorId: string | null;
  /** Client of the consultancy concerned (consulting model): the alert follows the client scope. */
  clientId?: string | null;
  /** Screen where the alert is handled. */
  link: string | null;
  /** Deadline (institution date) that was or will be missed, when the alert is about time. */
  dueOn?: IsoDate | null;
  /** CME process step concerned, when there is one. */
  step?: string | null;
  /**
   * An event (not a lasting condition): once an alert with this key is closed it is never
   * recreated, even after the suppression window, while the event is still recent.
   */
  oneShot?: boolean;
}

export interface AlertRules {
  investigationOverdueDays: number | undefined;
  deviceReviewDays: number | undefined;
  ibReadingHours?: number | undefined;
  qualificationWarningDays?: number | undefined;
  /** Hours allowed at each CME step before the next reading; a step without a value raises nothing. */
  cmeStepMaxHours?: Partial<Record<'recepcao' | 'limpeza' | 'inspecao' | 'preparo' | 'embalagem', number>>;
  loadDecisionMaxHours?: number | undefined;
  invalidReadingsLimit?: number | undefined;
  invalidReadingsWindowMin?: number | undefined;
}

export interface AlertInput {
  today: IsoDate;
  rules: AlertRules;
  openCases: Array<{ id: string; typeLabel: string; patientLabel: string; openedOn: IsoDate; sectorId: string }>;
  openDevices: Array<{ id: string; type: string; patientId: string; patientLabel: string; insertedOn: IsoDate; sectorId: string | null }>;
  newMdr: Array<{ isolateId: string; cultureId: string; organism: string; patientLabel: string; sectorId: string; collectedOn: IsoDate }>;
  trainingGaps: Array<{ trainingId: string; trainingTitle: string; sectorId: string; overdue: number }>;
  supplies: Array<{ id: string; name: string; evaluation: StockEvaluation }>;
  overdueActions: Array<{ id: string; ncId: string; what: string; dueOn: IsoDate; sectorId: string | null }>;
  pendingFollowups: Array<{ surgeryId: string; procedure: string; patientLabel: string; windowEnd: IsoDate }>;
  cme?: {
    /** Loads recalled (rejected after release) in the last days, with the exposure found. */
    recalledLoads: Array<{ loadId: string; code: string; surgeries: number; patients: number; sectorId: string }>;
    /** Packages used (surgery or sector) although the flow has no registered exit (transition period). */
    usesWithoutExit?: Array<{ useId: string; labelCode: string; processId: string; usedOn: IsoDate; sectorId: string }>;
    /** Released loads whose current tests now fail the policy (e.g. a positive IB read later). */
    releasedWithFailure: Array<{ loadId: string; code: string; reason: string; sectorId: string }>;
    /** Sterilizers still in use whose latest Bowie-Dick of the day failed. */
    failedBowieDick: Array<{ sterilizerId: string; name: string; sectorId: string }>;
    /** Pending biological indicators with the hours since incubation started. */
    pendingIb: Array<{ testId: string; loadId: string; loadCode: string; hours: number; sectorId: string }>;
    qualifications: Array<{ sterilizerId: string; name: string; dueOn: IsoDate; sectorId: string }>;
    /** Open processes with the hours since their last accepted reading. */
    stalledProcesses?: Array<{ processId: string; label: string; step: 'recepcao' | 'limpeza' | 'inspecao' | 'preparo' | 'embalagem'; hours: number; sectorId: string | null }>;
    /** Loads whose cycle ended and still await the release decision. */
    loadsAwaitingDecision?: Array<{ loadId: string; code: string; hours: number; sectorId: string }>;
    /** Refused readings per station within the configured window. */
    refusedReadings?: Array<{ stationId: string; stationName: string; count: number; sectorId: string }>;
    /** Readings refused today because the station does not handle the step (or method). */
    incompatibleStations?: Array<{ stationId: string; stationName: string; count: number; sectorId: string }>;
    /** Exit or separation attempts refused because the load was not released (last 30 days). */
    exitsWithoutRelease?: Array<{ processId: string; label: string; loadCode: string | null; on: IsoDate; sectorId: string | null }>;
  };
}

const STEP_NAME = { recepcao: 'recepção', limpeza: 'limpeza', inspecao: 'inspeção', preparo: 'preparo', embalagem: 'embalagem' } as const;

export function buildAlertCandidates(input: AlertInput): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const { investigationOverdueDays: overdue, deviceReviewDays: review } = input.rules;
  if (overdue != null) {
    for (const c of input.openCases) {
      const days = dayDiff(c.openedOn, input.today);
      if (days >= overdue) out.push({ kind: 'iras_investigacao_atrasada', dedupKey: `iras:${c.id}`, dueOn: addDays(c.openedOn, overdue), priority: 'alta', title: `${c.typeLabel} em aberto há ${days} dias`, detail: `Paciente ${c.patientLabel}. Limite institucional: ${overdue} dias.`, entity: 'iras_case', entityId: c.id, sectorId: c.sectorId, link: `/vigilancia/${c.id}` });
    }
  }
  if (review != null) {
    for (const d of input.openDevices) {
      const day = dayDiff(d.insertedOn, input.today) + 1;
      if (day > review) out.push({ kind: 'dispositivo_prolongado', dedupKey: `disp:${d.id}`, priority: 'media', title: `${d.type} em D${day}: reavaliar indicação`, detail: `Paciente ${d.patientLabel}. Revisão configurada a partir de D${review + 1}.`, entity: 'device_use', entityId: d.id, sectorId: d.sectorId, link: `/pacientes/${d.patientId}` });
    }
  }
  for (const m of input.newMdr) {
    out.push({ kind: 'mdr_novo', oneShot: true, dedupKey: `mdr:${m.isolateId}`, priority: 'alta', title: `${m.organism} multirresistente`, detail: `Paciente ${m.patientLabel}, coleta em ${m.collectedOn.split('-').reverse().join('/')}. Verificar precauções conforme protocolo institucional.`, entity: 'isolate', entityId: m.isolateId, sectorId: m.sectorId, link: `/microbiologia/${m.cultureId}` });
  }
  for (const t of input.trainingGaps) {
    if (t.overdue <= 0) continue;
    out.push({ kind: 'treinamento_vencido', dedupKey: `trein:${t.trainingId}:${t.sectorId}`, priority: 'baixa', title: `${t.trainingTitle}: ${t.overdue} profissional(is) sem treinamento válido`, detail: 'Inclui pendentes e vencidos do setor.', entity: 'training', entityId: t.trainingId, sectorId: t.sectorId, link: '/treinamentos' });
  }
  for (const s of input.supplies) {
    if (s.evaluation.status !== 'crit') continue;
    out.push({ kind: 'insumo_critico', dedupKey: `insumo:${s.id}:${s.evaluation.label}`, priority: s.evaluation.coverage === 'indisponivel' ? 'alta' : 'media', title: `${s.name}: ${s.evaluation.label}`, detail: s.evaluation.coverageDays != null ? `Cobertura estimada de ${Math.floor(s.evaluation.coverageDays)} dia(s).` : 'Sem consumo registrado nos últimos 30 dias.', entity: 'supply', entityId: s.id, sectorId: null, link: '/insumos' });
  }
  for (const a of input.overdueActions) {
    out.push({ kind: 'plano_acao_atrasado', dedupKey: `acao:${a.id}`, dueOn: a.dueOn, priority: 'media', title: `Ação atrasada: ${a.what.slice(0, 80)}`, detail: `Prazo ${a.dueOn.split('-').reverse().join('/')}.`, entity: 'action_plan', entityId: a.id, sectorId: a.sectorId, link: `/auditorias/nao-conformidades/${a.ncId}` });
  }
  for (const f of input.pendingFollowups) {
    out.push({ kind: 'isc_contato_pendente', dedupKey: `isc:${f.surgeryId}`, dueOn: f.windowEnd, priority: 'baixa', title: `${f.procedure}: sem contato pós-alta`, detail: `Paciente ${f.patientLabel}. Janela de vigilância até ${f.windowEnd.split('-').reverse().join('/')}.`, entity: 'surgery', entityId: f.surgeryId, sectorId: null, link: `/cirurgias/${f.surgeryId}` });
  }
  if (input.cme) {
    for (const l of input.cme.recalledLoads) {
      const exposure = l.surgeries ? `${l.patients} paciente(s) em ${l.surgeries} cirurgia(s) receberam material da carga: avaliar com a CCIH a necessidade de vigilância.` : 'Nenhum material desta carga foi registrado em uso.';
      out.push({ kind: 'cme_carga_recolhida', oneShot: true, dedupKey: `recolhe:${l.loadId}`, priority: l.surgeries ? 'critica' : 'media', title: `Carga ${l.code} recolhida`, detail: exposure, entity: 'sterilization_load', entityId: l.loadId, sectorId: l.sectorId, link: `/cme/cargas/${l.loadId}` });
    }
    for (const u of input.cme.usesWithoutExit ?? []) {
      out.push({ kind: 'cme_uso_sem_saida', oneShot: true, dedupKey: `semsaida:${u.useId}`, step: 'distribuicao', priority: 'media', title: `Pacote ${u.labelCode} usado sem saída do CME`, detail: `Uso em ${u.usedOn.split('-').reverse().join('/')}. O uso não foi bloqueado: foi aberta uma não conformidade e quem registrou o uso foi notificado. Revise com a expedição por que a saída não foi lida.`, entity: 'cme_process', entityId: u.processId, sectorId: u.sectorId, link: `/cme/processos/${u.processId}` });
    }
    for (const l of input.cme.releasedWithFailure) {
      out.push({ kind: 'cme_liberada_com_falha', dedupKey: `falha:${l.loadId}`, priority: 'critica', step: 'liberacao', title: `Carga ${l.code} liberada com teste reprovado`, detail: `${l.reason} Avaliar o recolhimento dos pacotes e a exposição de pacientes.`, entity: 'sterilization_load', entityId: l.loadId, sectorId: l.sectorId, link: `/cme/cargas/${l.loadId}` });
    }
    for (const b of input.cme.failedBowieDick) {
      out.push({ kind: 'cme_bowie_dick_reprovado', dedupKey: `bd:${b.sterilizerId}:${input.today}`, priority: 'critica', step: 'esterilizacao', title: `${b.name}: Bowie-Dick reprovado hoje`, detail: 'Bloquear o equipamento (manutenção) ou repetir o teste com aprovação antes de novas cargas.', entity: 'sterilizer', entityId: b.sterilizerId, sectorId: b.sectorId, link: '/cme/equipamentos' });
    }
    const limit = input.rules.ibReadingHours;
    if (limit != null) {
      for (const t of input.cme.pendingIb) {
        if (t.hours < limit) continue;
        out.push({ kind: 'cme_ib_leitura_atrasada', dedupKey: `ib:${t.testId}`, step: 'liberacao', priority: 'media', title: `Carga ${t.loadCode}: indicador biológico sem leitura há ${Math.floor(t.hours)} h`, detail: `Prazo institucional: ${limit} h após o início da incubação.`, entity: 'sterilization_test', entityId: t.testId, sectorId: t.sectorId, link: `/cme/cargas/${t.loadId}` });
      }
    }
    const warn = input.rules.qualificationWarningDays;
    if (warn != null) {
      for (const q of input.cme.qualifications) {
        const days = dayDiff(input.today, q.dueOn);
        if (days > warn) continue;
        out.push({ kind: 'cme_qualificacao', dedupKey: `qualif:${q.sterilizerId}:${q.dueOn}`, dueOn: q.dueOn, priority: days < 0 ? 'alta' : 'baixa', title: days < 0 ? `${q.name}: qualificação vencida` : `${q.name}: qualificação vence em ${days} dia(s)`, detail: `Vencimento em ${q.dueOn.split('-').reverse().join('/')}.`, entity: 'sterilizer', entityId: q.sterilizerId, sectorId: q.sectorId, link: '/cme/equipamentos' });
      }
    }
    // Process breaks. Time rules only exist where the institution configured a deadline.
    const stepLimits = input.rules.cmeStepMaxHours ?? {};
    for (const p of input.cme.stalledProcesses ?? []) {
      const limit = stepLimits[p.step];
      if (limit == null || p.hours < limit) continue;
      out.push({
        kind: 'cme_etapa_atrasada', dedupKey: `etapa:${p.processId}:${p.step}`, priority: 'media', step: p.step,
        title: `${p.label}: parado em ${STEP_NAME[p.step]} há ${Math.floor(p.hours)} h`, detail: `Prazo institucional para a próxima leitura: ${limit} h.`,
        entity: 'cme_process', entityId: p.processId, sectorId: p.sectorId, link: `/cme/processos/${p.processId}`,
      });
    }
    const decision = input.rules.loadDecisionMaxHours;
    if (decision != null) {
      for (const l of input.cme.loadsAwaitingDecision ?? []) {
        if (l.hours < decision) continue;
        out.push({
          kind: 'cme_carga_aguardando_decisao', dedupKey: `decisao:${l.loadId}`, priority: 'media', step: 'liberacao',
          title: `Carga ${l.code} aguardando decisão há ${Math.floor(l.hours)} h`, detail: `Prazo institucional entre o fim do ciclo e a decisão: ${decision} h.`,
          entity: 'sterilization_load', entityId: l.loadId, sectorId: l.sectorId, link: `/cme/cargas/${l.loadId}`,
        });
      }
    }
    const refusedLimit = input.rules.invalidReadingsLimit;
    if (refusedLimit != null && input.rules.invalidReadingsWindowMin != null) {
      for (const r of input.cme.refusedReadings ?? []) {
        if (r.count < refusedLimit) continue;
        out.push({
          kind: 'cme_leituras_recusadas', dedupKey: `recusas:${r.stationId}:${input.today}`, priority: 'media',
          title: `${r.stationName}: ${r.count} leituras recusadas em ${input.rules.invalidReadingsWindowMin} min`,
          detail: 'Verifique o leitor, as etiquetas e a etapa escolhida na estação. As leituras recusadas estão na lista da estação.',
          entity: 'scan_station', entityId: r.stationId, sectorId: r.sectorId, link: `/cme/estacao?estacao=${r.stationId}`,
        });
      }
    }
    for (const st of input.cme.incompatibleStations ?? []) {
      out.push({
        kind: 'cme_estacao_incompativel', oneShot: true, dedupKey: `incompativel:${st.stationId}:${input.today}`, priority: 'baixa',
        title: `${st.stationName}: ${st.count} leitura(s) de etapa ou método não configurado na estação`,
        detail: 'A leitura foi recusada. Confira a configuração da estação ou oriente a leitura na estação correta.',
        entity: 'scan_station', entityId: st.stationId, sectorId: st.sectorId, link: '/cme/estacoes',
      });
    }
    for (const x of input.cme.exitsWithoutRelease ?? []) {
      out.push({
        kind: 'cme_saida_sem_liberacao', oneShot: true, dedupKey: `saida:${x.processId}`, priority: 'alta', step: 'distribuicao',
        title: `${x.label}: tentativa de saída sem liberação${x.loadCode ? ` (carga ${x.loadCode})` : ''}`,
        detail: `Em ${x.on.split('-').reverse().join('/')}. A saída foi recusada pelo sistema; confira por que o material chegou à expedição antes da liberação.`,
        entity: 'cme_process', entityId: x.processId, sectorId: x.sectorId, link: `/cme/processos/${x.processId}`,
      });
    }
  }
  return out;
}

export type FollowupMethod = 'telefone' | 'ambulatorio' | 'retorno' | 'mensagem' | 'outro';
export const FOLLOWUP_METHOD_LABEL: Record<FollowupMethod, string> = { telefone: 'Telefone', ambulatorio: 'Ambulatório', retorno: 'Retorno ao hospital', mensagem: 'Mensagem', outro: 'Outro' };
export type FollowupOutcome = 'sem_sinais' | 'suspeita' | 'nao_localizado';
export const FOLLOWUP_OUTCOME_LABEL: Record<FollowupOutcome, string> = { sem_sinais: 'Sem sinais de infecção', suspeita: 'Suspeita de ISC', nao_localizado: 'Paciente não localizado' };
