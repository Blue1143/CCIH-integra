import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { normalizeFilter, type DemoConsultingState, type DemoFilter } from '@ccih/domain';

export type DemoFilterKey = 'inst' | 'unidade' | 'de' | 'ate';

/** Filters of the demonstration area live in the URL, like the rest of the app. */
export function useDemoFilters(state: DemoConsultingState) {
  const [params, setParams] = useSearchParams();
  const filter: DemoFilter = useMemo(
    () => normalizeFilter(state, { institutionId: params.get('inst'), unitId: params.get('unidade'), from: params.get('de'), to: params.get('ate') }),
    [state, params],
  );
  const update = useCallback(
    (patch: Partial<Record<DemoFilterKey, string | null>>) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        if ('inst' in patch && !('unidade' in patch)) next.delete('unidade');
        return next;
      }, { replace: true });
    },
    [setParams],
  );
  return [filter, update] as const;
}

/** Query string of a filter, to carry it across the area's pages. */
export function filterQuery(f: DemoFilter, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (f.institutionId) p.set('inst', f.institutionId);
  if (f.unitId) p.set('unidade', f.unitId);
  p.set('de', f.from);
  p.set('ate', f.to);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return `?${p.toString()}`;
}
