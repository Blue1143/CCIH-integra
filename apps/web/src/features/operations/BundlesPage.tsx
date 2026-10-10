import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BUNDLE_METHOD_LABEL, BUNDLE_METRIC_LABEL, HH_CATEGORY_LABEL, evaluateBundle, formatDate, formatNumber,
  type BundleAnswer, type BundleAuditDto, type BundleMetric, type BundleTemplateDto, type HandHygieneCategory, type HandHygieneDto,
} from '@ccih/domain';
import { BundleChecklist, Button, Card, DataTable, EmptyState, ErrorState, Field, FormMessage, LoadingState, ProvenanceTag, StatusBadge, SubNav, type Column } from '@ccih/ui';
import { useSession } from '../auth/session';
import { JustificationField, ReferenceSelect, justificationError } from '../admin/shared';
import { useInstitution } from '../../data/source';
import { FormCard } from '../clinical/patient-forms';
import { DemoTag, PageHeader, Pager, localToIso, nowLocal, sectorName, useOrg, useTimeZone } from '../clinical/shared';
import { RequireOps, SectorFilter, VoidDialog, pct, useDefaultPeriod, useOps, useOpsMutation, useUrlFilters } from './shared';

const SECTIONS = [
  { key: 'auditorias', label: 'Auditorias de bundle' },
  { key: 'higiene', label: 'Higiene das mãos' },
  { key: 'modelos', label: 'Modelos' },
] as const;

export function BundlesPage() {
  return <RequireOps title="Bundles"><Bundles /></RequireOps>;
}

function Bundles() {
  const f = useUrlFilters({ secao: 'auditorias' });
  const { pathname } = useLocation();
  const section = SECTIONS.find((s) => s.key === f.get('secao'))?.key ?? 'auditorias';
  return (
    <div className="page">
      <PageHeader title="Bundles e higiene das mãos" subtitle="Auditorias de bundles configuráveis e observação direta de higiene das mãos. Os indicadores de adesão são consolidados a partir destes registros." />
      <SubNav label="Seções" items={SECTIONS.map((s) => ({ key: s.key, label: s.label, href: `${pathname}?secao=${s.key}`, active: s.key === section }))}
        renderLink={(item, className) => <Link to={item.href} replace className={className} aria-current={item.active ? 'page' : undefined}>{item.label}</Link>} />
      {section === 'auditorias' ? <BundleAudits /> : section === 'higiene' ? <HandHygiene /> : <Templates />}
    </div>
  );
}

function BundleAudits() {
  const ops = useOps()!;
  const session = useSession();
  const org = useOrg();
  const tz = useTimeZone();
  const period = useDefaultPeriod();
  const f = useUrlFilters({ de: period.from, ate: period.to });
  const q = { from: f.get('de') || undefined, to: f.get('ate') || undefined, sectorId: f.get('setor') || undefined, templateId: f.get('modelo') || undefined };
  const templates = useQuery({ queryKey: ['bundles', 'templates'], queryFn: () => ops.bundleTemplates() });
  const summary = useQuery({ queryKey: ['bundles', 'summary', q], queryFn: () => ops.bundleSummary(q) });
  const audits = useQuery({ queryKey: ['bundles', 'audits', q, f.page], queryFn: () => ops.bundleAudits({ ...q, page: f.page, pageSize: 25 }) });
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<BundleAuditDto | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const tplName = (id: string) => templates.data?.templates.find((t) => t.id === id)?.name ?? 'Modelo';

  const summaryRows = (summary.data?.rows ?? []).filter((r) => !q.templateId || r.templateId === q.templateId);
  const summaryCols: Column<(typeof summaryRows)[number]>[] = [
    { key: 'template', label: 'Bundle', value: (r) => tplName(r.templateId) },
    { key: 'sector', label: 'Setor', value: (r) => sectorName(org.data, r.sectorId) },
    { key: 'audits', label: 'Auditorias', align: 'right' },
    { key: 'compliant', label: 'Conformes', align: 'right' },
    { key: 'pct', label: 'Adesão', align: 'right', value: (r) => pct(r.compliant, r.audits), render: (r) => { const p = pct(r.compliant, r.audits); return p == null ? '—' : <span><span className="bar-track" aria-hidden="true"><span className="bar" style={{ width: `${p}%` }} /></span>{formatNumber(p)}%</span>; } },
  ];
  const auditCols: Column<BundleAuditDto>[] = [
    { key: 'auditedAt', label: 'Data', value: (a) => a.auditedAt, render: (a) => formatDate(a.auditedAt, tz) },
    { key: 'template', label: 'Bundle', value: (a) => a.templateName },
    { key: 'sector', label: 'Setor', value: (a) => sectorName(org.data, a.sectorId) },
    { key: 'result', label: 'Resultado', value: (a) => a.result, render: (a) => (a.voided ? <StatusBadge status="neutral">Anulada</StatusBadge> : <StatusBadge status={a.result === 'conforme' ? 'ok' : 'crit'}>{a.result === 'conforme' ? 'Conforme' : `Não conforme (${a.answers.filter((x) => x.answer === 'nao_conforme').length})`}</StatusBadge>) },
    { key: 'items', label: 'Itens não conformes', sortable: false, render: (a) => a.answers.filter((x) => x.answer === 'nao_conforme').map((x) => x.label).join('; ') || '—' },
    { key: 'auditor', label: 'Auditor', value: (a) => a.auditorName, render: (a) => <span>{a.auditorName} <DemoTag origin={a.origin} /></span> },
    ...(session.can('quality:bundle:record') ? [{ key: 'act', label: 'Ação', sortable: false, exportable: false, render: (a: BundleAuditDto) => (a.voided ? <span className="ig-small ig-muted">{a.voidReason}</span> : <Button size="sm" variant="ghost" onClick={() => setVoiding(a)} aria-label={`Anular auditoria de ${formatDate(a.auditedAt, tz)}`}>Anular</Button>) } as Column<BundleAuditDto>] : []),
  ];

  return (
    <>
      {saved ? <FormMessage tone="success">{saved}</FormMessage> : null}
      {session.can('quality:bundle:record') && !creating ? <div><Button variant="primary" icon="plus" onClick={() => { setCreating(true); setSaved(null); }}>Nova auditoria de bundle</Button></div> : null}
      {creating && templates.data ? <AuditForm templates={templates.data.templates.filter((t) => t.active)} onDone={(msg) => { setCreating(false); if (msg) setSaved(msg); }} /> : null}
      <div className="filters">
        <div className="field"><label htmlFor="b-de">De</label><input id="b-de" type="date" className="select" value={f.get('de')} onChange={(e) => f.set('de', e.target.value)} /></div>
        <div className="field"><label htmlFor="b-ate">Até</label><input id="b-ate" type="date" className="select" value={f.get('ate')} onChange={(e) => f.set('ate', e.target.value)} /></div>
        <SectorFilter id="b-setor" value={f.get('setor')} onChange={(v) => f.set('setor', v)} />
        <div className="field">
          <label htmlFor="b-mod">Bundle</label>
          <select id="b-mod" className="select" value={f.get('modelo')} onChange={(e) => f.set('modelo', e.target.value)}>
            <option value="">Todos</option>
            {templates.data?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>
      <div className="cols-2">
        <DataTable caption="Adesão no período (auditorias não anuladas)" columns={summaryCols} rows={summaryRows} rowKey={(r) => `${r.templateId}|${r.sectorId}`} state={summary.isPending ? 'loading' : summary.isError ? 'error' : 'ready'} dense />
        <Card title="Itens mais descumpridos (Pareto)" subtitle="Onde concentrar a ação educativa.">
          {summary.data?.pareto.filter((p) => !q.templateId || p.templateId === q.templateId).length ? (
            <ol className="ig-list" style={{ paddingLeft: 0 }}>
              {summary.data.pareto.filter((p) => !q.templateId || p.templateId === q.templateId).slice(0, 8).map((p) => (
                <li key={p.itemId}><span>{p.label}<span className="ig-small ig-muted"> · {tplName(p.templateId)}</span></span><b className="ig-num">{p.nonCompliant}</b></li>
              ))}
            </ol>
          ) : <EmptyState title="Nenhum item não conforme no período" />}
        </Card>
      </div>
      <DataTable caption="Auditorias" columns={auditCols} rows={audits.data?.rows ?? []} rowKey={(a) => a.id} state={audits.isPending ? 'loading' : audits.isError ? 'error' : 'ready'} onRetry={() => void audits.refetch()} />
      {audits.data ? <Pager page={f.page} pageSize={audits.data.pageSize} total={audits.data.total} onPage={(p) => f.set('pagina', String(p))} /> : null}
      <VoidDialog open={!!voiding} title="Anular auditoria de bundle?" onVoid={(reason) => ops.voidBundleAudit(voiding!.id, reason)} onClose={() => setVoiding(null)} />
    </>
  );
}

function AuditForm({ templates, onDone }: { templates: BundleTemplateDto[]; onDone: (msg?: string) => void }) {
  const ops = useOps()!;
  const org = useOrg();
  const tz = useTimeZone();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [sectorId, setSectorId] = useState('');
  const [auditedAt, setAuditedAt] = useState(nowLocal(tz));
  const [notes, setNotes] = useState('');
  const [answers, setAnswers] = useState<Record<string, BundleAnswer>>({});
  const [error, setError] = useState<string | null>(null);
  const tpl = templates.find((t) => t.id === templateId);
  const list = tpl?.items.map((i) => answers[i.id] ?? null) ?? [];
  const evaluation = evaluateBundle(list, tpl?.method ?? 'tudo_ou_nada');
  const m = useOpsMutation(() => ops.createBundleAudit({ templateId, sectorId, admissionId: null, auditedAt: localToIso(auditedAt, tz)!, notes: notes.trim() || null, answers: tpl!.items.map((i) => ({ itemId: i.id, answer: answers[i.id]! })) }));
  const submit = () => {
    if (!sectorId) { setError('Selecione o setor auditado.'); return; }
    if (evaluation.unanswered) { setError(`Responda todos os itens (${evaluation.unanswered} sem resposta).`); return; }
    setError(null);
    m.mutation.mutate(undefined, { onSuccess: (r) => onDone(`Auditoria registrada: ${r.result === 'conforme' ? 'conforme' : 'não conforme'}.`) });
  };
  return (
    <FormCard title="Nova auditoria de bundle" error={error ?? m.formError} onSubmit={submit} onCancel={() => onDone()} busy={m.mutation.isPending} submitLabel="Registrar auditoria">
      <div className="ig-form-row">
        <Field label="Bundle" required><select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setAnswers({}); }}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <Field label="Setor" required error={m.fieldErrors.sectorId ?? null}>
          <select value={sectorId} onChange={(e) => setSectorId(e.target.value)}>
            <option value="">Selecione</option>
            {org.data?.sectors.filter((s) => s.kind === 'uti' || s.kind === 'internacao' || s.kind === 'centro_cirurgico').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Data e hora" required error={m.fieldErrors.auditedAt ?? null}><input type="datetime-local" value={auditedAt} max={nowLocal(tz)} onChange={(e) => setAuditedAt(e.target.value)} /></Field>
      </div>
      {tpl ? (
        <BundleChecklist title={tpl.name} context={`Método: ${BUNDLE_METHOD_LABEL[tpl.method]}`} items={tpl.items.map((i) => ({ id: i.id, text: i.label }))} answers={list} evaluation={evaluation} method={tpl.method}
          onAnswer={(index, answer) => setAnswers({ ...answers, [tpl.items[index]!.id]: answer })} />
      ) : null}
      <Field label="Observações"><textarea value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></Field>
    </FormCard>
  );
}

function HandHygiene() {
  const ops = useOps()!;
  const session = useSession();
  const org = useOrg();
  const tz = useTimeZone();
  const period = useDefaultPeriod();
  const f = useUrlFilters({ de: period.from, ate: period.to });
  const q = { from: f.get('de') || undefined, to: f.get('ate') || undefined, sectorId: f.get('setor') || undefined };
  const list = useQuery({ queryKey: ['hand-hygiene', q, f.page], queryFn: () => ops.handHygiene({ ...q, page: f.page, pageSize: 25 }) });
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<HandHygieneDto | null>(null);
  const bySector = new Map<string, { o: number; a: number }>();
  for (const s of list.data?.summary ?? []) { const c = bySector.get(s.sectorId) ?? { o: 0, a: 0 }; c.o += s.opportunities; c.a += s.actions; bySector.set(s.sectorId, c); }
  const byCategory = new Map<HandHygieneCategory, { o: number; a: number }>();
  for (const s of list.data?.summary ?? []) { const c = byCategory.get(s.category) ?? { o: 0, a: 0 }; c.o += s.opportunities; c.a += s.actions; byCategory.set(s.category, c); }
  const adherence = (c: { o: number; a: number }) => { const p = pct(c.a, c.o); return p == null ? '—' : `${formatNumber(p)}% (${c.a}/${c.o})`; };

  const cols: Column<HandHygieneDto>[] = [
    { key: 'observedAt', label: 'Data', value: (h) => h.observedAt, render: (h) => formatDate(h.observedAt, tz) },
    { key: 'sector', label: 'Setor', value: (h) => sectorName(org.data, h.sectorId) },
    { key: 'category', label: 'Categoria', value: (h) => HH_CATEGORY_LABEL[h.category] },
    { key: 'opportunities', label: 'Oportunidades', align: 'right' },
    { key: 'actions', label: 'Ações', align: 'right' },
    { key: 'pct', label: 'Adesão', align: 'right', value: (h) => pct(h.actions, h.opportunities), render: (h) => (h.voided ? <StatusBadge status="neutral">Anulada</StatusBadge> : `${formatNumber(pct(h.actions, h.opportunities))}%`) },
    { key: 'observer', label: 'Observador', render: (h) => <span>{h.observerName} <DemoTag origin={h.origin} /></span>, value: (h) => h.observerName },
    ...(session.can('quality:bundle:record') ? [{ key: 'act', label: 'Ação', sortable: false, exportable: false, render: (h: HandHygieneDto) => (h.voided ? <span className="ig-small ig-muted">{h.voidReason}</span> : <Button size="sm" variant="ghost" onClick={() => setVoiding(h)}>Anular</Button>) } as Column<HandHygieneDto>] : []),
  ];
  return (
    <>
      {session.can('quality:bundle:record') && !creating ? <div><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nova observação</Button></div> : null}
      {creating ? <HandHygieneForm onDone={() => setCreating(false)} /> : null}
      <div className="filters">
        <div className="field"><label htmlFor="h-de">De</label><input id="h-de" type="date" className="select" value={f.get('de')} onChange={(e) => f.set('de', e.target.value)} /></div>
        <div className="field"><label htmlFor="h-ate">Até</label><input id="h-ate" type="date" className="select" value={f.get('ate')} onChange={(e) => f.set('ate', e.target.value)} /></div>
        <SectorFilter id="h-setor" value={f.get('setor')} onChange={(v) => f.set('setor', v)} />
      </div>
      {list.isPending ? <LoadingState /> : list.isError ? <ErrorState onRetry={() => void list.refetch()} /> : (
        <div className="cols-2">
          <Card title="Adesão por setor"><ul className="ig-list">{[...bySector].map(([s, c]) => <li key={s}><span>{sectorName(org.data, s)}</span><b className="ig-num">{adherence(c)}</b></li>)}</ul></Card>
          <Card title="Adesão por categoria profissional"><ul className="ig-list">{[...byCategory].map(([k, c]) => <li key={k}><span>{HH_CATEGORY_LABEL[k]}</span><b className="ig-num">{adherence(c)}</b></li>)}</ul></Card>
        </div>
      )}
      <DataTable caption="Observações" columns={cols} rows={list.data?.rows ?? []} rowKey={(h) => h.id} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'} />
      {list.data ? <Pager page={f.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => f.set('pagina', String(p))} /> : null}
      <VoidDialog open={!!voiding} title="Anular observação?" onVoid={(reason) => ops.voidHandHygiene(voiding!.id, reason)} onClose={() => setVoiding(null)} />
    </>
  );
}

function HandHygieneForm({ onDone }: { onDone: () => void }) {
  const ops = useOps()!;
  const org = useOrg();
  const tz = useTimeZone();
  const [d, setD] = useState({ sectorId: '', observedAt: nowLocal(tz), category: 'enfermagem' as HandHygieneCategory, opportunities: '', actions: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useOpsMutation(() => ops.createHandHygiene({ sectorId: d.sectorId, observedAt: localToIso(d.observedAt, tz)!, category: d.category, opportunities: Number(d.opportunities), actions: Number(d.actions) }));
  const submit = () => {
    const o = Number(d.opportunities);
    const a = Number(d.actions);
    const e = {
      sectorId: d.sectorId ? undefined : 'Selecione o setor.',
      opportunities: Number.isInteger(o) && o > 0 ? undefined : 'Informe as oportunidades observadas.',
      actions: Number.isInteger(a) && a >= 0 && a <= o ? undefined : 'Ações devem ser um número entre 0 e o total de oportunidades.',
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  return (
    <FormCard title="Observação de higiene das mãos" subtitle="Registre as oportunidades observadas e as ações realizadas na sessão." error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Registrar observação">
      <div className="ig-form-row">
        <Field label="Setor" required error={errors.sectorId ?? m.fieldErrors.sectorId ?? null}>
          <select value={d.sectorId} onChange={(e) => setD({ ...d, sectorId: e.target.value })}>
            <option value="">Selecione</option>
            {org.data?.sectors.filter((s) => s.kind === 'uti' || s.kind === 'internacao').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Data e hora" required><input type="datetime-local" value={d.observedAt} max={nowLocal(tz)} onChange={(e) => setD({ ...d, observedAt: e.target.value })} /></Field>
        <Field label="Categoria" required><select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value as HandHygieneCategory })}>{Object.entries(HH_CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Oportunidades" required error={errors.opportunities ?? null}><input inputMode="numeric" value={d.opportunities} onChange={(e) => setD({ ...d, opportunities: e.target.value })} /></Field>
        <Field label="Ações realizadas" required error={errors.actions ?? m.fieldErrors.actions ?? null}><input inputMode="numeric" value={d.actions} onChange={(e) => setD({ ...d, actions: e.target.value })} /></Field>
      </div>
    </FormCard>
  );
}

function Templates() {
  const ops = useOps()!;
  const session = useSession();
  const institution = useInstitution();
  const templates = useQuery({ queryKey: ['bundles', 'templates'], queryFn: () => ops.bundleTemplates() });
  const [editing, setEditing] = useState<BundleTemplateDto | 'new' | null>(null);
  const references = institution.data?.data.references ?? [];
  if (templates.isPending) return <LoadingState />;
  if (templates.isError) return <ErrorState onRetry={() => void templates.refetch()} />;
  const canConfigure = session.can('quality:configure');
  return (
    <>
      {canConfigure && !editing ? <div><Button icon="plus" onClick={() => setEditing('new')}>Novo modelo</Button></div> : null}
      {editing ? <TemplateForm template={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      {templates.data.templates.map((t) => {
        const ref = references.find((r) => r.id === t.referenceId);
        return (
          <Card key={t.id} title={t.name} subtitle={`${BUNDLE_METHOD_LABEL[t.method]}${t.metric ? ` · alimenta “${BUNDLE_METRIC_LABEL[t.metric]}”` : ' · sem indicador do catálogo'}${t.active ? '' : ' · inativo'}`}
            actions={canConfigure && !editing ? <Button size="sm" onClick={() => setEditing(t)} aria-label={`Editar ${t.name}`}>Editar</Button> : null}>
            <ol style={{ margin: 0, paddingLeft: 20 }}>{t.items.map((i) => <li key={i.id}>{i.label}</li>)}</ol>
            <p className="ig-card-sub" style={{ marginTop: 8 }}>{ref ? `Referência: ${ref.title}` : 'Sem referência vinculada'} {!ref?.validatedBy ? <ProvenanceTag kind="requer_validacao" /> : null}</p>
          </Card>
        );
      })}
    </>
  );
}

function TemplateForm({ template, onDone }: { template: BundleTemplateDto | null; onDone: () => void }) {
  const ops = useOps()!;
  const institution = useInstitution();
  const [d, setD] = useState({
    code: template?.code ?? '', name: template?.name ?? '', metric: (template?.metric ?? '') as BundleMetric | '', method: template?.method ?? 'tudo_ou_nada',
    referenceId: template?.referenceId ?? '', active: template?.active ?? true, items: template?.items.map((i) => ({ id: i.id as string | null, label: i.label })) ?? [{ id: null, label: '' }], justification: '',
  });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const m = useOpsMutation(() => ops.saveBundleTemplate({ code: d.code.trim(), name: d.name.trim(), metric: d.metric || null, method: d.method, referenceId: d.referenceId || null, active: d.active, items: d.items.map((i) => ({ id: i.id, label: i.label.trim() })), rowVersion: template?.rowVersion ?? null, justification: d.justification.trim() }));
  const submit = () => {
    const e = {
      code: /^[a-z0-9-]{2,40}$/.test(d.code.trim()) ? undefined : 'Use letras minúsculas, números e hífen.',
      name: d.name.trim() ? undefined : 'Informe o nome.',
      items: d.items.length && d.items.every((i) => i.label.trim()) ? undefined : 'Preencha todos os itens.',
      justification: justificationError(d.justification),
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) m.mutation.mutate(undefined, { onSuccess: onDone });
  };
  const err = (k: string) => errors[k] ?? m.fieldErrors[k] ?? null;
  return (
    <FormCard title={template ? `Editar ${template.name}` : 'Novo modelo de bundle'} subtitle="Alterar o texto de um item cria um item novo: auditorias anteriores mantêm o texto original." error={m.formError} onSubmit={submit} onCancel={onDone} busy={m.mutation.isPending} submitLabel="Salvar modelo">
      <div className="ig-form-row">
        <Field label="Código" required error={err('code')}><input value={d.code} disabled={!!template} onChange={(e) => setD({ ...d, code: e.target.value })} /></Field>
        <Field label="Nome" required error={err('name')}><input value={d.name} maxLength={160} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
      </div>
      <div className="ig-form-row">
        <Field label="Método de cálculo" required><select value={d.method} onChange={(e) => setD({ ...d, method: e.target.value as typeof d.method })}>{Object.entries(BUNDLE_METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Indicador do catálogo" error={err('metric')}><select value={d.metric} onChange={(e) => setD({ ...d, metric: e.target.value as BundleMetric | '' })}><option value="">Nenhum</option>{Object.entries(BUNDLE_METRIC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Referência"><ReferenceSelect references={institution.data?.data.references ?? []} value={d.referenceId} onChange={(v) => setD({ ...d, referenceId: v })} /></Field>
      </div>
      <fieldset className="isolate-box">
        <legend>Itens</legend>
        {d.items.map((item, i) => (
          <div key={i} className="ig-row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}><Field label={`Item ${i + 1}`} required><input value={item.label} maxLength={200} onChange={(e) => setD({ ...d, items: d.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} /></Field></div>
            {d.items.length > 1 ? <Button size="sm" variant="ghost" onClick={() => setD({ ...d, items: d.items.filter((_, j) => j !== i) })} aria-label={`Remover item ${i + 1}`}>Remover</Button> : null}
          </div>
        ))}
        {err('items') ? <p className="ig-field-error" role="alert">{err('items')}</p> : null}
        <div><Button size="sm" icon="plus" onClick={() => setD({ ...d, items: [...d.items, { id: null, label: '' }] })}>Adicionar item</Button></div>
      </fieldset>
      <label className="ig-row" style={{ gap: 8 }}><input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Modelo ativo</label>
      <JustificationField value={d.justification} onChange={(v) => setD({ ...d, justification: v })} error={err('justification') ?? undefined} />
    </FormCard>
  );
}
