import { useState, useMemo, useCallback, useRef } from 'react';
import {
  Box, Typography, Paper, IconButton, Chip, CircularProgress,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Slider, Tooltip,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { ArrowBack, BarChart, PhotoCamera, InfoOutlined, OpenInNew } from '@mui/icons-material';
import type {
  CryptoOption, ParsedMarket, PolymarketEvent,
  BybitOptionChain as BybitChainType,
  PolymarketPosition, BybitPosition, ExtendedMatch,
} from '../types';
import { solveImpliedVol, autoH, type SmilePoint } from '../pricing/engine';
import { runExtendedOptimization } from '../optimization/extendedOptimizer';
import { ProjectionChart } from './ProjectionChart';
import { usePortfolioCurves } from '../hooks/usePortfolioCurves';

interface OptimizationScreenProps {
  polyEvent: PolymarketEvent | null;
  polyMarkets: ParsedMarket[];
  crypto: CryptoOption | null;
  spotPrice: number;
  bybitChain: BybitChainType | null;
  polyUrl?: string;
  onBack: () => void;
}

function toVisualizationPositions(match: ExtendedMatch, spotPrice: number): {
  polyPositions: PolymarketPosition[];
  bybitPositions: BybitPosition[];
} {
  const {
    polyUpperMarket, polyLowerMarket,
    polyUpperQty, polyLowerQty,
    polyUpperNoEntry, polyLowerNoEntry,
    polyUpperIv, polyLowerIv,
    longCallInstrument, longPutInstrument,
    shortCallInstrument, shortPutInstrument,
    longQty, shortCallQty, shortPutQty,
    longCallEntry, longPutEntry, shortCallEntry, shortPutEntry,
  } = match;

  const polyPositions: PolymarketPosition[] = [];
  if (polyUpperQty > 0) {
    polyPositions.push({
      marketId: polyUpperMarket.id, question: polyUpperMarket.question,
      groupItemTitle: polyUpperMarket.groupItemTitle, strikePrice: polyUpperMarket.strikePrice,
      side: 'NO', entryPrice: polyUpperNoEntry, impliedVol: polyUpperIv,
      isUpBarrier: true, quantity: polyUpperQty,
    });
  }
  if (polyLowerQty > 0) {
    polyPositions.push({
      marketId: polyLowerMarket.id, question: polyLowerMarket.question,
      groupItemTitle: polyLowerMarket.groupItemTitle, strikePrice: polyLowerMarket.strikePrice,
      side: 'NO', entryPrice: polyLowerNoEntry, impliedVol: polyLowerIv,
      isUpBarrier: false, quantity: polyLowerQty,
    });
  }
  const fee = (p: number, q: number) => Math.min(0.0003 * spotPrice, 0.07 * p) * q;
  const bybitPositions: BybitPosition[] = [
    { symbol: longCallInstrument.symbol, optionsType: 'Call', strike: longCallInstrument.strike, expiryTimestamp: longCallInstrument.expiryTimestamp, side: 'buy', entryPrice: longCallEntry, markIv: 0.5, quantity: longQty, entryFee: fee(longCallEntry, longQty) },
    { symbol: longPutInstrument.symbol, optionsType: 'Put', strike: longPutInstrument.strike, expiryTimestamp: longPutInstrument.expiryTimestamp, side: 'buy', entryPrice: longPutEntry, markIv: 0.5, quantity: longQty, entryFee: fee(longPutEntry, longQty) },
    { symbol: shortCallInstrument.symbol, optionsType: 'Call', strike: shortCallInstrument.strike, expiryTimestamp: shortCallInstrument.expiryTimestamp, side: 'sell', entryPrice: shortCallEntry, markIv: 0.5, quantity: shortCallQty, entryFee: fee(shortCallEntry, shortCallQty) },
    { symbol: shortPutInstrument.symbol, optionsType: 'Put', strike: shortPutInstrument.strike, expiryTimestamp: shortPutInstrument.expiryTimestamp, side: 'sell', entryPrice: shortPutEntry, markIv: 0.5, quantity: shortPutQty, entryFee: fee(shortPutEntry, shortPutQty) },
  ];
  return { polyPositions, bybitPositions };
}

function VizCard({ match, spotPrice, smile, bybitSmile, polyExpiryTs, cryptoSymbol, polyUrl, bybitChain }: {
  match: ExtendedMatch; spotPrice: number; smile: SmilePoint[]; bybitSmile: SmilePoint[];
  polyExpiryTs: number; cryptoSymbol: string; polyUrl?: string; bybitChain: BybitChainType | null;
}) {
  const isDark = useTheme().palette.mode === 'dark';
  const allStrikes = [match.polyLowerMarket.strikePrice, match.shortPutStrike, match.longStrike, match.shortCallStrike, match.polyUpperMarket.strikePrice, spotPrice];
  const minS = Math.min(...allStrikes);
  const maxS = Math.max(...allStrikes);
  const pad = Math.max((maxS - minS) * 0.25, spotPrice * 0.15);
  const sliderBounds: [number, number] = [Math.floor((minS - pad) / 100) * 100, Math.ceil((maxS + pad) / 100) * 100];
  const sliderStep = useMemo(() => {
    const r = sliderBounds[1] - sliderBounds[0];
    return r > 100000 ? 1000 : r > 10000 ? 100 : 10;
  }, [sliderBounds]);
  const [priceRange, setPriceRange] = useState<[number, number]>(() => {
    const ip = Math.max((maxS - minS) * 0.15, spotPrice * 0.10);
    return [Math.floor((minS - ip) / 100) * 100, Math.ceil((maxS + ip) / 100) * 100];
  });
  const [polyIvMult, setPolyIvMult] = useState(1.00);
  const scaledSmile = useMemo(() => smile.map(pt => ({ ...pt, iv: pt.iv * polyIvMult })), [smile, polyIvMult]);
  const { polyPositions, bybitPositions } = useMemo(() => toVisualizationPositions(match, spotPrice), [match, spotPrice]);
  const bybitPositionsWithIv = useMemo(() => {
    if (!bybitChain) return bybitPositions;
    return bybitPositions.map(pos => {
      const t = bybitChain.tickers.get(pos.symbol);
      return t ? { ...pos, markIv: t.markIv } : pos;
    });
  }, [bybitPositions, bybitChain]);
  const nowTs = useMemo(() => Math.floor(Date.now() / 1000), []);
  const polyTauNow = Math.max((polyExpiryTs - nowTs) / (365.25 * 24 * 3600), 0);
  const { combinedCurves, combinedLabels, polyNowCurve, polyExpiryCurve, bybitNowCurve, bybitExpiryCurve, polyAtBybitExpiryCurve, polyEntryCost, bybitEntryCost, totalEntryCost } = usePortfolioCurves({
    polyPositions, bybitPositions: bybitPositionsWithIv,
    lowerPrice: priceRange[0], upperPrice: priceRange[1],
    polyTauNow, polyExpiryTs, optionType: 'hit',
    smile: scaledSmile.length > 0 ? scaledSmile : undefined,
    bybitSmile: bybitSmile.length > 0 ? bybitSmile : undefined,
    numPoints: 500,
  });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#4A90D9', borderBottom: '2px solid rgba(74, 144, 217, 0.35)', pb: 0.5, mb: 1 }}>Upper NO</Typography>
            <Typography variant="body2" color="text.secondary">
              ${match.polyUpperMarket.strikePrice.toLocaleString()} HIT &mdash; NO &times;{match.polyUpperQty.toFixed(2)} @ {match.polyUpperNoEntry.toFixed(4)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#FF8C00', borderBottom: '2px solid rgba(255, 140, 0, 0.35)', pb: 0.5, mb: 1 }}>Long Call</Typography>
            <Typography variant="body2" color="text.secondary">
              {match.longCallInstrument.symbol} &times;{match.longQty} @ ${match.longCallEntry.toFixed(2)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#EF4444', borderBottom: '2px solid rgba(239, 68, 68, 0.35)', pb: 0.5, mb: 1 }}>Short Call</Typography>
            <Typography variant="body2" color="text.secondary">
              {match.shortCallInstrument.symbol} &times;{match.shortCallQty} @ ${match.shortCallEntry.toFixed(2)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#4A90D9', borderBottom: '2px solid rgba(74, 144, 217, 0.35)', pb: 0.5, mb: 1 }}>Lower NO</Typography>
            <Typography variant="body2" color="text.secondary">
              ${match.polyLowerMarket.strikePrice.toLocaleString()} HIT &mdash; NO &times;{match.polyLowerQty.toFixed(2)} @ {match.polyLowerNoEntry.toFixed(4)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#FF8C00', borderBottom: '2px solid rgba(255, 140, 0, 0.35)', pb: 0.5, mb: 1 }}>Long Put</Typography>
            <Typography variant="body2" color="text.secondary">
              {match.longPutInstrument.symbol} &times;{match.longQty} @ ${match.longPutEntry.toFixed(2)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#EF4444', borderBottom: '2px solid rgba(239, 68, 68, 0.35)', pb: 0.5, mb: 1 }}>Short Put</Typography>
            <Typography variant="body2" color="text.secondary">
              {match.shortPutInstrument.symbol} &times;{match.shortPutQty} @ ${match.shortPutEntry.toFixed(2)}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid rgba(139, 157, 195, 0.1)', display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ color: '#00D1FF', fontWeight: 600 }}>Net entry: ${totalEntryCost.toFixed(2)}</Typography>
          <Typography variant="body2" sx={{ color: '#22C55E', fontWeight: 600 }}>
            NOW @ barriers: {match.avgPnl1pct >= 0 ? '+' : ''}{match.avgPnl1pct.toFixed(2)} &nbsp;|&nbsp; EXPIRY @ barriers: {match.avgPnl7pct >= 0 ? '+' : ''}{match.avgPnl7pct.toFixed(2)}
          </Typography>
          <Typography variant="body2" sx={{ color: match.maxLoss < 0 ? '#EF4444' : '#22C55E', fontWeight: 600 }}>
            Max loss: ${match.maxLoss.toFixed(2)}
          </Typography>
          {polyUrl && (
            <Typography component="a" href={`${polyUrl}?via=delta`} target="_blank" rel="noopener noreferrer"
              variant="body2" sx={{ color: '#4A90D9', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
              Open on Polymarket
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.72rem' }}>
            Poly: ${polyEntryCost.toFixed(2)} | Bybit net: ${bybitEntryCost.toFixed(2)}
          </Typography>
        </Box>
      </Paper>
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        {combinedCurves.length > 0 && combinedCurves[0].length > 0 ? (
          <ProjectionChart
            combinedCurves={combinedCurves} combinedLabels={combinedLabels}
            polyNowCurve={polyNowCurve} polyExpiryCurve={polyExpiryCurve}
            bybitNowCurve={bybitNowCurve} bybitExpiryCurve={bybitExpiryCurve}
            polyAtBybitExpiryCurve={polyAtBybitExpiryCurve}
            polyEntryCost={polyEntryCost} bybitEntryCost={bybitEntryCost}
            currentCryptoPrice={spotPrice} cryptoSymbol={cryptoSymbol} totalEntryCost={totalEntryCost}
          />
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400, color: isDark ? 'rgba(139, 157, 195, 0.5)' : 'rgba(0,0,0,0.3)' }}>
            <CircularProgress size={24} sx={{ mr: 2 }} /><Typography variant="body2">Computing curves...</Typography>
          </Box>
        )}
      </Paper>
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2" color="text.secondary">${priceRange[0].toLocaleString()}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>{cryptoSymbol} Price Range</Typography>
          <Typography variant="body2" color="text.secondary">${priceRange[1].toLocaleString()}</Typography>
        </Box>
        <Slider value={priceRange} onChange={(_, v) => setPriceRange(v as [number, number])}
          min={sliderBounds[0]} max={sliderBounds[1]} step={sliderStep}
          valueLabelDisplay="auto" valueLabelFormat={(v) => `$${(v as number).toLocaleString()}`}
          sx={{ color: '#00D1FF', '& .MuiSlider-thumb': { bgcolor: '#00D1FF' }, '& .MuiSlider-track': { bgcolor: '#00D1FF' }, '& .MuiSlider-rail': { bgcolor: 'rgba(139, 157, 195, 0.2)' } }}
        />
      </Paper>
      <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="body2" color="text.secondary">&times;0.25</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>Poly IV: &times;{polyIvMult.toFixed(2)}</Typography>
            <Tooltip title={<Box sx={{ p: 0.5 }}><Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>Poly IV Multiplier</Typography><Typography variant="caption" display="block">Scales Polymarket IVs. &times;1.00 = market-calibrated.</Typography></Box>} placement="top" arrow>
              <InfoOutlined sx={{ fontSize: 15, color: 'text.secondary', opacity: 0.6, cursor: 'help' }} />
            </Tooltip>
          </Box>
          <Typography variant="body2" color="text.secondary">&times;4.00</Typography>
        </Box>
        <Slider value={polyIvMult} onChange={(_, v) => setPolyIvMult(v as number)}
          min={0.25} max={4.00} step={0.05} valueLabelDisplay="auto"
          valueLabelFormat={(v) => `\u00d7${(v as number).toFixed(2)}`}
          sx={{ color: '#A78BFA', '& .MuiSlider-thumb': { bgcolor: '#A78BFA' }, '& .MuiSlider-track': { bgcolor: '#A78BFA' }, '& .MuiSlider-rail': { bgcolor: 'rgba(139, 157, 195, 0.2)' } }}
        />
      </Paper>
    </Box>
  );
}

export function OptimizationScreen({ polyEvent, polyMarkets, crypto, spotPrice, bybitChain, polyUrl, onBack }: OptimizationScreenProps) {
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';
  const [vizMatch, setVizMatch] = useState<ExtendedMatch | null>(null);
  const [bybitQtyInput, setBybitQtyInput] = useState('0.01');
  const [targetLossInput, setTargetLossInput] = useState('5');
  const snapshotRef = useRef<HTMLDivElement>(null);

  const fmtTimeUTC1 = (ms: number) => {
    const d = new Date(ms + 3_600_000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC+1`;
  };

  const handleTransferToHedger = useCallback(() => {
    if (!vizMatch || !bybitChain) return;
    const { longCallInstrument, longPutInstrument, shortCallInstrument, shortPutInstrument,
            longQty, shortCallQty, shortPutQty,
            polyUpperMarket, polyLowerMarket, polyUpperQty, polyLowerQty } = vizMatch;
    const payload = {
      version: '3.1.0',
      savedAt: new Date().toISOString(),
      spotPrice,
      priceRange: [spotPrice * 0.75, spotPrice * 1.25],
      polyPriceMode: 'ask',
      optionType: 'hit',
      crypto,
      polyEvent: polyEvent ? {
        id: polyEvent.id, slug: polyEvent.slug, title: polyEvent.title,
        description: (polyEvent as { description?: string }).description ?? '',
        startDate: polyEvent.startDate, endDate: polyEvent.endDate,
      } : null,
      polyMarkets,
      polySelections: [
        { marketId: polyUpperMarket.id, side: 'NO', quantity: polyUpperQty },
        { marketId: polyLowerMarket.id, side: 'NO', quantity: polyLowerQty },
      ],
      bybitChain: {
        expiryLabel: bybitChain.expiryLabel,
        expiryTimestamp: bybitChain.expiryTimestamp,
        instruments: bybitChain.instruments,
        tickers: Array.from(bybitChain.tickers.values()),
      },
      bybitSelections: [
        { symbol: longCallInstrument.symbol, side: 'buy', quantity: longQty },
        { symbol: longPutInstrument.symbol, side: 'buy', quantity: longQty },
        { symbol: shortCallInstrument.symbol, side: 'sell', quantity: shortCallQty },
        { symbol: shortPutInstrument.symbol, side: 'sell', quantity: shortPutQty },
      ],
    };
    localStorage.setItem('position_hedger_transfer', JSON.stringify(payload));
    window.open('https://shtanga0x.github.io/position_hedger/', '_blank');
  }, [vizMatch, bybitChain, polyEvent, polyMarkets, crypto, spotPrice]);

  const handleSnapshot = useCallback(async () => {
    if (!snapshotRef.current) return;
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(snapshotRef.current, { backgroundColor: isDark ? '#0A0E17' : '#ffffff', scale: 2, useCORS: true, logging: false });
    const now = new Date();
    const dt = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
    const link = document.createElement('a');
    link.download = `PolyAHX_${dt}.jpg`;
    link.href = canvas.toDataURL('image/jpeg', 0.95);
    link.click();
  }, [isDark]);

  const bybitQty = useMemo(() => {
    const v = parseFloat(bybitQtyInput);
    return (!isNaN(v) && v > 0) ? Math.round(v * 100) / 100 : 0.01;
  }, [bybitQtyInput]);

  const targetLossFrac = useMemo(() => {
    const v = parseFloat(targetLossInput);
    return (!isNaN(v) && v > 0 && v < 100) ? v / 100 : 0.05;
  }, [targetLossInput]);

  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), []);

  const optResults = useMemo(() => {
    if (!polyMarkets.length || !bybitChain || spotPrice <= 0) return [];
    return runExtendedOptimization(polyMarkets, spotPrice, nowSec, bybitChain, bybitQty, targetLossFrac);
  }, [polyMarkets, spotPrice, bybitChain, nowSec, bybitQty, targetLossFrac]);

  const polyExpiryTs = polyEvent?.endDate ?? 0;
  const polyTauNow = useMemo(() => Math.max((polyExpiryTs - nowSec) / (365.25 * 24 * 3600), 0), [polyExpiryTs, nowSec]);

  const ivSmile: SmilePoint[] = useMemo(() => {
    if (!spotPrice || polyTauNow <= 0 || !polyMarkets.length) return [];
    const hNow = autoH(polyTauNow);
    const points: SmilePoint[] = [];
    for (const m of polyMarkets) {
      if (m.strikePrice <= 0 || m.currentPrice <= 0.001 || m.currentPrice >= 0.999) continue;
      const iv = solveImpliedVol(spotPrice, m.strikePrice, polyTauNow, m.currentPrice, 'hit', m.strikePrice > spotPrice, hNow);
      if (iv !== null) points.push({ moneyness: Math.log(spotPrice / m.strikePrice), iv });
    }
    return points.sort((a, b) => a.moneyness - b.moneyness);
  }, [polyMarkets, spotPrice, polyTauNow]);

  const bybitSmile: SmilePoint[] = useMemo(() => {
    if (!bybitChain || spotPrice <= 0) return [];
    const points: SmilePoint[] = [];
    for (const [sym, ticker] of bybitChain.tickers) {
      if (ticker.markIv <= 0) continue;
      const inst = bybitChain.instruments.find(i => i.symbol === sym);
      if (!inst) continue;
      points.push({ moneyness: Math.log(spotPrice / inst.strike), iv: ticker.markIv });
    }
    return points.sort((a, b) => a.moneyness - b.moneyness);
  }, [bybitChain, spotPrice]);

  const expiryDate = polyEvent ? new Date(polyEvent.endDate * 1000) : null;
  const ttxSec = polyExpiryTs > 0 ? polyExpiryTs - nowSec : 0;
  const formatTTX = (s: number) => {
    if (s <= 0) return 'Expired';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h`;
  };
  const handleViz = useCallback((m: ExtendedMatch) => setVizMatch(prev => prev === m ? null : m), []);
  const hasInputs = polyMarkets.length > 0 && !!bybitChain && spotPrice > 0;
  // useMemo is synchronous — optimizer finishes instantly; never show a spinner
  const isLoading = false;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', p: 2, gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <IconButton onClick={onBack} sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', '&:hover': { bgcolor: 'rgba(139, 157, 195, 0.2)' } }}>
          <ArrowBack />
        </IconButton>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h4" sx={{ fontWeight: 700, ...(isDark ? { background: 'linear-gradient(90deg, #E8EDF5 0%, #00D1FF 100%)', backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } : { color: 'text.primary' }) }}>
            6-Leg Optimization
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            {crypto && <Chip label={crypto} size="small" sx={{ bgcolor: 'rgba(247, 147, 26, 0.1)', color: '#F7931A', border: '1px solid rgba(247, 147, 26, 0.3)' }} />}
            <Chip label="One-Touch Barrier" size="small" sx={{ bgcolor: 'rgba(0, 209, 255, 0.1)', color: '#00D1FF', border: '1px solid rgba(0, 209, 255, 0.3)' }} />
            {polyExpiryTs > 0 && <Chip label={`Poly: ${expiryDate?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${fmtTimeUTC1(polyExpiryTs * 1000)}`} size="small" sx={{ bgcolor: 'rgba(74, 144, 217, 0.1)', color: '#4A90D9', border: '1px solid rgba(74, 144, 217, 0.3)' }} />}
            {ttxSec > 0 && <Chip label={`TTX: ${formatTTX(ttxSec)}`} size="small" sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', color: '#8B9DC3', border: '1px solid rgba(139, 157, 195, 0.2)' }} />}
            {spotPrice > 0 && <Chip label={`Spot: $${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} size="small" sx={{ bgcolor: 'rgba(34, 197, 94, 0.1)', color: '#22C55E', border: '1px solid rgba(34, 197, 94, 0.3)' }} />}
            {bybitChain && <Chip label={`Bybit: ${bybitChain.expiryLabel} ${fmtTimeUTC1(bybitChain.expiryTimestamp)}`} size="small" sx={{ bgcolor: 'rgba(255, 140, 0, 0.1)', color: '#FF8C00', border: '1px solid rgba(255, 140, 0, 0.3)' }} />}
            {polyMarkets.length > 0 && <Chip label={`${polyMarkets.filter(m => m.strikePrice > spotPrice).length}↑ / ${polyMarkets.filter(m => m.strikePrice < spotPrice).length}↓ strikes`} size="small" sx={{ bgcolor: 'rgba(74, 144, 217, 0.1)', color: '#4A90D9', border: '1px solid rgba(74, 144, 217, 0.3)' }} />}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, border: '1px solid rgba(255, 140, 0, 0.3)', borderRadius: '16px', px: 1, py: '3px', bgcolor: 'rgba(255, 140, 0, 0.06)' }}>
              <Typography variant="caption" sx={{ color: '#FF8C00', fontSize: '0.72rem', userSelect: 'none' }}>Bybit qty:</Typography>
              <Box component="input" type="number" value={bybitQtyInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setBybitQtyInput(e.target.value); setVizMatch(null); }}
                step="0.01" min="0.01"
                sx={{ width: 52, bgcolor: 'transparent', border: 'none', color: '#FF8C00', fontSize: '0.75rem', fontWeight: 700, outline: 'none', fontFamily: 'monospace', '&::-webkit-inner-spin-button': { WebkitAppearance: 'none' }, '&::-webkit-outer-spin-button': { WebkitAppearance: 'none' } }}
              />
            </Box>
            {/* Target loss at barriers */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '16px', px: 1, py: '3px', bgcolor: 'rgba(239, 68, 68, 0.06)' }}>
              <Typography variant="caption" sx={{ color: '#EF4444', fontSize: '0.72rem', userSelect: 'none' }}>Loss @ barriers:</Typography>
              <Box component="input" type="number" value={targetLossInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setTargetLossInput(e.target.value); setVizMatch(null); }}
                step="0.5" min="0.1" max="50"
                sx={{ width: 36, bgcolor: 'transparent', border: 'none', color: '#EF4444', fontSize: '0.75rem', fontWeight: 700, outline: 'none', fontFamily: 'monospace', '&::-webkit-inner-spin-button': { WebkitAppearance: 'none' }, '&::-webkit-outer-spin-button': { WebkitAppearance: 'none' } }}
              />
              <Typography variant="caption" sx={{ color: '#EF4444', fontSize: '0.72rem', userSelect: 'none' }}>%</Typography>
            </Box>
          </Box>
        </Box>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 2, color: 'text.secondary' }}>
          <CircularProgress size={24} /><Typography variant="body2">Running optimization...</Typography>
        </Box>
      ) : !hasInputs ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <Typography variant="body2" color="text.secondary">Waiting for market data…</Typography>
        </Box>
      ) : optResults.length === 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            No valid combinations found for this event + expiry.
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.6, textAlign: 'center', maxWidth: 420 }}>
            Possible reasons: no Poly strike pairs within 30% symmetry of spot; Bybit expiry
            already passed; no Bybit strikes near the symmetric target; options P&L couldn't
            be made flat with available strikes. Try a different Bybit expiry.
          </Typography>
        </Box>
      ) : (
        <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: isDark ? 'rgba(19, 26, 42, 0.5)' : 'rgba(0,0,0,0.03)' }}>
                <TableCell sx={{ fontWeight: 700, color: '#8B9DC3', width: 36 }}>#</TableCell>
                <TableCell sx={{ fontWeight: 700, color: '#4A90D9' }}>Poly Pair (↑/↓)</TableCell>
                <TableCell sx={{ fontWeight: 700, color: '#FF8C00' }}>Bybit Long / Short</TableCell>
                <TableCell sx={{ fontWeight: 700, color: '#4A90D9' }}>Poly qty</TableCell>
                <TableCell sx={{ fontWeight: 700, color: '#EF4444' }}>NOW @ barriers</TableCell>
                <TableCell sx={{ fontWeight: 700, color: '#A78BFA' }}>EXPIRY @ barriers</TableCell>
                <TableCell sx={{ fontWeight: 700, color: '#EF4444' }}>Max Loss</TableCell>
                <TableCell sx={{ fontWeight: 700, color: '#8B9DC3' }}></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {optResults.map((result, idx) => {
                const sel = vizMatch === result;
                const nowPct  = result.totalEntryCost > 0 ? (result.avgPnl1pct / result.totalEntryCost) * 100 : 0;
                const exPct   = result.totalEntryCost > 0 ? (result.avgPnl7pct / result.totalEntryCost) * 100 : 0;
                // Color: green if within ±2pp of target, red otherwise
                const nowColor = Math.abs(nowPct + targetLossFrac * 100) <= 2 ? '#22C55E' : '#EF4444';
                const exColor  = result.avgPnl7pct >= 0 ? '#22C55E' : result.avgPnl7pct > -result.totalEntryCost * 0.10 ? '#FFB020' : '#EF4444';
                return (
                  <TableRow key={idx} sx={{ '&:hover': { bgcolor: isDark ? 'rgba(139, 157, 195, 0.03)' : 'rgba(0,0,0,0.02)' }, bgcolor: sel ? 'rgba(0, 209, 255, 0.04)' : 'transparent' }}>
                    <TableCell sx={{ color: '#8B9DC3', fontWeight: 600, fontFamily: 'monospace' }}>{idx + 1}</TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: '#4A90D9' }}>↑ ${result.polyUpperMarket.strikePrice.toLocaleString()}</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: '#4A90D9' }}>↓ ${result.polyLowerMarket.strikePrice.toLocaleString()}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: '#FF8C00' }}>
                        ${result.longStrike.toLocaleString()} C+P (long)
                      </Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: '#EF4444' }}>
                        ${result.shortCallStrike.toLocaleString()} C / ${result.shortPutStrike.toLocaleString()} P (short)
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: '#4A90D9', fontWeight: 600 }}>
                        {result.polyUpperQty.toFixed(1)} each
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        NO×2 pos
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ color: nowColor, fontFamily: 'monospace', fontSize: '0.78rem', fontWeight: 600 }}>
                        {result.avgPnl1pct >= 0 ? '+' : ''}{result.avgPnl1pct.toFixed(2)}
                      </Typography>
                      <Typography variant="caption" sx={{ color: nowColor, opacity: 0.7 }}>{nowPct.toFixed(1)}% of cost</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ color: exColor, fontFamily: 'monospace', fontSize: '0.78rem', fontWeight: 600 }}>
                        {result.avgPnl7pct >= 0 ? '+' : ''}{result.avgPnl7pct.toFixed(2)}
                      </Typography>
                      <Typography variant="caption" sx={{ color: exColor, opacity: 0.7 }}>{exPct.toFixed(1)}% of cost</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ color: result.maxLoss < -0.01 ? '#EF4444' : '#22C55E', fontFamily: 'monospace', fontSize: '0.78rem' }}>{result.maxLoss.toFixed(2)}</Typography>
                    </TableCell>
                    <TableCell>
                      <IconButton size="small" onClick={() => handleViz(result)} sx={{ p: 0.5, color: sel ? '#00D1FF' : 'text.secondary', '&:hover': { color: '#00D1FF' } }}>
                        <BarChart fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {vizMatch && (
        <IconButton onClick={handleTransferToHedger} title="Open in position_hedger" sx={{ position: 'fixed', top: 16, right: 160, zIndex: 1300, bgcolor: isDark ? 'rgba(74, 144, 217, 0.12)' : 'rgba(74, 144, 217, 0.1)', color: '#4A90D9', '&:hover': { bgcolor: isDark ? 'rgba(74, 144, 217, 0.22)' : 'rgba(74, 144, 217, 0.2)' } }}>
          <OpenInNew />
        </IconButton>
      )}
      {vizMatch && (
        <IconButton onClick={handleSnapshot} title="Save snapshot" sx={{ position: 'fixed', top: 16, right: 112, zIndex: 1300, bgcolor: isDark ? 'rgba(34, 197, 94, 0.12)' : 'rgba(34, 197, 94, 0.1)', color: '#22C55E', '&:hover': { bgcolor: isDark ? 'rgba(34, 197, 94, 0.22)' : 'rgba(34, 197, 94, 0.2)' } }}>
          <PhotoCamera />
        </IconButton>
      )}

      {vizMatch && (
        <Box ref={snapshotRef}>
          <VizCard match={vizMatch} spotPrice={spotPrice} smile={ivSmile} bybitSmile={bybitSmile}
            polyExpiryTs={polyExpiryTs} cryptoSymbol={crypto ?? 'BTC'} polyUrl={polyUrl} bybitChain={bybitChain} />
        </Box>
      )}

      <Typography variant="caption" sx={{ textAlign: 'center', color: 'rgba(139, 157, 195, 0.4)', pb: 1, mt: 'auto' }}>
        v{__APP_VERSION__}
      </Typography>
    </Box>
  );
}
