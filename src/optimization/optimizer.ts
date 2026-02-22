import type { ParsedMarket, OptionType, BybitOptionChain, BybitInstrument, OptMatchResult, StrikeOptResult } from '../types';
import { priceHit, priceAbove, bsPrice, bybitTradingFee, solveImpliedVol, autoH } from '../pricing/engine';

const YEAR_SEC = 365.25 * 24 * 3600;
const NUM_GRID = 200;
// Allow a small tolerance for floating-point near-zero negatives
const FEASIBILITY_EPSILON = -0.001;

/**
 * Run optimization for all Polymarket strikes against a Bybit option chain.
 *
 * 3-leg position:
 *   1. Poly NO (sized by hedge constraint so combined P&L ≈ 0 at poly strike)
 *   2. Long Bybit option (CALL for up-barrier, PUT for down-barrier) — any strike
 *   3. Short Bybit option at the Polymarket strike price (or nearest valid strike):
 *        - CALL: sell CALL at lowest available strike >= K_poly
 *        - PUT:  sell PUT at highest available strike <= K_poly
 *      This converts unlimited option profit into a spread centred on K_poly.
 *
 * Feasibility: no negative combined 3-leg P&L in ±20% around spot price.
 * Score: average 3-leg P&L in ±5%, ±10%, ±20% ranges around spot price.
 */
export function runOptimization(
  polyMarkets: ParsedMarket[],
  optionType: OptionType,
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
): StrikeOptResult[] {
  const results: StrikeOptResult[] = [];

  for (const market of polyMarkets) {
    if (market.strikePrice <= 0) continue;

    const tauPoly = Math.max((market.endDate - nowSec) / YEAR_SEC, 0);
    if (tauPoly <= 0) continue;

    const isUpBarrier = market.strikePrice > spotPrice;
    const matchingType = isUpBarrier ? 'Call' : 'Put';

    // NO ask price: what we pay to buy the NO side at market
    const noAskPrice = market.bestBid != null
      ? (1 - market.bestBid)
      : (1 - market.currentPrice);

    // Skip near-resolved markets (NO < 1 cent): polyQty = profit/noAsk would be astronomically large
    if (noAskPrice < 0.01 || noAskPrice >= 1) continue;

    // Calibrate poly implied vol at current tau with auto-H
    const hNow = autoH(tauPoly, 0);
    const polyIv = solveImpliedVol(
      spotPrice, market.strikePrice, tauPoly,
      market.currentPrice, optionType, isUpBarrier, hNow,
    );
    if (polyIv === null || polyIv <= 0) continue;

    // --- Find the short option leg (fixed to K_poly or nearest valid strike) ---
    // CALL (up-barrier): sell CALL at lowest available strike >= K_poly
    // PUT  (down-barrier): sell PUT at highest available strike <= K_poly
    const K = market.strikePrice;
    const sameTypeCandidates = bybitChain.instruments.filter(i => i.optionsType === matchingType);

    let shortInst: BybitInstrument | null = null;
    if (isUpBarrier) {
      const above = sameTypeCandidates
        .filter(i => i.strike >= K)
        .sort((a, b) => a.strike - b.strike);
      shortInst = above[0] ?? null;
    } else {
      const below = sameTypeCandidates
        .filter(i => i.strike <= K)
        .sort((a, b) => b.strike - a.strike);
      shortInst = below[0] ?? null;
    }

    if (!shortInst) continue; // no valid short strike available

    const shortTicker = bybitChain.tickers.get(shortInst.symbol);
    if (!shortTicker) continue;
    const shortBid = shortTicker.bid1Price;
    if (shortBid <= 0 || shortTicker.markIv <= 0) continue;

    const shortFee = bybitTradingFee(spotPrice, shortBid, bybitQty);

    let best5: OptMatchResult | null = null;
    let best10: OptMatchResult | null = null;
    let best20: OptMatchResult | null = null;

    // Filter long-leg candidates (same option type, different from short leg)
    const longCandidates = sameTypeCandidates.filter(
      inst => inst.symbol !== shortInst!.symbol,
    );

    for (const inst of longCandidates) {
      const ticker = bybitChain.tickers.get(inst.symbol);
      if (!ticker) continue;

      const bybitAsk = ticker.ask1Price;
      if (bybitAsk <= 0 || ticker.markIv <= 0) continue;

      const tauBybit = Math.max(((inst.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0);
      if (tauBybit <= 0) continue;

      // Evaluate at earlier expiry
      const tauEval = Math.min(tauPoly, tauBybit);
      const tauPolyRem = tauPoly - tauEval;
      const tauBybitRem = tauBybit - tauEval;

      // Entry fees
      const bybitFee = bybitTradingFee(spotPrice, bybitAsk, bybitQty);

      // Long option value at poly strike at evaluation time
      const longValueAtStrike = bsPrice(
        K, inst.strike, ticker.markIv, tauBybitRem, inst.optionsType,
      );
      const longProfitAtStrike = (longValueAtStrike - bybitAsk) * bybitQty - bybitFee;

      // Short option P&L at poly strike at evaluation time
      const shortValueAtStrike = bsPrice(
        K, shortInst.strike, shortTicker.markIv, tauBybitRem, shortInst.optionsType,
      );
      const shortPnlAtStrike = (shortBid - shortValueAtStrike) * bybitQty - shortFee;

      // Net option profit at the poly strike (used for hedge constraint)
      const netOptionProfitAtStrike = longProfitAtStrike + shortPnlAtStrike;

      // Skip if net option profit is non-positive at the barrier (no hedge value)
      if (netOptionProfitAtStrike <= 0) continue;

      // Hedge constraint: polyLoss(at strike) + netOptionProfit(at strike) = 0
      // At barrier hit: YES=1, NO=0, poly loss = noAskPrice × polyQty
      const polyQty = netOptionProfitAtStrike / noAskPrice;
      if (polyQty <= 0) continue;

      // Build P&L grid over ±20% around current spot price
      const lower = 0.8 * spotPrice;
      const upper = 1.2 * spotPrice;
      const step = (upper - lower) / (NUM_GRID - 1);

      let feasible = true;
      const gridPnl: number[] = new Array(NUM_GRID);

      for (let i = 0; i < NUM_GRID; i++) {
        const S = lower + step * i;

        // Poly NO position P&L at evaluation time
        let polyYes: number;
        if (tauPolyRem <= 0) {
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

        // Long Bybit option P&L
        const longValue = bsPrice(S, inst.strike, ticker.markIv, tauBybitRem, inst.optionsType);
        const longPnl = (longValue - bybitAsk) * bybitQty - bybitFee;

        // Short Bybit option P&L (sell side)
        const shortValue = bsPrice(S, shortInst.strike, shortTicker.markIv, tauBybitRem, shortInst.optionsType);
        const shortPnl = (shortBid - shortValue) * bybitQty - shortFee;

        const combined = polyPnl + longPnl + shortPnl;
        gridPnl[i] = combined;

        if (combined < FEASIBILITY_EPSILON) {
          feasible = false;
          break;
        }
      }

      if (!feasible) continue;

      // Compute average P&L in each range around spot price
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

      const avgPnl5  = avgInRange(0.95 * spotPrice, 1.05 * spotPrice);
      const avgPnl10 = avgInRange(0.90 * spotPrice, 1.10 * spotPrice);
      const avgPnl20 = avgInRange(0.80 * spotPrice, 1.20 * spotPrice);

      const match: OptMatchResult = {
        instrument: inst,
        ticker,
        shortInstrument: shortInst,
        shortTicker,
        polyQty,
        noAskPrice,
        bybitAsk,
        bybitFee,
        shortBid,
        shortFee,
        avgPnl5,
        avgPnl10,
        avgPnl20,
        tauPolyRem,
        tauBybitRem,
        tauEval,
      };

      if (best5  === null || avgPnl5  > best5.avgPnl5)   best5  = match;
      if (best10 === null || avgPnl10 > best10.avgPnl10)  best10 = match;
      if (best20 === null || avgPnl20 > best20.avgPnl20)  best20 = match;
    }

    results.push({ market, isUpBarrier, polyIv, best5, best10, best20 });
  }

  return results;
}
