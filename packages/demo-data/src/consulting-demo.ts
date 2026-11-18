import {
  addDays, addMonths, findingId, monthStart, todayIn,
  type ChecklistAnswer, type ChecklistItem, type ChecklistResponse, type DemoAction, type DemoAssessment, type DemoConsultingState, type DemoInstitution,
  type FactRow, type IndicatorTarget, type IsoDate, type MetricCounts,
} from '@ccih/domain';

/**
 * Seed of the "Consultoria — Demonstração" area. Entirely fictitious: invented institutions,
 * units and people, aggregated monthly counts only, no patient. Counts are written out by hand
 * (no randomness) so the results can be checked with a calculator. Three profiles:
 *
 * - Hospital Alfa: stable general hospital, complete data.
 * - Hospital Beta: high complexity; ventilator-associated pneumonia rising in the last three
 *   months, overdue actions and an assessment still in progress.
 * - Instituto Gama: long-term care without mechanical ventilation (PAV denominator is zero) and
 *   one month with no data from one unit (missing data, never zero).
 */

export const DEMO_CONSULTING_SOURCE = 'Conjunto fictício da demonstração de consultoria v1 (sem pacientes, sem instituições reais)';
const TZ = 'America/Sao_Paulo';

type Series = [number, number, number, number, number, number];
interface UnitSeries {
  pacientes_dia: Series;
  cvc_dia: Series;
  vm_dia: Series;
  svd_dia: Series;
  iras_ipcs: Series;
  iras_pav: Series;
  iras_itu: Series;
  /** Month indexes (0–5) for which the unit sent nothing. */
  missing?: number[];
}

export const DEMO_CONSULTING_INSTITUTIONS: DemoInstitution[] = [
  {
    id: 'alfa', name: 'Hospital Alfa (fictício)', profile: 'Hospital geral de médio porte, 120 leitos; dados completos e indicadores estáveis.', beds: 120,
    consultant: 'Consultora Lúcia Exemplo',
    units: [{ id: 'alfa-uti', name: 'UTI Adulto' }, { id: 'alfa-cm', name: 'Clínica Médica' }],
  },
  {
    id: 'beta', name: 'Hospital Beta (fictício)', profile: 'Hospital de alta complexidade, 220 leitos; três unidades com dispositivos invasivos.', beds: 220,
    consultant: 'Consultor Marcos Modelo',
    units: [{ id: 'beta-uti', name: 'UTI Adulto' }, { id: 'beta-uco', name: 'UTI Coronariana' }, { id: 'beta-cc', name: 'Clínica Cirúrgica' }],
  },
  {
    id: 'gama', name: 'Instituto Gama de Retaguarda (fictício)', profile: 'Cuidados prolongados, 60 leitos; sem ventilação mecânica e com lacuna de registro.', beds: 60,
    consultant: 'Consultora Lúcia Exemplo',
    units: [{ id: 'gama-cp', name: 'Cuidados Prolongados' }, { id: 'gama-ut', name: 'Unidade de Transição' }],
  },
];

/** Monthly counts, oldest month first. */
export const DEMO_CONSULTING_SERIES: Record<string, UnitSeries> = {
  'alfa-uti': {
    pacientes_dia: [279, 252, 285, 276, 288, 270], cvc_dia: [180, 160, 190, 175, 182, 170], vm_dia: [120, 110, 125, 118, 121, 115], svd_dia: [150, 140, 155, 148, 152, 145],
    iras_ipcs: [1, 0, 0, 1, 0, 0], iras_pav: [1, 1, 0, 1, 0, 1], iras_itu: [0, 1, 0, 0, 1, 0],
  },
  'alfa-cm': {
    pacientes_dia: [820, 760, 840, 810, 830, 805], cvc_dia: [60, 55, 62, 58, 64, 59], vm_dia: [0, 0, 0, 0, 0, 0], svd_dia: [140, 130, 150, 138, 145, 136],
    iras_ipcs: [0, 0, 1, 0, 0, 0], iras_pav: [0, 0, 0, 0, 0, 0], iras_itu: [1, 0, 0, 1, 0, 0],
  },
  'beta-uti': {
    pacientes_dia: [590, 540, 600, 585, 598, 575], cvc_dia: [400, 370, 410, 395, 405, 390], vm_dia: [300, 280, 310, 330, 345, 352], svd_dia: [350, 320, 360, 348, 355, 340],
    iras_ipcs: [2, 1, 2, 1, 2, 1], iras_pav: [1, 2, 1, 3, 4, 5], iras_itu: [1, 1, 0, 1, 1, 1],
  },
  'beta-uco': {
    pacientes_dia: [290, 265, 300, 288, 295, 280], cvc_dia: [150, 140, 155, 148, 152, 146], vm_dia: [60, 55, 62, 70, 72, 75], svd_dia: [110, 100, 115, 108, 112, 105],
    iras_ipcs: [0, 1, 0, 0, 1, 0], iras_pav: [0, 0, 1, 0, 1, 1], iras_itu: [0, 0, 1, 0, 0, 1],
  },
  'beta-cc': {
    pacientes_dia: [1150, 1060, 1180, 1140, 1165, 1120], cvc_dia: [90, 85, 95, 88, 92, 87], vm_dia: [10, 8, 12, 9, 11, 10], svd_dia: [200, 185, 210, 198, 205, 190],
    iras_ipcs: [0, 0, 0, 1, 0, 0], iras_pav: [0, 0, 0, 0, 0, 0], iras_itu: [1, 0, 1, 1, 0, 1],
  },
  'gama-cp': {
    pacientes_dia: [1200, 1090, 1210, 1170, 1205, 1180], cvc_dia: [30, 28, 25, 32, 30, 27], vm_dia: [0, 0, 0, 0, 0, 0], svd_dia: [260, 240, 270, 255, 265, 250],
    iras_ipcs: [0, 0, 0, 0, 0, 0], iras_pav: [0, 0, 0, 0, 0, 0], iras_itu: [2, 1, 2, 3, 2, 2],
  },
  'gama-ut': {
    pacientes_dia: [560, 520, 575, 0, 570, 555], cvc_dia: [20, 18, 22, 0, 21, 19], vm_dia: [0, 0, 0, 0, 0, 0], svd_dia: [90, 85, 95, 0, 92, 88],
    iras_ipcs: [0, 0, 0, 0, 0, 0], iras_pav: [0, 0, 0, 0, 0, 0], iras_itu: [1, 0, 1, 0, 0, 1],
    missing: [3],
  },
};

const fictitiousTarget = (indicatorId: string, value: number, warningBand: number): IndicatorTarget => ({
  indicatorId, value, direction: 'lower', warningBand, origin: 'demonstracao', approvedBy: null, validFrom: '2026-01-01', referenceId: null,
});

/** Fictitious targets, created only for the demonstration and attributed to no entity. */
export const DEMO_CONSULTING_TARGETS: IndicatorTarget[] = [fictitiousTarget('di-ipcs', 2.0, 0.5), fictitiousTarget('di-pav', 7.0, 1.0), fictitiousTarget('di-itu', 2.5, 0.5)];

/** Illustrative checklist: not a certification nor a regulatory assessment. */
export const DEMO_CHECKLIST: ChecklistItem[] = [
  { id: 'v1', domain: 'vigilancia', text: 'Busca ativa de infecções associadas a dispositivos realizada com periodicidade definida' },
  { id: 'v2', domain: 'vigilancia', text: 'Critérios de vigilância adotados documentados e acessíveis à equipe' },
  { id: 'v3', domain: 'vigilancia', text: 'Denominadores (paciente-dia e dispositivo-dia) coletados diariamente em horário definido' },
  { id: 'v4', domain: 'vigilancia', text: 'Indicadores consolidados e divulgados mensalmente às unidades' },
  { id: 'p1', domain: 'protocolos', text: 'Protocolo de inserção e manutenção de cateter central aprovado e vigente' },
  { id: 'p2', domain: 'protocolos', text: 'Protocolo de prevenção de pneumonia associada à ventilação aprovado e vigente' },
  { id: 'p3', domain: 'protocolos', text: 'Protocolo de cateter urinário com critérios de indicação e retirada' },
  { id: 'p4', domain: 'protocolos', text: 'Protocolos revisados dentro do prazo definido pela própria instituição' },
  { id: 'c1', domain: 'capacitacao', text: 'Plano anual de capacitação em prevenção de infecções definido' },
  { id: 'c2', domain: 'capacitacao', text: 'Listas de presença das capacitações arquivadas' },
  { id: 'c3', domain: 'capacitacao', text: 'Equipes das unidades críticas capacitadas nos protocolos de dispositivos' },
  { id: 'c4', domain: 'capacitacao', text: 'Avaliação de aprendizagem aplicada após as capacitações' },
  { id: 'r1', domain: 'registros', text: 'Fichas de vigilância preenchidas de forma completa' },
  { id: 'r2', domain: 'registros', text: 'Atas das reuniões da comissão registradas e assinadas' },
  { id: 'r3', domain: 'registros', text: 'Planilhas de indicadores com fonte e responsável identificados' },
  { id: 'r4', domain: 'registros', text: 'Documentos controlados com versão e data de aprovação' },
];

type Answers = Partial<Record<string, [ChecklistAnswer | null, string?, string?]>>;

/** Items not listed are "conforme"; null = not answered yet. */
function responses(answers: Answers): ChecklistResponse[] {
  return DEMO_CHECKLIST.map((item) => {
    const [answer, observation = '', evidence = ''] = answers[item.id] ?? ['conforme'];
    return { itemId: item.id, answer, observation, evidence };
  });
}

function assessments(periods: string[]): DemoAssessment[] {
  const on = (month: number, day: number) => addDays(periods[month]!, day - 1);
  return [
    { id: 'alfa-1', institutionId: 'alfa', unitId: null, date: on(1, 15), status: 'concluida', responses: responses({
      v3: ['parcial', 'Horário de coleta varia entre os turnos.', 'Evidência simulada: 3 de 10 planilhas diárias com horário diferente.'],
      c4: ['parcial', 'Avaliação aplicada só em uma das turmas.', 'Evidência simulada: 1 de 3 turmas com avaliação registrada.'],
      p2: ['nao_se_aplica', 'Avaliado só para a UTI na visita anterior.'],
    }) },
    { id: 'alfa-2', institutionId: 'alfa', unitId: null, date: on(4, 11), status: 'concluida', responses: responses({
      c4: ['parcial', 'Avaliação ainda não aplicada na Clínica Médica.', 'Evidência simulada: 2 de 3 turmas com avaliação registrada.'],
      r2: ['parcial', 'Duas atas sem assinatura.', 'Evidência simulada: 4 atas revisadas, 2 sem assinatura.'],
      p4: ['nao_se_aplica', 'Prazo de revisão ainda não vencido para nenhum protocolo.'],
    }) },
    { id: 'beta-1', institutionId: 'beta', unitId: null, date: on(2, 9), status: 'concluida', responses: responses({
      c2: ['nao_conforme', 'Listas de presença não localizadas.', 'Evidência simulada: nenhuma lista de 2 turmas informadas.'],
      r1: ['parcial', 'Campos de data do dispositivo em branco.', 'Evidência simulada: 3 de 12 fichas incompletas.'],
    }) },
    { id: 'beta-2', institutionId: 'beta', unitId: null, date: on(5, 13), status: 'em_andamento', responses: responses({
      v1: ['nao_conforme', 'Busca ativa feita só quando há notificação da unidade.', 'Evidência simulada: registros de busca em 9 de 30 dias.'],
      p2: ['parcial', 'Protocolo existe, sem data de aprovação.', 'Evidência simulada: documento sem campo de aprovação.'],
      c3: ['nao_conforme', 'Equipe noturna da UTI Coronariana sem capacitação registrada.', 'Evidência simulada: 0 de 8 profissionais do turno com registro.'],
      r1: ['parcial', 'Persistem fichas incompletas.', 'Evidência simulada: 2 de 12 fichas incompletas.'],
      r3: ['nao_conforme', 'Planilhas sem identificação da fonte.', 'Evidência simulada: 3 planilhas revisadas, nenhuma com fonte.'],
      c4: [null], r2: [null], r4: [null],
    }) },
    { id: 'gama-1', institutionId: 'gama', unitId: null, date: on(3, 6), status: 'concluida', responses: responses({
      v3: ['nao_conforme', 'Dispositivo-dia da Unidade de Transição não coletado no mês.', 'Evidência simulada: planilha do mês vazia.'],
      v4: ['parcial', 'Divulgação irregular.', 'Evidência simulada: 2 de 4 meses com divulgação registrada.'],
      p2: ['nao_se_aplica', 'A instituição não utiliza ventilação mecânica.'],
      p3: ['nao_conforme', 'Não há protocolo escrito de cateter urinário.', 'Evidência simulada: documento não localizado.'],
      c1: ['nao_conforme', 'Plano anual não elaborado.', 'Evidência simulada: nenhum documento apresentado.'],
      c3: ['parcial', 'Capacitação registrada só para a equipe diurna.', 'Evidência simulada: 6 de 14 profissionais com registro.'],
      r4: ['parcial', 'Parte dos documentos sem versão.', 'Evidência simulada: 3 de 7 documentos sem versão.'],
    }) },
  ];
}

function actions(list: DemoAssessment[], ref: IsoDate): DemoAction[] {
  const date = (id: string) => list.find((a) => a.id === id)!.date;
  const make = (a: Omit<DemoAction, 'createdAt' | 'unitId' | 'findingId'> & { from: [string, string]; unitId?: string | null }): DemoAction => {
    const { from, unitId = null, ...rest } = a;
    return { ...rest, unitId, findingId: findingId(from[0], from[1]), createdAt: date(from[0]) };
  };
  return [
    make({ id: 'acao-alfa-1', institutionId: 'alfa', from: ['alfa-1', 'v3'], problem: 'Horário de coleta dos denominadores varia entre os turnos.', action: 'Definir horário único para a coleta de dispositivo-dia', responsible: 'Enf. Paula Modelo', deadline: addDays(date('alfa-1'), 30), priority: 'media', situation: 'concluida', completedAt: addDays(date('alfa-1'), 24) }),
    make({ id: 'acao-alfa-2', institutionId: 'alfa', from: ['alfa-2', 'c4'], problem: 'Avaliação de aprendizagem não aplicada em todas as turmas.', action: 'Aplicar avaliação de aprendizagem nas próximas capacitações da Clínica Médica', responsible: 'Enf. Paula Modelo', deadline: addDays(ref, 20), priority: 'media', situation: 'em_andamento', completedAt: null, unitId: 'alfa-cm' }),
    make({ id: 'acao-alfa-3', institutionId: 'alfa', from: ['alfa-2', 'r2'], problem: 'Atas da comissão sem assinatura.', action: 'Padronizar o modelo de ata e colher as assinaturas pendentes', responsible: 'Sec. Rui Exemplo', deadline: addDays(ref, -10), priority: 'baixa', situation: 'concluida', completedAt: addDays(ref, -15) }),
    make({ id: 'acao-beta-1', institutionId: 'beta', from: ['beta-1', 'c2'], problem: 'Listas de presença das capacitações não localizadas.', action: 'Organizar arquivo único das listas de presença', responsible: 'Analista Bruno Exemplo', deadline: addDays(date('beta-1'), 30), priority: 'media', situation: 'concluida', completedAt: addDays(date('beta-1'), 21) }),
    make({ id: 'acao-beta-2', institutionId: 'beta', from: ['beta-2', 'v1'], problem: 'Busca ativa realizada só quando há notificação da unidade.', action: 'Estruturar rotina diária de busca ativa nas UTIs', responsible: 'Enf. Carla Simulada', deadline: addDays(ref, -5), priority: 'alta', situation: 'em_andamento', completedAt: null }),
    make({ id: 'acao-beta-3', institutionId: 'beta', from: ['beta-2', 'p2'], problem: 'Protocolo de prevenção de PAV sem data de aprovação.', action: 'Revisar e aprovar o protocolo com as equipes das UTIs', responsible: 'Dr. Paulo Fictício', deadline: addDays(ref, 15), priority: 'alta', situation: 'pendente', completedAt: null }),
    make({ id: 'acao-beta-4', institutionId: 'beta', from: ['beta-2', 'r1'], problem: 'Fichas de vigilância incompletas.', action: 'Conferir mensalmente uma amostra de fichas de vigilância', responsible: 'Enf. Carla Simulada', deadline: addDays(ref, -12), priority: 'media', situation: 'pendente', completedAt: null }),
    make({ id: 'acao-beta-5', institutionId: 'beta', from: ['beta-2', 'r3'], problem: 'Planilhas de indicadores sem fonte identificada.', action: 'Identificar fonte e responsável em cada planilha de indicador', responsible: 'Analista Bruno Exemplo', deadline: addDays(ref, 30), priority: 'baixa', situation: 'pendente', completedAt: null }),
    make({ id: 'acao-gama-1', institutionId: 'gama', from: ['gama-1', 'p3'], problem: 'Ausência de protocolo escrito de cateter urinário.', action: 'Elaborar o protocolo de cateter urinário com critérios de indicação e retirada', responsible: 'Enf. Joana Modelo', deadline: addDays(ref, -20), priority: 'alta', situation: 'em_andamento', completedAt: null }),
    make({ id: 'acao-gama-2', institutionId: 'gama', from: ['gama-1', 'v3'], problem: 'Dispositivo-dia da Unidade de Transição não coletado.', action: 'Implantar a coleta diária de dispositivo-dia na Unidade de Transição', responsible: 'Téc. Ivo Simulado', deadline: addDays(ref, 10), priority: 'alta', situation: 'em_andamento', completedAt: null, unitId: 'gama-ut' }),
    make({ id: 'acao-gama-3', institutionId: 'gama', from: ['gama-1', 'c1'], problem: 'Plano anual de capacitação não elaborado.', action: 'Elaborar o plano anual de capacitação', responsible: 'Enf. Joana Modelo', deadline: addDays(ref, 45), priority: 'media', situation: 'pendente', completedAt: null }),
    make({ id: 'acao-gama-4', institutionId: 'gama', from: ['gama-1', 'v4'], problem: 'Divulgação irregular dos indicadores.', action: 'Divulgar os indicadores mensais em reunião com as unidades', responsible: 'Enf. Joana Modelo', deadline: addDays(date('gama-1'), 40), priority: 'baixa', situation: 'concluida', completedAt: addDays(date('gama-1'), 33) }),
  ];
}

function facts(periods: string[]): FactRow[] {
  const rows: FactRow[] = [];
  for (const [unitId, s] of Object.entries(DEMO_CONSULTING_SERIES)) {
    periods.forEach((period, i) => {
      if (s.missing?.includes(i)) return;
      const counts: MetricCounts = {
        pacientes_dia: s.pacientes_dia[i]!, cvc_dia: s.cvc_dia[i]!, vm_dia: s.vm_dia[i]!, svd_dia: s.svd_dia[i]!,
        iras_ipcs: s.iras_ipcs[i]!, iras_pav: s.iras_pav[i]!, iras_itu: s.iras_itu[i]!,
        iras_total: s.iras_ipcs[i]! + s.iras_pav[i]! + s.iras_itu[i]!,
      };
      rows.push({ period, sectorId: unitId, counts });
    });
  }
  return rows;
}

/**
 * Initial state of the demonstration. The six months end at the last closed month before `now`
 * (São Paulo time); deadlines are placed around that day, the demonstration's reference date.
 */
export function createConsultingDemo(now: Date = new Date()): DemoConsultingState {
  const referenceDate = todayIn(TZ, now);
  const last = addMonths(monthStart(referenceDate), -1);
  const periods = Array.from({ length: 6 }, (_, i) => addMonths(last, i - 5));
  const list = assessments(periods);
  return {
    version: 1,
    origin: 'demonstracao',
    referenceDate,
    periods,
    institutions: DEMO_CONSULTING_INSTITUTIONS,
    facts: facts(periods),
    targets: DEMO_CONSULTING_TARGETS,
    checklist: DEMO_CHECKLIST,
    assessments: list,
    actions: actions(list, referenceDate),
    reports: [
      { id: 'rel-alfa-1', institutionId: 'alfa', unitId: null, from: periods[0]!, to: periods[2]!, issuedAt: addDays(periods[3]!, 6) },
      { id: 'rel-beta-1', institutionId: 'beta', unitId: null, from: periods[0]!, to: periods[2]!, issuedAt: addDays(periods[3]!, 8) },
    ],
  };
}
