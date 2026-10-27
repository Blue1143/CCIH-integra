import { describe, expect, it } from 'vitest';
import {
  buildContractAlertCandidates, checkAmendment, checkContract, checkService, contractExpiry, contractSituation, parseMoney, planVsDone, serviceFrequency, servicePeriodAt, shiftMonths,
  type ContractInput, type ServiceInput,
} from './contracts';

const line: ServiceInput = { id: null, area: 'ccih', kind: 'visita_tecnica', description: 'Visita técnica mensal', establishmentId: null, unit: 'visitas', quantity: 2, period: 'mensal' };
const contract: ContractInput = { title: 'Assessoria CCIH', startsOn: '2026-01-15', endsOn: '2027-01-14', autoRenew: false, renewalNoticeDays: 60, responsibleId: null, scopeNotes: null, services: [line] };

describe('contract validation', () => {
  it('accepts a complete contract and asks for start and services only when signing', () => {
    expect(checkContract(contract, { signing: true })).toEqual([]);
    const draft = { ...contract, startsOn: null, services: [] };
    expect(checkContract(draft)).toEqual([]);
    expect(checkContract(draft, { signing: true }).map((p) => p.path)).toEqual(['startsOn', 'services']);
    expect(checkContract({ ...contract, endsOn: '2025-12-31' }).map((p) => p.path)).toEqual(['endsOn']);
  });

  it('counts visits and deliveries in whole numbers and hours in quarters', () => {
    expect(checkService({ ...line, quantity: 1.5 })[0]?.path).toBe('quantity');
    expect(checkService({ ...line, unit: 'horas', quantity: 1.5 })).toEqual([]);
    expect(checkService({ ...line, unit: 'horas', quantity: 1.1 })[0]?.path).toBe('quantity');
    expect(checkService({ ...line, quantity: 0 })[0]?.path).toBe('quantity');
  });

  it('requires what an amendment changes', () => {
    const base = { kinds: ['prazo' as const], description: 'Prorrogação por 12 meses', signedOn: '2026-12-01', effectiveOn: '2027-01-15', addServices: [], changeServices: [], endServices: [] };
    expect(checkAmendment(base, contract).map((p) => p.path)).toContain('newEndsOn');
    expect(checkAmendment({ ...base, newEndsOn: '2028-01-14' }, contract)).toEqual([]);
    expect(checkAmendment({ ...base, kinds: ['valor'] }, contract)).toEqual([]);
    expect(checkAmendment({ ...base, kinds: ['escopo'] }, contract).map((p) => p.path)).toContain('kinds');
    expect(checkAmendment({ ...base, newEndsOn: '2028-01-14', effectiveOn: '2025-01-01' }, contract).map((p) => p.path)).toContain('effectiveOn');
    expect(checkAmendment({ ...base, newEndsOn: '2028-01-14', changeServices: [{ id: 's1', quantity: 3, period: 'mensal' }], endServices: ['s1'] }, contract).map((p) => p.path)).toContain('changeServices');
  });

  it('reads money typed in Brazilian format', () => {
    expect(parseMoney('R$ 1.234,56')).toBe(123456);
    expect(parseMoney('2500')).toBe(250000);
    expect(parseMoney('12,5')).toBe(1250);
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
});

describe('contract term', () => {
  it('shows an open contract past its end as overdue and warns inside the notice window', () => {
    expect(contractSituation({ status: 'vigente', endsOn: '2026-10-01' }, '2026-10-27')).toBe('vencido');
    expect(contractSituation({ status: 'encerrado', endsOn: '2026-10-01' }, '2026-10-27')).toBe('encerrado');
    expect(contractExpiry({ status: 'vigente', endsOn: '2026-12-01', renewalNoticeDays: 60 }, '2026-10-27')).toBe('vencendo');
    expect(contractExpiry({ status: 'vigente', endsOn: '2027-06-01', renewalNoticeDays: 60 }, '2026-10-27')).toBe('em_dia');
    expect(contractExpiry({ status: 'vigente', endsOn: null, renewalNoticeDays: 60 }, '2026-10-27')).toBe('sem_termino');
    expect(contractExpiry({ status: 'proposta', endsOn: '2026-11-01', renewalNoticeDays: 60 }, '2026-10-27')).toBeNull();
  });
});

describe('planned × done', () => {
  it('keeps the day of the month when shifting, clamped to short months', () => {
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonths('2026-01-15', 3)).toBe('2026-04-15');
    expect(shiftMonths('2026-11-30', 3)).toBe('2027-02-28');
  });

  it('anchors periods at the start of the line', () => {
    expect(servicePeriodAt('mensal', '2026-01-15', null, '2026-03-20')).toEqual({ start: '2026-03-15', end: '2026-04-15' });
    expect(servicePeriodAt('trimestral', '2026-01-15', null, '2026-10-27')).toEqual({ start: '2026-10-15', end: '2027-01-15' });
    expect(servicePeriodAt('mensal', '2026-01-15', '2026-03-31', '2026-03-20')).toEqual({ start: '2026-03-15', end: '2026-04-01' });
    expect(servicePeriodAt('mensal', '2026-01-15', '2026-03-31', '2026-04-02')).toBeNull();
    expect(servicePeriodAt('contrato', '2026-01-15', null, '2026-10-27')).toEqual({ start: '2026-01-15', end: '9999-12-31' });
  });

  it('compares what was planned with what was delivered in closed periods and in the current one', () => {
    const deliveries = [
      { occurredOn: '2026-07-20', quantity: 2 }, // period 07-15..08-14: 2 of 2
      { occurredOn: '2026-08-20', quantity: 1 }, // period 08-15..09-14: 1 of 2
      { occurredOn: '2026-10-16', quantity: 1 }, // current period 10-15..11-14
      { occurredOn: '2026-11-01', quantity: 5 }, // future (after the reference day): not counted in the total
    ];
    const p = planVsDone({ quantity: 2, period: 'mensal', startsOn: '2026-07-15', endsOn: null }, deliveries, '2026-10-27');
    expect(p.closedPeriods).toBe(3);
    expect(p.plannedClosed).toBe(6);
    expect(p.doneClosed).toBe(3);
    expect(p.lastClosed).toEqual({ start: '2026-09-15', end: '2026-10-15', planned: 2, done: 0 });
    expect(p.current).toEqual({ start: '2026-10-15', end: '2026-11-15', planned: 2, done: 6 });
    expect(p.doneTotal).toBe(4);
  });

  it('treats a whole-contract line as a single period', () => {
    const open = planVsDone({ quantity: 1, period: 'contrato', startsOn: '2026-01-15', endsOn: null }, [{ occurredOn: '2026-03-01', quantity: 1 }], '2026-10-27');
    expect(open.closedPeriods).toBe(0);
    expect(open.current?.done).toBe(1);
    const ended = planVsDone({ quantity: 1, period: 'contrato', startsOn: '2026-01-15', endsOn: '2026-06-30' }, [], '2026-10-27');
    expect(ended.lastClosed).toEqual({ start: '2026-01-15', end: '2026-07-01', planned: 1, done: 0 });
  });

  it('describes the frequency in words', () => {
    expect(serviceFrequency({ quantity: 2, unit: 'visitas', period: 'mensal' })).toBe('2 visitas por mês');
    expect(serviceFrequency({ quantity: 1, unit: 'entregas', period: 'contrato' })).toBe('1 entrega no contrato');
    expect(serviceFrequency({ quantity: 1.5, unit: 'horas', period: 'trimestral' })).toBe('1,5 horas por trimestre');
  });
});

describe('contract alerts', () => {
  const base = { id: 'k1', code: 'CT-2026-001', clientId: 'c1', clientName: 'Hospital A', status: 'vigente' as const, autoRenew: false, renewalNoticeDays: 60 };

  it('warns before the end, then flags an overdue open contract, keyed by the end date', () => {
    const near = buildContractAlertCandidates({ today: '2026-10-27', contracts: [{ ...base, endsOn: '2026-11-05' }], lines: [], deliveries: [] });
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ kind: 'contrato_vencendo', priority: 'alta', clientId: 'c1', dedupKey: 'contrato_vencendo:k1:2026-11-05', link: '/consultoria/contratos/k1' });
    const far = buildContractAlertCandidates({ today: '2026-10-27', contracts: [{ ...base, endsOn: '2026-12-20' }], lines: [], deliveries: [] });
    expect(far[0]?.priority).toBe('media');
    const late = buildContractAlertCandidates({ today: '2026-10-27', contracts: [{ ...base, endsOn: '2026-10-01' }], lines: [], deliveries: [] });
    expect(late[0]).toMatchObject({ kind: 'contrato_vencido', title: expect.stringContaining('26 dia(s)') });
    expect(buildContractAlertCandidates({ today: '2026-10-27', contracts: [{ ...base, status: 'encerrado', endsOn: '2026-10-01' }], lines: [], deliveries: [] })).toEqual([]);
  });

  it('flags a closed period with fewer deliveries than planned, and stops once it is delivered', () => {
    const lines = [{ id: 's1', contractId: 'k1', description: 'Visita técnica', unit: 'visitas' as const, quantity: 2, period: 'mensal' as const, startsOn: '2026-08-15', endsOn: null }];
    const contracts = [{ ...base, endsOn: null }];
    const below = buildContractAlertCandidates({ today: '2026-10-27', contracts, lines, deliveries: [{ serviceId: 's1', occurredOn: '2026-09-20', quantity: 1 }] });
    expect(below).toHaveLength(1);
    expect(below[0]).toMatchObject({ kind: 'contrato_entregas_abaixo', dedupKey: 'contrato_entregas_abaixo:s1:2026-09-15', entity: 'contract_service' });
    const ok = buildContractAlertCandidates({ today: '2026-10-27', contracts, lines, deliveries: [{ serviceId: 's1', occurredOn: '2026-09-20', quantity: 2 }] });
    expect(ok).toEqual([]);
    expect(buildContractAlertCandidates({ today: '2026-10-27', contracts: [{ ...contracts[0]!, status: 'suspenso' }], lines, deliveries: [] })).toEqual([]);
  });
});
