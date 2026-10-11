import { code128Problem, code128Segments, code128Width, QUIET_ZONE_MODULES } from './barcode';
import { formatDate } from '../format';
import type { LoadStatus } from '../rules/sterilization';

/**
 * Labels: layouts (size, margins, resolution and fields), the plan shared by the browser print and
 * the ZPL output (same geometry, same encoded sequence), and the rules for printing, reprinting and
 * cancelling. A label never carries patient data.
 */
export type LabelEntity = 'pacote' | 'ativo' | 'processo';
export const LABEL_ENTITY_LABEL: Record<LabelEntity, string> = { pacote: 'Pacote estéril', ativo: 'Ativo (caixa/instrumental)', processo: 'Material avulso (processo)' };

export type LabelField = 'processamento' | 'validade' | 'lote' | 'equipamento' | 'liberacao' | 'embalagem' | 'implante' | 'conjunto' | 'identificacao';
export const LABEL_FIELDS: Record<LabelField, { label: string; short: string; entities: LabelEntity[]; hint?: string }> = {
  processamento: { label: 'Data de processamento', short: 'Proc.', entities: ['pacote', 'processo'] },
  validade: { label: 'Validade', short: 'Val.', entities: ['pacote'] },
  lote: { label: 'Lote (carga)', short: 'Lote', entities: ['pacote'] },
  equipamento: { label: 'Equipamento e programa', short: 'Equip.', entities: ['pacote'] },
  liberacao: { label: 'Situação de liberação', short: 'Liberação', entities: ['pacote'], hint: 'Fica fixa no papel: use só quando a etiqueta é impressa depois da decisão de liberação.' },
  embalagem: { label: 'Embalagem', short: 'Emb.', entities: ['pacote'] },
  implante: { label: 'Aviso de implantável', short: 'IMPLANTÁVEL', entities: ['pacote'] },
  conjunto: { label: 'Conjunto', short: 'Conj.', entities: ['pacote', 'ativo', 'processo'] },
  identificacao: { label: 'Identificação do ativo', short: 'Ident.', entities: ['ativo'] },
};
export const LABEL_DPI = [203, 300, 600] as const;
export type LabelDpi = (typeof LABEL_DPI)[number];
export type LabelOutput = 'navegador' | 'zpl';
export const LABEL_OUTPUT_LABEL: Record<LabelOutput, string> = { navegador: 'Impressão pelo navegador', zpl: 'Arquivo ZPL (impressora térmica)' };

export interface LabelLayoutInput {
  name: string;
  entity: LabelEntity;
  widthMm: number;
  heightMm: number;
  marginMm: number;
  dpi: number;
  barHeightMm: number;
  fields: LabelField[];
}
export interface LabelLayoutDto extends LabelLayoutInput {
  id: string;
  isDefault: boolean;
  active: boolean;
  dataOrigin: 'real' | 'demo';
  rowVersion: number;
  updatedAt: string;
}

/** What a label shows, read from the records at print time (and kept as printed). */
export interface LabelContent {
  entity: LabelEntity;
  code: string;
  material: string;
  processedOn?: string | null;
  expiresOn?: string | null;
  lot?: string | null;
  equipment?: string | null;
  release?: string | null;
  packaging?: string | null;
  implant?: boolean;
  setName?: string | null;
  tag?: string | null;
}

/** Typical code of each entity, used to check that a layout can hold it. */
export const LABEL_SAMPLE_CODE: Record<LabelEntity, string> = { pacote: 'CME01-251009-01-02', ativo: 'AT-K7M2Q9X4', processo: 'PR-K7M2Q9X4' };

/** Type sizes and spacing, in mm (the same for the browser and the ZPL output). */
export const LABEL_TYPE = { title: 3.0, titleLine: 3.6, code: 2.6, codeLine: 3.0, line: 2.4, lineStep: 2.9, gap: 0.8 } as const;
/** Smallest printable module: 2 printer dots and at least 0.165 mm (2 dots at 300 dpi). */
const MIN_MODULE_MM = 0.165;

const dotsPerMm = (dpi: number) => dpi / 25.4;

/** Height the layout needs for its fields (mm). */
export const labelNeededHeight = (l: Pick<LabelLayoutInput, 'marginMm' | 'barHeightMm' | 'fields'>) =>
  2 * l.marginMm + LABEL_TYPE.titleLine + l.barHeightMm + LABEL_TYPE.gap + LABEL_TYPE.codeLine + l.fields.length * LABEL_TYPE.lineStep;

/** Module size that fits the code in the printable width, snapped to whole printer dots. */
export function barcodeFit(l: Pick<LabelLayoutInput, 'widthMm' | 'marginMm' | 'dpi'>, code: string): { moduleDots: number; moduleMm: number; widthMm: number; problem: string | null } {
  const dpm = dotsPerMm(l.dpi);
  const modules = code128Width(code);
  const availableDots = Math.floor((l.widthMm - 2 * l.marginMm) * dpm);
  const moduleDots = Math.min(Math.floor(availableDots / modules), Math.max(2, Math.round(0.5 * dpm)));
  const moduleMm = moduleDots / dpm;
  const problem = moduleDots < 2 || moduleMm < MIN_MODULE_MM
    ? `O código ${code} não cabe na largura útil (${(l.widthMm - 2 * l.marginMm).toFixed(1)} mm) com barras legíveis: aumente a largura, reduza a margem ou use maior resolução.`
    : null;
  return { moduleDots, moduleMm, widthMm: modules * moduleMm, problem };
}

export interface LayoutProblem { path: string; message: string }

export function checkLabelLayout(l: LabelLayoutInput): LayoutProblem[] {
  const p: LayoutProblem[] = [];
  const range = (path: keyof LabelLayoutInput, v: number, min: number, max: number, unit = 'mm') => {
    if (!Number.isFinite(v) || v < min || v > max) p.push({ path, message: `Informe um valor entre ${min} e ${max} ${unit}.` });
  };
  if (l.name.trim().length < 2) p.push({ path: 'name', message: 'Informe o nome do layout.' });
  range('widthMm', l.widthMm, 20, 120);
  range('heightMm', l.heightMm, 10, 120);
  range('marginMm', l.marginMm, 0, 10);
  range('barHeightMm', l.barHeightMm, 4, 40);
  if (!(LABEL_DPI as readonly number[]).includes(l.dpi)) p.push({ path: 'dpi', message: 'Resolução aceita: 203, 300 ou 600 dpi.' });
  const wrong = l.fields.filter((f) => !LABEL_FIELDS[f]?.entities.includes(l.entity));
  if (wrong.length) p.push({ path: 'fields', message: `Campos que não se aplicam a ${LABEL_ENTITY_LABEL[l.entity].toLowerCase()}: ${wrong.map((f) => LABEL_FIELDS[f]?.label ?? f).join(', ')}.` });
  if (new Set(l.fields).size !== l.fields.length) p.push({ path: 'fields', message: 'Campo repetido.' });
  if (l.entity === 'pacote' && !l.fields.includes('validade')) p.push({ path: 'fields', message: 'A etiqueta do pacote estéril precisa mostrar a validade.' });
  if (p.length) return p;
  const need = labelNeededHeight(l);
  if (need > l.heightMm + 1e-9) p.push({ path: 'heightMm', message: `Os campos escolhidos precisam de ${need.toFixed(1)} mm de altura: aumente a altura, reduza as barras ou retire campos.` });
  const fit = barcodeFit(l, LABEL_SAMPLE_CODE[l.entity]);
  if (fit.problem) p.push({ path: 'widthMm', message: fit.problem });
  return p;
}

export interface LabelLine { field: LabelField; text: string; strong?: boolean }

/** Problems that prevent printing this content with this layout. */
export function labelContentProblems(l: LabelLayoutInput, c: LabelContent): string[] {
  const p: string[] = [];
  if (l.entity !== c.entity) p.push(`O layout é de ${LABEL_ENTITY_LABEL[l.entity].toLowerCase()}.`);
  const codeProblem = code128Problem(c.code);
  if (codeProblem) p.push(codeProblem);
  else {
    const fit = barcodeFit(l, c.code);
    if (fit.problem) p.push(fit.problem);
  }
  if (l.fields.includes('validade') && !c.expiresOn) p.push(`O pacote ${c.code} não tem validade definida: confira o prazo de validade da embalagem antes de imprimir.`);
  return p;
}

/** Field lines in layout order (the code and the material are always printed). */
export function labelLines(l: Pick<LabelLayoutInput, 'fields'>, c: LabelContent): LabelLine[] {
  const out: LabelLine[] = [];
  const v = (x: string | null | undefined) => (x && x.trim() ? x : '—');
  for (const f of l.fields) {
    const s = LABEL_FIELDS[f].short;
    switch (f) {
      case 'processamento': out.push({ field: f, text: `${s} ${formatDate(c.processedOn)}` }); break;
      case 'validade': out.push({ field: f, text: `${s} ${formatDate(c.expiresOn)}`, strong: true }); break;
      case 'lote': out.push({ field: f, text: `${s} ${v(c.lot)}` }); break;
      case 'equipamento': out.push({ field: f, text: `${s} ${v(c.equipment)}` }); break;
      case 'liberacao': out.push({ field: f, text: `${s}: ${v(c.release)}` }); break;
      case 'embalagem': out.push({ field: f, text: `${s} ${v(c.packaging)}` }); break;
      case 'implante': if (c.implant) out.push({ field: f, text: s, strong: true }); break;
      case 'conjunto': out.push({ field: f, text: `${s} ${v(c.setName)}` }); break;
      case 'identificacao': out.push({ field: f, text: `${s} ${v(c.tag)}` }); break;
    }
  }
  return out;
}

/** Text safe for a ZPL ^FD field under ^FH: control characters and non-ASCII go as hex bytes. */
export function zplText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c < 127 && ch !== '^' && ch !== '~' && ch !== '_') out += ch;
    else if (c >= 32 && c < 128) out += `_${c.toString(16).toUpperCase().padStart(2, '0')}`;
    else if (c >= 128) out += encodeURIComponent(ch).replace(/%/g, '_');
  }
  return out;
}

/** Fits a single line of the scalable font in the width (approximate average glyph width). */
const fitText = (s: string, widthDots: number, heightDots: number) => {
  const max = Math.max(4, Math.floor(widthDots / (heightDots * 0.6)));
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
};

/**
 * ZPL II for one label: UTF-8 (^CI28), size in dots, the barcode with the same subset sequence as the
 * SVG (explicit start/switch codes, so the printer encodes exactly what was checked) and text fields.
 * Sending it to the printer needs a print service or local agent (infrastructure).
 */
export function labelZpl(l: LabelLayoutInput, c: LabelContent): string {
  const dpm = dotsPerMm(l.dpi);
  const d = (mm: number) => Math.round(mm * dpm);
  const fit = barcodeFit(l, c.code);
  const widthDots = d(l.widthMm);
  const x = d(l.marginMm);
  const textWidth = widthDots - 2 * x;
  const line = (y: number, h: number, text: string) => `^FO${x},${y}^A0N,${h},${h}^FB${textWidth},1,0,L,0^FH_^FD${zplText(fitText(text, textWidth, h))}^FS`;
  const out = ['^XA', '^CI28', `^PW${widthDots}`, `^LL${d(l.heightMm)}`, '^LH0,0'];
  let y = d(l.marginMm);
  out.push(line(y, d(LABEL_TYPE.title), c.material));
  y += d(LABEL_TYPE.titleLine);
  const symbolDots = code128Width(c.code) * fit.moduleDots;
  const barX = Math.max(0, Math.floor((widthDots - symbolDots) / 2)) + QUIET_ZONE_MODULES * fit.moduleDots;
  const data = code128Segments(c.code).map((seg, k) => {
    const start = k === 0 ? (seg.subset === 'C' ? '>;' : '>:') : seg.subset === 'C' ? '>5' : '>6';
    return start + (seg.subset === 'B' ? seg.data.replace(/>/g, '><') : seg.data);
  }).join('');
  out.push(`^FO${barX},${y}^BY${fit.moduleDots}^BCN,${d(l.barHeightMm)},N,N,N,N^FH_^FD${zplText(data)}^FS`);
  y += d(l.barHeightMm + LABEL_TYPE.gap);
  out.push(`^FO${x},${y}^A0N,${d(LABEL_TYPE.code)},${d(LABEL_TYPE.code)}^FB${textWidth},1,0,C,0^FH_^FD${zplText(c.code)}^FS`);
  y += d(LABEL_TYPE.codeLine);
  for (const ln of labelLines(l, c)) {
    out.push(line(y, d(LABEL_TYPE.line), ln.text));
    y += d(LABEL_TYPE.lineStep);
  }
  out.push('^PQ1', '^XZ');
  return out.join('\n');
}

/** Why a label cannot be printed for this record (null when it can). */
export function labelPrintRefusal(f: { entity: LabelEntity; loadStatus?: LoadStatus | null; assetStatus?: 'ativo' | 'manutencao' | 'baixado' | null; processClosed?: boolean }): string | null {
  if (f.entity === 'pacote' && (f.loadStatus === 'rejeitada' || f.loadStatus === 'reprocessamento')) return 'Carga rejeitada ou em reprocessamento: o material volta ao fluxo e recebe nova etiqueta na nova carga.';
  if (f.entity === 'ativo' && f.assetStatus === 'baixado') return 'Ativo baixado: não recebe etiqueta.';
  if (f.entity === 'processo' && f.processClosed) return 'Processo encerrado: a etiqueta de recepção não é mais usada.';
  return null;
}

export type LabelPrintKind = 'impressao' | 'reimpressao';
export type LabelPrintStatus = 'ativa' | 'cancelada' | 'substituida';
export const LABEL_PRINT_STATUS_LABEL: Record<LabelPrintStatus, string> = { ativa: 'Ativa', cancelada: 'Cancelada', substituida: 'Substituída' };
export const LABEL_PRINT_KIND_LABEL: Record<LabelPrintKind, string> = { impressao: 'Impressão', reimpressao: 'Reimpressão' };

export interface LabelPrintDto {
  id: string;
  entity: LabelEntity;
  entityId: string;
  code: string;
  kind: LabelPrintKind;
  output: LabelOutput;
  reason: string | null;
  layoutName: string;
  printedAt: string;
  printedBy: string;
  status: LabelPrintStatus;
  replacedById: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
}

/** A printed label is replaced by a reprint or cancelled; otherwise it is the one in use. */
export const labelPrintStatus = (p: { replacedById: string | null; cancelledAt: string | null }): LabelPrintStatus =>
  p.cancelledAt ? 'cancelada' : p.replacedById ? 'substituida' : 'ativa';

/** One printed label returned to the screen: the layout used and the content as printed. */
export interface PrintedLabel { printId: string; layout: LabelLayoutInput; content: LabelContent }
