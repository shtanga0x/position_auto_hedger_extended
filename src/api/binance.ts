import axios from 'axios';
import type { CryptoOption } from '../types';
import { API_CONFIG } from './config';

const CRYPTO_SYMBOLS: Record<CryptoOption, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
};

/** Fetch current spot price for a crypto asset */
export async function fetchCurrentPrice(crypto: CryptoOption): Promise<number> {
  const symbol = CRYPTO_SYMBOLS[crypto];
  const response = await axios.get(`${API_CONFIG.BINANCE_API_BASE}/api/v3/ticker/price`, {
    params: { symbol },
  });
  return parseFloat(response.data.price);
}
