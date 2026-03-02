export interface Market {
  id: string;
  question: string;
  groupItemTitle: string;
  groupItemThreshold: number;
  endDate: number; // Unix timestamp (seconds)
  startDate: number; // Unix timestamp (seconds)
  clobTokenIds: string; // JSON-encoded string
  outcomePrices: string; // JSON-encoded string e.g. '["0.85","0.15"]'
  bestBid?: string | number; // YES token best bid (CLOB top-of-book)
  bestAsk?: string | number; // YES token best ask (CLOB top-of-book)
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
  currentPrice: number; // YES outcome price mid (0-1)
  bestBid?: number;     // YES token best bid (0-1); undefined if not available
  bestAsk?: number;     // YES token best ask (0-1); undefined if not available
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

// --- Optimization types ---

export interface OptMatchResult {
  instrument: BybitInstrument;     // Long Bybit option (buy leg)
  ticker: BybitTicker;
  shortInstrument: BybitInstrument; // Short Bybit option at poly strike (sell leg)
  shortTicker: BybitTicker;
  polyQty: number;       // Polymarket NO quantity derived from hedge constraint
  noAskPrice: number;    // Entry price for Polymarket NO position
  bybitAsk: number;      // Bybit ask price at entry (long leg)
  bybitFee: number;      // Entry fee for long bybit position (total, already × qty)
  shortBid: number;      // Bybit bid price received at entry (short leg)
  shortFee: number;      // Entry fee for short bybit position (total, already × qty)
  avgPnl1: number;       // Average combined 3-leg P&L in ±1% range
  avgPnl10: number;      // Average combined 3-leg P&L in ±10% range
  avgPnl20: number;      // Average combined 3-leg P&L in ±20% range
  tauPolyRem: number;    // Poly time-to-expiry remaining at evaluation (years)
  tauBybitRem: number;   // Bybit time-to-expiry remaining at evaluation (years)
  tauEval: number;       // Time until evaluation point from now (years)
}

export interface StrikeOptResult {
  market: ParsedMarket;
  isUpBarrier: boolean;
  polyIv: number;        // Calibrated IV for this poly strike at current spot
  best1: OptMatchResult | null;   // Best match ranked by avgPnl1
  best10: OptMatchResult | null;  // Best match ranked by avgPnl10
  best20: OptMatchResult | null;  // Best match ranked by avgPnl20
}

// --- Extended 6-leg optimization types ---

export interface ExtendedMatch {
  // Strike structure
  longStrike: number;           // K_mid — long call+put here (straddle)
  shortCallStrike: number;      // K_outer_call — sell call here
  shortPutStrike: number;       // K_outer_put — sell put here

  // Instruments
  longCallInstrument: BybitInstrument;
  longPutInstrument: BybitInstrument;
  shortCallInstrument: BybitInstrument;
  shortPutInstrument: BybitInstrument;
  polyUpperMarket: ParsedMarket;
  polyLowerMarket: ParsedMarket;

  // Quantities
  longQty: number;              // bybitQty (base unit)
  shortCallQty: number;
  shortPutQty: number;
  polyUpperQty: number;
  polyLowerQty: number;

  // Entry prices (per unit)
  longCallEntry: number;        // ask
  longPutEntry: number;         // ask
  shortCallEntry: number;       // bid
  shortPutEntry: number;        // bid
  polyUpperNoEntry: number;     // 1 - yesBid
  polyLowerNoEntry: number;     // 1 - yesBid
  polyUpperIv: number;          // calibrated IV for upper barrier
  polyLowerIv: number;          // calibrated IV for lower barrier

  // Scoring
  tauPolyRem: number;           // poly time remaining after Bybit expires (years)
  avgPnl1pct: number;           // avg NOW P&L at the two barrier strikes ($ — target ≈ -targetLoss% × cost)
  avgPnl7pct: number;           // avg EXPIRY P&L at the two barrier strikes ($)
  centralDip: number;           // NOW P&L at spot ($)
  maxLoss: number;              // worst EXPIRY P&L in full ±25% grid ($, negative)
  totalEntryCost: number;       // net premium paid ($) — options + poly cost
}
