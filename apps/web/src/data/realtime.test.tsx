import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DemoDataSource } from './demo/DemoDataSource';
import { DataSourceProvider } from './source';
import type { CcihDataSource, RealtimeConfig } from './port';
import { useRealtimeSync } from './realtime';

/** Minimal EventSource double: tests push named events into the last opened stream. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(name: string, fn: (e: MessageEvent) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  emit(name: string, data = '{}', id = '') { for (const fn of this.listeners.get(name) ?? []) fn(new MessageEvent(name, { data, lastEventId: id })); }
  close() { this.readyState = 2; }
}

function setup(config: RealtimeConfig) {
  const demo = new DemoDataSource(() => new Date('2026-10-09T12:00:00Z'));
  const source: CcihDataSource = { origin: 'real', realtime: { config: async () => config, eventsUrl: '/api/events' }, getInstitution: () => demo.getInstitution(), getFacts: (q) => demo.getFacts(q) };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  function Probe() { return <span data-testid="status">{useRealtimeSync(true)}</span>; }
  const wrap = (c: ReactNode) => <QueryClientProvider client={qc}><DataSourceProvider source={source}>{c}</DataSourceProvider></QueryClientProvider>;
  render(wrap(<Probe />));
  return { qc, spy };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeEventSource.last = null; });

describe('real-time sync', () => {
  it('refreshes only the queries of the event topic, once per event id', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { qc, spy } = setup({ mode: 'sse', pollSeconds: 60 });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    act(() => FakeEventSource.last!.emit('ready'));
    expect(screen.getByTestId('status')).toHaveTextContent('ativo');
    qc.setQueryData(['alerts', 'x'], 1);
    qc.setQueryData(['patients', 'y'], 1);
    act(() => FakeEventSource.last!.emit('change', '{"topic":"alertas"}', '41'));
    act(() => FakeEventSource.last!.emit('change', '{"topic":"alertas"}', '41'));
    expect(spy).toHaveBeenCalledTimes(1);
    const { predicate } = spy.mock.calls[0]![0] as unknown as { predicate: (q: { queryKey: unknown[] }) => boolean };
    expect(predicate({ queryKey: ['alerts', 'x'] })).toBe(true);
    expect(predicate({ queryKey: ['patients', 'y'] })).toBe(false);
  });

  it('falls back to periodic refresh while the connection is down', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    setup({ mode: 'sse', pollSeconds: 60 });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    act(() => { FakeEventSource.last!.readyState = 0; FakeEventSource.last!.onerror?.(); });
    expect(screen.getByTestId('status')).toHaveTextContent('reconectando');
    act(() => { FakeEventSource.last!.readyState = FakeEventSource.CLOSED; FakeEventSource.last!.onerror?.(); });
    expect(screen.getByTestId('status')).toHaveTextContent('periodico');
  });

  it('uses periodic refresh only when the installation chose polling', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    setup({ mode: 'polling', pollSeconds: 30 });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('periodico'));
    expect(FakeEventSource.last).toBeNull();
  });
});
