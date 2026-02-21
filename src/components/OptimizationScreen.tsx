import { useState, useMemo, useCallback } from 'react';
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
import { ArrowBack, BarChart } from '@mui/icons-material';
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
  range: '5' | '10' | '20';
}

/** Chart visualization for a selected poly + bybit match */
function VizCard({
  strikeResult,
  match,
  optionType,
  spotPrice,
  smile,
  bybitSmile,
  polyExpiryTs,
  cryptoSymbol,
}: {
  strikeResult: StrikeOptResult;
  match: OptMatchResult;
  optionType: OptionType;
  spotPrice: number;
  smile: SmilePoint[];
  bybitSmile: SmilePoint[];
  polyExpiryTs: number;
  cryptoSymbol: string;
}) {
  const { market, isUpBarrier, polyIv } = strikeResult;
  const { polyQty, noAskPrice, bybitAsk, bybitFee, instrument, ticker } = match;
  const isDark = useTheme().palette.mode === 'dark';

  // Step size based on asset price magnitude
  const priceStep = spotPrice > 10000 ? 500 : spotPrice > 1000 ? 50 : 5;

  // Wide slider bounds covering all three prices with ample padding
  const sliderBounds = useMemo((): [number, number] => {
    const prices = [market.strikePrice, instrument.strike, spotPrice];
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const pad = Math.max((maxP - minP) * 0.50, spotPrice * 0.30);
    return [
      Math.floor((minP - pad) / priceStep) * priceStep,
      Math.ceil((maxP + pad) / priceStep) * priceStep,
    ];
  }, [market.strikePrice, instrument.strike, spotPrice, priceStep]);

  // Initial chart price range covers all three prices with ±20% padding
  const [priceRange, setPriceRange] = useState<[number, number]>(() => {
    const prices = [market.strikePrice, instrument.strike, spotPrice];
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const pad = Math.max((maxP - minP) * 0.20, spotPrice * 0.12);
    return [
      Math.floor((minP - pad) / priceStep) * priceStep,
      Math.ceil((maxP + pad) / priceStep) * priceStep,
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

  const bybitPos: BybitPosition = useMemo(() => ({
    symbol: instrument.symbol,
    optionsType: instrument.optionsType,
    strike: instrument.strike,
    expiryTimestamp: instrument.expiryTimestamp,
    side: 'buy',
    entryPrice: bybitAsk,
    markIv: ticker.markIv,
    quantity: 0.01,
    entryFee: bybitFee,
  }), [instrument, ticker, bybitAsk, bybitFee]);

  const nowTs = useMemo(() => Math.floor(Date.now() / 1000), []);
  const polyTauNow = Math.max((polyExpiryTs - nowTs) / (365.25 * 24 * 3600), 0);

  const { combinedCurves, combinedLabels, polyNowCurve, polyExpiryCurve, bybitNowCurve, bybitExpiryCurve, totalEntryCost } = usePortfolioCurves({
    polyPositions: [polyPos],
    bybitPositions: [bybitPos],
    lowerPrice: priceRange[0],
    upperPrice: priceRange[1],
    polyTauNow,
    polyExpiryTs,
    optionType,
    deltaH: hDelta,
    smile: smile.length > 0 ? smile : undefined,
    bybitSmile: bybitSmile.length > 0 ? bybitSmile : undefined,
    numPoints: 500,
  });

  const evalDays = (match.tauEval * 365.25).toFixed(1);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {/* Position summary box */}
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, alignItems: 'flex-start' }}>
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
              Bybit
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {instrument.symbol} — buy ×0.01 @ ${bybitAsk.toFixed(2)} (${(bybitAsk * 0.01).toFixed(2)}, fee: ${bybitFee.toFixed(2)})
            </Typography>
          </Box>
        </Box>
        <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid rgba(139, 157, 195, 0.1)', display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="body2" sx={{ color: '#00D1FF', fontWeight: 600 }}>
            Net entry cost: ${totalEntryCost.toFixed(2)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Eval in {evalDays}d ({match.tauPolyRem > 0 ? `poly: ${(match.tauPolyRem * 365.25).toFixed(1)}d rem` : 'bybit: ' + (match.tauBybitRem * 365.25).toFixed(1) + 'd rem'})
          </Typography>
          <Typography variant="body2" sx={{ color: '#22C55E', fontWeight: 600 }}>
            Avg P&amp;L ±5%: +${match.avgPnl5.toFixed(2)} &nbsp;|&nbsp; ±10%: +${match.avgPnl10.toFixed(2)} &nbsp;|&nbsp; ±20%: +${match.avgPnl20.toFixed(2)}
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
        <Typography variant="caption" sx={{ color: 'rgba(139, 157, 195, 0.7)', display: 'block', mb: 1.5 }}>
          Price range: ${priceRange[0].toLocaleString()} — ${priceRange[1].toLocaleString()}
        </Typography>
        <Slider
          value={priceRange}
          onChange={(_, v) => setPriceRange(v as [number, number])}
          min={sliderBounds[0]}
          max={sliderBounds[1]}
          step={priceStep}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => `$${(v as number).toLocaleString()}`}
          sx={{ color: '#4A90D9' }}
        />
      </Paper>

      {/* H exponent offset slider */}
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        <Typography variant="caption" sx={{ color: 'rgba(139, 157, 195, 0.7)', display: 'block', mb: 1.5 }}>
          {'ΔH offset: '}{hDelta >= 0 ? '+' : ''}{hDelta.toFixed(2)}
          {' · >7d: H='}{autoH(10 / 365.25, hDelta).toFixed(2)}
          {' | 3–7d: H='}{autoH(5 / 365.25, hDelta).toFixed(2)}
          {' | <3d: H='}{autoH(1 / 365.25, hDelta).toFixed(2)}
        </Typography>
        <Slider
          value={hDelta}
          onChange={(_, v) => setHDelta(v as number)}
          min={-0.20}
          max={0.20}
          step={0.01}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => (v >= 0 ? '+' : '') + (v as number).toFixed(2)}
          sx={{ color: '#A78BFA' }}
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

  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), []);

  // Run optimization synchronously in useMemo (fast: 200 pts × ~100 options × ~15 strikes)
  const optResults = useMemo(() => {
    if (!polyMarkets.length || !bybitChain || spotPrice <= 0) return [];
    return runOptimization(polyMarkets, optionType, spotPrice, nowSec, bybitChain);
  }, [polyMarkets, optionType, spotPrice, bybitChain, nowSec]);

  const polyExpiryTs = polyEvent?.endDate ?? 0;
  const polyTauNow = useMemo(() => {
    return Math.max((polyExpiryTs - nowSec) / (365.25 * 24 * 3600), 0);
  }, [polyExpiryTs, nowSec]);

  // IV smile from poly markets (for chart viz)
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

  // Bybit IV smile (for chart viz)
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

  const handleViz = useCallback((strikeResult: StrikeOptResult, match: OptMatchResult, range: '5' | '10' | '20') => {
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

  const renderBybitCell = (strikeResult: StrikeOptResult, match: OptMatchResult | null, range: '5' | '10' | '20') => {
    if (!match) {
      return (
        <TableCell sx={{ verticalAlign: 'top', color: 'text.secondary', fontSize: '1.2rem' }}>
          —
        </TableCell>
      );
    }

    const { instrument, polyQty, noAskPrice, bybitAsk, bybitFee, avgPnl5, avgPnl10, avgPnl20 } = match;
    const avgPnl = range === '5' ? avgPnl5 : range === '10' ? avgPnl10 : avgPnl20;
    const totalCost = polyQty * noAskPrice + bybitAsk * 0.01 + bybitFee;
    const pct = totalCost > 0 ? (avgPnl / totalCost) * 100 : 0;
    const isSelected = vizSelection?.match === match && vizSelection?.range === range;

    return (
      <TableCell sx={{ verticalAlign: 'top' }}>
        <Box sx={{
          p: 1, borderRadius: 1,
          border: isSelected ? '1px solid rgba(0, 209, 255, 0.4)' : '1px solid transparent',
          bgcolor: isSelected ? 'rgba(0, 209, 255, 0.04)' : 'transparent',
        }}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#FF8C00', fontWeight: 600, mb: 0.5 }}>
            {instrument.symbol} — buy ×0.01
          </Typography>
          <Typography variant="body2" sx={{ fontSize: '0.72rem' }} color="text.secondary">
            @ ${bybitAsk.toFixed(0)} (${(bybitAsk * 0.01).toFixed(2)}, fee: ${bybitFee.toFixed(2)})
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#4A90D9', mt: 0.5 }}>
            Poly: NO ×{polyQty.toFixed(2)} @ {noAskPrice.toFixed(4)} (${(noAskPrice * polyQty).toFixed(2)})
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75 }}>
            <Typography variant="body2" sx={{ color: '#22C55E', fontWeight: 600, fontSize: '0.78rem' }}>
              Avg ±{range}%: +${avgPnl.toFixed(2)} (+{pct.toFixed(1)}%)
            </Typography>
            <IconButton
              size="small"
              onClick={() => handleViz(strikeResult, match, range)}
              sx={{
                ml: 'auto', p: 0.5,
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
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            {crypto && <Chip label={crypto} size="small" sx={{ bgcolor: 'rgba(247, 147, 26, 0.1)', color: '#F7931A', border: '1px solid rgba(247, 147, 26, 0.3)' }} />}
            {optionType && <Chip label={optionType === 'hit' ? 'One-Touch Barrier' : 'European Binary'} size="small" sx={{ bgcolor: 'rgba(0, 209, 255, 0.1)', color: '#00D1FF', border: '1px solid rgba(0, 209, 255, 0.3)' }} />}
            {expiryDate && <Chip label={`Poly: ${expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`} size="small" sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', color: '#8B9DC3', border: '1px solid rgba(139, 157, 195, 0.2)' }} />}
            {ttxSec > 0 && <Chip label={`TTX: ${formatTTX(ttxSec)}`} size="small" sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', color: '#8B9DC3', border: '1px solid rgba(139, 157, 195, 0.2)' }} />}
            {spotPrice > 0 && <Chip label={`Spot: $${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} size="small" sx={{ bgcolor: 'rgba(34, 197, 94, 0.1)', color: '#22C55E', border: '1px solid rgba(34, 197, 94, 0.3)' }} />}
            {bybitChain && <Chip label={`Bybit: ${bybitChain.expiryLabel}`} size="small" sx={{ bgcolor: 'rgba(255, 140, 0, 0.1)', color: '#FF8C00', border: '1px solid rgba(255, 140, 0, 0.3)' }} />}
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
                <TableCell sx={{ fontWeight: 700, width: '25%', color: '#22C55E' }}>Best ±5%</TableCell>
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
                    {renderBybitCell(result, result.best5, '5')}
                    {renderBybitCell(result, result.best10, '10')}
                    {renderBybitCell(result, result.best20, '20')}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Visualization section — rendered when a match is selected */}
      {vizSelection && (
        <VizCard
          strikeResult={vizSelection.strikeResult}
          match={vizSelection.match}
          optionType={optionType}
          spotPrice={spotPrice}
          smile={ivSmile}
          bybitSmile={bybitSmile}
          polyExpiryTs={polyExpiryTs}
          cryptoSymbol={crypto ?? 'BTC'}
        />
      )}

      <Typography variant="caption" sx={{ textAlign: 'center', color: 'rgba(139, 157, 195, 0.4)', pb: 1, mt: 'auto' }}>
        v{__APP_VERSION__}
      </Typography>
    </Box>
  );
}
