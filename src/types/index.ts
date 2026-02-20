export interface Market {
  id: string;
  question: string;
  groupItemTitle: string;
  groupItemThreshold: number;
  endDate: number; // Unix timestamp (seconds)
  startDate: number; // Unix timestamp (seconds)
  clobTokenIds: string; // JSON-encoded string
  outcomePrices: string; // JSON-encoded string e.g. '["0.85","0.15"]'
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  startDate: number; // Unix timestamp (seconds)
  endDate: number; // Unix timestamp (seconds)
  markets: Market[];
  series?: {
    cgAssetName?: string;
    seriesSlug?: string;
  };
}

export interface PricePoint {
  t: number; // Unix timestamp
  p: number; // Price
}

export interface PriceHistory {
  history: PricePoint[];
}

export interface ParsedMarket {
  id: string;
  question: string;
  groupItemTitle: string;
  groupItemThreshold: number;
  endDate: number; // Unix timestamp (seconds)
  startDate: number; // Unix timestamp (seconds)
  yesTokenId: string;
  noTokenId: string;
  currentPrice: number; // YES outcome price (0-1)
  strikePrice: number; // Parsed strike price from groupItemTitle
}

export type CryptoOption = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export type OptionType = 'above' | 'hit';

export type Side = 'YES' | 'NO';

export interface ProjectionPoint {
  cryptoPrice: number;
  pnl: number;
}

export interface SelectedStrike {
  marketId: string;
  question: string;
  groupItemTitle: string;
  strikePrice: number;
  side: Side;
  entryPrice: number; // Price paid (YES price for YES, 1-YES price for NO)
  impliedVol: number; // Calibrated IV (same for YES/NO)
  isUpBarrier: boolean; // For hit-type: true if strike > spot (need price to rise)
}

// --- Bybit types ---

export interface BybitInstrument {
  symbol: string;           // e.g. "BTC-28FEB25-100000-C"
  optionsType: 'Call' | 'Put';
  strike: number;
  expiryTimestamp: number;  // Unix ms
}

export interface BybitTicker {
  symbol: string;
  bid1Price: number;
  ask1Price: number;
  markPrice: number;
  markIv: number;           // annualized IV from Bybit (0-1 scale, e.g. 0.55 = 55%)
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

export interface BybitOptionChain {
  expiryLabel: string;      // e.g. "28 Feb 2025"
  expiryTimestamp: number;  // Unix ms
  instruments: BybitInstrument[];
  tickers: Map<string, BybitTicker>;
}

export type BybitSide = 'buy' | 'sell';

export interface BybitPosition {
  symbol: string;
  optionsType: 'Call' | 'Put';
  strike: number;
  expiryTimestamp: number;  // Unix ms
  side: BybitSide;
  entryPrice: number;       // premium in USD
  markIv: number;
  quantity: number;
  entryFee: number;         // trading fee in USD
}

export interface PolymarketPosition extends SelectedStrike {
  quantity: number;
}
