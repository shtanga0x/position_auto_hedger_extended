import { useState, useCallback } from 'react';
import { ThemeProvider, CssBaseline, Box, IconButton } from '@mui/material';
import { DarkMode, LightMode } from '@mui/icons-material';
import { darkTheme, lightTheme } from './theme';
import { SetupScreen } from './components/SetupScreen';
import { ChartScreen } from './components/ChartScreen';
import type { CryptoOption, OptionType, ParsedMarket, PolymarketEvent, PolymarketPosition, BybitPosition } from './types';

type Screen = 'setup' | 'chart';

function App() {
  const [screen, setScreen] = useState<Screen>('setup');
  const [isDark, setIsDark] = useState(true);

  // Polymarket state
  const [polyEvent, setPolyEvent] = useState<PolymarketEvent | null>(null);
  const [polyMarkets, setPolyMarkets] = useState<ParsedMarket[]>([]);
  const [crypto, setCrypto] = useState<CryptoOption | null>(null);
  const [optionType, setOptionType] = useState<OptionType>('above');
  const [polyPositions, setPolyPositions] = useState<PolymarketPosition[]>([]);

  // Bybit state
  const [bybitPositions, setBybitPositions] = useState<BybitPosition[]>([]);

  // Spot price (from either source)
  const [spotPrice, setSpotPrice] = useState(0);

  const handlePolyEventLoaded = useCallback(
    (event: PolymarketEvent, markets: ParsedMarket[], detectedCrypto: CryptoOption | null, detectedType: OptionType, spot: number) => {
      setPolyEvent(event);
      setPolyMarkets(markets);
      setCrypto(detectedCrypto);
      setOptionType(detectedType);
      setSpotPrice(prev => prev || spot); // prefer existing if already set
    },
    []
  );

  const handleBybitSpotPriceLoaded = useCallback((price: number) => {
    setSpotPrice(prev => prev || price);
  }, []);

  const handleContinue = useCallback(() => {
    setScreen('chart');
  }, []);

  const handleBack = useCallback(() => {
    setScreen('setup');
  }, []);

  return (
    <ThemeProvider theme={isDark ? darkTheme : lightTheme}>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', position: 'relative' }}>
        {/* Theme toggle */}
        <IconButton
          onClick={() => setIsDark(v => !v)}
          sx={{
            position: 'fixed', top: 16, right: 16, zIndex: 1300,
            bgcolor: isDark ? 'rgba(139, 157, 195, 0.1)' : 'rgba(0, 0, 0, 0.06)',
            '&:hover': { bgcolor: isDark ? 'rgba(139, 157, 195, 0.2)' : 'rgba(0, 0, 0, 0.12)' },
            color: isDark ? '#FFB020' : '#5A6A85',
          }}
        >
          {isDark ? <LightMode /> : <DarkMode />}
        </IconButton>

        {screen === 'setup' && (
          <SetupScreen
            polyPositions={polyPositions}
            bybitPositions={bybitPositions}
            onPolyPositionsChange={setPolyPositions}
            onBybitPositionsChange={setBybitPositions}
            onPolyEventLoaded={handlePolyEventLoaded}
            onBybitSpotPriceLoaded={handleBybitSpotPriceLoaded}
            onContinue={handleContinue}
          />
        )}
        {screen === 'chart' && (
          <ChartScreen
            polyEvent={polyEvent}
            polyMarkets={polyMarkets}
            crypto={crypto}
            optionType={optionType}
            spotPrice={spotPrice}
            polyPositions={polyPositions}
            bybitPositions={bybitPositions}
            onBack={handleBack}
          />
        )}
      </Box>
    </ThemeProvider>
  );
}

export default App;
