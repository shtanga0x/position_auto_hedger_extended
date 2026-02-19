import axios from 'axios';
import type { CryptoOption } from '../types';

const BINANCE_API_BASE = 'https://api.binance.com/api/v3';

const CRYPTO_SYMBOLS: Record<CryptoOption, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
};

/** Fetch current spot price for a crypto asset */
export async function fetchCurrentPrice(crypto: CryptoOption): Promise<number> {
  const symbol = CRYPTO_SYMBOLS[crypto];
  const response = await axios.get(`${BINANCE_API_BASE}/ticker/price`, {
    params: { symbol },
  });
  return parseFloat(response.data.price);
}
