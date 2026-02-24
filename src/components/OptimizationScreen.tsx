import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  Box,
  Typography,
  Paper,
  IconButton,
  Chip,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Slider,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { ArrowBack, BarChart, PhotoCamera, OpenInNew } from '@mui/icons-material';
import type {
  CryptoOption,
  OptionType,
  ParsedMarket,
  PolymarketEvent,
  BybitOptionChain as BybitChainType,
  PolymarketPosition,
  BybitPosition,
  OptMatchResult,
  StrikeOptResult,
} from '../types';
import { solveImpliedVol, autoH, type SmilePoint } from '../pricing/engine';
import { runOptimization } from '../optimization/optimizer';
import { ProjectionChart } from './ProjectionChart';
import { usePortfolioCurves } from '../hooks/usePortfolioCurves';

interface OptimizationScreenProps {
  polyEvent: PolymarketEvent | null;
  polyMarkets: ParsedMarket[];
  crypto: CryptoOption | null;
  optionType: OptionType;
  spotPrice: number;
  bybitChain: BybitChainType | null;
  onBack: () => void;
}

interface VizSelection {
  strikeResult: StrikeOptResult;
  match: OptMatchResult;
  range: '1' | '10' | '20';
}

/** Chart visualization for a selected poly + bybit 3-leg match */
function VizCard({
  strikeResult,
  match,
  optionType,
  spotPrice,
  bybitQty,
  smile,
  bybitSmile,
  polyExpiryTs,
  cryptoSymbol,
}: {
  strikeResult: StrikeOptResult;
  match: OptMatchResult;
  optionType: OptionType;
  spotPrice: number;
  bybitQty: number;
  smile: SmilePoint[];
  bybitSmile: SmilePoint[];
  polyExpiryTs: number;
  cryptoSymbol: string;
}) {
  const { market, isUpBarrier, polyIv } = strikeResult;
  const { polyQty, noAskPrice, bybitAsk, bybitFee, shortBid, shortFee, instrument, ticker, shortInstrument, shortTicker } = match;
  const isDark = useTheme().palette.mode === 'dark';

  const sliderBounds = useMemo((): [number, number] => {
    const prices = [market.strikePrice, instrument.strike, shortInstrument.strike, spotPrice];
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const pad = Math.max((maxP - minP) * 0.50, spotPrice * 0.30);
    const lo = Math.max(0, minP - pad);
    const hi = maxP + pad;
    return [Math.floor(lo / 100) * 100, Math.ceil(hi / 100) * 100];
  }, [market.strikePrice, instrument.strike, shortInstrument.strike, spotPrice]);

  const sliderStep = useMemo(() => {
    const range = sliderBounds[1] - sliderBounds[0];
    if (range > 100000) return 1000;
    if (range > 10000) return 100;
    if (range > 1000) return 10;
    return 1;
  }, [sliderBounds]);

  const [priceRange, setPriceRange] = useState<[number, number]>(() => {
    const prices = [market.strikePrice, instrument.strike, shortInstrument.strike, spotPrice];
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const pad = Math.max((maxP - minP) * 0.20, spotPrice * 0.12);
    return [
      Math.floor((minP - pad) / 100) * 100,
      Math.ceil((maxP + pad) / 100) * 100,
    ];
  });

  const [hDelta, setHDelta] = useState(0.00);

  const polyPos: PolymarketPosition = useMemo(() => ({
    marketId: market.id,
    question: market.question,
    groupItemTitle: market.groupItemTitle,
    strikePrice: market.strikePrice,
    side: 'NO',
    entryPrice: noAskPrice,
    impliedVol: polyIv,
    isUpBarrier,
    quantity: polyQty,
  }), [market, isUpBarrier, polyIv, noAskPrice, polyQty]);

  // Long option leg
  const longBybitPos: BybitPosition = useMemo(() => ({
    symbol: instrument.symbol,
    optionsType: instrument.optionsType,
    strike: instrument.strike,
    expiryTimestamp: instrument.expiryTimestamp,
    side: 'buy',
    entryPrice: bybitAsk,
    markIv: ticker.markIv,
    quantity: bybitQty,
    entryFee: bybitFee,
  }), [instrument, ticker, bybitAsk, bybitFee, bybitQty]);

  // Short option leg (sell side — hook handles sign flip via sideMultiplier)
  const shortBybitPos: BybitPosition = useMemo(() => ({
    symbol: shortInstrument.symbol,
    optionsType: shortInstrument.optionsType,
    strike: shortInstrument.strike,
    expiryTimestamp: shortInstrument.expiryTimestamp,
    side: 'sell',
    entryPrice: shortBid,
    markIv: shortTicker.markIv,
    quantity: bybitQty,
    entryFee: shortFee,
  }), [shortInstrument, shortTicker, shortBid, shortFee, bybitQty]);

  const nowTs = useMemo(() => Math.floor(Date.now() / 1000), []);
  const polyTauNow = Math.max((polyExpiryTs - nowTs) / (365.25 * 24 * 3600), 0);

  const { combinedCurves, combinedLabels, polyNowCurve, polyExpiryCurve, bybitNowCurve, bybitExpiryCurve, polyAtBybitExpiryCurve, polyEntryCost, bybitEntryCost, totalEntryCost, grossCost, totalInitialMargin, bybitMMNowCurve } = usePortfolioCurves({
    polyPositions: [polyPos],
    bybitPositions: [longBybitPos, shortBybitPos],
    lowerPrice: priceRange[0],
    upperPrice: priceRange[1],
    polyTauNow,
    polyExpiryTs,
    optionType,
    deltaH: hDelta,
    smile: smile.length > 0 ? smile : undefined,
    bybitSmile: bybitSmile.length > 0 ? bybitSmile : undefined,
    numPoints: 500,
    spotPrice,
  });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {/* Position summary */}
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, alignItems: 'flex-start' }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#4A90D9', borderBottom: '2px solid rgba(74, 144, 217, 0.35)', pb: 0.5, mb: 1 }}>
              Polymarket
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {market.groupItemTitle} — NO ×{polyQty.toFixed(2)} @ {noAskPrice.toFixed(4)} (${(noAskPrice * polyQty).toFixed(2)})
            </Typography>
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#FF8C00', borderBottom: '2px solid rgba(255, 140, 0, 0.35)', pb: 0.5, mb: 1 }}>
              Long Option
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {instrument.symbol} — buy ×{bybitQty} @ ${bybitAsk.toFixed(2)}{' '}
              (total: ${(bybitAsk * bybitQty + bybitFee).toFixed(2)}, fee: ${bybitFee.toFixed(2)})
            </Typography>
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#EF4444', borderBottom: '2px solid rgba(239, 68, 68, 0.35)', pb: 0.5, mb: 1 }}>
              Short Option
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {shortInstrument.symbol} — sell ×{bybitQty} @ ${shortBid.toFixed(2)}{' '}
              (${(shortBid * bybitQty).toFixed(2)}, fee: ${shortFee.toFixed(2)}) [IM: ${(Math.max(shortBid, 0.1 * spotPrice) * bybitQty).toFixed(2)}]
            </Typography>
          </Box>
        </Box>
        <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid rgba(139, 157, 195, 0.1)', display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="body2" sx={{ color: '#00D1FF', fontWeight: 600 }}>
            Net entry cost: ${totalEntryCost.toFixed(2)}
          </Typography>
          {totalInitialMargin > 0 && (
            <Typography variant="body2" sx={{ color: '#F59E0B', fontWeight: 600 }}>
              Gross cost: ${grossCost.toFixed(2)}
            </Typography>
          )}
          <Typography variant="body2" sx={{ color: '#22C55E', fontWeight: 600 }}>
            Avg P&amp;L ±1%: +${match.avgPnl1.toFixed(2)} &nbsp;|&nbsp; ±10%: +${match.avgPnl10.toFixed(2)} &nbsp;|&nbsp; ±20%: +${match.avgPnl20.toFixed(2)}
          </Typography>
        </Box>
      </Paper>

      {/* Chart */}
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        {combinedCurves.length > 0 && combinedCurves[0].length > 0 ? (
          <ProjectionChart
            combinedCurves={combinedCurves}
            combinedLabels={combinedLabels}
            polyNowCurve={polyNowCurve}
            polyExpiryCurve={polyExpiryCurve}
            bybitNowCurve={bybitNowCurve}
            bybitExpiryCurve={bybitExpiryCurve}
            bybitMMNowCurve={bybitMMNowCurve.length > 0 ? bybitMMNowCurve : undefined}
            polyAtBybitExpiryCurve={polyAtBybitExpiryCurve}
            polyEntryCost={polyEntryCost}
            bybitEntryCost={bybitEntryCost}
            currentCryptoPrice={spotPrice}
            cryptoSymbol={cryptoSymbol}
            totalEntryCost={totalEntryCost}
          />
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400, color: isDark ? 'rgba(139, 157, 195, 0.5)' : 'rgba(0,0,0,0.3)' }}>
            <CircularProgress size={24} sx={{ mr: 2 }} />
            <Typography variant="body2">Computing curves...</Typography>
          </Box>
        )}
      </Paper>

      {/* Price range slider */}
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2" color="text.secondary">${priceRange[0].toLocaleString()}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
            {cryptoSymbol} Price Range
          </Typography>
          <Typography variant="body2" color="text.secondary">${priceRange[1].toLocaleString()}</Typography>
        </Box>
        <Slider
          value={priceRange}
          onChange={(_, v) => setPriceRange(v as [number, number])}
          min={sliderBounds[0]}
          max={sliderBounds[1]}
          step={sliderStep}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => `$${(v as number).toLocaleString()}`}
          sx={{
            color: '#00D1FF',
            '& .MuiSlider-thumb': { bgcolor: '#00D1FF', '&:hover': { boxShadow: '0 0 8px rgba(0, 209, 255, 0.4)' } },
            '& .MuiSlider-track': { bgcolor: '#00D1FF' },
            '& .MuiSlider-rail': { bgcolor: 'rgba(139, 157, 195, 0.2)' },
          }}
        />
      </Paper>

      {/* H exponent offset slider */}
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1 }}>
          <Typography variant="body2" color="text.secondary">−0.20</Typography>
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
              H offset: {hDelta >= 0 ? '+' : ''}{hDelta.toFixed(2)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {'>'}{'>'}7d: H={autoH(10 / 365.25, hDelta).toFixed(2)} &nbsp;|&nbsp;
              3–7d: H={autoH(5 / 365.25, hDelta).toFixed(2)} &nbsp;|&nbsp;
              {'<'}3d: H={autoH(1 / 365.25, hDelta).toFixed(2)}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">+0.20</Typography>
        </Box>
        <Slider
          value={hDelta}
          onChange={(_, v) => setHDelta(v as number)}
          min={-0.20}
          max={0.20}
          step={0.01}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => (v >= 0 ? '+' : '') + (v as number).toFixed(2)}
          sx={{
            color: '#A78BFA',
            '& .MuiSlider-thumb': { bgcolor: '#A78BFA', '&:hover': { boxShadow: '0 0 8px rgba(167, 139, 250, 0.4)' } },
            '& .MuiSlider-track': { bgcolor: '#A78BFA' },
            '& .MuiSlider-rail': { bgcolor: 'rgba(139, 157, 195, 0.2)' },
          }}
        />
      </Paper>
    </Box>
  );
}

export function OptimizationScreen({
  polyEvent,
  polyMarkets,
  crypto,
  optionType,
  spotPrice,
  bybitChain,
  onBack,
}: OptimizationScreenProps) {
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';

  const [vizSelection, setVizSelection] = useState<VizSelection | null>(null);
  const [bybitQtyInput, setBybitQtyInput] = useState('0.01');
  const snapshotRef = useRef<HTMLDivElement>(null);

  /** Format a Unix-ms timestamp as HH:MM UTC+1 */
  const fmtTimeUTC1 = (ms: number) => {
    const d = new Date(ms + 3_600_000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC+1`;
  };

  const handleSnapshot = useCallback(async () => {
    if (!snapshotRef.current) return;
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(snapshotRef.current, {
      backgroundColor: isDark ? '#0A0E17' : '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    });
    const now = new Date();
    const datetime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
    const strike = vizSelection?.strikeResult.market.strikePrice ?? 'noK';
    const expTs = polyEvent?.endDate ?? 0;
    const expiryPart = expTs > 0
      ? new Date(expTs * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short' }).replace(' ', '')
      : 'noexp';
    const link = document.createElement('a');
    link.download = `PolyAH_K${strike}_exp${expiryPart}_${datetime}.jpg`;
    link.href = canvas.toDataURL('image/jpeg', 0.95);
    link.click();
  }, [isDark, vizSelection, polyEvent]);

  const bybitQty = useMemo(() => {
    const v = parseFloat(bybitQtyInput);
    if (isNaN(v) || v <= 0) return 0.01;
    return Math.round(v * 100) / 100;
  }, [bybitQtyInput]);

  useEffect(() => {
    setVizSelection(null);
  }, [bybitQty]);

  const handleTransferToHedger = useCallback(() => {
    if (!vizSelection || !bybitChain) return;
    const { match, strikeResult } = vizSelection;
    const { instrument, shortInstrument, polyQty } = match;
    const { market } = strikeResult;
    const payload = {
      version: '3.1.0',
      savedAt: new Date().toISOString(),
      spotPrice,
      hDelta: 0,
      priceRange: [spotPrice * 0.75, spotPrice * 1.25],
      polyPriceMode: 'ask',
      optionType,
      crypto,
      polyEvent: polyEvent ? {
        id: polyEvent.id, slug: polyEvent.slug, title: polyEvent.title,
        description: (polyEvent as { description?: string }).description ?? '',
        startDate: polyEvent.startDate, endDate: polyEvent.endDate,
      } : null,
      polyMarkets,
      polySelections: [{ marketId: market.id, side: 'NO', quantity: polyQty }],
      bybitChain: {
        expiryLabel: bybitChain.expiryLabel,
        expiryTimestamp: bybitChain.expiryTimestamp,
        instruments: bybitChain.instruments,
        tickers: Array.from(bybitChain.tickers.values()),
      },
      bybitSelections: [
        { symbol: instrument.symbol, side: 'buy', quantity: bybitQty },
        { symbol: shortInstrument.symbol, side: 'sell', quantity: bybitQty },
      ],
    };
    localStorage.setItem('position_hedger_transfer', JSON.stringify(payload));
    window.open('https://shtanga0x.github.io/position_hedger/', '_blank');
  }, [vizSelection, bybitChain, polyEvent, polyMarkets, optionType, crypto, spotPrice, bybitQty]);

  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), []);

  const optResults = useMemo(() => {
    if (!polyMarkets.length || !bybitChain || spotPrice <= 0) return [];
    return runOptimization(polyMarkets, optionType, spotPrice, nowSec, bybitChain, bybitQty);
  }, [polyMarkets, optionType, spotPrice, bybitChain, nowSec, bybitQty]);

  const polyExpiryTs = polyEvent?.endDate ?? 0;
  const polyTauNow = useMemo(() => {
    return Math.max((polyExpiryTs - nowSec) / (365.25 * 24 * 3600), 0);
  }, [polyExpiryTs, nowSec]);

  const ivSmile: SmilePoint[] = useMemo(() => {
    if (!spotPrice || polyTauNow <= 0 || polyMarkets.length === 0) return [];
    const hNow = autoH(polyTauNow, 0);
    const points: SmilePoint[] = [];
    for (const market of polyMarkets) {
      if (market.strikePrice <= 0 || market.currentPrice <= 0.001 || market.currentPrice >= 0.999) continue;
      const isUp = market.strikePrice > spotPrice;
      const iv = solveImpliedVol(spotPrice, market.strikePrice, polyTauNow, market.currentPrice, optionType, isUp, hNow);
      if (iv !== null) points.push({ moneyness: Math.log(spotPrice / market.strikePrice), iv });
    }
    return points.sort((a, b) => a.moneyness - b.moneyness);
  }, [polyMarkets, spotPrice, polyTauNow, optionType]);

  const bybitSmile: SmilePoint[] = useMemo(() => {
    if (!bybitChain || spotPrice <= 0) return [];
    const points: SmilePoint[] = [];
    for (const [symbol, ticker] of bybitChain.tickers) {
      if (ticker.markIv <= 0) continue;
      const inst = bybitChain.instruments.find(i => i.symbol === symbol);
      if (!inst) continue;
      points.push({ moneyness: Math.log(spotPrice / inst.strike), iv: ticker.markIv });
    }
    return points.sort((a, b) => a.moneyness - b.moneyness);
  }, [bybitChain, spotPrice]);

  // For each column range, identify the single best-profitability match across all strikes
  const bestMatchPerRange = useMemo(() => {
    type Best = { match: OptMatchResult; pct: number } | null;
    let b1: Best = null, b10: Best = null, b20: Best = null;
    for (const r of optResults) {
      const pct = (m: OptMatchResult | null, pnl: number) => {
        if (!m) return -Infinity;
        const cost = m.polyQty * m.noAskPrice + m.bybitAsk * bybitQty + m.bybitFee + m.shortBid * bybitQty + m.shortFee;
        return cost > 0 ? (pnl / cost) * 100 : -Infinity;
      };
      if (r.best1)  { const p = pct(r.best1,  r.best1.avgPnl1);   if (!b1  || p > b1.pct)  b1  = { match: r.best1,  pct: p }; }
      if (r.best10) { const p = pct(r.best10, r.best10.avgPnl10);  if (!b10 || p > b10.pct) b10 = { match: r.best10, pct: p }; }
      if (r.best20) { const p = pct(r.best20, r.best20.avgPnl20);  if (!b20 || p > b20.pct) b20 = { match: r.best20, pct: p }; }
    }
    return { b1, b10, b20 };
  }, [optResults, bybitQty]);

  const handleViz = useCallback((strikeResult: StrikeOptResult, match: OptMatchResult, range: '1' | '10' | '20') => {
    setVizSelection(prev =>
      (prev?.match === match && prev?.range === range) ? null : { strikeResult, match, range }
    );
  }, []);

  const expiryDate = polyEvent ? new Date(polyEvent.endDate * 1000) : null;
  const ttxSec = polyExpiryTs > 0 ? polyExpiryTs - nowSec : 0;

  function formatTTX(s: number): string {
    if (s <= 0) return 'Expired';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h`;
  }

  const renderBybitCell = (strikeResult: StrikeOptResult, match: OptMatchResult | null, range: '1' | '10' | '20') => {
    if (!match) {
      return (
        <TableCell sx={{ verticalAlign: 'top', color: 'text.secondary', fontSize: '1.2rem' }}>
          —
        </TableCell>
      );
    }

    const { instrument, shortInstrument, polyQty, noAskPrice, bybitAsk, bybitFee, shortBid, shortFee, avgPnl1, avgPnl10, avgPnl20 } = match;
    const avgPnl = range === '1' ? avgPnl1 : range === '10' ? avgPnl10 : avgPnl20;
    const totalCost = polyQty * noAskPrice + bybitAsk * bybitQty + bybitFee + shortBid * bybitQty + shortFee;
    const pct = totalCost > 0 ? (avgPnl / totalCost) * 100 : 0;
    const isSelected = vizSelection?.match === match && vizSelection?.range === range;

    const bestForRange = range === '1' ? bestMatchPerRange.b1 : range === '10' ? bestMatchPerRange.b10 : bestMatchPerRange.b20;
    const isTopCell = bestForRange?.match === match;

    return (
      <TableCell sx={{ verticalAlign: 'top' }}>
        <Box sx={{
          p: 1, borderRadius: 1,
          border: isSelected ? '1px solid rgba(0, 209, 255, 0.4)' : '1px solid transparent',
          bgcolor: isSelected ? 'rgba(0, 209, 255, 0.04)' : 'transparent',
        }}>
          {/* Long leg */}
          <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#FF8C00', fontWeight: 600, mb: 0.25 }}>
            ↑ {instrument.symbol} ×{bybitQty} @ ${bybitAsk.toFixed(0)}
          </Typography>
          {/* Short leg */}
          <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#EF4444', fontWeight: 600, mb: 0.5 }}>
            ↓ {shortInstrument.symbol} ×{bybitQty} @ ${shortBid.toFixed(0)}
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#4A90D9' }}>
            Poly: NO ×{polyQty.toFixed(2)} @ {noAskPrice.toFixed(4)} (${(noAskPrice * polyQty).toFixed(2)})
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75 }}>
            <Typography variant="body2" sx={{ color: '#22C55E', fontWeight: 600, fontSize: '0.78rem', flex: 1 }}>
              Avg ±{range}%: +${avgPnl.toFixed(2)} (+{pct.toFixed(1)}%)
            </Typography>
            {isTopCell && (
              <Typography sx={{
                color: '#22C55E', fontWeight: 800, fontSize: '1.15rem',
                fontFamily: 'monospace', lineHeight: 1, whiteSpace: 'nowrap',
              }}>
                +{pct.toFixed(1)}%
              </Typography>
            )}
            <IconButton
              size="small"
              onClick={() => handleViz(strikeResult, match, range)}
              sx={{
                p: 0.5,
                color: isSelected ? '#00D1FF' : 'text.secondary',
                '&:hover': { color: '#00D1FF' },
              }}
            >
              <BarChart fontSize="small" />
            </IconButton>
          </Box>
        </Box>
      </TableCell>
    );
  };

  const isLoading = polyMarkets.length > 0 && bybitChain !== null && optResults.length === 0;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', p: 2, gap: 1.5 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <IconButton
          onClick={onBack}
          sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', '&:hover': { bgcolor: 'rgba(139, 157, 195, 0.2)' } }}
        >
          <ArrowBack />
        </IconButton>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h4" sx={{
            fontWeight: 700,
            ...(isDark
              ? { background: 'linear-gradient(90deg, #E8EDF5 0%, #00D1FF 100%)', backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }
              : { color: 'text.primary' }),
          }}>
            Optimization
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            {crypto && <Chip label={crypto} size="small" sx={{ bgcolor: 'rgba(247, 147, 26, 0.1)', color: '#F7931A', border: '1px solid rgba(247, 147, 26, 0.3)' }} />}
            {optionType && <Chip label={optionType === 'hit' ? 'One-Touch Barrier' : 'European Binary'} size="small" sx={{ bgcolor: 'rgba(0, 209, 255, 0.1)', color: '#00D1FF', border: '1px solid rgba(0, 209, 255, 0.3)' }} />}
            {polyExpiryTs > 0 && <Chip label={`Poly: ${expiryDate?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${fmtTimeUTC1(polyExpiryTs * 1000)}`} size="small" sx={{ bgcolor: 'rgba(74, 144, 217, 0.1)', color: '#4A90D9', border: '1px solid rgba(74, 144, 217, 0.3)' }} />}
            {ttxSec > 0 && <Chip label={`TTX: ${formatTTX(ttxSec)}`} size="small" sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', color: '#8B9DC3', border: '1px solid rgba(139, 157, 195, 0.2)' }} />}
            {spotPrice > 0 && <Chip label={`Spot: $${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} size="small" sx={{ bgcolor: 'rgba(34, 197, 94, 0.1)', color: '#22C55E', border: '1px solid rgba(34, 197, 94, 0.3)' }} />}
            {bybitChain && <Chip label={`Bybit: ${bybitChain.expiryLabel} ${fmtTimeUTC1(bybitChain.expiryTimestamp)}`} size="small" sx={{ bgcolor: 'rgba(255, 140, 0, 0.1)', color: '#FF8C00', border: '1px solid rgba(255, 140, 0, 0.3)' }} />}
            {/* Bybit quantity input */}
            <Box sx={{
              display: 'flex', alignItems: 'center', gap: 0.5,
              border: '1px solid rgba(255, 140, 0, 0.3)',
              borderRadius: '16px', px: 1, py: '3px',
              bgcolor: 'rgba(255, 140, 0, 0.06)',
            }}>
              <Typography variant="caption" sx={{ color: '#FF8C00', fontSize: '0.72rem', userSelect: 'none' }}>
                Bybit qty:
              </Typography>
              <Box
                component="input"
                type="number"
                value={bybitQtyInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBybitQtyInput(e.target.value)}
                step="0.01"
                min="0.01"
                sx={{
                  width: 52,
                  bgcolor: 'transparent',
                  border: 'none',
                  color: '#FF8C00',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  outline: 'none',
                  fontFamily: 'monospace',
                  '&::-webkit-inner-spin-button': { WebkitAppearance: 'none' },
                  '&::-webkit-outer-spin-button': { WebkitAppearance: 'none' },
                }}
              />
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Optimization table */}
      {isLoading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 2, color: 'text.secondary' }}>
          <CircularProgress size={24} />
          <Typography variant="body2">Running optimization...</Typography>
        </Box>
      ) : optResults.length === 0 ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <Typography variant="body2" color="text.secondary">
            No results — load a Polymarket event and select a Bybit expiry.
          </Typography>
        </Box>
      ) : (
        <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: isDark ? 'rgba(19, 26, 42, 0.5)' : 'rgba(0,0,0,0.03)' }}>
                <TableCell sx={{ fontWeight: 700, width: '25%', color: '#4A90D9' }}>Poly Strike</TableCell>
                <TableCell sx={{ fontWeight: 700, width: '25%', color: '#22C55E' }}>Best ±1%</TableCell>
                <TableCell sx={{ fontWeight: 700, width: '25%', color: '#22C55E' }}>Best ±10%</TableCell>
                <TableCell sx={{ fontWeight: 700, width: '25%', color: '#22C55E' }}>Best ±20%</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {optResults.map((result) => {
                const market = result.market;
                const noAsk = market.bestBid != null
                  ? (1 - market.bestBid)
                  : (1 - market.currentPrice);
                const arrow = result.isUpBarrier ? '↑' : '↓';

                return (
                  <TableRow key={market.id} sx={{ '&:hover': { bgcolor: isDark ? 'rgba(139, 157, 195, 0.03)' : 'rgba(0,0,0,0.02)' } }}>
                    <TableCell sx={{ verticalAlign: 'top', py: 1.5 }}>
                      <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 0.5 }}>
                        {arrow} ${market.strikePrice.toLocaleString()}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        NO ask: {noAsk.toFixed(4)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        IV: {(result.polyIv * 100).toFixed(0)}%
                      </Typography>
                    </TableCell>
                    {renderBybitCell(result, result.best1, '1')}
                    {renderBybitCell(result, result.best10, '10')}
                    {renderBybitCell(result, result.best20, '20')}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Transfer to position_hedger button — fixed top-right, visible when viz is open */}
      {vizSelection && (
        <IconButton
          onClick={handleTransferToHedger}
          title="Open in position_hedger"
          sx={{
            position: 'fixed', top: 16, right: 160, zIndex: 1300,
            bgcolor: isDark ? 'rgba(74, 144, 217, 0.12)' : 'rgba(74, 144, 217, 0.1)',
            color: '#4A90D9',
            '&:hover': { bgcolor: isDark ? 'rgba(74, 144, 217, 0.22)' : 'rgba(74, 144, 217, 0.2)' },
          }}
        >
          <OpenInNew />
        </IconButton>
      )}

      {/* Snapshot button — fixed top-right, visible when viz is open */}
      {vizSelection && (
        <IconButton
          onClick={handleSnapshot}
          title="Save snapshot as JPG"
          sx={{
            position: 'fixed', top: 16, right: 112, zIndex: 1300,
            bgcolor: isDark ? 'rgba(34, 197, 94, 0.12)' : 'rgba(34, 197, 94, 0.1)',
            color: '#22C55E',
            '&:hover': { bgcolor: isDark ? 'rgba(34, 197, 94, 0.22)' : 'rgba(34, 197, 94, 0.2)' },
          }}
        >
          <PhotoCamera />
        </IconButton>
      )}

      {/* Visualization section */}
      {vizSelection && (
        <Box ref={snapshotRef}>
          <VizCard
            strikeResult={vizSelection.strikeResult}
            match={vizSelection.match}
            optionType={optionType}
            spotPrice={spotPrice}
            bybitQty={bybitQty}
            smile={ivSmile}
            bybitSmile={bybitSmile}
            polyExpiryTs={polyExpiryTs}
            cryptoSymbol={crypto ?? 'BTC'}
          />
        </Box>
      )}

      <Typography variant="caption" sx={{ textAlign: 'center', color: 'rgba(139, 157, 195, 0.4)', pb: 1, mt: 'auto' }}>
        v{__APP_VERSION__}
      </Typography>
    </Box>
  );
}
