import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LABEL_ENTITY_LABEL, LABEL_OUTPUT_LABEL, LABEL_PRINT_KIND_LABEL, LABEL_PRINT_STATUS_LABEL, LABEL_TYPE, barcodeFit, code128Bars, formatDate, labelLines,
  type LabelContent, type LabelEntity, type LabelLayoutInput, type LabelOutput, type LabelPrintDto, type LabelPrintKind, type LabelPrintStatus, type PrintedLabel, type Status,
} from '@ccih/domain';
import { AlertBanner, Button, Card, DataTable, Field, FormMessage, StatusBadge, type Column } from '@ccih/ui';
import { ApiError } from '../../data/api/http';
import { useSession } from '../auth/session';
import { useTimeZone } from '../clinical/shared';
import { useCme } from './shared';

/** Barcode as SVG elements (same bars as the ZPL output), sized in millimetres. */
export function Barcode({ code, moduleMm, heightMm }: { code: string; moduleMm: number; heightMm: number }) {
  const { total, bars } = code128Bars(code);
  return (
    <svg className="cme-label-bars" width={`${total * moduleMm}mm`} height={`${heightMm}mm`} viewBox={`0 0 ${total} 1`} preserveAspectRatio="none" shapeRendering="crispEdges" role="img" aria-label={`Código de barras ${code}`} data-code={code}>
      <rect width={total} height={1} fill="#fff" />
      <g fill="#000">{bars.map((b) => <rect key={b.x} x={b.x} y={0} width={b.w} height={1} />)}</g>
    </svg>
  );
}

/** One label at its real size: material, barcode, human-readable code and the layout's fields. */
export function LabelView({ layout, content }: { layout: LabelLayoutInput; content: LabelContent }) {
  const fit = barcodeFit(layout, content.code);
  const mm = (n: number) => `${n}mm`;
  return (
    <div className="cme-label" style={{ width: mm(layout.widthMm), height: mm(layout.heightMm), padding: mm(layout.marginMm) }} data-label-code={content.code}>
      <div className="cme-label-title" style={{ fontSize: mm(LABEL_TYPE.title), lineHeight: mm(LABEL_TYPE.titleLine), height: mm(LABEL_TYPE.titleLine) }}>{content.material}</div>
      <div className="cme-label-barrow" style={{ height: mm(layout.barHeightMm) }}><Barcode code={content.code} moduleMm={fit.moduleMm} heightMm={layout.barHeightMm} /></div>
      <div className="cme-label-code" style={{ marginTop: mm(LABEL_TYPE.gap), fontSize: mm(LABEL_TYPE.code), lineHeight: mm(LABEL_TYPE.codeLine) }}>{content.code}</div>
      {labelLines(layout, content).map((l) => (
        <div key={l.field} className={l.strong ? 'cme-label-line strong' : 'cme-label-line'} style={{ fontSize: mm(LABEL_TYPE.line), lineHeight: mm(LABEL_TYPE.lineStep) }}>{l.text}</div>
      ))}
    </div>
  );
}

/**
 * Print sheet: only the labels are printed, one per page at the layout size. It is mounted outside
 * the application root so the print style can hide everything else.
 */
function PrintSheet({ labels }: { labels: PrintedLabel[] }) {
  // Stays mounted after printing: some browsers print asynchronously and would otherwise print a blank page.
  useEffect(() => {
    const t = window.setTimeout(() => window.print(), 50);
    return () => window.clearTimeout(t);
  }, [labels]);
  const first = labels[0]!.layout;
  return createPortal(
    <div className="label-print-root" aria-hidden="true">
      <style>{`@page { size: ${first.widthMm}mm ${first.heightMm}mm; margin: 0; }`}</style>
      {labels.map((l) => <div key={l.printId} className="label-print-page"><LabelView layout={l.layout} content={l.content} /></div>)}
    </div>,
    document.body,
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface LabelTarget { id: string; code: string; hasActive: boolean }

/**
 * Print or reprint the labels of some records. The server decides: a record with a label in use is
 * only reprinted, with a reason, and the new label replaces the previous one.
 */
export function LabelPrintPanel({ entity, targets, onClose }: { entity: LabelEntity; targets: LabelTarget[]; onClose: () => void }) {
  const cme = useCme()!;
  const client = useQueryClient();
  const layouts = useQuery({ queryKey: ['cme', 'label-layouts'], queryFn: () => cme.labelLayouts() });
  const options = (layouts.data?.layouts ?? []).filter((l) => l.entity === entity && l.active);
  const [layoutId, setLayoutId] = useState('');
  const [output, setOutput] = useState<LabelOutput>('navegador');
  const [mode, setMode] = useState<LabelPrintKind>(targets.some((t) => t.hasActive) ? 'reimpressao' : 'impressao');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [printed, setPrinted] = useState<PrintedLabel[]>([]);
  const [sheet, setSheet] = useState<PrintedLabel[] | null>(null);
  const chosen = layoutId || options.find((l) => l.isDefault)?.id || options[0]?.id || '';
  // What the server reported overrides what the screen knew (another station may have printed meanwhile).
  const [inUse, setInUse] = useState<Record<string, boolean>>({});
  const active = (t: LabelTarget) => inUse[t.code] ?? t.hasActive;
  const pending = targets.filter((t) => (mode === 'impressao' ? !active(t) : active(t)));

  const submit = async () => {
    setMessage(null);
    if (!chosen) { setMessage({ tone: 'error', text: 'Escolha o layout da etiqueta.' }); return; }
    if (mode === 'reimpressao' && reason.trim().length < 10) { setMessage({ tone: 'error', text: 'Informe o motivo da reimpressão (mínimo 10 caracteres).' }); return; }
    if (!pending.length) { setMessage({ tone: 'error', text: mode === 'impressao' ? 'Todos já têm etiqueta em uso: use a reimpressão.' : 'Nenhum tem etiqueta em uso: faça a impressão.' }); return; }
    setBusy(true);
    try {
      const r = await cme.printLabels({ entity, ids: pending.map((t) => t.id), layoutId: chosen, output, mode, reason: mode === 'reimpressao' ? reason.trim() : null });
      await client.invalidateQueries({ queryKey: ['cme'] });
      setPrinted(r.labels);
      setInUse((m) => ({ ...m, ...Object.fromEntries(r.labels.map((l) => [l.content.code, true])) }));
      if (r.zpl) {
        download(`etiquetas-${r.labels[0]!.content.code}${r.labels.length > 1 ? `-e-mais-${r.labels.length - 1}` : ''}.zpl`, r.zpl);
        setMessage({ tone: 'success', text: `${r.labels.length} etiqueta(s) registrada(s) e arquivo ZPL gerado. O envio direto à impressora térmica depende de um serviço de impressão local, ainda não instalado.` });
      } else {
        setSheet(r.labels);
        setMessage({ tone: 'success', text: `${r.labels.length} etiqueta(s) registrada(s) e enviada(s) à impressão do navegador.` });
      }
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'etiqueta_ja_impressa' || e.code === 'sem_etiqueta_ativa')) {
        const used = e.code === 'etiqueta_ja_impressa';
        setInUse((m) => ({ ...m, ...Object.fromEntries(e.fields.map((f) => [f.message, used])) }));
        setMode(used ? 'reimpressao' : 'impressao');
        setMessage({ tone: 'error', text: e.message });
      }
      else setMessage({ tone: 'error', text: e instanceof ApiError ? e.message : 'Não foi possível imprimir.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={mode === 'impressao' ? 'Imprimir etiquetas' : 'Reimprimir etiquetas'} subtitle={`${LABEL_ENTITY_LABEL[entity]} · ${pending.length} de ${targets.length} selecionado(s)`} headingLevel={2}>
      {layouts.isSuccess && !options.length ? (
        <AlertBanner tone="warn" title="Sem layout de etiqueta">Quem configura as estações da CME cadastra o layout (tamanho, margens e resolução da impressora) em CME → Etiquetas.</AlertBanner>
      ) : null}
      <div className="ig-form-row">
        <Field label="Layout" required><select value={chosen} onChange={(e) => setLayoutId(e.target.value)}>{options.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isDefault ? ' (padrão)' : ''}</option>)}</select></Field>
        <Field label="Saída" required><select value={output} onChange={(e) => setOutput(e.target.value as LabelOutput)}>{(Object.keys(LABEL_OUTPUT_LABEL) as LabelOutput[]).map((o) => <option key={o} value={o}>{LABEL_OUTPUT_LABEL[o]}</option>)}</select></Field>
        <Field label="Tipo" required><select value={mode} onChange={(e) => setMode(e.target.value as LabelPrintKind)}><option value="impressao">Impressão (sem etiqueta em uso)</option><option value="reimpressao">Reimpressão (substitui a etiqueta em uso)</option></select></Field>
      </div>
      {mode === 'reimpressao' ? (
        <Field label="Motivo da reimpressão" required hint="Fica no histórico da etiqueta e no log de auditoria. A etiqueta anterior passa a constar como substituída.">
          <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
      ) : null}
      <p className="ig-small ig-muted">{pending.map((t) => t.code).join(', ') || 'Nenhum registro para este tipo de impressão.'}</p>
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      <div className="ig-row" style={{ gap: 8 }}>
        <Button variant="primary" icon="printer" disabled={busy || !options.length} onClick={() => void submit()}>{busy ? 'Imprimindo…' : mode === 'impressao' ? 'Imprimir' : 'Reimprimir'}</Button>
        <Button onClick={onClose}>Fechar</Button>
      </div>
      {printed.length ? (
        <div className="cme-label-preview" aria-label="Etiquetas impressas">
          {printed.slice(0, 6).map((l) => <LabelView key={l.printId} layout={l.layout} content={l.content} />)}
          {printed.length > 6 ? <p className="ig-small ig-muted">e mais {printed.length - 6}.</p> : null}
          {output === 'navegador' ? <Button size="sm" onClick={() => setSheet([...printed])}>Abrir a impressão de novo</Button> : null}
        </div>
      ) : null}
      {sheet ? <PrintSheet labels={sheet} /> : null}
    </Card>
  );
}

const STATUS_TONE: Record<LabelPrintStatus, Status> = { ativa: 'ok', cancelada: 'crit', substituida: 'neutral' };

/** Labels printed for one record (or matching a code): who, when, why; cancel the one in use. */
export function LabelHistory({ entity, entityId, q, title = 'Etiquetas' }: { entity?: LabelEntity; entityId?: string; q?: string; title?: string }) {
  const cme = useCme()!;
  const session = useSession();
  const tz = useTimeZone();
  const client = useQueryClient();
  const query = { ...(entity ? { entity } : {}), ...(entityId ? { entityId } : {}), ...(q ? { q } : {}), limit: 100 };
  const list = useQuery({ queryKey: ['cme', 'labels', query], queryFn: () => cme.labelPrints(query) });
  const [cancelling, setCancelling] = useState<LabelPrintDto | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canCancel = session.can('cme:cycle:record') && session.writable;
  const cancel = async () => {
    if (reason.trim().length < 10) { setError('Informe o motivo do cancelamento (mínimo 10 caracteres).'); return; }
    try {
      await cme.cancelLabel(cancelling!.id, reason.trim());
      setCancelling(null);
      setReason('');
      setError(null);
      await client.invalidateQueries({ queryKey: ['cme'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível cancelar.');
    }
  };
  const cols: Column<LabelPrintDto>[] = [
    { key: 'code', label: 'Código', render: (p) => <span className="ig-mono">{p.code}</span> },
    { key: 'kind', label: 'Tipo', value: (p) => LABEL_PRINT_KIND_LABEL[p.kind] },
    { key: 'status', label: 'Situação', render: (p) => <StatusBadge status={STATUS_TONE[p.status]}>{LABEL_PRINT_STATUS_LABEL[p.status]}</StatusBadge> },
    { key: 'printedAt', label: 'Impressa em', value: (p) => p.printedAt, render: (p) => formatDate(p.printedAt, tz) },
    { key: 'printedBy', label: 'Por', value: (p) => p.printedBy },
    { key: 'layout', label: 'Layout e saída', value: (p) => `${p.layoutName} · ${p.output === 'zpl' ? 'ZPL' : 'navegador'}` },
    { key: 'reason', label: 'Motivo', value: (p) => (p.cancelReason ? `Cancelada: ${p.cancelReason}` : (p.reason ?? '—')) },
    ...(canCancel ? [{ key: 'actions', label: 'Ações', render: (p: LabelPrintDto) => (p.status === 'ativa' ? <Button size="sm" onClick={() => { setCancelling(p); setError(null); }} aria-label={`Cancelar etiqueta ${p.code}`}>Cancelar</Button> : null) }] : []),
  ];
  return (
    <Card title={title} subtitle="Impressões, reimpressões e cancelamentos ficam registrados e não podem ser alterados." headingLevel={2}>
      {cancelling ? (
        <div className="ig-stack" style={{ marginBottom: 12 }}>
          <Field label={`Motivo do cancelamento da etiqueta ${cancelling.code}`} required hint="Ex.: etiqueta danificada ou ilegível. O registro fica sem etiqueta em uso até nova impressão.">
            <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <div className="ig-row" style={{ gap: 8 }}>
            <Button variant="danger" onClick={() => void cancel()}>Cancelar etiqueta</Button>
            <Button onClick={() => setCancelling(null)}>Voltar</Button>
          </div>
        </div>
      ) : null}
      <DataTable caption={title} dense rows={list.data?.prints ?? []} rowKey={(p) => p.id} columns={cols} state={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'} emptyMessage="Nenhuma etiqueta impressa." pageSize={25} />
    </Card>
  );
}

/** Which records already have a label in use (to suggest print or reprint). */
export function useActiveLabels(entity: LabelEntity, q?: string) {
  const cme = useCme()!;
  const query = { entity, situacao: 'ativas' as const, limit: 200, ...(q ? { q } : {}) };
  const list = useQuery({ queryKey: ['cme', 'labels', query], queryFn: () => cme.labelPrints(query) });
  return new Set((list.data?.prints ?? []).map((p) => p.entityId));
}
