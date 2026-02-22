import axios from 'axios';
import type { BybitInstrument, BybitTicker, BybitOptionChain } from '../types';
import { API_CONFIG } from './config';

const { BYBIT_API_BASE } = API_CONFIG;

// 30-second in-memory cache
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL = 30_000;
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data as T;
  return null;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

/** Parse Bybit symbol like "BTC-28FEB25-100000-C" or "BTC-27MAR26-86000-P-USDT" */
export function parseBybitSymbol(symbol: string): {
  base: string;
  expiryStr: string;
  strike: number;
  optionsType: 'Call' | 'Put';
} | null {
  const parts = symbol.split('-');
  // Strip trailing USDT suffix (5-part format) — all BTC options use this format
  if (parts.length === 5 && parts[4] === 'USDT') parts.pop();
  if (parts.length !== 4) return null;
  const strike = parseFloat(parts[2]);
  if (isNaN(strike)) return null;
  return {
    base: parts[0],
    expiryStr: parts[1],
    strike,
    optionsType: parts[3] === 'C' ? 'Call' : 'Put',
  };
}

/** Fetch BTC option instruments from Bybit V5 (with cursor pagination) */
export async function fetchBybitInstruments(): Promise<BybitInstrument[]> {
  const cacheKey = 'bybit-instruments';
  const cached = getCached<BybitInstrument[]>(cacheKey);
  if (cached) return cached;

  const instruments: BybitInstrument[] = [];
  let cursor = '';

  do {
    const params: Record<string, string> = { category: 'option', baseCoin: 'BTC' };
    if (cursor) params.cursor = cursor;

    const resp = await axios.get(`${BYBIT_API_BASE}/v5/market/instruments-info`, { params });
    const list = resp.data?.result?.list || [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of list as any[]) {
      const parsed = parseBybitSymbol(item.symbol);
      if (!parsed) continue;
      instruments.push({
        symbol: item.symbol,
        optionsType: parsed.optionsType,
        strike: parsed.strike,
        expiryTimestamp: parseInt(item.deliveryTime, 10),
      });
    }

    cursor = resp.data?.result?.nextPageCursor || '';
  } while (cursor);

  setCache(cacheKey, instruments);
  return instruments;
}

/** Fetch BTC option tickers from Bybit V5 (with cursor pagination) */
export async function fetchBybitTickers(): Promise<Map<string, BybitTicker>> {
  const cacheKey = 'bybit-tickers';
  const cached = getCached<Map<string, BybitTicker>>(cacheKey);
  if (cached) return cached;

  const tickers = new Map<string, BybitTicker>();
  let cursor = '';

  do {
    const params: Record<string, string> = { category: 'option', baseCoin: 'BTC' };
    if (cursor) params.cursor = cursor;

    const resp = await axios.get(`${BYBIT_API_BASE}/v5/market/tickers`, { params });
    const list = resp.data?.result?.list || [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of list as any[]) {
      tickers.set(item.symbol, {
        symbol: item.symbol,
        bid1Price: parseFloat(item.bid1Price) || 0,
        ask1Price: parseFloat(item.ask1Price) || 0,
        markPrice: parseFloat(item.markPrice) || 0,
        markIv: parseFloat(item.markIv) || 0,
        delta: parseFloat(item.delta) || 0,
        gamma: parseFloat(item.gamma) || 0,
        vega: parseFloat(item.vega) || 0,
        theta: parseFloat(item.theta) || 0,
      });
    }

    cursor = resp.data?.result?.nextPageCursor || '';
  } while (cursor);

  setCache(cacheKey, tickers);
  return tickers;
}

/** Fetch BTC spot price from Bybit */
export async function fetchBybitSpotPrice(): Promise<number> {
  const cacheKey = 'bybit-spot';
  const cached = getCached<number>(cacheKey);
  if (cached) return cached;

  const resp = await axios.get(`${BYBIT_API_BASE}/v5/market/tickers`, {
    params: { category: 'spot', symbol: 'BTCUSDT' },
  });

  const price = parseFloat(resp.data?.result?.list?.[0]?.lastPrice) || 0;
  setCache(cacheKey, price);
  return price;
}

/** Group instruments by expiry into BybitOptionChain[], sorted chronologically */
export function groupByExpiry(
  instruments: BybitInstrument[],
  tickers: Map<string, BybitTicker>,
): BybitOptionChain[] {
  const groups = new Map<number, BybitInstrument[]>();

  for (const inst of instruments) {
    const existing = groups.get(inst.expiryTimestamp) || [];
    existing.push(inst);
    groups.set(inst.expiryTimestamp, existing);
  }

  const chains: BybitOptionChain[] = [];
  for (const [expiryTs, insts] of groups) {
    const date = new Date(expiryTs);
    const expiryLabel = date.toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    // Filter tickers for this expiry's instruments
    const chainTickers = new Map<string, BybitTicker>();
    for (const inst of insts) {
      const t = tickers.get(inst.symbol);
      if (t) chainTickers.set(inst.symbol, t);
    }

    // Sort instruments by strike
    insts.sort((a, b) => a.strike - b.strike);

    chains.push({
      expiryLabel,
      expiryTimestamp: expiryTs,
      instruments: insts,
      tickers: chainTickers,
    });
  }

  // Sort chronologically
  chains.sort((a, b) => a.expiryTimestamp - b.expiryTimestamp);
  return chains;
}
