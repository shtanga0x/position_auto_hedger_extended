import { useState, useCallback } from 'react';
import { ThemeProvider, CssBaseline, Box, IconButton } from '@mui/material';
import { DarkMode, LightMode } from '@mui/icons-material';
import { darkTheme, lightTheme } from './theme';
import { FirstScreen } from './components/FirstScreen';
import { SecondScreen } from './components/SecondScreen';
import type { CryptoOption, OptionType, ParsedMarket, PolymarketEvent } from './types';

type Screen = 'first' | 'second';

interface AppState {
  event: PolymarketEvent | null;
  markets: ParsedMarket[];
  crypto: CryptoOption | null;
  optionType: OptionType;
}

function App() {
  const [screen, setScreen] = useState<Screen>('first');
  const [isDark, setIsDark] = useState(true);
  const [appState, setAppState] = useState<AppState>({
    event: null,
    markets: [],
    crypto: null,
    optionType: 'above',
  });

  const handleNavigateToChart = useCallback(
    (event: PolymarketEvent, markets: ParsedMarket[], crypto: CryptoOption | null, optionType: OptionType) => {
      setAppState({ event, markets, crypto, optionType });
      setScreen('second');
    },
    []
  );

  const handleBack = useCallback(() => {
    setScreen('first');
    setAppState({ event: null, markets: [], crypto: null, optionType: 'above' });
  }, []);

  return (
    <ThemeProvider theme={isDark ? darkTheme : lightTheme}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: '100vh',
          bgcolor: 'background.default',
          position: 'relative',
        }}
      >
        {/* Theme toggle — top right */}
        <IconButton
          onClick={() => setIsDark((v) => !v)}
          sx={{
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 1300,
            bgcolor: isDark ? 'rgba(139, 157, 195, 0.1)' : 'rgba(0, 0, 0, 0.06)',
            '&:hover': {
              bgcolor: isDark ? 'rgba(139, 157, 195, 0.2)' : 'rgba(0, 0, 0, 0.12)',
            },
            color: isDark ? '#FFB020' : '#5A6A85',
          }}
        >
          {isDark ? <LightMode /> : <DarkMode />}
        </IconButton>

        {screen === 'first' && (
          <FirstScreen onNavigateToChart={handleNavigateToChart} />
        )}
        {screen === 'second' && appState.event && (
          <SecondScreen
            event={appState.event}
            markets={appState.markets}
            crypto={appState.crypto}
            optionType={appState.optionType}
            onBack={handleBack}
          />
        )}
      </Box>
    </ThemeProvider>
  );
}

export default App;
