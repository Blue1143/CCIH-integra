import type { OrganizationType, Permission } from '@ccih/domain';

/** Main navigation. Modules not yet built say so and name the roadmap phase — no fake screens. */
export interface NavItem {
  path: string;
  label: string;
  /** Shown when the profile has any of these (the API enforces the same rule); empty = anyone in the model. */
  permissions: Permission[];
  /** Business models that have this module (default: hospital only). */
  models?: OrganizationType[];
  /** Roadmap phase (number) or delivery stage (text, e.g. "M3") of the module; null = available now. */
  phase: number | string | null;
  summary: string;
  planned?: string[];
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  // Consulting model (hidden in hospitals; the hospital menu below is unchanged).
  {
    label: null,
    items: [{ path: '/', permissions: [], models: ['consultoria'], label: 'Início', phase: null, summary: 'Visão da consultoria e situação de implantação dos módulos.' }],
  },
  {
    label: 'Consultoria',
    items: [
      { path: '/consultoria/clientes', permissions: ['consultoria:clients:view'], models: ['consultoria'], label: 'Clientes', phase: null, summary: 'Carteira de clientes, estabelecimentos, unidades, contatos, consultores responsáveis e histórico de atendimentos.' },
      { path: '/consultoria/equipe', permissions: ['consultoria:portfolio:assign', 'consultoria:portfolio:all'], models: ['consultoria'], label: 'Equipe e carteiras', phase: null, summary: 'Quem atende cada cliente: distribuição da carteira entre os consultores.' },
      { path: '/consultoria/contratos', permissions: ['consultoria:contracts:view'], models: ['consultoria'], label: 'Contratos', phase: null, summary: 'Propostas e contratos: serviços, escopo, vigência, aditivos, vencimentos e previsto × realizado.' },
      { path: '/consultoria/agenda', permissions: [], models: ['consultoria'], label: 'Agenda', phase: 'M5', summary: 'Visitas, reuniões, auditorias, inspeções, treinamentos e entregas.',
        planned: ['Agenda individual e compartilhada', 'Lembretes e atrasos internos', 'Pendências geradas por atividade'] },
      { path: '/consultoria/avaliacoes', permissions: [], models: ['consultoria'], label: 'Diagnósticos e auditorias', phase: 'M6', summary: 'Checklists versionados, diagnóstico situacional e auditorias por domínio.',
        planned: ['Conformidade legal × institucional × maturidade', 'Pontuação por domínio e comparação entre avaliações', 'Evidências e amostragem'] },
      { path: '/consultoria/nao-conformidades', permissions: [], models: ['consultoria'], label: 'Não conformidades e planos', phase: 'M7', summary: 'Achados, causa raiz, 5W2H, PDCA, evidência e validação de eficácia.',
        planned: ['Responsável do cliente e prazo', 'Encerramento só com evidência e validação', '5 Porquês e Ishikawa'] },
      { path: '/consultoria/indicadores', permissions: [], models: ['consultoria'], label: 'Indicadores dos clientes', phase: 'M8', summary: 'IRAS, CME e qualidade por cliente a partir de dados agregados mensais.',
        planned: ['Fórmulas do catálogo existente', 'Tendências e sinais de alerta', 'Sem dados de pacientes'] },
      { path: '/consultoria/documentos', permissions: [], models: ['consultoria'], label: 'Documentos', phase: 'M9', summary: 'POPs, protocolos, atas, relatórios e evidências com versão e aprovação.' },
      { path: '/consultoria/treinamentos', permissions: [], models: ['consultoria'], label: 'Treinamentos', phase: 'M10', summary: 'Catálogo, calendário, presença e avaliação por estabelecimento.' },
      { path: '/consultoria/relatorios', permissions: [], models: ['consultoria'], label: 'Relatórios e painéis', phase: 'M12', summary: 'Relatórios por cliente e da carteira, planilhas para tabela dinâmica e painéis por escopo.' },
      { path: '/consultoria/area-do-cliente', permissions: [], models: ['consultoria'], label: 'Área do cliente', phase: 'M13', summary: 'Acesso restrito do cliente ao que foi liberado pela consultoria.' },
    ],
  },
  {
    label: null,
    items: [{ path: '/', permissions: ['dashboard:view'], label: 'Visão Geral', phase: null, summary: 'Painel executivo da CCIH.' }],
  },
  {
    label: 'Vigilância',
    items: [
      { path: '/vigilancia', permissions: ['iras:view'], label: 'Vigilância IRAS', phase: null, summary: 'Suspeitas, investigações, confirmações e descartes de IRAS.' },
      { path: '/pacientes', permissions: ['patient:view'], label: 'Pacientes', phase: null, summary: 'Internações, dispositivos, culturas, cirurgias, IRAS e evolução CCIH do paciente.' },
      { path: '/censo', permissions: ['patient:view', 'indicators:view'], label: 'Censo diário', phase: null, summary: 'Ocupação e denominadores reais (paciente-dia, dispositivo-dia) e consolidação de indicadores.' },
      { path: '/cirurgias', permissions: ['surgery:view'], label: 'Cirurgias', phase: null, summary: 'Registro cirúrgico, risco, antibioticoprofilaxia e vigilância de ISC.' },
      { path: '/microbiologia', permissions: ['micro:view'], label: 'Microbiologia', phase: null, summary: 'Culturas, microrganismos, antibiograma e perfis de resistência.' },
      { path: '/antimicrobianos', permissions: ['atm:view'], label: 'Antimicrobianos', phase: 6, summary: 'Stewardship: prescrições, revisões e alertas de apoio à decisão.',
        planned: ['Registro de prescrição e revisão CCIH', 'Alertas de terapia prolongada e descalonamento', 'DDD por setor'] },
    ],
  },
  {
    label: 'Prevenção e qualidade',
    items: [
      { path: '/bundles', permissions: ['quality:view'], label: 'Bundles e higiene das mãos', phase: null, summary: 'Auditoria de bundles configuráveis e observação de higiene das mãos, com adesão e Pareto.' },
      { path: '/auditorias', permissions: ['quality:view'], label: 'Auditorias', phase: null, summary: 'Auditorias, não conformidades e planos de ação (5W2H).' },
      { path: '/treinamentos', permissions: ['quality:view'], label: 'Treinamentos', phase: null, summary: 'Treinamentos, presença, cobertura e vencimentos.' },
      { path: '/insumos', permissions: ['quality:view'], label: 'Insumos', phase: null, summary: 'Estoque por lote, validade e cobertura de insumos de prevenção.' },
    ],
  },
  {
    label: 'CME',
    items: [
      { path: '/cme', permissions: ['cme:view'], label: 'CME', phase: null, summary: 'Ciclos, testes (Bowie-Dick, IQ classes 1–6, IB) e liberação de cargas.' },
      { path: '/cme/estacao', permissions: ['cme:scan'], label: 'Estação de leitura', phase: null, summary: 'Leitura de código de barras na entrada, no processamento e na saída do CME.' },
      { path: '/rastreabilidade', permissions: ['cme:view'], label: 'Rastreabilidade', phase: null, summary: 'Lote → ciclo → carga → material → cirurgia → paciente, e o caminho inverso.' },
    ],
  },
  {
    label: 'Gestão',
    items: [
      { path: '/indicadores', permissions: ['indicators:view'], label: 'Indicadores', phase: null, summary: 'Catálogo de indicadores com fórmula, fonte e meta.' },
      { path: '/relatorios', permissions: ['reports:view'], label: 'Relatórios', phase: 7, summary: 'Relatórios com filtros, impressão, PDF e CSV.' },
      { path: '/alertas', permissions: ['alerts:view'], models: ['hospitalar', 'consultoria'], label: 'Alertas', phase: null, summary: 'Central de alertas com prioridade, responsável e controle de excesso de alertas.' },
      { path: '/admin', permissions: ['config:view', 'users:view', 'users:manage', 'users:manage:ccih', 'users:manage:cme', 'audit:view', 'audit:view:module'], models: ['hospitalar', 'consultoria'], label: 'Administração', phase: null, summary: 'Metas, parâmetros, referências, política da CME, usuários, perfis e log de auditoria.' },
    ],
  },
];

export const ALL_NAV_ITEMS = NAVIGATION.flatMap((g) => g.items);

/** Whether a menu item is offered: the organization's model has it and the profile can use it. */
export const navItemVisible = (item: NavItem, model: OrganizationType, can: (...p: Permission[]) => boolean) =>
  (item.models ?? ['hospitalar']).includes(model) && (item.permissions.length === 0 || can(...item.permissions));

export const phaseLabel = (phase: number | string) => (typeof phase === 'number' ? `Fase ${phase}` : `Etapa ${phase}`);
