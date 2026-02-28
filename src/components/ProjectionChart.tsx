import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTheme } from '@mui/material/styles';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type { ProjectionPoint } from '../types';

const GREEN = '#22C55E';
const RED = '#EF4444';
const POLY_BLUE = '#4A90D9';
const BYBIT_ORANGE = '#FF8C00';

// Dash patterns for combined curves: [Now=solid, 1/3=short, 2/3=medium, Expiry=long]
const COMBINED_DASH = ['', '4 3', '8 5', '14 6'];
const COMBINED_WIDTHS = [2, 1.5, 2, 2.5];
const COMBINED_OPACITIES = [1, 0.45, 0.7, 1];

interface ProjectionChartProps {
  // Combined curves (green/red split)
  combinedCurves: ProjectionPoint[][];
  combinedLabels: string[];
  // Polymarket overlay (blue)
  polyNowCurve?: ProjectionPoint[];
  polyExpiryCurve?: ProjectionPoint[];
  // Bybit overlay (orange)
  bybitNowCurve?: ProjectionPoint[];
  bybitExpiryCurve?: ProjectionPoint[];
  bybitMMNowCurve?: ProjectionPoint[]; // maintenance margin for short positions
  currentCryptoPrice: number;
  cryptoSymbol: string;
  totalEntryCost?: number;
  polyAtBybitExpiryCurve?: ProjectionPoint[];
  polyEntryCost?: number;
  bybitEntryCost?: number;
}

interface ChartDataRow {
  cryptoPrice: number;
  [key: string]: number;
}

const CHART_MARGIN = { top: 20, right: 60, bottom: 50, left: 20 };
const ACTIVE_DOT = { r: 4 };

/** Adaptive tick intervals: ~11 labeled major ticks at 1100px chart width, scales with actual width. */
function getAdaptiveTickIntervals(range: number, chartWidth: number): { major: number; minor: number } {
  const TARGET_TICKS_1100 = 11;
  const targetTicks = Math.max(4, Math.round(TARGET_TICKS_1100 * chartWidth / 1100));
  if (range <= 0) return { major: 1000, minor: 200 };
  const rawMajor = range / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMajor)));
  let bestMajor = magnitude;
  let bestDiff = Infinity;
  for (const n of [1, 2, 5, 10]) {
    const candidate = n * magnitude;
    const diff = Math.abs(range / candidate - targetTicks);
    if (diff < bestDiff) { bestDiff = diff; bestMajor = candidate; }
  }
  return { major: bestMajor, minor: bestMajor / 5 };
}

function formatPct(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}


function CustomXTick(props: {
  x: number;
  y: number;
  payload: { value: number };
  majorInterval: number;
  minorInterval: number;
  tickColor: string;
  tickColorFaded: string;
}) {
  const { x, y, payload, majorInterval, tickColor, tickColorFaded } = props;
  const value = payload.value;
  const isMajor = value % majorInterval === 0;

  if (isMajor) {
    return (
      <g transform={`translate(${x},${y})`}>
        <line y1={0} y2={8} stroke={tickColor} strokeWidth={1} />
        <text y={22} textAnchor="middle" fill={tickColor} fontSize={13} fontFamily="JetBrains Mono, monospace">
          ${value.toLocaleString()}
        </text>
      </g>
    );
  }

  return (
    <g transform={`translate(${x},${y})`}>
      <line y1={0} y2={4} stroke={tickColorFaded} strokeWidth={1} />
    </g>
  );
}

// All line keys for the chart
const POLY_NOW = 'Poly Now';
const POLY_EXPIRY = 'Poly Expiry';
const POLY_OPTION_EXPIRY = 'Poly Option Expiry';
const BYBIT_NOW = 'Bybit Now';
const BYBIT_EXPIRY = 'Bybit Expiry';

interface LineStyle {
  color: string;
  secondColor?: string;
  dash?: string;
  width: number;
  opacity: number;
}

function TooltipLineSample({ style, pnlColor }: { style: LineStyle; pnlColor?: string }) {
  const w = 20;
  const h = style.width + 2;
  const y = h / 2;
  if (style.secondColor && pnlColor) {
    // For combined curves, show the actual pnl color (green or red)
    return (
      <svg width={w} height={h} style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }}>
        <line x1={0} y1={y} x2={w} y2={y}
          stroke={pnlColor} strokeWidth={style.width} strokeDasharray={style.dash} />
      </svg>
    );
  }
  return (
    <svg width={w} height={h} style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }}>
      <line x1={0} y1={y} x2={w} y2={y}
        stroke={style.color} strokeWidth={style.width} strokeDasharray={style.dash} strokeOpacity={style.opacity} />
    </svg>
  );
}

function CustomTooltipContent({
  active,
  payload,
  combinedLabels,
  cryptoSymbol,
  hiddenLines,
  currentCryptoPrice,
  tooltipBg,
  tooltipBorder,
  secondaryColor,
  hasPolyOverlay,
  hasPolyAtBybitExpiry,
  hasBybitOverlay,
  lineStyles,
  totalEntryCost,
  polyEntryCost,
  bybitEntryCost,
  hasMMCurve,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  label?: number;
  combinedLabels: string[];
  cryptoSymbol: string;
  hiddenLines: Set<string>;
  currentCryptoPrice: number;
  tooltipBg: string;
  tooltipBorder: string;
  secondaryColor: string;
  hasPolyOverlay: boolean;
  hasPolyAtBybitExpiry: boolean;
  hasBybitOverlay: boolean;
  lineStyles: Map<string, LineStyle>;
  totalEntryCost?: number;
  polyEntryCost?: number;
  bybitEntryCost?: number;
  hasMMCurve?: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const cryptoPrice = payload[0]?.payload?.cryptoPrice;
  if (cryptoPrice == null) return null;

  const pricePct = ((cryptoPrice - currentCryptoPrice) / currentCryptoPrice) * 100;

  // Collect values from payload
  const valueMap = new Map<string, number>();
  for (const entry of payload) {
    const name = entry.name as string;
    if (name && entry.value != null) {
      const baseName = name.replace(/__pos$|__neg$/, '');
      valueMap.set(baseName, entry.value);
    }
  }

  const absCost = Math.abs(totalEntryCost ?? 0);
  const absPolyCost = Math.abs(polyEntryCost ?? 0);
  const absBybitCost = Math.abs(bybitEntryCost ?? 0);

  // Compute absolute P&L as % of entry cost
  function absPct(pnl: number): string {
    if (absCost <= 0) return '';
    const pct = (pnl / absCost) * 100;
    const sign = pct >= 0 ? '+' : '';
    return ` (${sign}${pct.toFixed(1)}%)`;
  }
  function polyPct(pnl: number): string {
    if (absPolyCost <= 0) return '';
    const pct = (pnl / absPolyCost) * 100;
    const sign = pct >= 0 ? '+' : '';
    return ` (${sign}${pct.toFixed(1)}%)`;
  }
  function bybitPct(pnl: number): string {
    if (absBybitCost <= 0) return '';
    const pct = (pnl / absBybitCost) * 100;
    const sign = pct >= 0 ? '+' : '';
    return ` (${sign}${pct.toFixed(1)}%)`;
  }

  const renderRow = (label: string, pnl: number, textColor: string, style: LineStyle | undefined, pnlColor?: string, suffix?: string) => {
    const pnlSign = pnl >= 0 ? '+' : '';
    return (
      <div key={label} style={{ display: 'flex', alignItems: 'center', fontSize: 14, padding: '2px 0' }}>
        {style && <TooltipLineSample style={style} pnlColor={pnlColor} />}
        <span style={{ color: textColor }}>{label}: {pnlSign}{pnl.toFixed(2)}{suffix ?? ''}</span>
      </div>
    );
  };

  return (
    <div style={{
      backgroundColor: tooltipBg,
      border: `1px solid ${tooltipBorder}`,
      borderRadius: 8,
      padding: '10px 14px',
      maxWidth: 500,
    }}>
      <div style={{ color: secondaryColor, marginBottom: 6, fontSize: 15 }}>
        {cryptoSymbol}: ${cryptoPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({formatPct(pricePct)})
      </div>

      {/* Combined curves — all show absolute % */}
      {combinedLabels.map((label) => {
        if (hiddenLines.has(label)) return null;
        const pnl = valueMap.get(label);
        if (pnl == null) return null;
        const color = pnl >= 0 ? GREEN : RED;
        return renderRow(label, pnl, color, lineStyles.get(label), color, absPct(pnl));
      })}

      {/* Poly overlay — use poly entry cost for % */}
      {hasPolyOverlay && (
        <>
          {!hiddenLines.has(POLY_NOW) && valueMap.has(POLY_NOW) &&
            renderRow(POLY_NOW, valueMap.get(POLY_NOW)!, POLY_BLUE, lineStyles.get(POLY_NOW), undefined, polyPct(valueMap.get(POLY_NOW)!))}
          {!hiddenLines.has(POLY_EXPIRY) && valueMap.has(POLY_EXPIRY) &&
            renderRow(POLY_EXPIRY, valueMap.get(POLY_EXPIRY)!, POLY_BLUE, lineStyles.get(POLY_EXPIRY), undefined, polyPct(valueMap.get(POLY_EXPIRY)!))}
          {hasPolyAtBybitExpiry && !hiddenLines.has(POLY_OPTION_EXPIRY) && valueMap.has(POLY_OPTION_EXPIRY) &&
            renderRow(POLY_OPTION_EXPIRY, valueMap.get(POLY_OPTION_EXPIRY)!, POLY_BLUE, lineStyles.get(POLY_OPTION_EXPIRY), undefined, polyPct(valueMap.get(POLY_OPTION_EXPIRY)!))}
        </>
      )}

      {/* Bybit overlay — use bybit entry cost for % */}
      {hasBybitOverlay && (
        <>
          {!hiddenLines.has(BYBIT_NOW) && valueMap.has(BYBIT_NOW) &&
            renderRow(BYBIT_NOW, valueMap.get(BYBIT_NOW)!, BYBIT_ORANGE, lineStyles.get(BYBIT_NOW), undefined, bybitPct(valueMap.get(BYBIT_NOW)!))}
          {!hiddenLines.has(BYBIT_EXPIRY) && valueMap.has(BYBIT_EXPIRY) &&
            renderRow(BYBIT_EXPIRY, valueMap.get(BYBIT_EXPIRY)!, BYBIT_ORANGE, lineStyles.get(BYBIT_EXPIRY), undefined, bybitPct(valueMap.get(BYBIT_EXPIRY)!))}
          {hasMMCurve && valueMap.has('__bybit_mm') && (valueMap.get('__bybit_mm')! > 0) && (
            <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, padding: '2px 0', color: '#F59E0B' }}>
              <span style={{ marginRight: 6, opacity: 0.7 }}>▲</span>
              <span>Portfolio Margin: ${valueMap.get('__bybit_mm')!.toFixed(2)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ProjectionChart({
  combinedCurves,
  combinedLabels,
  polyNowCurve,
  polyExpiryCurve,
  bybitNowCurve,
  bybitExpiryCurve,
  bybitMMNowCurve,
  polyAtBybitExpiryCurve,
  polyEntryCost,
  bybitEntryCost,
  currentCryptoPrice,
  cryptoSymbol,
  totalEntryCost,
}: ProjectionChartProps) {
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';
  const axisColor = isDark ? '#8B9DC3' : '#5A6A85';
  const gridColor = isDark ? 'rgba(139, 157, 195, 0.1)' : 'rgba(0, 0, 0, 0.08)';
  const refLineColor = isDark ? 'rgba(139, 157, 195, 0.5)' : 'rgba(0, 0, 0, 0.2)';
  const zeroLineColor = isDark ? 'rgba(139, 157, 195, 0.6)' : 'rgba(0, 0, 0, 0.25)';
  const tickColorFaded = isDark ? 'rgba(139, 157, 195, 0.3)' : 'rgba(0, 0, 0, 0.15)';
  const tooltipBg = isDark ? 'rgba(19, 26, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)';
  const tooltipBorder = isDark ? 'rgba(139, 157, 195, 0.3)' : 'rgba(0, 0, 0, 0.12)';
  const legendColor = isDark ? '#8B9DC3' : '#5A6A85';

  const [hiddenLines, setHiddenLines] = useState<Set<string>>(new Set());
  const [chartWidth, setChartWidth] = useState(1100);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => setChartWidth(entries[0].contentRect.width));
    ro.observe(el);
    setChartWidth(el.clientWidth || 1100);
    return () => ro.disconnect();
  }, []);

  const hasPolyOverlay = (polyNowCurve && polyNowCurve.length > 0) || false;
  const hasBybitOverlay = (bybitNowCurve && bybitNowCurve.length > 0) || false;
  const hasPolyAtBybitExpiry = (polyAtBybitExpiryCurve && polyAtBybitExpiryCurve.length > 0) || false;
  const hasMMCurve = (bybitMMNowCurve && bybitMMNowCurve.length > 0) || false;

  const chartData = useMemo(() => {
    if (combinedCurves.length === 0 || combinedCurves[0].length === 0) return [];

    const data = combinedCurves[0].map((point, i) => {
      const row: ChartDataRow = { cryptoPrice: point.cryptoPrice };

      // Combined curves: split green/red — skip hidden curves so Recharts
      // cannot use their extreme values to override the explicit yDomain.
      for (let c = 0; c < combinedCurves.length; c++) {
        if (hiddenLines.has(combinedLabels[c])) continue;
        if (combinedCurves[c][i]) {
          const pnl = combinedCurves[c][i].pnl;
          if (pnl >= 0) {
            row[`${combinedLabels[c]}__pos`] = pnl;
          } else {
            row[`${combinedLabels[c]}__neg`] = pnl;
          }
        }
      }

      // Poly overlay (solid color, no split) — skip if hidden
      if (!hiddenLines.has(POLY_NOW) && polyNowCurve?.[i]) row[POLY_NOW] = polyNowCurve[i].pnl;
      if (!hiddenLines.has(POLY_EXPIRY) && polyExpiryCurve?.[i]) row[POLY_EXPIRY] = polyExpiryCurve[i].pnl;
      if (hasPolyAtBybitExpiry && !hiddenLines.has(POLY_OPTION_EXPIRY) && polyAtBybitExpiryCurve?.[i]) row[POLY_OPTION_EXPIRY] = polyAtBybitExpiryCurve[i].pnl;

      // Bybit overlay — skip if hidden
      if (!hiddenLines.has(BYBIT_NOW) && bybitNowCurve?.[i]) row[BYBIT_NOW] = bybitNowCurve[i].pnl;
      if (!hiddenLines.has(BYBIT_EXPIRY) && bybitExpiryCurve?.[i]) row[BYBIT_EXPIRY] = bybitExpiryCurve[i].pnl;
      if (hasMMCurve && bybitMMNowCurve?.[i]) row['__bybit_mm'] = bybitMMNowCurve[i].pnl;

      return row;
    });

    // Bridge sign changes for visible combined curves only
    for (let i = 0; i < data.length - 1; i++) {
      for (let c = 0; c < combinedCurves.length; c++) {
        if (hiddenLines.has(combinedLabels[c])) continue;
        const posKey = `${combinedLabels[c]}__pos`;
        const negKey = `${combinedLabels[c]}__neg`;
        const hasPosNow = posKey in data[i];
        const hasPosNext = posKey in data[i + 1];
        const hasNegNow = negKey in data[i];
        const hasNegNext = negKey in data[i + 1];

        if (hasNegNow && hasPosNext) data[i][posKey] = data[i][negKey];
        if (hasPosNow && hasNegNext) data[i + 1][posKey] = data[i + 1][negKey];
      }
    }

    return data;
  }, [combinedCurves, combinedLabels, hiddenLines, polyNowCurve, polyExpiryCurve, polyAtBybitExpiryCurve, bybitNowCurve, bybitExpiryCurve, bybitMMNowCurve, hasPolyAtBybitExpiry, hasMMCurve]);

  // Collect all visible pnl values for Y domain
  const { yDomain, yTicks } = useMemo(() => {
    let min = 0;
    let max = 0;

    const addPoints = (pts: ProjectionPoint[] | undefined, label: string) => {
      if (!pts || hiddenLines.has(label)) return;
      for (const pt of pts) {
        if (pt.pnl < min) min = pt.pnl;
        if (pt.pnl > max) max = pt.pnl;
      }
    };

    for (let c = 0; c < combinedCurves.length; c++) {
      if (!hiddenLines.has(combinedLabels[c])) {
        for (const pt of combinedCurves[c]) {
          if (pt.pnl < min) min = pt.pnl;
          if (pt.pnl > max) max = pt.pnl;
        }
      }
    }

    addPoints(polyNowCurve, POLY_NOW);
    addPoints(polyExpiryCurve, POLY_EXPIRY);
    addPoints(polyAtBybitExpiryCurve, POLY_OPTION_EXPIRY);
    addPoints(bybitNowCurve, BYBIT_NOW);
    addPoints(bybitExpiryCurve, BYBIT_EXPIRY);

    const pad = Math.max(0.1, (max - min) * 0.1);
    const domain: [number, number] = [min - pad, max + pad];

    const range = domain[1] - domain[0];
    const rawStep = range / 6;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const nice = [1, 2, 2.5, 5, 10].find((n) => n * magnitude >= rawStep) ?? 10;
    const step = nice * magnitude;

    const ticks: number[] = [0];
    for (let v = step; v <= domain[1]; v += step) ticks.push(Math.round(v * 1000) / 1000);
    for (let v = -step; v >= domain[0]; v -= step) ticks.push(Math.round(v * 1000) / 1000);
    ticks.sort((a, b) => a - b);

    return { yDomain: domain, yTicks: ticks };
  }, [combinedCurves, combinedLabels, hiddenLines, polyNowCurve, polyExpiryCurve, polyAtBybitExpiryCurve, bybitNowCurve, bybitExpiryCurve]);

  const { allTicks, majorInterval, minorInterval, xDomain } = useMemo(() => {
    if (chartData.length === 0) return { allTicks: [], majorInterval: 1000, minorInterval: 100, xDomain: [0, 1] };
    const min = chartData[0].cryptoPrice;
    const max = chartData[chartData.length - 1].cryptoPrice;
    const range = max - min;
    const { major, minor } = getAdaptiveTickIntervals(range, chartWidth);

    const ticks: number[] = [];
    const start = Math.ceil(min / minor) * minor;
    for (let v = start; v <= max; v += minor) ticks.push(Math.round(v));
    return { allTicks: ticks, majorInterval: major, minorInterval: minor, xDomain: [min, max] };
  }, [chartData, chartWidth]);

  const formatYAxisPnl = useCallback((v: number) => v.toFixed(2), []);

  // Right axis: P&L expressed as % of entry cost
  const absCost = Math.abs(totalEntryCost ?? 0);
  const { yDomainPct, yTicksPct } = useMemo(() => {
    if (absCost <= 0) return { yDomainPct: yDomain, yTicksPct: yTicks };
    return {
      yDomainPct: [yDomain[0] / absCost * 100, yDomain[1] / absCost * 100] as [number, number],
      yTicksPct: yTicks.map(t => Math.round(t / absCost * 1000) / 10),
    };
  }, [yDomain, yTicks, absCost]);

  const formatYAxisPct = useCallback((v: number) => {
    const abs = Math.abs(v);
    return (abs >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%';
  }, []);

  const handleLegendClick = useCallback((label: string) => {
    setHiddenLines(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }, []);

  const allLineLabels = useMemo(() => {
    const labels = [...combinedLabels];
    if (hasPolyOverlay) {
      labels.push(POLY_NOW, POLY_EXPIRY);
      if (hasPolyAtBybitExpiry) labels.push(POLY_OPTION_EXPIRY);
    }
    if (hasBybitOverlay) labels.push(BYBIT_NOW, BYBIT_EXPIRY);
    return labels;
  }, [combinedLabels, hasPolyOverlay, hasPolyAtBybitExpiry, hasBybitOverlay]);

  const isAllVisible = hiddenLines.size === 0;
  const handleToggleAll = useCallback(() => {
    setHiddenLines(isAllVisible ? new Set(allLineLabels) : new Set());
  }, [isAllVisible, allLineLabels]);


  const renderTick = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) => (
      <CustomXTick {...props} majorInterval={majorInterval} minorInterval={minorInterval} tickColor={axisColor} tickColorFaded={tickColorFaded} />
    ),
    [majorInterval, minorInterval, axisColor, tickColorFaded]
  );

  // Line styles map for tooltip + legend
  const lineStyles = useMemo(() => {
    const styles = new Map<string, LineStyle>();
    for (let i = 0; i < combinedLabels.length; i++) {
      styles.set(combinedLabels[i], {
        color: GREEN, secondColor: RED,
        dash: COMBINED_DASH[i] || undefined,
        width: COMBINED_WIDTHS[i], opacity: COMBINED_OPACITIES[i],
      });
    }
    if (hasPolyOverlay) {
      styles.set(POLY_NOW, { color: POLY_BLUE, width: 2, opacity: 0.8 });
      styles.set(POLY_EXPIRY, { color: POLY_BLUE, dash: '14 6', width: 2, opacity: 0.6 });
      if (hasPolyAtBybitExpiry)
        styles.set(POLY_OPTION_EXPIRY, { color: POLY_BLUE, dash: '8 5', width: 2, opacity: 0.7 });
    }
    if (hasBybitOverlay) {
      styles.set(BYBIT_NOW, { color: BYBIT_ORANGE, width: 2, opacity: 0.8 });
      styles.set(BYBIT_EXPIRY, { color: BYBIT_ORANGE, dash: '14 6', width: 2, opacity: 0.6 });
    }
    return styles;
  }, [combinedLabels, hasPolyOverlay, hasPolyAtBybitExpiry, hasBybitOverlay]);

  const renderTooltip = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) => (
      <CustomTooltipContent
        {...props}
        combinedLabels={combinedLabels}
        cryptoSymbol={cryptoSymbol}
        hiddenLines={hiddenLines}
        currentCryptoPrice={currentCryptoPrice}
        tooltipBg={tooltipBg}
        tooltipBorder={tooltipBorder}
        secondaryColor={axisColor}
        hasPolyOverlay={hasPolyOverlay}
        hasPolyAtBybitExpiry={hasPolyAtBybitExpiry}
        hasBybitOverlay={hasBybitOverlay}
        lineStyles={lineStyles}
        totalEntryCost={totalEntryCost}
        polyEntryCost={polyEntryCost}
        bybitEntryCost={bybitEntryCost}
        hasMMCurve={hasMMCurve}
      />
    ),
    [combinedLabels, cryptoSymbol, hiddenLines, currentCryptoPrice, tooltipBg, tooltipBorder, axisColor, hasPolyOverlay, hasPolyAtBybitExpiry, hasBybitOverlay, lineStyles, totalEntryCost, polyEntryCost, bybitEntryCost, hasMMCurve]
  );

  if (chartData.length === 0) return null;

  // Build legend items (no % — % shown in tooltip instead)
  const legendItems: Array<{ label: string; color: string; secondColor?: string; dash?: string; width: number }> = [];

  for (let i = 0; i < combinedLabels.length; i++) {
    legendItems.push({
      label: combinedLabels[i],
      color: GREEN, secondColor: RED,
      dash: COMBINED_DASH[i] || undefined,
      width: COMBINED_WIDTHS[i],
    });
  }
  if (hasPolyOverlay) {
    legendItems.push({ label: POLY_NOW, color: POLY_BLUE, width: 2 });
    legendItems.push({ label: POLY_EXPIRY, color: POLY_BLUE, dash: '14 6', width: 2 });
    if (hasPolyAtBybitExpiry)
      legendItems.push({ label: POLY_OPTION_EXPIRY, color: POLY_BLUE, dash: '8 5', width: 2 });
  }
  if (hasBybitOverlay) {
    legendItems.push({ label: BYBIT_NOW, color: BYBIT_ORANGE, width: 2 });
    legendItems.push({ label: BYBIT_EXPIRY, color: BYBIT_ORANGE, dash: '14 6', width: 2 });
  }

  return (
    <div ref={containerRef}>
      <ResponsiveContainer width="100%" minHeight={600}>
        <LineChart data={chartData} margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
          <XAxis
            dataKey="cryptoPrice"
            type="number"
            domain={xDomain}
            ticks={allTicks}
            tick={renderTick}
            stroke={axisColor}
            tickLine={false}
            interval={0}
          />
          <YAxis
            yAxisId="left"
            orientation="left"
            domain={yDomain}
            ticks={yTicks}
            allowDataOverflow={true}
            tickFormatter={formatYAxisPnl}
            stroke={axisColor}
            fontSize={14}
            label={{ value: 'P&L ($)', angle: -90, position: 'insideLeft', style: { fill: axisColor, fontSize: 15 } }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={yDomainPct}
            ticks={yTicksPct}
            allowDataOverflow={true}
            tickFormatter={formatYAxisPct}
            stroke={axisColor}
            fontSize={14}
            label={{ value: 'P&L (%)', angle: 90, position: 'insideRight', style: { fill: axisColor, fontSize: 15 } }}
          />
          <Tooltip content={renderTooltip} />
          <ReferenceLine yAxisId="left" y={0} stroke={zeroLineColor} strokeDasharray="3 3" />
          <ReferenceLine
            yAxisId="left"
            x={currentCryptoPrice}
            stroke={refLineColor}
            strokeDasharray="5 5"
            label={{ value: `Spot: $${currentCryptoPrice.toLocaleString()}`, position: 'top', fill: axisColor, fontSize: 14 }}
          />

          {/* Invisible line for right Y-axis scale — use first visible combined curve so the
              right axis rescales correctly when curves are hidden */}
          <Line
            yAxisId="right"
            type="linear"
            dataKey={(() => {
              const visibleLabel = combinedLabels.find(l => !hiddenLines.has(l));
              if (visibleLabel) return `${visibleLabel}__pos`;
              if (hasPolyOverlay && !hiddenLines.has(POLY_NOW)) return POLY_NOW;
              return combinedLabels[0] ? `${combinedLabels[0]}__pos` : POLY_NOW;
            })()}
            stroke="none"
            strokeWidth={0}
            dot={false}
            activeDot={false}
            legendType="none"
            tooltipType="none"
          />
          {/* Invisible line for MM data — included in payload for tooltip */}
          {hasMMCurve && (
            <Line
              yAxisId="left"
              type="linear"
              dataKey="__bybit_mm"
              name="__bybit_mm"
              stroke="none"
              strokeWidth={0}
              dot={false}
              activeDot={false}
              legendType="none"
            />
          )}

          {/* Combined curves: green/red split */}
          {combinedLabels.map((label, i) => [
            <Line
              key={`${label}__pos`}
              yAxisId="left"
              type="linear"
              dataKey={`${label}__pos`}
              name={`${label}__pos`}
              stroke={GREEN}
              strokeWidth={COMBINED_WIDTHS[i]}
              strokeDasharray={COMBINED_DASH[i] || undefined}
              dot={false}
              activeDot={ACTIVE_DOT}
              connectNulls={false}
              strokeOpacity={COMBINED_OPACITIES[i]}
              legendType="none"
            />,
            <Line
              key={`${label}__neg`}
              yAxisId="left"
              type="linear"
              dataKey={`${label}__neg`}
              name={`${label}__neg`}
              stroke={RED}
              strokeWidth={COMBINED_WIDTHS[i]}
              strokeDasharray={COMBINED_DASH[i] || undefined}
              dot={false}
              activeDot={ACTIVE_DOT}
              connectNulls={false}
              strokeOpacity={COMBINED_OPACITIES[i]}
              legendType="none"
            />,
          ])}

          {/* Poly overlay: blue solid=Now, dashed=Expiry */}
          {hasPolyOverlay && (
            <>
              <Line
                yAxisId="left" type="linear" dataKey={POLY_NOW} name={POLY_NOW}
                stroke={POLY_BLUE} strokeWidth={2} dot={false} activeDot={ACTIVE_DOT}
                strokeOpacity={0.8}
                legendType="none"
              />
              <Line
                yAxisId="left" type="linear" dataKey={POLY_EXPIRY} name={POLY_EXPIRY}
                stroke={POLY_BLUE} strokeWidth={2} strokeDasharray="14 6" dot={false} activeDot={ACTIVE_DOT}
                strokeOpacity={0.6}
                legendType="none"
              />
              {hasPolyAtBybitExpiry && (
                <Line
                  yAxisId="left" type="linear" dataKey={POLY_OPTION_EXPIRY} name={POLY_OPTION_EXPIRY}
                  stroke={POLY_BLUE} strokeWidth={2} strokeDasharray="8 5" dot={false} activeDot={ACTIVE_DOT}
                  strokeOpacity={0.7}
                  legendType="none"
                />
              )}
            </>
          )}

          {/* Bybit overlay: orange solid=Now, dashed=Expiry */}
          {hasBybitOverlay && (
            <>
              <Line
                yAxisId="left" type="linear" dataKey={BYBIT_NOW} name={BYBIT_NOW}
                stroke={BYBIT_ORANGE} strokeWidth={2} dot={false} activeDot={ACTIVE_DOT}
                strokeOpacity={0.8}
                legendType="none"
              />
              <Line
                yAxisId="left" type="linear" dataKey={BYBIT_EXPIRY} name={BYBIT_EXPIRY}
                stroke={BYBIT_ORANGE} strokeWidth={2} strokeDasharray="14 6" dot={false} activeDot={ACTIVE_DOT}
                strokeOpacity={0.6}
                legendType="none"
              />
            </>
          )}
        </LineChart>
      </ResponsiveContainer>

      {/* Custom legend */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 20, paddingTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {legendItems.map(item => (
          <div
            key={item.label}
            onClick={() => handleLegendClick(item.label)}
            style={{
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              opacity: hiddenLines.has(item.label) ? 0.3 : 1,
            }}
          >
            <svg width={24} height={item.width + 2} style={{ display: 'block' }}>
              {item.secondColor ? (
                <>
                  <line x1={0} y1={(item.width + 2) / 2} x2={12} y2={(item.width + 2) / 2}
                    stroke={item.color} strokeWidth={item.width} strokeDasharray={item.dash} />
                  <line x1={12} y1={(item.width + 2) / 2} x2={24} y2={(item.width + 2) / 2}
                    stroke={item.secondColor} strokeWidth={item.width} strokeDasharray={item.dash} />
                </>
              ) : (
                <line x1={0} y1={(item.width + 2) / 2} x2={24} y2={(item.width + 2) / 2}
                  stroke={item.color} strokeWidth={item.width} strokeDasharray={item.dash} />
              )}
            </svg>
            <span style={{ color: legendColor, fontSize: 14 }}>{item.label}</span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 1, height: 16, background: legendColor, opacity: 0.3 }} />
          <button onClick={handleToggleAll} style={{
            background: 'transparent', border: `1px solid ${legendColor}`,
            color: legendColor, fontSize: 13, padding: '2px 10px', borderRadius: 4,
            cursor: 'pointer', opacity: 0.8,
          }}>
            {isAllVisible ? 'Hide All' : 'Show All'}
          </button>
        </div>
      </div>
    </div>
  );
}
