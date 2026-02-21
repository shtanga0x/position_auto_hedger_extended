import type { ParsedMarket, OptionType, BybitOptionChain, OptMatchResult, StrikeOptResult } from '../types';
import { priceHit, priceAbove, bsPrice, bybitTradingFee, solveImpliedVol, autoH } from '../pricing/engine';

const YEAR_SEC = 365.25 * 24 * 3600;
const BYBIT_QTY = 0.01;
const NUM_GRID = 200;
// Allow a small tolerance for floating-point near-zero negatives
const FEASIBILITY_EPSILON = -0.001;

/**
 * Run optimization for all Polymarket strikes against a Bybit option chain.
 *
 * For each Polymarket strike (HIT type):
 *   - Direction: isUpBarrier = strikePrice > spotPrice → use CALL options
 *   - For each matching Bybit option (same direction):
 *     - Fix bybit qty = 0.01
 *     - Evaluate at earlier of poly/bybit expiry
 *     - Derive poly qty so combined P&L = 0 at the poly strike (hedge constraint)
 *     - Feasibility: no negative combined P&L in ±20% range around poly strike
 *     - Score: average combined P&L in ±5%, ±10%, ±20% ranges
 *   - Keep best option per range
 */
export function runOptimization(
  polyMarkets: ParsedMarket[],
  optionType: OptionType,
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
): StrikeOptResult[] {
  const results: StrikeOptResult[] = [];

  for (const market of polyMarkets) {
    if (market.strikePrice <= 0) continue;

    const tauPoly = Math.max((market.endDate - nowSec) / YEAR_SEC, 0);
    if (tauPoly <= 0) continue;

    const isUpBarrier = market.strikePrice > spotPrice;
    const matchingType = isUpBarrier ? 'Call' : 'Put';

    // NO ask price: what we pay to buy the NO side at market
    // For YES bid = market.bestBid, NO ask = 1 - YES bid
    const noAskPrice = market.bestBid != null
      ? (1 - market.bestBid)
      : (1 - market.currentPrice);

    if (noAskPrice <= 0 || noAskPrice >= 1) continue;

    // Calibrate poly implied vol at current tau with auto-H
    const hNow = autoH(tauPoly, 0);
    const polyIv = solveImpliedVol(
      spotPrice, market.strikePrice, tauPoly,
      market.currentPrice, optionType, isUpBarrier, hNow,
    );
    if (polyIv === null || polyIv <= 0) continue;

    let best5: OptMatchResult | null = null;
    let best10: OptMatchResult | null = null;
    let best20: OptMatchResult | null = null;

    // Filter instruments to matching option type only
    const candidates = bybitChain.instruments.filter(inst => inst.optionsType === matchingType);

    for (const inst of candidates) {
      const ticker = bybitChain.tickers.get(inst.symbol);
      if (!ticker) continue;

      const bybitAsk = ticker.ask1Price;
      if (bybitAsk <= 0 || ticker.markIv <= 0) continue;

      const tauBybit = Math.max(((inst.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0);
      if (tauBybit <= 0) continue;

      // Evaluate at earlier expiry
      const tauEval = Math.min(tauPoly, tauBybit);
      const tauPolyRem = tauPoly - tauEval;   // poly time remaining at eval
      const tauBybitRem = tauBybit - tauEval; // bybit time remaining at eval

      // Entry fee for 0.01 bybit contracts
      const bybitFee = bybitTradingFee(spotPrice, bybitAsk, BYBIT_QTY);

      // Bybit option value at poly strike at evaluation time
      const bybitValueAtStrike = bsPrice(
        market.strikePrice, inst.strike, ticker.markIv, tauBybitRem, inst.optionsType,
      );
      const bybitProfitAtStrike = (bybitValueAtStrike - bybitAsk) * BYBIT_QTY - bybitFee;

      // Skip if bybit can't profit at the poly strike (no hedge value)
      if (bybitProfitAtStrike <= 0) continue;

      // Hedge constraint: polyLoss(at strike) + bybitProfit(at strike) = 0
      // Poly NO position: at barrier hit, YES=1, NO value=0, loss = noAskPrice × polyQty
      // ⇒ polyQty = bybitProfitAtStrike / noAskPrice
      const polyQty = bybitProfitAtStrike / noAskPrice;
      if (polyQty <= 0) continue;

      // Build P&L grid over [0.8*K, 1.2*K]
      const K = market.strikePrice;
      const lower = 0.8 * K;
      const upper = 1.2 * K;
      const step = (upper - lower) / (NUM_GRID - 1);

      let feasible = true;
      const gridPnl: number[] = new Array(NUM_GRID);

      for (let i = 0; i < NUM_GRID; i++) {
        const S = lower + step * i;

        // Poly NO position P&L at evaluation time
        let polyYes: number;
        if (tauPolyRem <= 0) {
          // Poly has expired: use step function
          if (optionType === 'above') {
            polyYes = S >= K ? 1 : 0;
          } else {
            polyYes = isUpBarrier ? (S >= K ? 1 : 0) : (S <= K ? 1 : 0);
          }
        } else {
          const hAtEval = autoH(tauPolyRem, 0);
          polyYes = optionType === 'above'
            ? priceAbove(S, K, polyIv, tauPolyRem, hAtEval)
            : priceHit(S, K, polyIv, tauPolyRem, isUpBarrier, hAtEval);
        }
        const polyPnl = ((1 - polyYes) - noAskPrice) * polyQty;

        // Bybit position P&L at evaluation time
        const bybitValue = bsPrice(S, inst.strike, ticker.markIv, tauBybitRem, inst.optionsType);
        const bybitPnl = (bybitValue - bybitAsk) * BYBIT_QTY - bybitFee;

        const combined = polyPnl + bybitPnl;
        gridPnl[i] = combined;

        if (combined < FEASIBILITY_EPSILON) {
          feasible = false;
          break;
        }
      }

      if (!feasible) continue;

      // Compute average P&L in each range
      const avgInRange = (lo: number, hi: number): number => {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < NUM_GRID; i++) {
          const S = lower + step * i;
          if (S >= lo && S <= hi) {
            sum += gridPnl[i];
            count++;
          }
        }
        return count > 0 ? sum / count : 0;
      };

      const avgPnl5 = avgInRange(0.95 * K, 1.05 * K);
      const avgPnl10 = avgInRange(0.90 * K, 1.10 * K);
      const avgPnl20 = avgInRange(0.80 * K, 1.20 * K);

      const match: OptMatchResult = {
        instrument: inst,
        ticker,
        polyQty,
        noAskPrice,
        bybitAsk,
        bybitFee,
        avgPnl5,
        avgPnl10,
        avgPnl20,
        tauPolyRem,
        tauBybitRem,
        tauEval,
      };

      if (best5 === null || avgPnl5 > best5.avgPnl5) best5 = match;
      if (best10 === null || avgPnl10 > best10.avgPnl10) best10 = match;
      if (best20 === null || avgPnl20 > best20.avgPnl20) best20 = match;
    }

    results.push({ market, isUpBarrier, polyIv, best5, best10, best20 });
  }

  return results;
}
