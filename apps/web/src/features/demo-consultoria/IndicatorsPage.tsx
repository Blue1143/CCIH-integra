import { useId, useState } from 'react';
import {
  DEVICE_DENSITY_IDS, DEVICE_INDICATOR_IDS, compareWithPrevious, describeComputation, describeGaps, formatNumber, formatSigned, formatValue, getIndicator, indicatorView, indicatorViews,
  ruleSummary, roundTrend, type DemoConsultingState, type DemoFilter, type IndicatorView, type MonthPoint,
} from '@ccih/domain';
import { Button, Card, DataTable, StatusBadge, TrendChart, type Column } from '@ccih/ui';
import { useDemoState } from './store';
import { useDemoFilters } from './filters';
import { DENSITY_COLORS, FictitiousTargetTag, IndicatorCard, InstitutionLink, RuleSummaryView, SectionCard, chartGapNote, trendSeries } from './parts';

export function DemoIndicatorsPage() {
  const state = useDemoState();
  const [filter] = useDemoFilters(state);
  const views = indicatorViews(state, filter);
  const densities = views.filter((v) => (DEVICE_DENSITY_IDS as readonly string[]).includes(v.id));
  const usage = views.filter((v) => !(DEVICE_DENSITY_IDS as readonly string[]).includes(v.id));
  const labels = views[0]!.series.map((p) => p.label);
  const range = `${labels[0]} – ${labels[labels.length - 1]}`;
  return (
    <>
      <Card title="Como os indicadores são calculados" headingLevel={2}>
        <p className="ig-small" style={{ margin: 0 }}>
          Cálculo determinístico pelo motor de indicadores do sistema (sem inteligência artificial): as contagens de todas as unidades e meses do filtro são somadas e a taxa é calculada uma única vez — nunca a média das taxas mensais.
          Denominador zero não vira 0: a taxa fica sem valor. Mês sem registro aparece como dado ausente. As metas exibidas são <FictitiousTargetTag />, criadas só para esta demonstração e não atribuídas à Anvisa nem a outra entidade.
        </p>
      </Card>

      {filter.institutionId ? null : <PortfolioComparison state={state} filter={filter} />}

      <section aria-labelledby="h-dens">
        <h2 id="h-dens" className="section-title">Densidade de incidência{filter.institutionId ? '' : ' — carteira somada'}</h2>
        <div className="demo-ind-grid">{densities.map((v) => <IndicatorCard key={v.id} view={v} state={state} />)}</div>
      </section>
      <section aria-labelledby="h-uso">
        <h2 id="h-uso" className="section-title">Utilização de dispositivos</h2>
        <div className="demo-ind-grid">{usage.map((v) => <IndicatorCard key={v.id} view={v} state={state} />)}</div>
      </section>

      <div className="cols-2">
        <TrendChart title="Densidade de incidência por mês" description="Casos por 1.000 dispositivos-dia" period={range} unit="‰" labels={labels} series={trendSeries(densities, DENSITY_COLORS)} footnote={chartGapNote(densities) ?? 'Todos os meses com valor calculado.'} />
        <TrendChart title="Utilização de dispositivos por mês" description="Dispositivo-dia por 100 pacientes-dia" period={range} unit="%" labels={labels} series={trendSeries(usage, DENSITY_COLORS)} footnote={chartGapNote(usage) ?? 'Todos os meses com valor calculado.'} />
      </div>

      <MonthTable state={state} filter={filter} />
      <SummaryPanel state={state} filter={filter} />
    </>
  );
}

function PortfolioComparison({ state, filter }: { state: DemoConsultingState; filter: DemoFilter }) {
  type Row = { id: string; name: string; views: IndicatorView[] };
  const rows: Row[] = state.institutions.map((i) => ({ id: i.id, name: i.name, views: DEVICE_DENSITY_IDS.map((id) => indicatorView(state, { ...filter, institutionId: i.id, unitId: null }, id)) }));
  const cols: Column<Row>[] = [
    { key: 'name', label: 'Instituição', render: (r) => <InstitutionLink state={state} f={filter} id={r.id} /> },
    ...DEVICE_DENSITY_IDS.map((id, k): Column<Row> => ({
      key: id, label: `${getIndicator(id).shortName} (‰)`, align: 'right', value: (r) => r.views[k]!.current.result.value,
      render: (r) => {
        const v = r.views[k]!;
        return <span className="demo-cell"><b>{formatValue(v.def, v.current.result)}</b><span className="ig-small ig-muted">{describeComputation(v.def, v.current.result)}</span><StatusBadge status={v.evaluation.status}>{v.evaluation.label}</StatusBadge></span>;
      },
    })),
  ];
  return (
    <SectionCard title="Comparação entre as instituições" subtitle="Cada instituição com suas próprias contagens. Escolha uma instituição no filtro para ver o detalhe.">
      <DataTable caption="Densidades por instituição" columns={cols} rows={rows} rowKey={(r) => r.id} dense />
    </SectionCard>
  );
}

type MonthRow = MonthPoint & { delta: number | null; improved: boolean | null };

function MonthTable({ state, filter }: { state: DemoConsultingState; filter: DemoFilter }) {
  const [indicator, setIndicator] = useState<string>('di-ipcs');
  const id = useId();
  const view = indicatorView(state, filter, indicator);
  const { def } = view;
  const rows: MonthRow[] = view.series.map((p, i) => {
    const prev = i ? view.series[i - 1]!.result.value : null;
    const t = roundTrend(compareWithPrevious(p.result.value, prev, def.direction), def.decimals);
    return { ...p, delta: t.delta, improved: t.improved };
  });
  const cols: Column<MonthRow>[] = [
    { key: 'label', label: 'Mês' },
    { key: 'num', label: def.numerator.label, align: 'right', value: (r) => r.result.numerator, render: (r) => formatNumber(r.result.numerator) },
    { key: 'den', label: def.denominator?.label ?? 'Denominador', align: 'right', value: (r) => r.result.denominator, render: (r) => formatNumber(r.result.denominator) },
    { key: 'val', label: `Valor (${def.unit})`, align: 'right', value: (r) => r.result.value, render: (r) => (r.result.value != null ? formatNumber(r.result.value, def.decimals) : r.result.kind === 'denominador_zero' ? 'Denominador zero' : 'Sem dado') },
    { key: 'delta', label: 'Variação vs mês anterior', align: 'right', value: (r) => r.delta, render: (r) => (r.delta != null ? `${formatSigned(r.delta, def.decimals)} (${r.improved == null ? 'estável' : r.improved ? 'melhora' : 'piora'})` : '—') },
    { key: 'obs', label: 'Observação', value: (r) => describeGaps(state, r.gaps).join('; '), render: (r) => (r.gaps.length ? `Sem registro: ${describeGaps(state, r.gaps).join('; ')}` : '') },
  ];
  return (
    <SectionCard title="Comparação mês a mês" subtitle={`${view.formula} · unidade ${def.unit}. Cada mês usa o próprio numerador e denominador; a variação só é calculada quando os dois meses têm valor.`}
      actions={
        <div className="field">
          <label htmlFor={id}>Indicador</label>
          <select id={id} className="select" value={indicator} onChange={(e) => setIndicator(e.target.value)}>
            {DEVICE_INDICATOR_IDS.map((x) => <option key={x} value={x}>{getIndicator(x).name}</option>)}
          </select>
        </div>
      }>
      <DataTable caption={`Mês a mês — ${def.name}`} columns={cols} rows={rows} rowKey={(r) => r.period} dense />
    </SectionCard>
  );
}

/** Summary of the selected data for professional review, made by rules (there is no AI integration). */
function SummaryPanel({ state, filter }: { state: DemoConsultingState; filter: DemoFilter }) {
  const [open, setOpen] = useState(false);
  return (
    <SectionCard title="Resumo dos dados selecionados" subtitle="Para revisão profissional. Gerado por regras a partir dos mesmos números exibidos acima."
      actions={<Button icon={open ? 'close' : 'eye'} onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Ocultar resumo' : 'Gerar resumo por regras'}</Button>}>
      {open ? <RuleSummaryView summary={ruleSummary(state, filter)} /> : <p className="ig-small ig-muted" style={{ margin: 0 }}>O projeto não tem integração com inteligência artificial; este resumo é um modelo de texto preenchido por regras e é identificado assim.</p>}
    </SectionCard>
  );
}
