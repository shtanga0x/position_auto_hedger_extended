import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTheme } from '@mui/material/styles';
import {
  Box,
  Typography,
  Paper,
  Checkbox,
  CircularProgress,
  IconButton,
  Chip,
  Alert,
  Slider,
} from '@mui/material';
import { ArrowBack } from '@mui/icons-material';
import type { CryptoOption, OptionType, ParsedMarket, PolymarketEvent, SelectedStrike, ProjectionPoint, Side } from '../types';
import { fetchCurrentPrice } from '../api/binance';
import { solveImpliedVol, computePnlCurve, computeExpiryPnl, type SmilePoint } from '../pricing/engine';
import { ProjectionChart } from './ProjectionChart';

interface SecondScreenProps {
  event: PolymarketEvent;
  markets: ParsedMarket[];
  crypto: CryptoOption | null;
  optionType: OptionType;
  onBack: () => void;
}

const CRYPTO_COLORS: Record<CryptoOption, string> = {
  BTC: '#F7931A',
  ETH: '#627EEA',
  SOL: '#9945FF',
  XRP: '#23292F',
};

/** Round down to nearest "3 zeros" (1000 for values > 10k, 100 for > 1k, etc.) */
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

function formatHours(seconds: number): string {
  const h = Math.round(seconds / 3600);
  return `${h}h`;
}

// Selection key: marketId-YES or marketId-NO
function selKey(marketId: string, side: Side): string {
  return `${marketId}-${side}`;
}

export function SecondScreen({
  event,
  markets,
  crypto,
  optionType,
  onBack,
}: SecondScreenProps) {
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';

  const [selections, setSelections] = useState<Set<string>>(new Set());
  const [spotPrice, setSpotPrice] = useState<number | null>(null);
  const [loadingSpot, setLoadingSpot] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 0]);
  const [sliderBounds, setSliderBounds] = useState<[number, number]>([0, 0]);
  const [hExponent, setHExponent] = useState(0.5);

  const expirationTs = event.endDate;
  const nowTs = Math.floor(Date.now() / 1000);
  const timeToExpirySec = expirationTs - nowTs;
  const tauNow = Math.max(timeToExpirySec / (365.25 * 24 * 3600), 0);

  // Compute slider bounds from strike prices
  useEffect(() => {
    if (markets.length === 0) return;
    const strikes = markets.map((m) => m.strikePrice).filter((s) => s > 0);
    if (strikes.length === 0) return;
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const lower = roundTo3Zeros(minStrike * 0.9, 'down');
    const upper = roundTo3Zeros(maxStrike * 1.1, 'up');
    setSliderBounds([lower, upper]);
    setPriceRange([lower, upper]);
  }, [markets]);

  // Fetch current crypto price
  useEffect(() => {
    if (!crypto) return;
    setLoadingSpot(true);
    fetchCurrentPrice(crypto)
      .then((price) => setSpotPrice(price))
      .catch((err) => {
        console.error('Failed to fetch spot price:', err);
        setError(`Failed to fetch ${crypto} price`);
      })
      .finally(() => setLoadingSpot(false));
  }, [crypto]);

  const handleToggle = useCallback((marketId: string, side: Side) => {
    setSelections((prev) => {
      const next = new Set(prev);
      const key = selKey(marketId, side);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const handleSliderChange = useCallback((_: unknown, value: number | number[]) => {
    setPriceRange(value as [number, number]);
  }, []);

  const handleHChange = useCallback((_: unknown, value: number | number[]) => {
    setHExponent(value as number);
  }, []);

  // Calibrate IV and build selected strikes
  const selectedStrikes: SelectedStrike[] = useMemo(() => {
    if (!spotPrice || tauNow <= 0) return [];

    const result: SelectedStrike[] = [];
    for (const key of selections) {
      const [marketId, sideStr] = key.split('-') as [string, Side];
      const market = markets.find((m) => m.id === marketId);
      if (!market || market.strikePrice <= 0) continue;

      const isUpBarrier = market.strikePrice > spotPrice;
      const iv = solveImpliedVol(spotPrice, market.strikePrice, tauNow, market.currentPrice, optionType, isUpBarrier, hExponent);
      const side: Side = sideStr;
      const entryPrice = side === 'YES' ? market.currentPrice : (1 - market.currentPrice);

      result.push({
        marketId: market.id,
        question: market.question,
        groupItemTitle: market.groupItemTitle,
        strikePrice: market.strikePrice,
        side,
        entryPrice,
        impliedVol: iv ?? 0.5,
        isUpBarrier,
      });
    }
    return result;
  }, [markets, selections, spotPrice, tauNow, optionType, hExponent]);

  // Build IV smile from ALL market strikes (not just selected)
  const ivSmile: SmilePoint[] = useMemo(() => {
    if (!spotPrice || tauNow <= 0) return [];

    const points: SmilePoint[] = [];
    for (const market of markets) {
      if (market.strikePrice <= 0 || market.currentPrice <= 0.001 || market.currentPrice >= 0.999) continue;
      const isUpBarrier = market.strikePrice > spotPrice;
      const iv = solveImpliedVol(spotPrice, market.strikePrice, tauNow, market.currentPrice, optionType, isUpBarrier, hExponent);
      if (iv !== null) {
        points.push({ moneyness: Math.log(spotPrice / market.strikePrice), iv });
      }
    }
    return points.sort((a, b) => a.moneyness - b.moneyness);
  }, [markets, spotPrice, tauNow, optionType, hExponent]);

  // Curve labels with hours
  const curveLabels = useMemo(() => {
    const h1 = formatHours(timeToExpirySec);
    const h2 = formatHours(timeToExpirySec * 2 / 3);
    const h3 = formatHours(timeToExpirySec / 3);
    return [
      `Now (${h1} to exp)`,
      `1/3 to expiry (${h2})`,
      `2/3 to expiry (${h3})`,
      'At expiry',
    ];
  }, [timeToExpirySec]);

  // Compute 4 P&L curves
  const projectionCurves: ProjectionPoint[][] = useMemo(() => {
    const [lower, upper] = priceRange;
    if (selectedStrikes.length === 0 || lower <= 0 || upper <= lower) return [];

    const tau1 = tauNow;
    const tau2 = tauNow * (2 / 3);
    const tau3 = tauNow * (1 / 3);

    return [
      computePnlCurve(selectedStrikes, lower, upper, tau1, optionType, hExponent, ivSmile),
      computePnlCurve(selectedStrikes, lower, upper, tau2, optionType, hExponent, ivSmile),
      computePnlCurve(selectedStrikes, lower, upper, tau3, optionType, hExponent, ivSmile),
      computeExpiryPnl(selectedStrikes, lower, upper, optionType),
    ];
  }, [selectedStrikes, priceRange, tauNow, optionType, hExponent, ivSmile]);

  const expiryDate = new Date(expirationTs * 1000);
  const hasSelections = selections.size > 0;

  // Slider step: scale based on range
  const sliderStep = useMemo(() => {
    const range = sliderBounds[1] - sliderBounds[0];
    if (range > 100000) return 1000;
    if (range > 10000) return 100;
    if (range > 1000) return 10;
    return 1;
  }, [sliderBounds]);

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        p: 3,
        gap: 3,
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <IconButton
          onClick={onBack}
          sx={{
            bgcolor: 'rgba(139, 157, 195, 0.1)',
            '&:hover': { bgcolor: 'rgba(139, 157, 195, 0.2)' },
          }}
        >
          <ArrowBack />
        </IconButton>
        <Box sx={{ flex: 1 }}>
          <Typography
            variant="h4"
            sx={{
              fontWeight: 700,
              ...(isDark
                ? {
                    background: 'linear-gradient(90deg, #E8EDF5 0%, #00D1FF 100%)',
                    backgroundClip: 'text',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }
                : { color: 'text.primary' }),
            }}
          >
            {event.title}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            {crypto && (
              <Chip
                label={crypto}
                size="small"
                sx={{
                  bgcolor: `${CRYPTO_COLORS[crypto]}20`,
                  color: CRYPTO_COLORS[crypto],
                  border: `1px solid ${CRYPTO_COLORS[crypto]}40`,
                }}
              />
            )}
            <Chip
              label={optionType === 'above' ? 'European Binary' : 'One-Touch Barrier'}
              size="small"
              sx={{
                bgcolor: 'rgba(0, 209, 255, 0.1)',
                color: '#00D1FF',
                border: '1px solid rgba(0, 209, 255, 0.3)',
              }}
            />
            <Chip
              label={`Expires: ${expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
              size="small"
              sx={{
                bgcolor: 'rgba(139, 157, 195, 0.1)',
                color: '#8B9DC3',
                border: '1px solid rgba(139, 157, 195, 0.2)',
              }}
            />
            <Chip
              label={`Time to expiry: ${formatTimeToExpiry(timeToExpirySec)}`}
              size="small"
              sx={{
                bgcolor: 'rgba(139, 157, 195, 0.1)',
                color: '#8B9DC3',
                border: '1px solid rgba(139, 157, 195, 0.2)',
              }}
            />
            {spotPrice && (
              <Chip
                label={`${crypto} Spot: $${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                size="small"
                sx={{
                  bgcolor: 'rgba(34, 197, 94, 0.1)',
                  color: '#22C55E',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                }}
              />
            )}
          </Box>
        </Box>
      </Box>

      {error && (
        <Alert
          severity="error"
          onClose={() => setError(null)}
          sx={{
            bgcolor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
          }}
        >
          {error}
        </Alert>
      )}

      {/* Chart */}
      <Paper
        elevation={0}
        sx={{
          flex: 1,
          minHeight: 500,
          p: 3,
          border: '1px solid rgba(139, 157, 195, 0.15)',
        }}
      >
        {loadingSpot ? (
          <Box
            sx={{
              height: '100%',
              minHeight: 440,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CircularProgress />
          </Box>
        ) : !hasSelections ? (
          <Box
            sx={{
              height: '100%',
              minHeight: 440,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 2,
              color: 'text.secondary',
            }}
          >
            <Typography variant="h6">No strikes selected</Typography>
            <Typography variant="body2">
              Select YES or NO on strikes below to see the P&L projection
            </Typography>
          </Box>
        ) : projectionCurves.length > 0 && spotPrice ? (
          <ProjectionChart
            curves={projectionCurves}
            curveLabels={curveLabels}
            currentCryptoPrice={spotPrice}
            cryptoSymbol={crypto || 'BTC'}
            totalEntryCost={selectedStrikes.reduce((sum, s) => sum + s.entryPrice, 0)}
          />
        ) : null}

        {/* Price Range Slider */}
        {!loadingSpot && sliderBounds[1] > sliderBounds[0] && (
          <Box
            sx={{
              mt: 2,
              pt: 2,
              px: 3,
              borderTop: '1px solid rgba(139, 157, 195, 0.1)',
            }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="body2" color="text.secondary">
                ${priceRange[0].toLocaleString()}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
                {crypto} Price Range
              </Typography>
              <Typography variant="body2" color="text.secondary">
                ${priceRange[1].toLocaleString()}
              </Typography>
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
                '& .MuiSlider-thumb': {
                  bgcolor: '#00D1FF',
                  '&:hover': { boxShadow: '0 0 8px rgba(0, 209, 255, 0.4)' },
                },
                '& .MuiSlider-track': { bgcolor: '#00D1FF' },
                '& .MuiSlider-rail': { bgcolor: 'rgba(139, 157, 195, 0.2)' },
              }}
            />
          </Box>
        )}

      </Paper>

      {/* Time Exponent (H) Slider */}
      {!loadingSpot && (
        <Paper
          elevation={0}
          sx={{
            p: 3,
            border: '1px solid rgba(139, 157, 195, 0.15)',
          }}
        >
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="body2" color="text.secondary">
              0.40
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
              Time Exponent H = {hExponent.toFixed(2)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              0.80
            </Typography>
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
              '& .MuiSlider-thumb': {
                bgcolor: '#A78BFA',
                '&:hover': { boxShadow: '0 0 8px rgba(167, 139, 250, 0.4)' },
              },
              '& .MuiSlider-track': { bgcolor: '#A78BFA' },
              '& .MuiSlider-rail': { bgcolor: 'rgba(139, 157, 195, 0.2)' },
            }}
          />
        </Paper>
      )}

      {/* Strike Selection — Single Column Polymarket Style */}
      <Paper
        elevation={0}
        sx={{
          p: 3,
          border: '1px solid rgba(139, 157, 195, 0.15)',
        }}
      >
        <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
          Select Strikes
        </Typography>

        {/* Header row */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr 120px 120px',
            gap: 1,
            mb: 1,
            px: 2,
          }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
            Strike
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>
            YES
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>
            NO
          </Typography>
        </Box>

        {/* Rows */}
        {markets.map((market) => {
          const yesKey = selKey(market.id, 'YES');
          const noKey = selKey(market.id, 'NO');
          const yesSelected = selections.has(yesKey);
          const noSelected = selections.has(noKey);
          const yesPrice = market.currentPrice;
          const noPrice = 1 - market.currentPrice;
          const ivInfo = selectedStrikes.find((s) => s.marketId === market.id);

          return (
            <Box
              key={market.id}
              sx={{
                display: 'grid',
                gridTemplateColumns: '1fr 120px 120px',
                gap: 1,
                alignItems: 'center',
                px: 2,
                py: 1,
                borderRadius: 1,
                bgcolor: (yesSelected || noSelected) ? 'rgba(0, 209, 255, 0.03)' : 'transparent',
                borderBottom: '1px solid rgba(139, 157, 195, 0.06)',
                '&:hover': { bgcolor: 'rgba(139, 157, 195, 0.04)' },
              }}
            >
              {/* Strike info */}
              <Box>
                <Typography variant="body1" sx={{ fontWeight: 500, fontSize: '1.125rem' }}>
                  {market.groupItemTitle || market.question}
                </Typography>
                {ivInfo && (
                  <Typography variant="caption" sx={{ color: '#00D1FF' }}>
                    IV: {(ivInfo.impliedVol * 100).toFixed(1)}%
                  </Typography>
                )}
              </Box>

              {/* YES */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 0.5,
                }}
              >
                <Checkbox
                  checked={yesSelected}
                  onChange={() => handleToggle(market.id, 'YES')}
                  size="small"
                  sx={{ '&.Mui-checked': { color: '#22C55E' }, p: 0.5 }}
                />
                <Typography
                  variant="body2"
                  sx={{
                    color: yesSelected ? '#22C55E' : 'text.secondary',
                    fontWeight: yesSelected ? 600 : 400,
                    fontSize: '1rem',
                    minWidth: 45,
                    textAlign: 'right',
                  }}
                >
                  {(yesPrice * 100).toFixed(1)}¢
                </Typography>
              </Box>

              {/* NO */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 0.5,
                }}
              >
                <Checkbox
                  checked={noSelected}
                  onChange={() => handleToggle(market.id, 'NO')}
                  size="small"
                  sx={{ '&.Mui-checked': { color: '#EF4444' }, p: 0.5 }}
                />
                <Typography
                  variant="body2"
                  sx={{
                    color: noSelected ? '#EF4444' : 'text.secondary',
                    fontWeight: noSelected ? 600 : 400,
                    fontSize: '1rem',
                    minWidth: 45,
                    textAlign: 'right',
                  }}
                >
                  {(noPrice * 100).toFixed(1)}¢
                </Typography>
              </Box>
            </Box>
          );
        })}

        {/* Entry cost summary */}
        {selectedStrikes.length > 0 && (
          <Box
            sx={{
              mt: 2,
              pt: 2,
              borderTop: '1px solid rgba(139, 157, 195, 0.15)',
              display: 'flex',
              gap: 3,
              justifyContent: 'center',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Positions: {selectedStrikes.length}
            </Typography>
            <Typography variant="body2" sx={{ color: '#00D1FF', fontWeight: 600 }}>
              Entry cost: {selectedStrikes.reduce((sum, s) => sum + s.entryPrice, 0).toFixed(4)}
            </Typography>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
