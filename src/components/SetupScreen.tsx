import { Box, Typography, Paper, Button, FormControl, InputLabel, Select, MenuItem } from '@mui/material';
import { Hub } from '@mui/icons-material';
import type { CryptoOption, OptionType, ParsedMarket, PolymarketEvent, BybitOptionChain as BybitChainType } from '../types';
import { PolymarketPanel } from './PolymarketPanel';
import { BybitOptionChain } from './BybitOptionChain';

interface SetupScreenProps {
  polyEvent: PolymarketEvent | null;
  polyMarkets: ParsedMarket[];
  spotPrice: number;
  upperMarket: ParsedMarket | null;
  lowerMarket: ParsedMarket | null;
  bybitChain: BybitChainType | null;
  onPolyEventLoaded: (event: PolymarketEvent, markets: ParsedMarket[], crypto: CryptoOption | null, optionType: OptionType, spotPrice: number, polyUrl: string) => void;
  onBybitChainSelected: (chain: BybitChainType | null) => void;
  onBybitSpotPriceLoaded: (price: number) => void;
  onUpperMarketChange: (market: ParsedMarket | null) => void;
  onLowerMarketChange: (market: ParsedMarket | null) => void;
  onContinue: () => void;
}

export function SetupScreen({
  polyEvent,
  polyMarkets,
  spotPrice,
  upperMarket,
  lowerMarket,
  bybitChain,
  onPolyEventLoaded,
  onBybitChainSelected,
  onBybitSpotPriceLoaded,
  onUpperMarketChange,
  onLowerMarketChange,
  onContinue,
}: SetupScreenProps) {
  const canContinue = polyEvent !== null && upperMarket !== null && lowerMarket !== null && bybitChain !== null;

  // Markets above and below spot (for selectors)
  const upperCandidates = [...polyMarkets]
    .filter(m => m.strikePrice > spotPrice)
    .sort((a, b) => a.strikePrice - b.strikePrice);
  const lowerCandidates = [...polyMarkets]
    .filter(m => m.strikePrice < spotPrice)
    .sort((a, b) => a.strikePrice - b.strikePrice);

  return (
    <Box sx={{ minHeight: '100vh', overflow: 'auto', display: 'flex', flexDirection: 'column', p: 2, gap: 2.5, position: 'relative' }}>
      {/* Background decorations */}
      <Box sx={{ position: 'absolute', top: '-20%', left: '-10%', width: '60%', height: '60%', background: 'radial-gradient(ellipse at center, rgba(0, 209, 255, 0.08) 0%, transparent 70%)', pointerEvents: 'none' }} />
      <Box sx={{ position: 'absolute', bottom: '-20%', right: '-10%', width: '50%', height: '50%', background: 'radial-gradient(ellipse at center, rgba(255, 107, 53, 0.06) 0%, transparent 70%)', pointerEvents: 'none' }} />

      {/* Header */}
      <Box sx={{ textAlign: 'center', pt: 1, position: 'relative', zIndex: 1 }}>
        <Box sx={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 44, height: 44, borderRadius: '12px',
          background: 'linear-gradient(135deg, #00D1FF 0%, #00A3CC 100%)',
          mb: 1, boxShadow: '0 6px 24px rgba(0, 209, 255, 0.3)',
        }}>
          <Hub sx={{ fontSize: 26, color: '#0A0E17' }} />
        </Box>
        <Typography variant="h5" sx={{
          fontWeight: 700,
          background: 'linear-gradient(90deg, #E8EDF5 0%, #00D1FF 100%)',
          backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          Position Auto-Hedger Extended
        </Typography>
        <Typography variant="caption" color="text.secondary">
          6-leg symmetric strategy: long straddle + short strangle + 2× Polymarket HIT NO
        </Typography>
      </Box>

      {/* Side-by-side panels */}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, position: 'relative', zIndex: 1 }}>
        <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
          <PolymarketPanel onEventLoaded={onPolyEventLoaded} />
        </Paper>
        <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px' }}>
          <BybitOptionChain
            onChainSelected={onBybitChainSelected}
            onSpotPriceLoaded={onBybitSpotPriceLoaded}
          />
        </Paper>
      </Box>

      {/* Strategy market selectors */}
      {polyEvent !== null && polyMarkets.length > 0 && (
        <Paper elevation={0} sx={{ p: 2, border: '1px solid rgba(139, 157, 195, 0.15)', borderRadius: '8px', position: 'relative', zIndex: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#00D1FF', mb: 1.5 }}>
            Strategy Markets — Buy NO on both HIT barriers
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
            {/* Upper barrier */}
            <Box>
              <FormControl fullWidth size="small">
                <InputLabel sx={{ fontSize: '0.8rem' }}>Upper Barrier (buy NO)</InputLabel>
                <Select
                  value={upperMarket?.id ?? ''}
                  label="Upper Barrier (buy NO)"
                  onChange={e => {
                    const m = polyMarkets.find(x => x.id === e.target.value) ?? null;
                    onUpperMarketChange(m);
                  }}
                  sx={{ fontSize: '0.8rem' }}
                >
                  {upperCandidates.map(m => {
                    const noAsk = m.bestBid != null ? (1 - m.bestBid) : (1 - m.currentPrice);
                    return (
                      <MenuItem key={m.id} value={m.id} sx={{ fontSize: '0.8rem' }}>
                        ↑ ${m.strikePrice.toLocaleString()} — NO ask: {noAsk.toFixed(3)}
                      </MenuItem>
                    );
                  })}
                  {upperCandidates.length === 0 && (
                    <MenuItem disabled value="">No markets above spot</MenuItem>
                  )}
                </Select>
              </FormControl>
              {upperMarket && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, pl: 0.5 }}>
                  Strike: ${upperMarket.strikePrice.toLocaleString()} &nbsp;|&nbsp;
                  NO ask: {upperMarket.bestBid != null ? (1 - upperMarket.bestBid).toFixed(4) : (1 - upperMarket.currentPrice).toFixed(4)}
                </Typography>
              )}
            </Box>
            {/* Lower barrier */}
            <Box>
              <FormControl fullWidth size="small">
                <InputLabel sx={{ fontSize: '0.8rem' }}>Lower Barrier (buy NO)</InputLabel>
                <Select
                  value={lowerMarket?.id ?? ''}
                  label="Lower Barrier (buy NO)"
                  onChange={e => {
                    const m = polyMarkets.find(x => x.id === e.target.value) ?? null;
                    onLowerMarketChange(m);
                  }}
                  sx={{ fontSize: '0.8rem' }}
                >
                  {lowerCandidates.map(m => {
                    const noAsk = m.bestBid != null ? (1 - m.bestBid) : (1 - m.currentPrice);
                    return (
                      <MenuItem key={m.id} value={m.id} sx={{ fontSize: '0.8rem' }}>
                        ↓ ${m.strikePrice.toLocaleString()} — NO ask: {noAsk.toFixed(3)}
                      </MenuItem>
                    );
                  })}
                  {lowerCandidates.length === 0 && (
                    <MenuItem disabled value="">No markets below spot</MenuItem>
                  )}
                </Select>
              </FormControl>
              {lowerMarket && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, pl: 0.5 }}>
                  Strike: ${lowerMarket.strikePrice.toLocaleString()} &nbsp;|&nbsp;
                  NO ask: {lowerMarket.bestBid != null ? (1 - lowerMarket.bestBid).toFixed(4) : (1 - lowerMarket.currentPrice).toFixed(4)}
                </Typography>
              )}
            </Box>
          </Box>
        </Paper>
      )}

      {/* Run Optimization button */}
      <Box sx={{ textAlign: 'center', position: 'relative', zIndex: 1 }}>
        <Button
          variant="contained"
          disabled={!canContinue}
          onClick={onContinue}
          sx={{
            px: 5, height: 44, fontSize: '1rem',
            background: canContinue ? 'linear-gradient(135deg, #00D1FF 0%, #00A3CC 100%)' : undefined,
          }}
        >
          Run Optimization
        </Button>
        {!canContinue && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Load a Polymarket event, select upper + lower barriers, and choose a Bybit expiry
          </Typography>
        )}
      </Box>

      <Typography variant="caption" sx={{ textAlign: 'center', color: 'rgba(139, 157, 195, 0.4)', mt: 'auto', pb: 1, position: 'relative', zIndex: 1 }}>
        v{__APP_VERSION__}
      </Typography>
    </Box>
  );
}
