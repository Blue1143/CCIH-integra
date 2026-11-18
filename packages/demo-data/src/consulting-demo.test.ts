import { describe, expect, it } from 'vitest';
import {
  buildReport, computeWindow, countByStatus, actionsIn, demoActionStatus, findingById, getIndicator, indicatorView, institutionSummary, normalizeFilter,
  pendingItems, portfolioSummary, ruleSummary, type DemoFilter,
} from '@ccih/domain';
import { createConsultingDemo } from './consulting-demo';

// Reference day 17/11/2026 → series from May to October 2026.
const state = createConsultingDemo(new Date('2026-11-17T15:00:00Z'));
const all = (patch: Partial<DemoFilter> = {}): DemoFilter => ({ institutionId: null, unitId: null, from: '2026-05-01', to: '2026-10-01', ...patch });

describe('consulting demonstration — dataset', () => {
  it('covers six closed months and three fictitious institutions, without patient data', () => {
    expect(state.periods).toEqual(['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
    expect(state.referenceDate).toBe('2026-11-17');
    expect(state.institutions.map((i) => i.name)).toEqual(['Hospital Alfa (fictício)', 'Hospital Beta (fictício)', 'Instituto Gama de Retaguarda (fictício)']);
    expect(state.targets.every((t) => t.origin === 'demonstracao' && t.approvedBy == null && t.referenceId == null)).toBe(true);
    // Aggregated monthly counts only.
    expect(JSON.stringify(state)).not.toMatch(/paciente"|patient|prontu|cpf|nascimento/i);
    // One unit sent nothing in August: no row at all (missing, never zero).
    expect(state.facts.find((r) => r.sectorId === 'gama-ut' && r.period === '2026-08-01')).toBeUndefined();
  });

  it('is deterministic', () => {
    expect(createConsultingDemo(new Date('2026-11-17T15:00:00Z'))).toEqual(state);
  });
});

describe('consulting demonstration — indicators checked by hand', () => {
  it('IPCS of Hospital Alfa over six months sums the counts before dividing (3 / 1.415 × 1.000)', () => {
    const v = indicatorView(state, all({ institutionId: 'alfa' }), 'di-ipcs');
    expect(v.current.result).toEqual({ kind: 'valor', numerator: 3, denominator: 1415, value: (3 / 1415) * 1000 });
    expect(v.current.result.value!.toFixed(1)).toBe('2.1');
    // An average of the monthly rates would give another number — the engine never does that.
    const monthly = v.series.map((p) => p.result.value ?? 0);
    expect((monthly.reduce((a, b) => a + b, 0) / 6).toFixed(2)).not.toBe(v.current.result.value!.toFixed(2));
    expect(v.formula).toBe('(IPCS confirmadas ÷ Cateter central-dia) × 1.000');
    expect(v.evaluation.result).toBe('atencao'); // meta fictícia ≤ 2,0 com faixa de 0,5
    expect(v.previous).toBeNull();
    expect(v.noComparisonReason).toMatch(/não tem os 6 meses anteriores/);
  });

  it('first month of Alfa: 1 IPCS / 240 catheter-days = 4.2 ‰', () => {
    const v = indicatorView(state, all({ institutionId: 'alfa', from: '2026-05-01', to: '2026-05-01' }), 'di-ipcs');
    expect(v.current.result).toMatchObject({ numerator: 1, denominator: 240 });
    expect(v.current.result.value!.toFixed(1)).toBe('4.2');
    expect(v.series[0]!.result.value).toBe(v.current.result.value);
  });

  it('PAV of Hospital Beta: last quarter compared with the previous one, both from summed counts', () => {
    const v = indicatorView(state, all({ institutionId: 'beta', from: '2026-08-01', to: '2026-10-01' }), 'di-pav');
    expect(v.current.result).toMatchObject({ numerator: 14, denominator: 1274 });
    expect(v.previous!.result).toMatchObject({ numerator: 5, denominator: 1097 });
    expect(v.previous!.periods).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
    expect(v.current.result.value!.toFixed(1)).toBe('11.0');
    expect(v.previous!.result.value!.toFixed(1)).toBe('4.6');
    expect(v.trend.improved).toBe(false);
    expect(v.evaluation.result).toBe('fora_da_meta');
  });

  it('PAV with no ventilator-days is "denominador zero", never 0 ‰', () => {
    const gama = indicatorView(state, all({ institutionId: 'gama' }), 'di-pav');
    expect(gama.current.result).toEqual({ kind: 'denominador_zero', value: null, numerator: 0, denominator: 0 });
    expect(gama.evaluation.result).toBe('sem_dado');
    const ward = indicatorView(state, all({ institutionId: 'alfa', unitId: 'alfa-cm' }), 'di-pav');
    expect(ward.current.result.kind).toBe('denominador_zero');
  });

  it('a month without data is reported as a gap and left out of the sums', () => {
    const v = indicatorView(state, all({ institutionId: 'gama' }), 'di-itu');
    expect(v.current.result).toMatchObject({ numerator: 15, denominator: 1990 });
    expect(v.current.gaps).toEqual([
      { unitId: 'gama-ut', period: '2026-08-01', metric: 'iras_itu' },
      { unitId: 'gama-ut', period: '2026-08-01', metric: 'svd_dia' },
    ]);
    const august = indicatorView(state, all({ institutionId: 'gama', unitId: 'gama-ut', from: '2026-08-01', to: '2026-08-01' }), 'di-itu');
    expect(august.current.result.kind).toBe('sem_dado');
    expect(computeWindow(state, getIndicator('di-itu'), [], ['gama-ut']).result.kind).toBe('sem_dado');
  });

  it('the unit filter narrows the counts to that unit', () => {
    const uti = indicatorView(state, all({ institutionId: 'alfa', unitId: 'alfa-uti' }), 'di-ipcs');
    expect(uti.current.result).toMatchObject({ numerator: 2, denominator: 1057 });
  });

  it('normalizes unknown filters to the whole series and portfolio', () => {
    expect(normalizeFilter(state, { institutionId: 'x', unitId: 'alfa-uti', from: '1999-01-01', to: null })).toEqual(all());
    expect(normalizeFilter(state, { institutionId: 'alfa', unitId: 'beta-uti', from: '2026-09-01', to: '2026-06-01' })).toEqual(all({ institutionId: 'alfa', from: '2026-06-01', to: '2026-09-01' }));
  });
});

describe('consulting demonstration — diagnosis, actions and reports', () => {
  it('derives "atrasada" from the deadline at the reference date', () => {
    const counts = countByStatus(actionsIn(state, all()), state.referenceDate);
    expect(counts).toEqual({ pendente: 3, em_andamento: 2, atrasada: 3, concluida: 4 });
    const beta = state.actions.find((a) => a.id === 'acao-beta-2')!;
    expect(beta.situation).toBe('em_andamento');
    expect(demoActionStatus(beta, state.referenceDate)).toBe('atrasada');
  });

  it('links every action to the finding that originated it', () => {
    for (const a of state.actions) {
      const f = findingById(state, a.findingId);
      expect(f, a.id).toBeDefined();
      expect(f!.institutionId).toBe(a.institutionId);
    }
  });

  it('lists findings without action and unanswered items as pending', () => {
    const beta = pendingItems(state, all({ institutionId: 'beta' }));
    expect(beta.filter((p) => p.kind === 'achado_sem_acao').map((p) => p.text)).toEqual(['Equipes das unidades críticas capacitadas nos protocolos de dispositivos']);
    expect(beta.filter((p) => p.kind === 'item_sem_resposta')).toHaveLength(3);
    const gama = pendingItems(state, all({ institutionId: 'gama' }));
    expect(gama.filter((p) => p.kind === 'dado_ausente')).toHaveLength(1);
  });

  it('portfolio totals are the sum of the institution cards', () => {
    const p = portfolioSummary(state, all());
    expect(p.institutions).toHaveLength(3);
    expect(p.actionsTotal).toBe(12);
    expect(p.pending).toBe(p.institutions.reduce((n, s) => n + s.pending, 0));
    expect(p.reports).toBe(2);
    expect(institutionSummary(state, all(), 'beta').outsideTarget).toEqual(['IPCS', 'PAV']);
    expect(institutionSummary(state, all(), 'gama').outsideTarget).toEqual(['ITU-AC']);
  });

  it('the period filter keeps only actions alive in the window', () => {
    expect(actionsIn(state, all({ from: '2026-10-01' }))).toHaveLength(9);
    // The first quarter excludes what was created later (assessments of August onward).
    expect(actionsIn(state, all({ to: '2026-07-01' })).map((a) => a.id)).toEqual(['acao-alfa-1', 'acao-beta-1']);
  });

  it('what is recorded on the reference date shows in windows that reach the last month', () => {
    const created = { ...state.actions[0]!, id: 'nova', createdAt: state.referenceDate, situation: 'pendente' as const, completedAt: null };
    const next = { ...state, actions: [...state.actions, created] };
    expect(actionsIn(next, all()).some((a) => a.id === 'nova')).toBe(true);
    expect(actionsIn(next, all({ to: '2026-09-01' })).some((a) => a.id === 'nova')).toBe(false);
  });

  it('the report uses the same indicator views as the panel', () => {
    const f = all({ institutionId: 'beta', from: '2026-08-01' });
    const report = buildReport(state, f);
    expect(report.indicators.find((v) => v.id === 'di-pav')).toEqual(indicatorView(state, f, 'di-pav'));
    expect(report.findings.find((x) => x.item.id === 'v1')!.actions.map((a) => a.id)).toEqual(['acao-beta-2']);
  });

  it('the rule-based summary repeats the computed numbers and names the gaps, without causes', () => {
    const s = ruleSummary(state, all({ institutionId: 'gama' }));
    expect(s.observed[0]).toContain('IPCS: 0,0 ‰ (0 IPCS confirmadas / 272 Cateter central-dia)');
    expect(s.missing.join(' ')).toContain('PAV: denominador zero');
    expect(s.missing.join(' ')).toContain('Unidade de Transição — ago/26');
    expect(s.forInvestigation.join(' ')).toContain('ITU-AC está fora da meta fictícia');
    expect(JSON.stringify(s)).not.toMatch(/causad|devido a|recomenda|Anvisa|ANVISA/);
  });
});
