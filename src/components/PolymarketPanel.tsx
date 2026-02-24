import { useState, useCallback } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  CircularProgress,
  Chip,
  Alert,
} from '@mui/material';
import type { CryptoOption, OptionType, ParsedMarket, PolymarketEvent } from '../types';
import {
  isValidPolymarketUrl,
  extractSlugFromUrl,
  fetchEventBySlug,
  parseMarkets,
  detectCrypto,
  detectOptionType,
} from '../api/polymarket';
import { fetchCurrentPrice } from '../api/binance';

interface PolymarketPanelProps {
  onEventLoaded: (event: PolymarketEvent, markets: ParsedMarket[], crypto: CryptoOption | null, optionType: OptionType, spotPrice: number) => void;
}

const CRYPTO_COLORS: Record<CryptoOption, string> = {
  BTC: '#F7931A',
  ETH: '#627EEA',
  SOL: '#9945FF',
  XRP: '#23292F',
};

export function PolymarketPanel({ onEventLoaded }: PolymarketPanelProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [event, setEvent] = useState<PolymarketEvent | null>(null);
  const [crypto, setCrypto] = useState<CryptoOption | null>(null);
  const [optionType, setOptionType] = useState<OptionType>('above');

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
      setCrypto(detectedCrypto);
      setOptionType(detectedType);
      onEventLoaded(eventData, parsed, detectedCrypto, detectedType, spot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch event data.');
    } finally {
      setLoading(false);
    }
  }, [url, onEventLoaded]);

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
            minWidth: 120, height: 40, whiteSpace: 'nowrap',
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
        </Box>
      )}
    </Box>
  );
}
