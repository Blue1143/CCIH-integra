import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { createConsultingDemo } from '@ccih/demo-data';
import type { ActionPriority, ActionSituation, AssessmentStatus, ChecklistResponse, DemoAction, DemoConsultingState, DemoFilter, IsoDate } from '@ccih/domain';

/**
 * Data of the "Consultoria — Demonstração" area. Kept apart from every other environment: it
 * never goes through the data port nor the API, lives only in this browser under its own key,
 * and "restore" erases only that key. Cards, charts and reports read this single state.
 */
export const DEMO_STORAGE_KEY = 'ccih-integra:consultoria-demonstracao:v1';

type Listener = () => void;

export interface NewActionInput {
  institutionId: string;
  unitId: string | null;
  findingId: string;
  problem: string;
  action: string;
  responsible: string;
  deadline: IsoDate;
  priority: ActionPriority;
}

export interface ActionPatch {
  action?: string;
  responsible?: string;
  deadline?: IsoDate;
  priority?: ActionPriority;
  situation?: ActionSituation;
}

const isState = (v: unknown): v is DemoConsultingState => {
  const s = v as Partial<DemoConsultingState> | null;
  return !!s && s.version === 1 && s.origin === 'demonstracao' && typeof s.referenceDate === 'string' && Array.isArray(s.periods) && s.periods.length === 6
    && [s.institutions, s.facts, s.targets, s.checklist, s.assessments, s.actions, s.reports].every(Array.isArray);
};

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class DemoConsultingStore {
  private state: DemoConsultingState;
  private listeners = new Set<Listener>();
  /** False when the browser refuses storage: changes then last only while the page is open. */
  readonly persistent: boolean;

  constructor(private readonly now: () => Date = () => new Date(), private readonly storage: Storage | null = safeStorage()) {
    this.persistent = !!storage;
    this.state = this.load() ?? this.seed();
  }

  private load(): DemoConsultingState | null {
    try {
      const raw = this.storage?.getItem(DEMO_STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private seed(): DemoConsultingState {
    const s = createConsultingDemo(this.now());
    this.write(s);
    return s;
  }

  private write(s: DemoConsultingState) {
    try {
      this.storage?.setItem(DEMO_STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* storage full or blocked: keep working in memory */
    }
  }

  private set(next: DemoConsultingState) {
    this.state = next;
    this.write(next);
    this.listeners.forEach((l) => l());
  }

  getState = () => this.state;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Restores the initial demonstration data. Touches only this area's key. */
  reset() {
    this.storage?.removeItem(DEMO_STORAGE_KEY);
    this.set(createConsultingDemo(this.now()));
  }

  setResponse(assessmentId: string, itemId: string, patch: Partial<Omit<ChecklistResponse, 'itemId'>>) {
    const s = this.state;
    this.set({
      ...s,
      assessments: s.assessments.map((a) => (a.id !== assessmentId ? a : { ...a, responses: a.responses.map((r) => (r.itemId === itemId ? { ...r, ...patch } : r)) })),
    });
  }

  setAssessmentStatus(assessmentId: string, status: AssessmentStatus) {
    const s = this.state;
    this.set({ ...s, assessments: s.assessments.map((a) => (a.id === assessmentId ? { ...a, status } : a)) });
  }

  addAction(input: NewActionInput): string {
    const s = this.state;
    const n = s.actions.filter((a) => a.institutionId === input.institutionId).length + 1;
    let id = `acao-${input.institutionId}-${n}`;
    for (let k = n + 1; s.actions.some((a) => a.id === id); k++) id = `acao-${input.institutionId}-${k}`;
    const action: DemoAction = { ...input, id, createdAt: s.referenceDate, situation: 'pendente', completedAt: null };
    this.set({ ...s, actions: [...s.actions, action] });
    return id;
  }

  updateAction(id: string, patch: ActionPatch) {
    const s = this.state;
    this.set({
      ...s,
      actions: s.actions.map((a) => {
        if (a.id !== id) return a;
        const next = { ...a, ...patch };
        if (patch.situation) next.completedAt = patch.situation === 'concluida' ? (a.completedAt ?? s.referenceDate) : null;
        return next;
      }),
    });
  }

  issueReport(f: DemoFilter): string {
    const s = this.state;
    const id = `rel-${f.institutionId ?? 'carteira'}-${s.reports.length + 1}`;
    this.set({ ...s, reports: [...s.reports, { id, institutionId: f.institutionId!, unitId: f.unitId, from: f.from, to: f.to, issuedAt: s.referenceDate }] });
    return id;
  }
}

const Ctx = createContext<DemoConsultingStore | null>(null);

export function DemoConsultingProvider({ store, children }: { store?: DemoConsultingStore; children: ReactNode }) {
  const value = useMemo(() => store ?? new DemoConsultingStore(), [store]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDemoStore(): DemoConsultingStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('DemoConsultingProvider ausente.');
  return s;
}

/** The single state every card, chart and report of the area reads. */
export function useDemoState(): DemoConsultingState {
  const store = useDemoStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
