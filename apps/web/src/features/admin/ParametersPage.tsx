import { useState, type FormEvent } from 'react';
import { RULE_GROUP_LABEL, RULE_PARAMETERS, formatDate, parametersFromRules, requiresValidation, validateRuleValue, type RuleParameterSpec } from '@ccih/domain';
import { Button, Card, ConfirmDialog, DataTable, ErrorState, Field, FormMessage, LoadingState, ProvenanceTag, type Column } from '@ccih/ui';
import { useInstitution } from '../../data/source';
import { useSession } from '../auth/session';
import { EditAvailability, JustificationField, ReferenceSelect, UnsavedChangesGuard, justificationError, useAdmin, useAdminMutation, useConfigVersions } from './shared';

/** "vancomicina=120" per line ⇄ { vancomicina: 120 } */
const drugMapToText = (v: unknown) => Object.entries((v ?? {}) as Record<string, number>).map(([k, n]) => `${k}=${n}`).join('\n');
function textToDrugMap(text: string): Record<string, number> | string {
  const out: Record<string, number> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([^=]+)=\s*(\d+)$/.exec(line);
    if (!m) return `Linha inválida: "${line}". Use o formato fármaco=minutos.`;
    out[m[1]!.trim().toLowerCase()] = Number(m[2]);
  }
  return out;
}
const display = (spec: RuleParameterSpec, v: unknown) => (spec.kind === 'drug_minutes' ? (drugMapToText(v).replace(/\n/g, '; ') || 'Nenhuma exceção') : `${String(v)} ${spec.unit}`);

export function ParametersPage() {
  const institution = useInstitution();
  const versions = useConfigVersions();
  const session = useSession();
  const admin = useAdmin();
  const [spec, setSpec] = useState<RuleParameterSpec | null>(null);
  const [draft, setDraft] = useState({ value: '', referenceId: '', justification: '' });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // A module administrator edits only its module's parameters (cme.* for the CME, the others for the CCIH); the API checks the same.
  const canEditSpec = (spec: RuleParameterSpec) => session.writable && session.can('config:rules:edit', spec.group === 'cme' ? 'cme:parameters:edit' : 'ccih:parameters:edit');
  const canEdit = session.writable && session.can('config:rules:edit', 'cme:parameters:edit', 'ccih:parameters:edit');
  const save = useAdminMutation((d: { key: string; value: unknown; referenceId: string | null; rowVersion: number | null; justification: string }) => admin!.saveRule(d.key, d));

  if (institution.isPending) return <LoadingState />;
  if (institution.isError) return <ErrorState onRetry={() => void institution.refetch()} />;
  const { config, references } = institution.data.data;
  const current = new Map(parametersFromRules(config.rules).map((p) => [p.key, p]));
  const refOf = (id: string | null | undefined) => references.find((r) => r.id === id);

  const open = (s: RuleParameterSpec) => {
    const p = current.get(s.key);
    setSpec(s);
    setSaved(null);
    setErrors({});
    setDraft({ value: s.kind === 'drug_minutes' ? drugMapToText(p?.value) : p ? String(p.value) : '', referenceId: p?.referenceId ?? '', justification: '' });
  };

  const parsedValue = (): unknown => (spec?.kind === 'drug_minutes' ? textToDrugMap(draft.value) : Number(draft.value));

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!spec) return;
    const v = parsedValue();
    const e: Record<string, string | undefined> = {
      value: typeof v === 'string' ? v : draft.value.trim() === '' && spec.kind === 'integer' ? 'Informe o valor.' : (validateRuleValue(spec, v) ?? undefined),
      justification: justificationError(draft.justification),
    };
    setErrors(e);
    if (!Object.values(e).some(Boolean)) setConfirm(true);
  };

  const doSave = () => {
    if (!spec) return;
    const rowVersion = versions.data?.rules.find((r) => r.key === spec.key)?.row_version ?? null;
    save.mutation.mutate(
      { key: spec.key, value: parsedValue(), referenceId: draft.referenceId || null, rowVersion, justification: draft.justification.trim() },
      { onSettled: () => setConfirm(false), onSuccess: () => { setSaved(`Parâmetro “${spec.label}” atualizado.`); setSpec(null); } },
    );
  };

  const columns: Column<RuleParameterSpec>[] = [
    { key: 'group', label: 'Grupo', value: (s) => RULE_GROUP_LABEL[s.group] },
    { key: 'label', label: 'Parâmetro' },
    { key: 'value', label: 'Valor', sortable: false, render: (s) => { const p = current.get(s.key); return p ? <span className="ig-row" style={{ gap: 6 }}>{display(s, p.value)}<ProvenanceTag kind="parametro">configurável</ProvenanceTag></span> : <span className="ig-muted">Não configurado — a regra não é aplicada</span>; } },
    { key: 'reference', label: 'Referência', value: (s) => refOf(current.get(s.key)?.referenceId)?.title ?? '', render: (s) => { const r = refOf(current.get(s.key)?.referenceId); return <span className="ig-row" style={{ gap: 6 }}>{r?.title ?? 'Sem referência'}{requiresValidation(r) ? <ProvenanceTag kind="requer_validacao" /> : null}</span>; } },
    { key: 'approved', label: 'Última alteração', hidden: !versions.data, value: (s) => versions.data?.rules.find((r) => r.key === s.key)?.approved_by_name ?? '', render: (s) => { const v = versions.data?.rules.find((r) => r.key === s.key); return v?.approved_by_name ? `${v.approved_by_name} · ${formatDate(v.updated_at, config.timezone)}` : 'Valor inicial (demonstração)'; } },
    ...(canEdit ? [{ key: 'action', label: 'Ação', sortable: false, exportable: false, render: (s: RuleParameterSpec) => (canEditSpec(s) ? <Button size="sm" onClick={() => open(s)} aria-label={`Editar ${s.label}`}>Editar</Button> : <span className="ig-small ig-muted">Outro módulo</span>) } as Column<RuleParameterSpec>] : []),
  ];

  return (
    <div className="ig-stack" style={{ gap: 16 }}>
      <EditAvailability permissionLabel="Editar parâmetros de regras institucionais" allowed={canEdit} />
      {saved ? <FormMessage tone="success">{saved}</FormMessage> : null}
      {spec ? (
        <Card title={spec.label} subtitle={`Grupo ${RULE_GROUP_LABEL[spec.group]}. Limites de digitação: ${spec.min}–${spec.max} ${spec.unit} (checagem de entrada, não recomendação clínica).`}>
          <form className="ig-form" onSubmit={submit} noValidate>
            {save.formError ? <FormMessage tone="error">{save.formError}</FormMessage> : null}
            {spec.kind === 'drug_minutes' ? (
              <Field label="Exceções por fármaco" hint="Uma por linha, no formato fármaco=minutos (ex.: vancomicina=120)." error={errors.value ?? save.fieldErrors.value ?? null}>
                <textarea value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              </Field>
            ) : (
              <Field label={`Valor (${spec.unit})`} required error={errors.value ?? save.fieldErrors.value ?? null}>
                <input inputMode="numeric" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              </Field>
            )}
            <Field label="Referência que fundamenta o valor" hint="Sem referência validada, a interface continua marcando o parâmetro como “Requer validação institucional”.">
              <ReferenceSelect references={references} value={draft.referenceId} onChange={(v) => setDraft({ ...draft, referenceId: v })} />
            </Field>
            <JustificationField value={draft.justification} onChange={(v) => setDraft({ ...draft, justification: v })} error={errors.justification ?? save.fieldErrors.justification} />
            <div className="ig-form-actions">
              <Button type="submit" variant="primary">Salvar parâmetro</Button>
              <Button onClick={() => setSpec(null)}>Cancelar</Button>
            </div>
          </form>
          <UnsavedChangesGuard when={draft.justification !== ''} />
        </Card>
      ) : null}
      <DataTable caption="Parâmetros de regras institucionais" columns={columns} rows={RULE_PARAMETERS} rowKey={(s) => s.key} searchable />
      <ConfirmDialog open={confirm} title="Alterar parâmetro de regra?" confirmLabel="Salvar parâmetro" busy={save.mutation.isPending} onConfirm={doSave} onCancel={() => setConfirm(false)}>
        O novo valor passa a ser aplicado imediatamente pelos módulos que usam esta regra. A alteração fica registrada no log de auditoria.
      </ConfirmDialog>
    </div>
  );
}
