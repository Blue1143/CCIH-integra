import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ALL_PERMISSIONS, type Permission, type OrganizationType } from '@ccih/domain';
import { useDataSource, UNAUTHORIZED_EVENT } from '../../data/source';
import type { SessionInfo } from '../../data/port';

/**
 * Who is using the app and what they may do. With a backend the answer comes from /auth/me
 * (the server still checks every request); the demo source has no login and is read-only.
 */
export type SessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'demo' | 'error';

/** Why the last session ended; the route guard turns it into the login page message. */
export type ExitReason = 'saida' | 'inatividade' | 'expirada';

export interface SessionValue {
  status: SessionStatus;
  exitReason: ExitReason | null;
  info: SessionInfo | null;
  can: (...anyOf: Permission[]) => boolean;
  /** Business model of the signed-in organization (hospital in demo mode). */
  model: OrganizationType;
  /** True when the data source accepts changes (backend mode). */
  writable: boolean;
  logout: (reason?: ExitReason) => Promise<void>;
  refresh: () => Promise<unknown>;
}

/** Demo mode: everything readable, nothing editable or exportable as identified data. */
const DEMO_PERMISSIONS = ALL_PERMISSIONS.filter((p) => p.endsWith(':view') || p === 'export:aggregate');

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const source = useDataSource();
  const client = useQueryClient();
  const auth = source.auth;
  const [exitReason, setExitReason] = useState<ExitReason | null>(null);
  const me = useQuery({
    queryKey: ['session'],
    enabled: !!auth,
    retry: false,
    staleTime: 60_000,
    queryFn: () => auth!.me(),
  });

  /**
   * Ends the client-side session: the session query becomes null in place (observers stay
   * attached) and every other cached query — institutional data included — is purged, so
   * nothing remains on a shared workstation after logout or expiry.
   */
  const dropSession = useCallback((reason: ExitReason) => {
    setExitReason(reason);
    client.setQueryData(['session'], null);
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
  }, [client]);

  useEffect(() => {
    const onUnauthorized = () => dropSession('expirada');
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [dropSession]);

  const logout = useCallback(async (reason: ExitReason = 'saida') => {
    if (auth) await auth.logout().catch(() => undefined);
    dropSession(reason);
  }, [auth, dropSession]);

  const value = useMemo<SessionValue>(() => {
    if (!auth) return { status: 'demo', exitReason: null, info: null, writable: false, model: 'hospitalar', can: (...p) => p.some((x) => DEMO_PERMISSIONS.includes(x)), logout, refresh: async () => undefined };
    const status: SessionStatus = me.isPending ? 'loading' : me.isError ? 'error' : me.data ? 'authenticated' : 'anonymous';
    const perms = me.data?.permissions ?? [];
    return { status, exitReason: status === 'authenticated' ? null : exitReason, info: me.data ?? null, writable: true, model: me.data?.organization?.type ?? 'hospitalar', can: (...p) => p.some((x) => perms.includes(x)), logout, refresh: () => me.refetch() };
  }, [auth, me, logout, exitReason]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider ausente.');
  return v;
}
