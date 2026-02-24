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
  const canContinue = polyEvent !== null && bybitChain !== null;

  return (
    <Box sx={{ height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', p: 2, gap: 2.5, position: 'relative' }}>
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
          <TravelExplore sx={{ fontSize: 26, color: '#0A0E17' }} />
        </Box>
        <Typography variant="h5" sx={{
          fontWeight: 700,
          background: 'linear-gradient(90deg, #E8EDF5 0%, #00D1FF 100%)',
          backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          position_auto_hedger
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Auto-find the best 2-leg Bybit spread hedge for each Polymarket strike
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
            Load a Polymarket event and select a Bybit expiry to continue
          </Typography>
        )}
      </Box>

      <Typography variant="caption" sx={{ textAlign: 'center', color: 'rgba(139, 157, 195, 0.4)', mt: 'auto', pb: 1, position: 'relative', zIndex: 1 }}>
        v{__APP_VERSION__}
      </Typography>
    </Box>
  );
}
