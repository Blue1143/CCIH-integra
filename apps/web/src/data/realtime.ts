import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useDataSource } from './source';

export type RealtimeStatus = 'ativo' | 'reconectando' | 'periodico' | 'desligado';

/** Topic of a server event → first segment of the query keys to refresh (only active queries refetch). */
export const TOPIC_KEYS: Record<string, string[]> = {
  clinico: ['patients', 'patient', 'cases', 'case', 'surgeries', 'surgery', 'cultures', 'culture', 'census', 'surveillance', 'facts'],
  cme: ['cme', 'surgery', 'facts'],
  qualidade: ['quality', 'bundles', 'hand-hygiene', 'trainings', 'supplies', 'facts'],
  alertas: ['alerts'],
  notificacoes: ['notifications'],
  config: ['institution', 'org', 'facts'],
};

export function invalidateTopic(qc: QueryClient, topic: string) {
  const keys = TOPIC_KEYS[topic];
  // Unknown topic (newer server): refresh what is on screen rather than miss a change.
  if (!keys) return void qc.invalidateQueries({ refetchType: 'active' });
  void qc.invalidateQueries({ predicate: (q) => keys.includes(String(q.queryKey[0])), refetchType: 'active' });
}

/**
 * Keeps the screens current: Server-Sent Events when the installation allows it, periodic refresh
 * otherwise and while the live connection is down. Events carry only a topic; the data is always
 * read again through the normal authorized calls. Repeated event ids are ignored.
 */
export function useRealtimeSync(enabled: boolean): RealtimeStatus {
  const rt = useDataSource().realtime;
  const qc = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('desligado');
  const config = useQuery({ queryKey: ['realtime-config'], queryFn: () => rt!.config(), enabled: enabled && !!rt, staleTime: Infinity, retry: false });

  useEffect(() => {
    if (!enabled || !rt || !config.data) { setStatus('desligado'); return; }
    const pollMs = config.data.pollSeconds * 1000;
    let poll: ReturnType<typeof setInterval> | undefined;
    const startPolling = () => { poll ??= setInterval(() => void qc.invalidateQueries({ refetchType: 'active' }), pollMs); };
    const stopPolling = () => { if (poll !== undefined) { clearInterval(poll); poll = undefined; } };
    if (config.data.mode !== 'sse' || typeof EventSource === 'undefined') {
      setStatus('periodico');
      startPolling();
      return stopPolling;
    }
    const seen: string[] = [];
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      es = new EventSource(rt.eventsUrl, { withCredentials: true });
      es.addEventListener('ready', () => { setStatus('ativo'); stopPolling(); });
      es.addEventListener('change', (ev) => {
        const m = ev as MessageEvent<string>;
        if (m.lastEventId) {
          if (seen.includes(m.lastEventId)) return;
          seen.push(m.lastEventId);
          if (seen.length > 500) seen.shift();
        }
        try { invalidateTopic(qc, (JSON.parse(m.data) as { topic: string }).topic); } catch { void qc.invalidateQueries({ refetchType: 'active' }); }
      });
      es.addEventListener('reset', () => void qc.invalidateQueries({ refetchType: 'active' }));
      es.addEventListener('session_end', () => {
        es?.close();
        setStatus('desligado');
        void qc.invalidateQueries({ queryKey: ['session'] });
      });
      es.onerror = () => {
        if (stopped) return;
        startPolling();
        if (es?.readyState === EventSource.CLOSED) {
          setStatus('periodico');
          retry = setTimeout(connect, 30_000);
        } else setStatus('reconectando');
      };
    };
    connect();
    return () => {
      stopped = true;
      es?.close();
      stopPolling();
      if (retry) clearTimeout(retry);
    };
  }, [enabled, rt, config.data, qc]);

  return status;
}

export const REALTIME_LABEL: Record<Exclude<RealtimeStatus, 'desligado'>, { text: string; title: string }> = {
  ativo: { text: 'Tempo real', title: 'Conectado: as telas se atualizam quando algo é registrado.' },
  reconectando: { text: 'Reconectando…', title: 'Conexão em tempo real interrompida. Enquanto isso, as telas se atualizam periodicamente.' },
  periodico: { text: 'Atualização periódica', title: 'Sem conexão em tempo real: as telas se atualizam em intervalos.' },
};
