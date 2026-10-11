/**
 * Code 128 (ISO/IEC 15417) without dependencies: values, bar modules, SVG and a decoder used to check
 * every generated symbol before it is printed. Only printable ASCII (32–126) is encoded, through
 * subsets B and C (runs of digits are packed in pairs to keep the symbol short).
 */

/** Bar/space widths of the 107 symbols (0–105; 106 is the stop, with its final bar). */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const START_C = 105;
const TO_C = 99;
const TO_B = 100;
const STOP = 106;
/** Quiet zone required on each side, in modules. */
export const QUIET_ZONE_MODULES = 10;

export type Code128Subset = 'B' | 'C';
export interface Code128Segment { subset: Code128Subset; data: string }

/** Why a text cannot be encoded (null when it can). */
export function code128Problem(text: string): string | null {
  if (!text) return 'Código vazio.';
  if (text.length > 80) return 'Código longo demais para Code 128.';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) return `Caractere não aceito no Code 128: "${ch}".`;
  }
  return null;
}

const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';
function digitRun(text: string, from: number) {
  let n = 0;
  while (isDigit(text[from + n])) n++;
  return n;
}

/**
 * Splits the text into subset segments: C for runs of at least 4 digits at the start or end (or the
 * whole text) and of at least 6 in the middle; B elsewhere. An odd run leaves its first digit in B.
 */
export function code128Segments(text: string): Code128Segment[] {
  const problem = code128Problem(text);
  if (problem) throw new Error(problem);
  const out: Code128Segment[] = [];
  const push = (subset: Code128Subset, s: string) => {
    const last = out[out.length - 1];
    if (last && last.subset === subset) last.data += s;
    else out.push({ subset, data: s });
  };
  let i = 0;
  while (i < text.length) {
    const run = digitRun(text, i);
    const atStart = i === 0;
    const atEnd = i + run === text.length;
    const worth = run === text.length ? run === 2 || run >= 4 : run >= (atStart || atEnd ? 4 : 6);
    if (worth) {
      let r = run;
      if (r % 2 === 1) {
        // The odd digit goes in B: before the run in the middle/end, after it at the start.
        if (atStart) {
          push('C', text.slice(i, i + r - 1));
          i += r - 1;
          continue;
        }
        push('B', text[i]!);
        i++;
        r--;
      }
      push('C', text.slice(i, i + r));
      i += r;
    } else {
      push('B', text.slice(i, i + Math.max(run, 1)));
      i += Math.max(run, 1);
    }
  }
  return out;
}

/** Symbol values: start, data (with subset switches), check symbol and stop. */
export function code128Values(text: string): number[] {
  const segments = code128Segments(text);
  const values: number[] = [];
  segments.forEach((seg, k) => {
    if (k === 0) values.push(seg.subset === 'C' ? START_C : START_B);
    else values.push(seg.subset === 'C' ? TO_C : TO_B);
    if (seg.subset === 'C') for (let j = 0; j < seg.data.length; j += 2) values.push(Number(seg.data.slice(j, j + 2)));
    else for (const ch of seg.data) values.push(ch.charCodeAt(0) - 32);
  });
  const check = values.reduce((sum, v, idx) => sum + v * Math.max(idx, 1), 0) % 103;
  values.push(check, STOP);
  return values;
}

/** Bars as modules (true = dark), without the quiet zones. */
export function code128Modules(text: string): boolean[] {
  const out: boolean[] = [];
  for (const v of code128Values(text)) {
    PATTERNS[v]!.split('').forEach((w, idx) => {
      for (let n = 0; n < Number(w); n++) out.push(idx % 2 === 0);
    });
  }
  return out;
}

/** Width of the symbol in modules, quiet zones included. */
export const code128Width = (text: string) => code128Modules(text).length + 2 * QUIET_ZONE_MODULES;

/**
 * Reads modules back into text (quiet zones allowed). Checks the start, every pattern, the check symbol
 * and the stop; returns null when anything fails. Used to verify a symbol before it is printed.
 */
export function decodeCode128(modules: boolean[]): string | null {
  let a = 0;
  let b = modules.length;
  while (a < b && !modules[a]) a++;
  while (b > a && !modules[b - 1]) b--;
  const bars = modules.slice(a, b);
  if (bars.length < 35 || (bars.length - 13) % 11 !== 0) return null;
  const widths = (from: number, count: number) => {
    let s = '';
    let i = from;
    for (let e = 0; e < count; e++) {
      const dark = e % 2 === 0;
      let w = 0;
      while (i < from + (count === 6 ? 11 : 13) && bars[i] === dark) { w++; i++; }
      if (w === 0 || w > 4) return null;
      s += String(w);
    }
    return i === from + (count === 6 ? 11 : 13) ? s : null;
  };
  const n = (bars.length - 13) / 11;
  const values: number[] = [];
  for (let k = 0; k < n; k++) {
    const w = widths(k * 11, 6);
    const v = w === null ? -1 : PATTERNS.indexOf(w);
    if (v < 0 || v > 105) return null;
    values.push(v);
  }
  if (widths(n * 11, 7) !== PATTERNS[STOP]) return null;
  if (values.length < 2) return null;
  const check = values.pop()!;
  if (values.reduce((sum, v, idx) => sum + v * Math.max(idx, 1), 0) % 103 !== check) return null;
  let subset: Code128Subset;
  if (values[0] === START_B) subset = 'B';
  else if (values[0] === START_C) subset = 'C';
  else return null;
  let text = '';
  for (const v of values.slice(1)) {
    if (subset === 'C') {
      if (v < 100) text += String(v).padStart(2, '0');
      else if (v === TO_B) subset = 'B';
      else return null;
    } else if (v < 95) text += String.fromCharCode(v + 32);
    else if (v === TO_C) subset = 'C';
    else return null;
  }
  return text;
}

export interface BarcodeSvgOptions {
  /** Module width in millimetres (the SVG is sized in mm for printing). */
  moduleMm: number;
  heightMm: number;
}

/** Dark bars as runs (x and width in modules, quiet zone included) and the total width in modules. */
export function code128Bars(text: string): { total: number; bars: Array<{ x: number; w: number }> } {
  const modules = code128Modules(text);
  const bars: Array<{ x: number; w: number }> = [];
  let i = 0;
  while (i < modules.length) {
    if (!modules[i]) { i++; continue; }
    let w = 0;
    while (modules[i + w]) w++;
    bars.push({ x: i + QUIET_ZONE_MODULES, w });
    i += w;
  }
  return { total: modules.length + 2 * QUIET_ZONE_MODULES, bars };
}

/** SVG of the symbol with its quiet zones, sized in millimetres; adjacent dark modules are merged. */
export function code128Svg(text: string, o: BarcodeSvgOptions): string {
  const { total, bars } = code128Bars(text);
  const rects = bars.map((b) => `<rect x="${b.x}" y="0" width="${b.w}" height="1"/>`);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r(total * o.moduleMm)}mm" height="${r(o.heightMm)}mm" viewBox="0 0 ${total} 1" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Código de barras ${escapeXml(text)}" data-code="${escapeXml(text)}"><rect width="${total}" height="1" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
}

/** Reads back the modules of an SVG produced by {@link code128Svg} (automatic check of the image). */
export function modulesFromSvg(svg: string): boolean[] {
  const total = Number(/viewBox="0 0 (\d+) 1"/.exec(svg)?.[1] ?? 0);
  const modules = new Array<boolean>(total).fill(false);
  const g = /<g fill="#000">(.*)<\/g>/.exec(svg)?.[1] ?? '';
  for (const m of g.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="1"\/>/g)) {
    for (let k = 0; k < Number(m[2]); k++) modules[Number(m[1]) + k] = true;
  }
  return modules;
}

export const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
