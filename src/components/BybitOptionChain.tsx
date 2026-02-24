import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
} from '@mui/material';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import type { BybitOptionChain as BybitChainType } from '../types';
import { fetchBybitInstruments, fetchBybitTickers, fetchBybitSpotPrice, groupByExpiry } from '../api/bybit';

interface BybitOptionChainProps {
  onChainSelected: (chain: BybitChainType | null) => void;
  onSpotPriceLoaded: (price: number) => void;
}

export function BybitOptionChain({ onChainSelected, onSpotPriceLoaded }: BybitOptionChainProps) {
  const [chains, setChains] = useState<BybitChainType[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch instruments + tickers on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [instruments, tickers, spot] = await Promise.all([
          fetchBybitInstruments(),
          fetchBybitTickers(),
          fetchBybitSpotPrice(),
        ]);
        if (cancelled) return;
        const grouped = groupByExpiry(instruments, tickers);
        setChains(grouped);
        onSpotPriceLoaded(spot);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to fetch Bybit data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [onSpotPriceLoaded]);

  const activeChain = useMemo(() => {
    if (selectedExpiry === '') return null;
    return chains.find(c => c.expiryTimestamp === selectedExpiry) ?? null;
  }, [chains, selectedExpiry]);

  const handleExpiryChange = useCallback((value: number | '') => {
    setSelectedExpiry(value);
    if (value === '') {
      onChainSelected(null);
    } else {
      const chain = chains.find(c => c.expiryTimestamp === value) ?? null;
      onChainSelected(chain);
    }
  }, [chains, onChainSelected]);

  // Also notify parent when chains data loads and expiry was already selected
  useEffect(() => {
    onChainSelected(activeChain);
  }, [activeChain, onChainSelected]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>Bybit BTC Options</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">Loading option chain...</Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h6" sx={{ fontWeight: 600 }}>Bybit BTC Options</Typography>

      {error && <Alert severity="error">{error}</Alert>}

      {/* Expiry selector */}
      <Select
        size="small"
        value={selectedExpiry}
        onChange={e => handleExpiryChange(e.target.value as number | '')}
        displayEmpty
        sx={{ maxWidth: 300 }}
      >
        <MenuItem value="">Select expiration...</MenuItem>
        {chains.map(chain => (
          <MenuItem key={chain.expiryTimestamp} value={chain.expiryTimestamp}>
            {chain.expiryLabel} ({chain.instruments.length} contracts)
          </MenuItem>
        ))}
      </Select>
    </Box>
  );
}
