import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import type { BybitPosition, BybitOptionChain as BybitChainType, BybitSide } from '../types';
import { fetchBybitInstruments, fetchBybitTickers, fetchBybitSpotPrice, groupByExpiry } from '../api/bybit';

interface BybitOptionChainProps {
  onPositionsChange: (positions: BybitPosition[]) => void;
  onSpotPriceLoaded: (price: number) => void;
}

// Track selected positions: symbol -> { side, quantity }
interface SelectedOption {
  side: BybitSide;
  quantity: number;
}

export function BybitOptionChain({ onPositionsChange, onSpotPriceLoaded }: BybitOptionChainProps) {
  const [chains, setChains] = useState<BybitChainType[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState<number | ''>('');
  const [spotPrice, setSpotPrice] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, SelectedOption>>(new Map());

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
        setSpotPrice(spot);
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

  // Group instruments by strike: each strike has a call and/or put
  const strikeRows = useMemo(() => {
    if (!activeChain) return [];
    const strikeMap = new Map<number, { call?: string; put?: string }>();
    for (const inst of activeChain.instruments) {
      const entry = strikeMap.get(inst.strike) || {};
      if (inst.optionsType === 'Call') entry.call = inst.symbol;
      else entry.put = inst.symbol;
      strikeMap.set(inst.strike, entry);
    }
    return Array.from(strikeMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([strike, syms]) => ({ strike, ...syms }));
  }, [activeChain]);

  const handleSideToggle = useCallback((symbol: string, newSide: BybitSide | null) => {
    setSelected(prev => {
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

  const handleQuantityChange = useCallback((symbol: string, qty: number) => {
    setSelected(prev => {
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

  // Build positions and notify parent
  const positions: BybitPosition[] = useMemo(() => {
    if (!activeChain) return [];
    const result: BybitPosition[] = [];
    for (const [symbol, sel] of selected) {
      const ticker = activeChain.tickers.get(symbol);
      const inst = activeChain.instruments.find(i => i.symbol === symbol);
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
  }, [selected, activeChain]);

  useEffect(() => {
    onPositionsChange(positions);
  }, [positions, onPositionsChange]);

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

      {spotPrice > 0 && (
        <Typography variant="body2" color="text.secondary">
          BTC Spot: ${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </Typography>
      )}

      {/* Expiry selector */}
      <Select
        size="small"
        value={selectedExpiry}
        onChange={e => {
          setSelectedExpiry(e.target.value as number);
          setSelected(new Map());
        }}
        displayEmpty
        sx={{ maxWidth: 300 }}
      >
        <MenuItem value="">Select expiration...</MenuItem>
        {chains.map(chain => (
          <MenuItem key={chain.expiryTimestamp} value={chain.expiryTimestamp}>
            {chain.expiryLabel}
          </MenuItem>
        ))}
      </Select>

      {/* Option chain table */}
      {activeChain && strikeRows.length > 0 && (
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

          {strikeRows.map(row => {
            const callTicker = row.call ? activeChain.tickers.get(row.call) : null;
            const putTicker = row.put ? activeChain.tickers.get(row.put) : null;
            const isITMCall = spotPrice > row.strike;
            const isITMPut = spotPrice < row.strike;
            const callSel = row.call ? selected.get(row.call) : undefined;
            const putSel = row.put ? selected.get(row.put) : undefined;

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
                      onChange={(_, v) => handleSideToggle(row.call!, v)}
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
                        if (row.call) handleQuantityChange(row.call, isNaN(v) ? 0 : v);
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
                      onChange={(_, v) => handleSideToggle(row.put!, v)}
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
                        if (row.put) handleQuantityChange(row.put, isNaN(v) ? 0 : v);
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
      )}
    </Box>
  );
}
