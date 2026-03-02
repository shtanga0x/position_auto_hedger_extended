import { useState, useCallback } from 'react';
import { ThemeProvider, CssBaseline, Box, IconButton } from '@mui/material';
import { DarkMode, LightMode, Refresh } from '@mui/icons-material';
import { darkTheme, lightTheme } from './theme';
import { SetupScreen } from './components/SetupScreen';
import { OptimizationScreen } from './components/OptimizationScreen';
import type { CryptoOption, OptionType, ParsedMarket, PolymarketEvent, BybitOptionChain as BybitChainType } from './types';
import { fetchCurrentPrice } from './api/binance';
import { fetchEventBySlug, parseMarkets } from './api/polymarket';
import { fetchBybitTickers, clearBybitCache } from './api/bybit';

type Screen = 'setup' | 'optimize';

function App() {
  const [screen, setScreen] = useState<Screen>('setup');
  const [isDark, setIsDark] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Polymarket state
  const [polyEvent, setPolyEvent] = useState<PolymarketEvent | null>(null);
  const [polyMarkets, setPolyMarkets] = useState<ParsedMarket[]>([]);
  const [crypto, setCrypto] = useState<CryptoOption | null>(null);

  // Selected strategy markets (upper HIT NO + lower HIT NO)
  const [upperMarket, setUpperMarket] = useState<ParsedMarket | null>(null);
  const [lowerMarket, setLowerMarket] = useState<ParsedMarket | null>(null);

  // Bybit state
  const [bybitChain, setBybitChain] = useState<BybitChainType | null>(null);

  // Spot price (from either source)
  const [spotPrice, setSpotPrice] = useState(0);
  const [polyUrl, setPolyUrl] = useState('');

  const handlePolyEventLoaded = useCallback(
    (event: PolymarketEvent, markets: ParsedMarket[], detectedCrypto: CryptoOption | null, _detectedType: OptionType, spot: number, url: string) => {
      setPolyEvent(event);
      setPolyMarkets(markets);
      setCrypto(detectedCrypto);
      setSpotPrice(prev => prev || spot);
      setPolyUrl(url);
      // Auto-select closest-above upper and closest-below lower
      const currentSpot = spot;
      const sortedMarkets = [...markets].sort((a, b) => a.strikePrice - b.strikePrice);
      const lowerCandidates = sortedMarkets.filter(m => m.strikePrice < currentSpot);
      const upperCandidates = sortedMarkets.filter(m => m.strikePrice > currentSpot);
      setLowerMarket(lowerCandidates.length > 0 ? lowerCandidates[lowerCandidates.length - 1] : null);
      setUpperMarket(upperCandidates.length > 0 ? upperCandidates[0] : null);
    },
    []
  );

  const handleBybitChainSelected = useCallback((chain: BybitChainType | null) => {
    setBybitChain(chain);
  }, []);

  const handleBybitSpotPriceLoaded = useCallback((price: number) => {
    setSpotPrice(prev => prev || price);
  }, []);

  const handleContinue = useCallback(() => {
    setScreen('optimize');
  }, []);

  const handleBack = useCallback(() => {
    setScreen('setup');
  }, []);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      if (crypto) {
        const newSpot = await fetchCurrentPrice(crypto);
        setSpotPrice(newSpot);
      }
      if (polyEvent) {
        const freshEvent = await fetchEventBySlug(polyEvent.slug);
        const freshMarkets = parseMarkets(freshEvent.markets);
        setPolyMarkets(freshMarkets);
        // Re-sync selected markets to fresh data
        setUpperMarket(prev => {
          if (!prev) return null;
          return freshMarkets.find(m => m.id === prev.id) ?? prev;
        });
        setLowerMarket(prev => {
          if (!prev) return null;
          return freshMarkets.find(m => m.id === prev.id) ?? prev;
        });
      }
      if (bybitChain) {
        clearBybitCache();
        const freshTickers = await fetchBybitTickers();
        const chainSymbols = new Set(bybitChain.instruments.map(i => i.symbol));
        const chainTickers = new Map([...freshTickers.entries()].filter(([sym]) => chainSymbols.has(sym)));
        setBybitChain({ ...bybitChain, tickers: chainTickers });
      }
    } catch (err) {
      console.error('Refresh failed:', err);
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, crypto, polyEvent, bybitChain]);

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

        {/* Refresh prices button */}
        {(polyEvent !== null || bybitChain !== null) && (
          <IconButton
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh prices & rerun optimization"
            sx={{
              position: 'fixed', top: 16, right: 64, zIndex: 1300,
              bgcolor: isDark ? 'rgba(34, 197, 94, 0.1)' : 'rgba(34, 197, 94, 0.06)',
              color: '#22C55E',
              '&:hover': { bgcolor: isDark ? 'rgba(34, 197, 94, 0.2)' : 'rgba(34, 197, 94, 0.12)' },
              '&.Mui-disabled': { color: 'rgba(34, 197, 94, 0.3)' },
            }}
          >
            <Refresh sx={{ animation: isRefreshing ? 'spin 1s linear infinite' : 'none', '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }} />
          </IconButton>
        )}

        {screen === 'setup' && (
          <SetupScreen
            polyEvent={polyEvent}
            polyMarkets={polyMarkets}
            spotPrice={spotPrice}
            upperMarket={upperMarket}
            lowerMarket={lowerMarket}
            bybitChain={bybitChain}
            onPolyEventLoaded={handlePolyEventLoaded}
            onBybitChainSelected={handleBybitChainSelected}
            onBybitSpotPriceLoaded={handleBybitSpotPriceLoaded}
            onUpperMarketChange={setUpperMarket}
            onLowerMarketChange={setLowerMarket}
            onContinue={handleContinue}
          />
        )}
        {screen === 'optimize' && (
          <OptimizationScreen
            polyEvent={polyEvent}
            polyMarkets={polyMarkets}
            crypto={crypto}
            upperMarket={upperMarket}
            lowerMarket={lowerMarket}
            spotPrice={spotPrice}
            bybitChain={bybitChain}
            polyUrl={polyUrl}
            onBack={handleBack}
          />
        )}
      </Box>
    </ThemeProvider>
  );
}

export default App;
