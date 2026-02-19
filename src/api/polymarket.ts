import axios from 'axios';
import type { PolymarketEvent, ParsedMarket, CryptoOption, OptionType } from '../types';
import { API_CONFIG } from './config';

const { GAMMA_API_BASE } = API_CONFIG;

/** Parse ISO 8601 date string to Unix timestamp (seconds) */
function parseTimestamp(isoString: string): number {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

export async function fetchEventBySlug(slug: string): Promise<PolymarketEvent> {
  const response = await axios.get<PolymarketEvent>(
    `${GAMMA_API_BASE}/events/slug/${slug}`
  );
  const data = response.data;

  return {
    ...data,
    startDate: parseTimestamp(data.startDate as unknown as string),
    endDate: parseTimestamp(data.endDate as unknown as string),
    markets: data.markets
      .map((market) => ({
        ...market,
        startDate: parseTimestamp(market.startDate as unknown as string),
        endDate: parseTimestamp(market.endDate as unknown as string),
      }))
      .sort((a, b) => {
        if (a.groupItemThreshold && b.groupItemThreshold) {
          return a.groupItemThreshold - b.groupItemThreshold;
        }

        if (a.groupItemTitle && b.groupItemTitle) {
          return a.groupItemTitle.localeCompare(b.groupItemTitle);
        }

        return a.question.localeCompare(b.question);
      }),
  };
}

/** Parse strike price from groupItemTitle like "↑$100,000" or "$95,000" */
export function parseStrikePrice(title: string): number {
  // Remove arrows, dollar signs, commas, whitespace
  const cleaned = title.replace(/[↑↓$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

export function parseMarkets(markets: PolymarketEvent['markets']): ParsedMarket[] {
  return markets.map((market) => {
    const tokenIds = JSON.parse(market.clobTokenIds) as string[];
    let currentPrice = 0;
    try {
      const prices = JSON.parse(market.outcomePrices) as string[];
      currentPrice = parseFloat(prices[0]); // YES price
    } catch {
      currentPrice = 0;
    }
    return {
      id: market.id,
      question: market.question,
      groupItemTitle: market.groupItemTitle,
      groupItemThreshold: market.groupItemThreshold,
      endDate: market.endDate,
      startDate: market.startDate,
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      currentPrice,
      strikePrice: parseStrikePrice(market.groupItemTitle || ''),
    };
  });
}

/** Auto-detect crypto asset from event data */
export function detectCrypto(event: PolymarketEvent): CryptoOption | null {
  // Check series.cgAssetName first
  const cgAsset = (event.series?.cgAssetName || '').toLowerCase();
  if (cgAsset === 'bitcoin' || cgAsset === 'btc') return 'BTC';
  if (cgAsset === 'ethereum' || cgAsset === 'eth') return 'ETH';
  if (cgAsset === 'solana' || cgAsset === 'sol') return 'SOL';
  if (cgAsset === 'ripple' || cgAsset === 'xrp') return 'XRP';

  // Check series slug
  const slug = (event.series?.seriesSlug || '').toLowerCase();
  if (slug.includes('btc') || slug.includes('bitcoin')) return 'BTC';
  if (slug.includes('eth') || slug.includes('ethereum')) return 'ETH';
  if (slug.includes('sol') || slug.includes('solana')) return 'SOL';
  if (slug.includes('xrp') || slug.includes('ripple')) return 'XRP';

  // Parse event title
  const title = event.title.toLowerCase();
  if (title.includes('bitcoin') || title.includes('btc')) return 'BTC';
  if (title.includes('ethereum') || title.includes('eth')) return 'ETH';
  if (title.includes('solana') || title.includes('sol')) return 'SOL';
  if (title.includes('xrp') || title.includes('ripple')) return 'XRP';

  return null;
}

/** Detect option type from event/market data */
export function detectOptionType(event: PolymarketEvent): OptionType {
  // Check series slug patterns
  const slug = (event.series?.seriesSlug || '').toLowerCase();
  if (slug.includes('hit') || slug.includes('reach') || slug.includes('dip')) return 'hit';
  if (slug.includes('above') || slug.includes('strike')) return 'above';

  // Check market questions
  for (const market of event.markets) {
    const q = market.question.toLowerCase();
    if (q.includes('reach') || q.includes('dip') || q.includes('hit')) return 'hit';
    if (q.includes('above') || q.includes('below')) return 'above';
  }

  // Default to above
  return 'above';
}

export function extractSlugFromUrl(url: string): string | null {
  const regex = /^https?:\/\/(?:www\.)?polymarket\.com\/event\/([a-zA-Z0-9-]+)\/?.*$/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

export function isValidPolymarketUrl(url: string): boolean {
  return extractSlugFromUrl(url) !== null;
}
