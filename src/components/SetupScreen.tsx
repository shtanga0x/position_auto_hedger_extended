import { Box, Typography, Paper, Button } from '@mui/material';
import { TravelExplore } from '@mui/icons-material';
import type { CryptoOption, OptionType, ParsedMarket, PolymarketEvent, BybitOptionChain as BybitChainType } from '../types';
import { PolymarketPanel } from './PolymarketPanel';
import { BybitOptionChain } from './BybitOptionChain';

interface SetupScreenProps {
  polyEvent: PolymarketEvent | null;
  bybitChain: BybitChainType | null;
  onPolyEventLoaded: (event: PolymarketEvent, markets: ParsedMarket[], crypto: CryptoOption | null, optionType: OptionType, spotPrice: number) => void;
  onBybitChainSelected: (chain: BybitChainType | null) => void;
  onBybitSpotPriceLoaded: (price: number) => void;
  onContinue: () => void;
}

export function SetupScreen({
  polyEvent,
  bybitChain,
  onPolyEventLoaded,
  onBybitChainSelected,
  onBybitSpotPriceLoaded,
  onContinue,
}: SetupScreenProps) {
  // Require both sources for optimization
  const canContinue = polyEvent !== null && bybitChain !== null;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', p: 3, gap: 3, position: 'relative', overflow: 'hidden' }}>
      {/* Background decorations */}
      <Box sx={{ position: 'absolute', top: '-20%', left: '-10%', width: '60%', height: '60%', background: 'radial-gradient(ellipse at center, rgba(0, 209, 255, 0.08) 0%, transparent 70%)', pointerEvents: 'none' }} />
      <Box sx={{ position: 'absolute', bottom: '-20%', right: '-10%', width: '50%', height: '50%', background: 'radial-gradient(ellipse at center, rgba(255, 107, 53, 0.06) 0%, transparent 70%)', pointerEvents: 'none' }} />

      {/* Header */}
      <Box sx={{ textAlign: 'center', pt: 2, position: 'relative', zIndex: 1 }}>
        <Box sx={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 56, height: 56, borderRadius: '14px',
          background: 'linear-gradient(135deg, #00D1FF 0%, #00A3CC 100%)',
          mb: 2, boxShadow: '0 8px 32px rgba(0, 209, 255, 0.3)',
        }}>
          <TravelExplore sx={{ fontSize: 32, color: '#0A0E17' }} />
        </Box>
        <Typography variant="h4" sx={{
          fontWeight: 700,
          background: 'linear-gradient(90deg, #E8EDF5 0%, #00D1FF 100%)',
          backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          Grapher V5
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Find optimal Bybit hedges for each Polymarket strike
        </Typography>
      </Box>

      {/* Section A: Polymarket */}
      <Paper elevation={0} sx={{ p: 3, border: '1px solid rgba(139, 157, 195, 0.15)', position: 'relative', zIndex: 1 }}>
        <PolymarketPanel onEventLoaded={onPolyEventLoaded} />
      </Paper>

      {/* Section B: Bybit */}
      <Paper elevation={0} sx={{ p: 3, border: '1px solid rgba(139, 157, 195, 0.15)', position: 'relative', zIndex: 1 }}>
        <BybitOptionChain
          onChainSelected={onBybitChainSelected}
          onSpotPriceLoaded={onBybitSpotPriceLoaded}
        />
      </Paper>

      {/* Run Optimization button */}
      <Box sx={{ textAlign: 'center', position: 'relative', zIndex: 1, pb: 3 }}>
        <Button
          variant="contained"
          size="large"
          disabled={!canContinue}
          onClick={onContinue}
          sx={{
            px: 6, py: 1.5, fontSize: '1.1rem',
            background: canContinue ? 'linear-gradient(135deg, #00D1FF 0%, #00A3CC 100%)' : undefined,
          }}
        >
          Run Optimization
        </Button>
        {!canContinue && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Load a Polymarket event and select a Bybit expiry to continue
          </Typography>
        )}
      </Box>
      <Typography variant="caption" sx={{ textAlign: 'center', color: 'rgba(139, 157, 195, 0.4)', pb: 2, position: 'relative', zIndex: 1 }}>
        v{__APP_VERSION__}
      </Typography>
    </Box>
  );
}
