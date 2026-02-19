import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Box,
  Typography,
  Paper,
  IconButton,
  Chip,
  Slider,
  CircularProgress,
  Checkbox,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { ArrowBack, ExpandMore } from '@mui/icons-material';
import type {
  CryptoOption,
  OptionType,
  PolymarketPosition,
  BybitPosition,
  ParsedMarket,
  PolymarketEvent,
  BybitOptionChain as BybitChainType,
  Side,
  BybitSide,
} from '../types';
import { solveImpliedVol, type SmilePoint } from '../pricing/engine';
import { ProjectionChart } from './ProjectionChart';
import { usePortfolioCurves } from '../hooks/usePortfolioCurves';

interface ChartScreenProps {
  polyEvent: PolymarketEvent | null;
  polyMarkets: ParsedMarket[];
  crypto: CryptoOption | null;
  optionType: OptionType;
  spotPrice: number;
  bybitChain: BybitChainType | null;
  onBack: () => void;
}

function roundTo3Zeros(value: number, direction: 'down' | 'up'): number {
  if (value <= 0) return 0;
  const magnitude = Math.pow(10, Math.max(0, Math.floor(Math.log10(value)) - 1));
  const rounded = magnitude >= 1000 ? Math.round(magnitude / 1000) * 1000 : magnitude;
  const unit = Math.max(rounded, 1000);
  return direction === 'down'
    ? Math.floor(value / unit) * unit
    : Math.ceil(value / unit) * unit;
}

function formatTimeToExpiry(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

// --- Poly selection helpers ---
function polySelKey(marketId: string, side: Side): string {
  return `${marketId}-${side}`;
}

// --- Bybit selection helpers ---
interface BybitSelectedOption {
  side: BybitSide;
  quantity: number;
}

export function ChartScreen({
  polyEvent,
  polyMarkets,
  crypto,
  optionType,
  spotPrice,
  bybitChain,
  onBack,
}: ChartScreenProps) {
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';

  const [priceRange, setPriceRange] = useState<[number, number]>([0, 0]);
  const [sliderBounds, setSliderBounds] = useState<[number, number]>([0, 0]);
  const [hExponent, setHExponent] = useState(0.5);

  // --- Poly position state (moved from PolymarketPanel) ---
  const [polySelections, setPolySelections] = useState<Map<string, number>>(new Map());

  const handlePolyToggle = useCallback((marketId: string, side: Side) => {
    setPolySelections(prev => {
      const next = new Map(prev);
      const key = polySelKey(marketId, side);
      if (next.has(key)) next.delete(key);
      else next.set(key, 1);
      return next;
    });
  }, []);

  const handlePolyQtyChange = useCallback((marketId: string, side: Side, qty: number) => {
    setPolySelections(prev => {
      const next = new Map(prev);
      const key = polySelKey(marketId, side);
      if (qty > 0) next.set(key, qty);
      else next.delete(key);
      return next;
    });
  }, []);

  const polyPositions: PolymarketPosition[] = useMemo(() => {
    if (!spotPrice || !polyEvent) return [];
    const nowTs = Math.floor(Date.now() / 1000);
    const tauNow = Math.max((polyEvent.endDate - nowTs) / (365.25 * 24 * 3600), 0);
    if (tauNow <= 0) return [];

    const result: PolymarketPosition[] = [];
    for (const [key, quantity] of polySelections) {
      const dashIdx = key.indexOf('-');
      const marketId = key.slice(0, dashIdx);
      const sideStr = key.slice(dashIdx + 1) as Side;
      const market = polyMarkets.find(m => m.id === marketId);
      if (!market || market.strikePrice <= 0) continue;

      const isUpBarrier = market.strikePrice > spotPrice;
      const iv = solveImpliedVol(spotPrice, market.strikePrice, tauNow, market.currentPrice, optionType, isUpBarrier, 0.5);
      const entryPrice = sideStr === 'YES' ? market.currentPrice : (1 - market.currentPrice);

      result.push({
        marketId: market.id,
        question: market.question,
        groupItemTitle: market.groupItemTitle,
        strikePrice: market.strikePrice,
        side: sideStr,
        entryPrice,
        impliedVol: iv ?? 0.5,
        isUpBarrier,
        quantity,
      });
    }
    return result;
  }, [polyMarkets, polySelections, spotPrice, polyEvent, optionType]);

  // --- Bybit position state (moved from BybitOptionChain) ---
  const [bybitSelections, setBybitSelections] = useState<Map<string, BybitSelectedOption>>(new Map());

  const handleBybitSideToggle = useCallback((symbol: string, newSide: BybitSide | null) => {
    setBybitSelections(prev => {
      const next = new Map(prev);
      if (!newSide) {
        next.delete(symbol);
      } else {
        const existing = next.get(symbol);
        next.set(symbol, { side: newSide, quantity: existing?.quantity ?? 1 });
      }
      return next;
    });
  }, []);

  const handleBybitQtyChange = useCallback((symbol: string, qty: number) => {
    setBybitSelections(prev => {
      const next = new Map(prev);
      const existing = next.get(symbol);
      if (existing && qty > 0) {
        next.set(symbol, { ...existing, quantity: qty });
      } else {
        next.delete(symbol);
      }
      return next;
    });
  }, []);

  const bybitStrikeRows = useMemo(() => {
    if (!bybitChain) return [];
    const strikeMap = new Map<number, { call?: string; put?: string }>();
    for (const inst of bybitChain.instruments) {
      const entry = strikeMap.get(inst.strike) || {};
      if (inst.optionsType === 'Call') entry.call = inst.symbol;
      else entry.put = inst.symbol;
      strikeMap.set(inst.strike, entry);
    }
    return Array.from(strikeMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([strike, syms]) => ({ strike, ...syms }));
  }, [bybitChain]);

  const bybitPositions: BybitPosition[] = useMemo(() => {
    if (!bybitChain) return [];
    const result: BybitPosition[] = [];
    for (const [symbol, sel] of bybitSelections) {
      const ticker = bybitChain.tickers.get(symbol);
      const inst = bybitChain.instruments.find(i => i.symbol === symbol);
      if (!ticker || !inst) continue;

      result.push({
        symbol,
        optionsType: inst.optionsType,
        strike: inst.strike,
        expiryTimestamp: inst.expiryTimestamp,
        side: sel.side,
        entryPrice: sel.side === 'buy' ? ticker.ask1Price : ticker.bid1Price,
        markIv: ticker.markIv,
        quantity: sel.quantity,
      });
    }
    return result;
  }, [bybitSelections, bybitChain]);

  // Compute slider bounds from all strikes (poly + bybit)
  useEffect(() => {
    const strikes: number[] = [];
    for (const p of polyPositions) strikes.push(p.strikePrice);
    for (const b of bybitPositions) strikes.push(b.strike);
    if (spotPrice > 0) strikes.push(spotPrice);

    if (strikes.length === 0) return;
    const min = Math.min(...strikes);
    const max = Math.max(...strikes);
    const lower = roundTo3Zeros(min * 0.85, 'down');
    const upper = roundTo3Zeros(max * 1.15, 'up');
    setSliderBounds([lower, upper]);
    setPriceRange([lower, upper]);
  }, [polyPositions, bybitPositions, spotPrice]);

  // Poly expiry
  const polyExpiryTs = polyEvent?.endDate ?? 0;
  const nowTs = Math.floor(Date.now() / 1000);
  const polyTimeToExpirySec = polyExpiryTs > 0 ? polyExpiryTs - nowTs : 0;
  const polyTauNow = Math.max(polyTimeToExpirySec / (365.25 * 24 * 3600), 0);

  // Build IV smile from all poly markets
  const ivSmile: SmilePoint[] = useMemo(() => {
    if (!spotPrice || polyTauNow <= 0 || polyMarkets.length === 0) return [];

    const points: SmilePoint[] = [];
    for (const market of polyMarkets) {
      if (market.strikePrice <= 0 || market.currentPrice <= 0.001 || market.currentPrice >= 0.999) continue;
      const isUpBarrier = market.strikePrice > spotPrice;
      const iv = solveImpliedVol(spotPrice, market.strikePrice, polyTauNow, market.currentPrice, optionType, isUpBarrier, hExponent);
      if (iv !== null) {
        points.push({ moneyness: Math.log(spotPrice / market.strikePrice), iv });
      }
    }
    return points.sort((a, b) => a.moneyness - b.moneyness);
  }, [polyMarkets, spotPrice, polyTauNow, optionType, hExponent]);

  // Compute all curves
  const {
    combinedCurves,
    combinedLabels,
    polyNowCurve,
    polyExpiryCurve,
    bybitNowCurve,
    bybitExpiryCurve,
    totalEntryCost,
  } = usePortfolioCurves({
    polyPositions,
    bybitPositions,
    lowerPrice: priceRange[0],
    upperPrice: priceRange[1],
    polyTauNow,
    polyExpiryTs,
    optionType,
    H: hExponent,
    smile: ivSmile.length > 0 ? ivSmile : undefined,
  });

  const handleSliderChange = useCallback((_: unknown, value: number | number[]) => {
    setPriceRange(value as [number, number]);
  }, []);

  const handleHChange = useCallback((_: unknown, value: number | number[]) => {
    setHExponent(value as number);
  }, []);

  const sliderStep = useMemo(() => {
    const range = sliderBounds[1] - sliderBounds[0];
    if (range > 100000) return 1000;
    if (range > 10000) return 100;
    if (range > 1000) return 10;
    return 1;
  }, [sliderBounds]);

  const hasData = combinedCurves.length > 0 && combinedCurves[0].length > 0;
  const expiryDate = polyEvent ? new Date(polyEvent.endDate * 1000) : null;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', p: 3, gap: 3 }}>
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
            Portfolio P&L
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            {crypto && <Chip label={crypto} size="small" sx={{ bgcolor: 'rgba(247, 147, 26, 0.1)', color: '#F7931A', border: '1px solid rgba(247, 147, 26, 0.3)' }} />}
            {polyPositions.length > 0 && <Chip label={`Poly: ${polyPositions.length} pos`} size="small" sx={{ bgcolor: 'rgba(74, 144, 217, 0.1)', color: '#4A90D9', border: '1px solid rgba(74, 144, 217, 0.3)' }} />}
            {bybitPositions.length > 0 && <Chip label={`Bybit: ${bybitPositions.length} pos`} size="small" sx={{ bgcolor: 'rgba(255, 140, 0, 0.1)', color: '#FF8C00', border: '1px solid rgba(255, 140, 0, 0.3)' }} />}
            {expiryDate && <Chip label={`Poly Exp: ${expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`} size="small" sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', color: '#8B9DC3', border: '1px solid rgba(139, 157, 195, 0.2)' }} />}
            {polyTimeToExpirySec > 0 && <Chip label={`TTX: ${formatTimeToExpiry(polyTimeToExpirySec)}`} size="small" sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', color: '#8B9DC3', border: '1px solid rgba(139, 157, 195, 0.2)' }} />}
            <Chip label={`Spot: $${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} size="small" sx={{ bgcolor: 'rgba(34, 197, 94, 0.1)', color: '#22C55E', border: '1px solid rgba(34, 197, 94, 0.3)' }} />
          </Box>
        </Box>
      </Box>

      {/* Polymarket strike selection */}
      {polyMarkets.length > 0 && (
        <Accordion defaultExpanded elevation={0} sx={{ border: '1px solid rgba(139, 157, 195, 0.15)', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Typography sx={{ fontWeight: 600, color: '#4A90D9' }}>Polymarket Strikes</Typography>
          </AccordionSummary>
          <AccordionDetails>
            {/* Header */}
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 100px 100px 80px', gap: 1, mb: 1, px: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>Strike</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>YES</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>NO</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Qty</Typography>
            </Box>

            {polyMarkets.map(market => {
              const yesKey = polySelKey(market.id, 'YES');
              const noKey = polySelKey(market.id, 'NO');
              const yesSelected = polySelections.has(yesKey);
              const noSelected = polySelections.has(noKey);
              const activeKey = yesSelected ? yesKey : noSelected ? noKey : null;
              const qty = activeKey ? (polySelections.get(activeKey) ?? 1) : 1;

              return (
                <Box key={market.id} sx={{
                  display: 'grid', gridTemplateColumns: '1fr 100px 100px 80px', gap: 1, alignItems: 'center', px: 1, py: 0.5,
                  borderBottom: '1px solid rgba(139, 157, 195, 0.06)',
                  bgcolor: (yesSelected || noSelected) ? 'rgba(0, 209, 255, 0.03)' : 'transparent',
                  '&:hover': { bgcolor: 'rgba(139, 157, 195, 0.04)' },
                }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {market.groupItemTitle || market.question}
                  </Typography>

                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5 }}>
                    <Checkbox checked={yesSelected} onChange={() => handlePolyToggle(market.id, 'YES')} size="small" sx={{ '&.Mui-checked': { color: '#22C55E' }, p: 0.5 }} />
                    <Typography variant="body2" sx={{ color: yesSelected ? '#22C55E' : 'text.secondary', fontSize: '0.875rem', minWidth: 35, textAlign: 'right' }}>
                      {(market.currentPrice * 100).toFixed(1)}
                    </Typography>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5 }}>
                    <Checkbox checked={noSelected} onChange={() => handlePolyToggle(market.id, 'NO')} size="small" sx={{ '&.Mui-checked': { color: '#EF4444' }, p: 0.5 }} />
                    <Typography variant="body2" sx={{ color: noSelected ? '#EF4444' : 'text.secondary', fontSize: '0.875rem', minWidth: 35, textAlign: 'right' }}>
                      {((1 - market.currentPrice) * 100).toFixed(1)}
                    </Typography>
                  </Box>

                  <TextField
                    type="number"
                    size="small"
                    value={activeKey ? qty : ''}
                    disabled={!activeKey}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10);
                      if (yesSelected) handlePolyQtyChange(market.id, 'YES', isNaN(v) ? 0 : v);
                      else if (noSelected) handlePolyQtyChange(market.id, 'NO', isNaN(v) ? 0 : v);
                    }}
                    inputProps={{ min: 1, style: { textAlign: 'center', padding: '4px 8px' } }}
                    sx={{ '& .MuiOutlinedInput-root': { backgroundColor: 'transparent' } }}
                  />
                </Box>
              );
            })}
          </AccordionDetails>
        </Accordion>
      )}

      {/* Bybit strike selection */}
      {bybitChain && bybitStrikeRows.length > 0 && (
        <Accordion defaultExpanded elevation={0} sx={{ border: '1px solid rgba(139, 157, 195, 0.15)', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Typography sx={{ fontWeight: 600, color: '#FF8C00' }}>
              Bybit Strikes — {bybitChain.expiryLabel}
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box sx={{ maxHeight: 400, overflowY: 'auto' }}>
              {/* Header */}
              <Box sx={{
                display: 'grid', gridTemplateColumns: '1fr 120px 60px 80px 120px 60px 80px',
                gap: 1, mb: 1, px: 1, position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1,
              }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Strike</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Call</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Delta</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Qty</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Put</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Delta</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Qty</Typography>
              </Box>

              {bybitStrikeRows.map(row => {
                const callTicker = row.call ? bybitChain.tickers.get(row.call) : null;
                const putTicker = row.put ? bybitChain.tickers.get(row.put) : null;
                const isITMCall = spotPrice > row.strike;
                const isITMPut = spotPrice < row.strike;
                const callSel = row.call ? bybitSelections.get(row.call) : undefined;
                const putSel = row.put ? bybitSelections.get(row.put) : undefined;

                return (
                  <Box key={row.strike} sx={{
                    display: 'grid', gridTemplateColumns: '1fr 120px 60px 80px 120px 60px 80px',
                    gap: 1, alignItems: 'center', px: 1, py: 0.5,
                    borderBottom: '1px solid rgba(139, 157, 195, 0.06)',
                    bgcolor: (callSel || putSel) ? 'rgba(0, 209, 255, 0.03)' : 'transparent',
                  }}>
                    {/* Strike */}
                    <Typography variant="body2" sx={{
                      fontWeight: 600, textAlign: 'center',
                      color: (isITMCall || isITMPut) ? '#FFB020' : 'text.primary',
                    }}>
                      ${row.strike.toLocaleString()}
                    </Typography>

                    {/* Call buy/sell */}
                    {row.call && callTicker ? (
                      <>
                        <ToggleButtonGroup
                          size="small"
                          exclusive
                          value={callSel?.side ?? null}
                          onChange={(_, v) => handleBybitSideToggle(row.call!, v)}
                          sx={{ justifyContent: 'center' }}
                        >
                          <ToggleButton value="buy" sx={{ px: 1, py: 0.25, fontSize: '0.7rem', color: '#22C55E', '&.Mui-selected': { bgcolor: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' } }}>
                            {callTicker.ask1Price.toFixed(0)}
                          </ToggleButton>
                          <ToggleButton value="sell" sx={{ px: 1, py: 0.25, fontSize: '0.7rem', color: '#EF4444', '&.Mui-selected': { bgcolor: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' } }}>
                            {callTicker.bid1Price.toFixed(0)}
                          </ToggleButton>
                        </ToggleButtonGroup>
                        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                          {callTicker.delta.toFixed(2)}
                        </Typography>
                        <TextField
                          type="number"
                          size="small"
                          value={callSel ? callSel.quantity : ''}
                          disabled={!callSel}
                          onChange={e => {
                            const v = parseInt(e.target.value, 10);
                            if (row.call) handleBybitQtyChange(row.call, isNaN(v) ? 0 : v);
                          }}
                          inputProps={{ min: 1, style: { textAlign: 'center', padding: '2px 4px', fontSize: '0.75rem' } }}
                          sx={{ '& .MuiOutlinedInput-root': { backgroundColor: 'transparent' } }}
                        />
                      </>
                    ) : (
                      <><Box /><Box /><Box /></>
                    )}

                    {/* Put buy/sell */}
                    {row.put && putTicker ? (
                      <>
                        <ToggleButtonGroup
                          size="small"
                          exclusive
                          value={putSel?.side ?? null}
                          onChange={(_, v) => handleBybitSideToggle(row.put!, v)}
                          sx={{ justifyContent: 'center' }}
                        >
                          <ToggleButton value="buy" sx={{ px: 1, py: 0.25, fontSize: '0.7rem', color: '#22C55E', '&.Mui-selected': { bgcolor: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' } }}>
                            {putTicker.ask1Price.toFixed(0)}
                          </ToggleButton>
                          <ToggleButton value="sell" sx={{ px: 1, py: 0.25, fontSize: '0.7rem', color: '#EF4444', '&.Mui-selected': { bgcolor: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' } }}>
                            {putTicker.bid1Price.toFixed(0)}
                          </ToggleButton>
                        </ToggleButtonGroup>
                        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                          {putTicker.delta.toFixed(2)}
                        </Typography>
                        <TextField
                          type="number"
                          size="small"
                          value={putSel ? putSel.quantity : ''}
                          disabled={!putSel}
                          onChange={e => {
                            const v = parseInt(e.target.value, 10);
                            if (row.put) handleBybitQtyChange(row.put, isNaN(v) ? 0 : v);
                          }}
                          inputProps={{ min: 1, style: { textAlign: 'center', padding: '2px 4px', fontSize: '0.75rem' } }}
                          sx={{ '& .MuiOutlinedInput-root': { backgroundColor: 'transparent' } }}
                        />
                      </>
                    ) : (
                      <><Box /><Box /><Box /></>
                    )}
                  </Box>
                );
              })}
            </Box>
          </AccordionDetails>
        </Accordion>
      )}

      {/* Chart */}
      <Paper elevation={0} sx={{ flex: 1, minHeight: 500, p: 3, border: '1px solid rgba(139, 157, 195, 0.15)' }}>
        {!hasData ? (
          <Box sx={{ height: '100%', minHeight: 440, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 2, color: 'text.secondary' }}>
            {polyPositions.length === 0 && bybitPositions.length === 0 ? (
              <Typography variant="body2">Select at least one position above to see the P&L chart</Typography>
            ) : (
              <>
                <CircularProgress />
                <Typography variant="body2">Computing curves...</Typography>
              </>
            )}
          </Box>
        ) : (
          <ProjectionChart
            combinedCurves={combinedCurves}
            combinedLabels={combinedLabels}
            polyNowCurve={polyPositions.length > 0 && bybitPositions.length > 0 ? polyNowCurve : undefined}
            polyExpiryCurve={polyPositions.length > 0 && bybitPositions.length > 0 ? polyExpiryCurve : undefined}
            bybitNowCurve={polyPositions.length > 0 && bybitPositions.length > 0 ? bybitNowCurve : undefined}
            bybitExpiryCurve={polyPositions.length > 0 && bybitPositions.length > 0 ? bybitExpiryCurve : undefined}
            currentCryptoPrice={spotPrice}
            cryptoSymbol={crypto || 'BTC'}
            totalEntryCost={totalEntryCost}
          />
        )}

        {/* Price Range Slider */}
        {sliderBounds[1] > sliderBounds[0] && (
          <Box sx={{ mt: 2, pt: 2, px: 3, borderTop: '1px solid rgba(139, 157, 195, 0.1)' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="body2" color="text.secondary">${priceRange[0].toLocaleString()}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>BTC Price Range</Typography>
              <Typography variant="body2" color="text.secondary">${priceRange[1].toLocaleString()}</Typography>
            </Box>
            <Slider
              value={priceRange}
              onChange={handleSliderChange}
              min={sliderBounds[0]}
              max={sliderBounds[1]}
              step={sliderStep}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `$${v.toLocaleString()}`}
              sx={{
                color: '#00D1FF',
                '& .MuiSlider-thumb': { bgcolor: '#00D1FF', '&:hover': { boxShadow: '0 0 8px rgba(0, 209, 255, 0.4)' } },
                '& .MuiSlider-track': { bgcolor: '#00D1FF' },
                '& .MuiSlider-rail': { bgcolor: 'rgba(139, 157, 195, 0.2)' },
              }}
            />
          </Box>
        )}
      </Paper>

      {/* H Exponent Slider (Polymarket only) */}
      {polyPositions.length > 0 && (
        <Paper elevation={0} sx={{ p: 3, border: '1px solid rgba(139, 157, 195, 0.15)' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="body2" color="text.secondary">0.40</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
              Time Exponent H = {hExponent.toFixed(2)} (Polymarket curves)
            </Typography>
            <Typography variant="body2" color="text.secondary">0.80</Typography>
          </Box>
          <Slider
            value={hExponent}
            onChange={handleHChange}
            min={0.4}
            max={0.8}
            step={0.01}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) => v.toFixed(2)}
            sx={{
              color: '#A78BFA',
              '& .MuiSlider-thumb': { bgcolor: '#A78BFA', '&:hover': { boxShadow: '0 0 8px rgba(167, 139, 250, 0.4)' } },
              '& .MuiSlider-track': { bgcolor: '#A78BFA' },
              '& .MuiSlider-rail': { bgcolor: 'rgba(139, 157, 195, 0.2)' },
            }}
          />
        </Paper>
      )}

      {/* Position summary */}
      {(polyPositions.length > 0 || bybitPositions.length > 0) && (
        <Paper elevation={0} sx={{ p: 3, border: '1px solid rgba(139, 157, 195, 0.15)' }}>
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>Positions</Typography>

          {polyPositions.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ color: '#4A90D9', fontWeight: 600, mb: 1 }}>Polymarket</Typography>
              {polyPositions.map((pos, i) => (
                <Typography key={i} variant="body2" color="text.secondary" sx={{ pl: 2 }}>
                  {pos.groupItemTitle} — {pos.side} x{pos.quantity} @ {pos.entryPrice.toFixed(4)}
                </Typography>
              ))}
            </Box>
          )}

          {bybitPositions.length > 0 && (
            <Box>
              <Typography variant="body2" sx={{ color: '#FF8C00', fontWeight: 600, mb: 1 }}>Bybit</Typography>
              {bybitPositions.map((pos, i) => (
                <Typography key={i} variant="body2" color="text.secondary" sx={{ pl: 2 }}>
                  {pos.symbol} — {pos.side} x{pos.quantity} @ ${pos.entryPrice.toFixed(2)}
                </Typography>
              ))}
            </Box>
          )}

          <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid rgba(139, 157, 195, 0.15)', display: 'flex', gap: 3, justifyContent: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              Total positions: {polyPositions.length + bybitPositions.length}
            </Typography>
            <Typography variant="body2" sx={{ color: '#00D1FF', fontWeight: 600 }}>
              Net entry cost: ${totalEntryCost.toFixed(2)}
            </Typography>
          </Box>
        </Paper>
      )}
    </Box>
  );
}
