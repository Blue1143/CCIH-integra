import { describe, expect, it } from 'vitest';
import {
  activitySituation, agendaIcs, buildAgendaAlertCandidates, checkActivity, checkOutcome, checkTask, deliveredQuantity, scheduleConflicts, type ActivityInput,
} from './agenda';

const base: ActivityInput = {
  kind: 'visita_tecnica', mode: 'presencial', title: 'Visita mensal à CCIH', description: null, startsAt: '2026-11-20T12:00:00.000Z', endsAt: '2026-11-20T15:00:00.000Z',
  location: null, establishmentId: 'e1', contractServiceId: null, responsibleId: 'u1', participantIds: ['u2'],
};

describe('activity validation', () => {
  it('accepts a complete activity and checks times, people and the place of a visit', () => {
    expect(checkActivity(base)).toEqual([]);
    expect(checkActivity({ ...base, endsAt: base.startsAt }).map((p) => p.path)).toEqual(['endsAt']);
    expect(checkActivity({ ...base, endsAt: '2026-11-21T03:00:00.000Z' })[0]?.message).toMatch(/12 horas/);
    expect(checkActivity({ ...base, participantIds: ['u1'] }).map((p) => p.path)).toEqual(['participantIds']);
    expect(checkActivity({ ...base, establishmentId: null }).map((p) => p.path)).toEqual(['establishmentId']);
    expect(checkActivity({ ...base, establishmentId: null, mode: 'remoto' })).toEqual([]);
    expect(checkActivity({ ...base, title: 'x', startsAt: '2026-11-20' }).map((p) => p.path)).toEqual(['title', 'startsAt']);
  });

  it('requires a summary and duration to record a realization, and a reason otherwise', () => {
    const done = { status: 'realizada' as const, summary: 'Revisão do plano de ação da CCIH', detail: null, actualMinutes: 150, reason: null, registerDelivery: true, tasks: [] };
    expect(checkOutcome(done, '2026-11-20')).toEqual([]);
    expect(checkOutcome({ ...done, summary: 'curto', actualMinutes: 2 }, '2026-11-20').map((p) => p.path)).toEqual(['summary', 'actualMinutes']);
    expect(checkOutcome({ ...done, status: 'cancelada', registerDelivery: false }, '2026-11-20').map((p) => p.path)).toEqual(['reason']);
    expect(checkOutcome({ ...done, status: 'nao_realizada', reason: 'Cliente ausente', registerDelivery: true }, '2026-11-20').map((p) => p.path)).toEqual(['registerDelivery']);
    expect(checkOutcome({ ...done, tasks: [{ description: 'Enviar ata', ownerId: 'u1', dueOn: '2026-11-19' }] }, '2026-11-20').map((p) => p.path)).toEqual(['tasks.0.dueOn']);
    expect(checkTask({ description: 'x', ownerId: '', dueOn: '' }, '2026-11-20').map((p) => p.path)).toEqual(['description', 'ownerId', 'dueOn']);
  });

  it('turns a realized activity into the delivered quantity of its service', () => {
    expect(deliveredQuantity('visitas', 150)).toBe(1);
    expect(deliveredQuantity('entregas', 30)).toBe(1);
    expect(deliveredQuantity('horas', 150)).toBe(2.5);
    expect(deliveredQuantity('horas', 50)).toBe(0.75);
    expect(deliveredQuantity('horas', 5)).toBe(0.25);
  });

  it('flags a scheduled activity past its end as without record', () => {
    const now = new Date('2026-11-20T16:00:00Z');
    expect(activitySituation({ status: 'agendada', endsAt: base.endsAt }, now)).toBe('sem_registro');
    expect(activitySituation({ status: 'agendada', endsAt: '2026-11-20T17:00:00Z' }, now)).toBe('agendada');
    expect(activitySituation({ status: 'realizada', endsAt: base.endsAt }, now)).toBe('realizada');
  });
});

describe('schedule conflicts', () => {
  const busy = [
    { activityId: 'a1', userId: 'u2', startsAt: '2026-11-20T14:00:00Z', endsAt: '2026-11-20T16:00:00Z', title: 'Reunião', clientName: 'Hospital B' },
    { activityId: 'a2', userId: 'u3', startsAt: '2026-11-20T12:00:00Z', endsAt: '2026-11-20T13:00:00Z', title: 'Outra', clientName: 'Hospital C' },
    { activityId: 'a3', userId: 'u1', startsAt: '2026-11-20T15:00:00Z', endsAt: '2026-11-20T16:00:00Z', title: 'Logo depois', clientName: 'Hospital D' },
  ];
  it('finds overlaps of the same people, not touching ends nor the activity itself', () => {
    expect(scheduleConflicts(['u1', 'u2'], base.startsAt, base.endsAt, busy).map((b) => b.activityId)).toEqual(['a1']);
    expect(scheduleConflicts(['u1', 'u2'], base.startsAt, base.endsAt, busy, 'a1')).toEqual([]);
  });
});

describe('calendar export', () => {
  it('writes a valid iCalendar with escaped text, UTC times and folded lines', () => {
    const ics = agendaIcs('Agenda de Ana', [
      { id: 'a1', title: 'Visita; CCIH, plano', startsAt: base.startsAt, endsAt: base.endsAt, location: 'Hospital São Lucas — Unidade Centro', description: `Linha 1\nLinha 2 ${'ç'.repeat(60)}`, status: 'agendada', updatedAt: '2026-11-18T10:00:00Z' },
      { id: 'a2', title: 'Cancelada', startsAt: base.startsAt, endsAt: base.endsAt, location: null, description: null, status: 'cancelada', updatedAt: '2026-11-18T10:00:00Z' },
    ]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20261120T120000Z');
    expect(ics).toContain('SUMMARY:Visita\\; CCIH\\, plano');
    expect(ics).toContain('UID:a1@ccih-integra');
    expect(ics).toContain('STATUS:CANCELLED');
    const lines = ics.split('\r\n');
    const bytes = (s: string) => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! < 0x80 ? 1 : ch.codePointAt(0)! < 0x800 ? 2 : 3), 0);
    expect(lines.every((l) => bytes(l) <= 75)).toBe(true);
    // Unfolding restores the description.
    expect(ics.replace(/\r\n /g, '')).toContain(`DESCRIPTION:Linha 1\\nLinha 2 ${'ç'.repeat(60)}`);
  });
});

describe('agenda alerts', () => {
  it('flags activities without record after the grace day and late open tasks', () => {
    const r = buildAgendaAlertCandidates({
      today: '2026-11-20',
      activities: [
        { id: 'a1', title: 'Visita', kind: 'visita_tecnica', clientId: 'c1', clientName: 'Hospital A', endsOn: '2026-11-19', responsible: 'Ana' },
        { id: 'a2', title: 'Hoje', kind: 'reuniao', clientId: 'c1', clientName: 'Hospital A', endsOn: '2026-11-20', responsible: 'Ana' },
        { id: 'a3', title: 'Antiga', kind: 'auditoria', clientId: 'c2', clientName: 'Hospital B', endsOn: '2026-11-01', responsible: 'Bia' },
      ],
      tasks: [
        { id: 't1', description: 'Enviar ata', clientId: 'c1', clientName: 'Hospital A', dueOn: '2026-11-18', owner: 'Ana', activityId: 'a1' },
        { id: 't2', description: 'No prazo', clientId: 'c1', clientName: 'Hospital A', dueOn: '2026-11-20', owner: 'Ana', activityId: null },
      ],
    });
    expect(r.map((a) => `${a.kind}:${a.entityId}:${a.priority}`)).toEqual(['atividade_sem_registro:a1:media', 'atividade_sem_registro:a3:alta', 'pendencia_atrasada:t1:media']);
    expect(r[0]).toMatchObject({ clientId: 'c1', link: '/consultoria/agenda/a1' });
  });
});
