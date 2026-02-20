import { useState, useMemo, useCallback } from 'react';
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
  currentCryptoPrice: number;
  cryptoSymbol: string;
  totalEntryCost?: number;
}

interface ChartDataRow {
  cryptoPrice: number;
  [key: string]: number;
}

const CHART_MARGIN = { top: 20, right: 60, bottom: 50, left: 20 };
const ACTIVE_DOT = { r: 4 };

function getTickIntervals(range: number): { major: number; minor: number } {
  if (range > 100000) return { major: 10000, minor: 1000 };
  if (range > 50000) return { major: 5000, minor: 1000 };
  if (range > 10000) return { major: 2000, minor: 500 };
  if (range > 5000) return { major: 1000, minor: 100 };
  if (range > 1000) return { major: 500, minor: 100 };
  return { major: 100, minor: 10 };
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
        <text y={22} textAnchor="middle" fill={tickColor} fontSize={12} fontFamily="JetBrains Mono, monospace">
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
  hasBybitOverlay,
  lineStyles,
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
  hasBybitOverlay: boolean;
  lineStyles: Map<string, LineStyle>;
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

  const renderRow = (label: string, pnl: number, textColor: string, style: LineStyle | undefined, pnlColor?: string) => {
    const pnlSign = pnl >= 0 ? '+' : '';
    return (
      <div key={label} style={{ display: 'flex', alignItems: 'center', fontSize: 13, padding: '2px 0' }}>
        {style && <TooltipLineSample style={style} pnlColor={pnlColor} />}
        <span style={{ color: textColor }}>{label}: {pnlSign}{pnl.toFixed(2)}</span>
      </div>
    );
  };

  return (
    <div style={{
      backgroundColor: tooltipBg,
      border: `1px solid ${tooltipBorder}`,
      borderRadius: 8,
      padding: '10px 14px',
      maxWidth: 360,
    }}>
      <div style={{ color: secondaryColor, marginBottom: 6, fontSize: 14 }}>
        {cryptoSymbol}: ${cryptoPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({formatPct(pricePct)})
      </div>

      {/* Combined curves */}
      {combinedLabels.map((label) => {
        if (hiddenLines.has(label)) return null;
        const pnl = valueMap.get(label);
        if (pnl == null) return null;
        const color = pnl >= 0 ? GREEN : RED;
        return renderRow(label, pnl, color, lineStyles.get(label), color);
      })}

      {/* Poly overlay */}
      {hasPolyOverlay && (
        <>
          {!hiddenLines.has(POLY_NOW) && valueMap.has(POLY_NOW) &&
            renderRow(POLY_NOW, valueMap.get(POLY_NOW)!, POLY_BLUE, lineStyles.get(POLY_NOW))}
          {!hiddenLines.has(POLY_EXPIRY) && valueMap.has(POLY_EXPIRY) &&
            renderRow(POLY_EXPIRY, valueMap.get(POLY_EXPIRY)!, POLY_BLUE, lineStyles.get(POLY_EXPIRY))}
        </>
      )}

      {/* Bybit overlay */}
      {hasBybitOverlay && (
        <>
          {!hiddenLines.has(BYBIT_NOW) && valueMap.has(BYBIT_NOW) &&
            renderRow(BYBIT_NOW, valueMap.get(BYBIT_NOW)!, BYBIT_ORANGE, lineStyles.get(BYBIT_NOW))}
          {!hiddenLines.has(BYBIT_EXPIRY) && valueMap.has(BYBIT_EXPIRY) &&
            renderRow(BYBIT_EXPIRY, valueMap.get(BYBIT_EXPIRY)!, BYBIT_ORANGE, lineStyles.get(BYBIT_EXPIRY))}
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
  currentCryptoPrice,
  cryptoSymbol,
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

  const hasPolyOverlay = (polyNowCurve && polyNowCurve.length > 0) || false;
  const hasBybitOverlay = (bybitNowCurve && bybitNowCurve.length > 0) || false;

  const chartData = useMemo(() => {
    if (combinedCurves.length === 0 || combinedCurves[0].length === 0) return [];

    const data = combinedCurves[0].map((point, i) => {
      const row: ChartDataRow = { cryptoPrice: point.cryptoPrice };

      // Combined curves: split green/red
      for (let c = 0; c < combinedCurves.length; c++) {
        if (combinedCurves[c][i]) {
          const pnl = combinedCurves[c][i].pnl;
          if (pnl >= 0) {
            row[`${combinedLabels[c]}__pos`] = pnl;
          } else {
            row[`${combinedLabels[c]}__neg`] = pnl;
          }
        }
      }

      // Poly overlay (solid color, no split)
      if (polyNowCurve?.[i]) row[POLY_NOW] = polyNowCurve[i].pnl;
      if (polyExpiryCurve?.[i]) row[POLY_EXPIRY] = polyExpiryCurve[i].pnl;

      // Bybit overlay
      if (bybitNowCurve?.[i]) row[BYBIT_NOW] = bybitNowCurve[i].pnl;
      if (bybitExpiryCurve?.[i]) row[BYBIT_EXPIRY] = bybitExpiryCurve[i].pnl;

      return row;
    });

    // Bridge sign changes for combined curves
    for (let i = 0; i < data.length - 1; i++) {
      for (let c = 0; c < combinedCurves.length; c++) {
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
  }, [combinedCurves, combinedLabels, polyNowCurve, polyExpiryCurve, bybitNowCurve, bybitExpiryCurve]);

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
  }, [combinedCurves, combinedLabels, hiddenLines, polyNowCurve, polyExpiryCurve, bybitNowCurve, bybitExpiryCurve]);

  const { allTicks, majorInterval, minorInterval, xDomain } = useMemo(() => {
    if (chartData.length === 0) return { allTicks: [], majorInterval: 1000, minorInterval: 100, xDomain: [0, 1] };
    const min = chartData[0].cryptoPrice;
    const max = chartData[chartData.length - 1].cryptoPrice;
    const range = max - min;
    const { major, minor } = getTickIntervals(range);

    const ticks: number[] = [];
    const start = Math.ceil(min / minor) * minor;
    for (let v = start; v <= max; v += minor) ticks.push(v);
    return { allTicks: ticks, majorInterval: major, minorInterval: minor, xDomain: [min, max] };
  }, [chartData]);

  const formatYAxisPnl = useCallback((v: number) => v.toFixed(2), []);

  const handleLegendClick = useCallback((label: string) => {
    setHiddenLines(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }, []);

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
    }
    if (hasBybitOverlay) {
      styles.set(BYBIT_NOW, { color: BYBIT_ORANGE, width: 2, opacity: 0.8 });
      styles.set(BYBIT_EXPIRY, { color: BYBIT_ORANGE, dash: '14 6', width: 2, opacity: 0.6 });
    }
    return styles;
  }, [combinedLabels, hasPolyOverlay, hasBybitOverlay]);

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
        hasBybitOverlay={hasBybitOverlay}
        lineStyles={lineStyles}
      />
    ),
    [combinedLabels, cryptoSymbol, hiddenLines, currentCryptoPrice, tooltipBg, tooltipBorder, axisColor, hasPolyOverlay, hasBybitOverlay, lineStyles]
  );

  if (chartData.length === 0) return null;

  // Build legend items
  const legendItems: Array<{ label: string; color: string; secondColor?: string; dash?: string; width: number }> = [];

  // Combined curves
  for (let i = 0; i < combinedLabels.length; i++) {
    legendItems.push({
      label: combinedLabels[i],
      color: GREEN,
      secondColor: RED,
      dash: COMBINED_DASH[i] || undefined,
      width: COMBINED_WIDTHS[i],
    });
  }

  // Poly overlay
  if (hasPolyOverlay) {
    legendItems.push({ label: POLY_NOW, color: POLY_BLUE, width: 2 });
    legendItems.push({ label: POLY_EXPIRY, color: POLY_BLUE, dash: '14 6', width: 2 });
  }

  // Bybit overlay
  if (hasBybitOverlay) {
    legendItems.push({ label: BYBIT_NOW, color: BYBIT_ORANGE, width: 2 });
    legendItems.push({ label: BYBIT_EXPIRY, color: BYBIT_ORANGE, dash: '14 6', width: 2 });
  }

  return (
    <div>
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
            tickFormatter={formatYAxisPnl}
            stroke={axisColor}
            fontSize={13}
            label={{ value: 'P&L ($)', angle: -90, position: 'insideLeft', style: { fill: axisColor, fontSize: 14 } }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={yDomain}
            ticks={yTicks}
            tickFormatter={formatYAxisPnl}
            stroke={axisColor}
            fontSize={13}
            label={{ value: 'P&L', angle: 90, position: 'insideRight', style: { fill: axisColor, fontSize: 14 } }}
          />
          <Tooltip content={renderTooltip} />
          <ReferenceLine yAxisId="left" y={0} stroke={zeroLineColor} strokeDasharray="3 3" />
          <ReferenceLine
            yAxisId="left"
            x={currentCryptoPrice}
            stroke={refLineColor}
            strokeDasharray="5 5"
            label={{ value: `Spot: $${currentCryptoPrice.toLocaleString()}`, position: 'top', fill: axisColor, fontSize: 13 }}
          />

          {/* Invisible line for right Y-axis scale */}
          <Line
            yAxisId="right"
            type="linear"
            dataKey={combinedLabels[0] ? `${combinedLabels[0]}__pos` : POLY_NOW}
            stroke="none"
            strokeWidth={0}
            dot={false}
            activeDot={false}
            legendType="none"
            tooltipType="none"
          />

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
              hide={hiddenLines.has(label)}
              strokeOpacity={hiddenLines.has(label) ? 0.15 : COMBINED_OPACITIES[i]}
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
              hide={hiddenLines.has(label)}
              strokeOpacity={hiddenLines.has(label) ? 0.15 : COMBINED_OPACITIES[i]}
              legendType="none"
            />,
          ])}

          {/* Poly overlay: blue solid=Now, dashed=Expiry */}
          {hasPolyOverlay && (
            <>
              <Line
                yAxisId="left" type="linear" dataKey={POLY_NOW} name={POLY_NOW}
                stroke={POLY_BLUE} strokeWidth={2} dot={false} activeDot={ACTIVE_DOT}
                hide={hiddenLines.has(POLY_NOW)} strokeOpacity={hiddenLines.has(POLY_NOW) ? 0.15 : 0.8}
                legendType="none"
              />
              <Line
                yAxisId="left" type="linear" dataKey={POLY_EXPIRY} name={POLY_EXPIRY}
                stroke={POLY_BLUE} strokeWidth={2} strokeDasharray="14 6" dot={false} activeDot={ACTIVE_DOT}
                hide={hiddenLines.has(POLY_EXPIRY)} strokeOpacity={hiddenLines.has(POLY_EXPIRY) ? 0.15 : 0.6}
                legendType="none"
              />
            </>
          )}

          {/* Bybit overlay: orange solid=Now, dashed=Expiry */}
          {hasBybitOverlay && (
            <>
              <Line
                yAxisId="left" type="linear" dataKey={BYBIT_NOW} name={BYBIT_NOW}
                stroke={BYBIT_ORANGE} strokeWidth={2} dot={false} activeDot={ACTIVE_DOT}
                hide={hiddenLines.has(BYBIT_NOW)} strokeOpacity={hiddenLines.has(BYBIT_NOW) ? 0.15 : 0.8}
                legendType="none"
              />
              <Line
                yAxisId="left" type="linear" dataKey={BYBIT_EXPIRY} name={BYBIT_EXPIRY}
                stroke={BYBIT_ORANGE} strokeWidth={2} strokeDasharray="14 6" dot={false} activeDot={ACTIVE_DOT}
                hide={hiddenLines.has(BYBIT_EXPIRY)} strokeOpacity={hiddenLines.has(BYBIT_EXPIRY) ? 0.15 : 0.6}
                legendType="none"
              />
            </>
          )}
        </LineChart>
      </ResponsiveContainer>

      {/* Custom legend */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 20, paddingTop: 12, flexWrap: 'wrap' }}>
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
            <span style={{ color: legendColor, fontSize: 13 }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
