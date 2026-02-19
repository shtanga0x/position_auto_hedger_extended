import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Checkbox,
  CircularProgress,
  Chip,
  Alert,
} from '@mui/material';
import type { CryptoOption, OptionType, ParsedMarket, PolymarketEvent, PolymarketPosition, Side } from '../types';
import {
  isValidPolymarketUrl,
  extractSlugFromUrl,
  fetchEventBySlug,
  parseMarkets,
  detectCrypto,
  detectOptionType,
} from '../api/polymarket';
import { fetchCurrentPrice } from '../api/binance';
import { solveImpliedVol } from '../pricing/engine';

interface PolymarketPanelProps {
  onPositionsChange: (positions: PolymarketPosition[]) => void;
  onEventLoaded: (event: PolymarketEvent, markets: ParsedMarket[], crypto: CryptoOption | null, optionType: OptionType, spotPrice: number) => void;
}

const CRYPTO_COLORS: Record<CryptoOption, string> = {
  BTC: '#F7931A',
  ETH: '#627EEA',
  SOL: '#9945FF',
  XRP: '#23292F',
};

function selKey(marketId: string, side: Side): string {
  return `${marketId}-${side}`;
}

export function PolymarketPanel({ onPositionsChange, onEventLoaded }: PolymarketPanelProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [event, setEvent] = useState<PolymarketEvent | null>(null);
  const [markets, setMarkets] = useState<ParsedMarket[]>([]);
  const [crypto, setCrypto] = useState<CryptoOption | null>(null);
  const [optionType, setOptionType] = useState<OptionType>('above');
  const [spotPrice, setSpotPrice] = useState<number | null>(null);
  const [selections, setSelections] = useState<Map<string, number>>(new Map()); // key -> quantity

  const isValidUrl = isValidPolymarketUrl(url);

  const handleSubmit = useCallback(async () => {
    const slug = extractSlugFromUrl(url);
    if (!slug) { setError('Invalid URL'); return; }

    setLoading(true);
    setError(null);
    try {
      const eventData = await fetchEventBySlug(slug);
      const parsed = parseMarkets(eventData.markets);
      const detectedCrypto = detectCrypto(eventData);
      const detectedType = detectOptionType(eventData);

      if (!detectedCrypto) {
        setError('Could not detect cryptocurrency from this event.');
        return;
      }

      const spot = await fetchCurrentPrice(detectedCrypto);

      setEvent(eventData);
      setMarkets(parsed);
      setCrypto(detectedCrypto);
      setOptionType(detectedType);
      setSpotPrice(spot);
      setSelections(new Map());
      onEventLoaded(eventData, parsed, detectedCrypto, detectedType, spot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch event data.');
    } finally {
      setLoading(false);
    }
  }, [url, onEventLoaded]);

  const handleToggle = useCallback((marketId: string, side: Side) => {
    setSelections(prev => {
      const next = new Map(prev);
      const key = selKey(marketId, side);
      if (next.has(key)) next.delete(key);
      else next.set(key, 1);
      return next;
    });
  }, []);

  const handleQuantityChange = useCallback((marketId: string, side: Side, qty: number) => {
    setSelections(prev => {
      const next = new Map(prev);
      const key = selKey(marketId, side);
      if (qty > 0) next.set(key, qty);
      else next.delete(key);
      return next;
    });
  }, []);

  // Build positions from selections
  const positions: PolymarketPosition[] = useMemo(() => {
    if (!spotPrice || !event) return [];
    const nowTs = Math.floor(Date.now() / 1000);
    const tauNow = Math.max((event.endDate - nowTs) / (365.25 * 24 * 3600), 0);
    if (tauNow <= 0) return [];

    const result: PolymarketPosition[] = [];
    for (const [key, quantity] of selections) {
      const [marketId, sideStr] = key.split('-') as [string, Side];
      const market = markets.find(m => m.id === marketId);
      if (!market || market.strikePrice <= 0) continue;

      const isUpBarrier = market.strikePrice > spotPrice;
      const iv = solveImpliedVol(spotPrice, market.strikePrice, tauNow, market.currentPrice, optionType, isUpBarrier, 0.5);
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
        quantity,
      });
    }
    return result;
  }, [markets, selections, spotPrice, event, optionType]);

  useEffect(() => {
    onPositionsChange(positions);
  }, [positions, onPositionsChange]);

  const expiryDate = event ? new Date(event.endDate * 1000) : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h6" sx={{ fontWeight: 600 }}>Polymarket</Typography>

      {/* URL input */}
      <Box sx={{ display: 'flex', gap: 2 }}>
        <TextField
          fullWidth
          size="small"
          label="Event URL"
          placeholder="https://polymarket.com/event/..."
          value={url}
          onChange={e => { setUrl(e.target.value); setError(null); }}
          error={url.length > 0 && !isValidUrl}
        />
        <Button
          variant="contained"
          disabled={!isValidUrl || loading}
          onClick={handleSubmit}
          sx={{
            minWidth: 140,
            background: isValidUrl ? 'linear-gradient(135deg, #00D1FF 0%, #00A3CC 100%)' : undefined,
          }}
        >
          {loading ? <CircularProgress size={20} sx={{ color: 'inherit' }} /> : 'Load Event'}
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ bgcolor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>{error}</Alert>}

      {/* Event info chips */}
      {event && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {crypto && (
            <Chip label={crypto} size="small" sx={{ bgcolor: `${CRYPTO_COLORS[crypto]}20`, color: CRYPTO_COLORS[crypto], border: `1px solid ${CRYPTO_COLORS[crypto]}40` }} />
          )}
          <Chip label={optionType === 'above' ? 'European Binary' : 'One-Touch Barrier'} size="small" sx={{ bgcolor: 'rgba(0, 209, 255, 0.1)', color: '#00D1FF', border: '1px solid rgba(0, 209, 255, 0.3)' }} />
          {expiryDate && (
            <Chip label={`Exp: ${expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`} size="small" sx={{ bgcolor: 'rgba(139, 157, 195, 0.1)', color: '#8B9DC3', border: '1px solid rgba(139, 157, 195, 0.2)' }} />
          )}
          {spotPrice && (
            <Chip label={`${crypto} Spot: $${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} size="small" sx={{ bgcolor: 'rgba(34, 197, 94, 0.1)', color: '#22C55E', border: '1px solid rgba(34, 197, 94, 0.3)' }} />
          )}
        </Box>
      )}

      {/* Strike selection table */}
      {markets.length > 0 && (
        <Box>
          {/* Header */}
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 100px 100px 80px', gap: 1, mb: 1, px: 1 }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>Strike</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>YES</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>NO</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600, textAlign: 'center' }}>Qty</Typography>
          </Box>

          {markets.map(market => {
            const yesKey = selKey(market.id, 'YES');
            const noKey = selKey(market.id, 'NO');
            const yesSelected = selections.has(yesKey);
            const noSelected = selections.has(noKey);
            const activeKey = yesSelected ? yesKey : noSelected ? noKey : null;
            const qty = activeKey ? (selections.get(activeKey) ?? 1) : 1;

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
                  <Checkbox checked={yesSelected} onChange={() => handleToggle(market.id, 'YES')} size="small" sx={{ '&.Mui-checked': { color: '#22C55E' }, p: 0.5 }} />
                  <Typography variant="body2" sx={{ color: yesSelected ? '#22C55E' : 'text.secondary', fontSize: '0.875rem', minWidth: 35, textAlign: 'right' }}>
                    {(market.currentPrice * 100).toFixed(1)}
                  </Typography>
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5 }}>
                  <Checkbox checked={noSelected} onChange={() => handleToggle(market.id, 'NO')} size="small" sx={{ '&.Mui-checked': { color: '#EF4444' }, p: 0.5 }} />
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
                    if (yesSelected) handleQuantityChange(market.id, 'YES', isNaN(v) ? 0 : v);
                    else if (noSelected) handleQuantityChange(market.id, 'NO', isNaN(v) ? 0 : v);
                  }}
                  inputProps={{ min: 1, style: { textAlign: 'center', padding: '4px 8px' } }}
                  sx={{ '& .MuiOutlinedInput-root': { backgroundColor: 'transparent' } }}
                />
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
