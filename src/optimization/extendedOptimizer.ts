import type { ParsedMarket, BybitOptionChain, ExtendedMatch } from '../types';
import { priceHit, bybitTradingFee, solveImpliedVol, autoH } from '../pricing/engine';

const YEAR_SEC = 365.25 * 24 * 3600;
const NUM_GRID = 200;

function closestStrike(candidates: number[], target: number): number | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, k) =>
    Math.abs(k - target) < Math.abs(best - target) ? k : best,
  );
}

/**
 * Run optimization for the 6-leg symmetric BTC strategy across ALL available
 * Polymarket strike pairs (every upper × lower combination):
 *
 *   1. Long straddle at K_mid (closest Bybit strike to spot, fixed for all pairs)
 *   2. Short strangle: outer Bybit strikes derived by symmetric distance —
 *        D_sym = min(K_poly_upper − spot, spot − K_poly_lower)
 *        outer_call_target = spot + D_sym  →  closest available Bybit call
 *        outer_put_target  = spot − D_sym  →  closest available Bybit put
 *   3. 2× Polymarket NO positions (upper HIT + lower HIT)
 *
 * Qty ratios are optimised independently for each side (short call, short put,
 * poly upper, poly lower), allowing asymmetric sizing when barriers are unequal.
 *
 * Evaluated at options expiry (tau_bybit→0, poly still has tauPolyRem remaining).
 */
export function runExtendedOptimization(
  polyMarkets: ParsedMarket[],
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
): ExtendedMatch[] {
  const results: ExtendedMatch[] = [];

  // --- Separate upper / lower poly markets ---
  const upperPoly = polyMarkets.filter(m => m.strikePrice > spotPrice);
  const lowerPoly = polyMarkets.filter(m => m.strikePrice < spotPrice);
  if (upperPoly.length === 0 || lowerPoly.length === 0) return [];

  // --- Bybit option sets ---
  const calls = bybitChain.instruments.filter(i => i.optionsType === 'Call');
  const puts  = bybitChain.instruments.filter(i => i.optionsType === 'Put');

  // --- Fixed straddle strike: closest Bybit strike to spot that has both C+P ---
  const callStrikeSet = new Set(calls.map(c => c.strike));
  const putStrikeSet  = new Set(puts.map(p => p.strike));
  const straddleCandidates = [...callStrikeSet].filter(
    k => putStrikeSet.has(k) && k >= spotPrice * 0.97 && k <= spotPrice * 1.03,
  );
  if (straddleCandidates.length === 0) return [];

  const kMid = closestStrike(straddleCandidates, spotPrice)!;
  const longCallInst = calls.find(c => c.strike === kMid)!;
  const longPutInst  = puts.find(p => p.strike === kMid)!;

  const longCallTicker = bybitChain.tickers.get(longCallInst.symbol);
  const longPutTicker  = bybitChain.tickers.get(longPutInst.symbol);
  if (!longCallTicker || !longPutTicker) return [];

  const longCallAsk = longCallTicker.ask1Price;
  const longPutAsk  = longPutTicker.ask1Price;
  if (longCallAsk <= 0 || longPutAsk <= 0) return [];

  // Pre-compute long fees (same for all combos)
  const longCallFee = bybitTradingFee(spotPrice, longCallAsk, bybitQty);
  const longPutFee  = bybitTradingFee(spotPrice, longPutAsk,  bybitQty);

  // Available outer strike lists (must be beyond the straddle strike)
  const outerCallStrikes = calls.filter(c => c.strike > kMid).map(c => c.strike);
  const outerPutStrikes  = puts.filter(p => p.strike < kMid).map(p => p.strike);

  // --- P&L evaluation grid (±25% from spot) ---
  const gridLower = 0.75 * spotPrice;
  const gridUpper = 1.25 * spotPrice;
  const gridStep  = (gridUpper - gridLower) / (NUM_GRID - 1);

  // --- Qty ratio grids (independent per side) ---
  const qShortRatios = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const qPolyRatios  = [0, 0.5, 1.0, 1.5, 2.0, 3.0];

  // --- Iterate all Poly pairs ---
  for (const polyUpper of upperPoly) {
    for (const polyLower of lowerPoly) {
      const K_upper = polyUpper.strikePrice;
      const K_lower = polyLower.strikePrice;

      // --- Taus ---
      const tauPolyUpper = Math.max((polyUpper.endDate - nowSec) / YEAR_SEC, 0);
      const tauPolyLower = Math.max((polyLower.endDate - nowSec) / YEAR_SEC, 0);
      if (tauPolyUpper <= 0 || tauPolyLower <= 0) continue;

      const tauBybit = Math.max(((bybitChain.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0);
      if (tauBybit <= 0) continue;

      const tauPoly    = Math.min(tauPolyUpper, tauPolyLower);
      const tauPolyRem = Math.max(tauPoly - tauBybit, 0);

      // --- Calibrate Poly IVs ---
      const hPoly = autoH(tauPoly);

      const yesBidUpper = (polyUpper.bestBid != null && polyUpper.bestBid > 0)
        ? polyUpper.bestBid : polyUpper.currentPrice;
      const noAskUpper = 1 - yesBidUpper;
      if (noAskUpper < 0.01 || noAskUpper > 0.9999) continue;

      const yesBidLower = (polyLower.bestBid != null && polyLower.bestBid > 0)
        ? polyLower.bestBid : polyLower.currentPrice;
      const noAskLower = 1 - yesBidLower;
      if (noAskLower < 0.01 || noAskLower > 0.9999) continue;

      const polyUpperIv = solveImpliedVol(
        spotPrice, K_upper, tauPolyUpper, polyUpper.currentPrice, 'hit', true, hPoly,
      );
      const polyLowerIv = solveImpliedVol(
        spotPrice, K_lower, tauPolyLower, polyLower.currentPrice, 'hit', false, hPoly,
      );
      if (!polyUpperIv || polyUpperIv <= 0 || !polyLowerIv || polyLowerIv <= 0) continue;

      // --- Symmetric Bybit outer strikes ---
      // D_sym = min distance from spot to either Poly barrier → symmetric bracket
      const D_sym = Math.min(K_upper - spotPrice, spotPrice - K_lower);

      const shortCallStrike = closestStrike(outerCallStrikes, spotPrice + D_sym);
      const shortPutStrike  = closestStrike(outerPutStrikes,  spotPrice - D_sym);
      if (shortCallStrike === null || shortPutStrike === null) continue;
      if (shortCallStrike <= kMid || shortPutStrike >= kMid) continue;

      const shortCallInst = calls.find(c => c.strike === shortCallStrike)!;
      const shortPutInst  = puts.find(p => p.strike === shortPutStrike)!;

      const shortCallTicker = bybitChain.tickers.get(shortCallInst.symbol);
      const shortPutTicker  = bybitChain.tickers.get(shortPutInst.symbol);
      if (!shortCallTicker || !shortPutTicker) continue;

      const shortCallBid = shortCallTicker.bid1Price;
      const shortPutBid  = shortPutTicker.bid1Price;
      if (shortCallBid <= 0 || shortPutBid <= 0) continue;

      const hPolyRem = autoH(tauPolyRem);

      // Pre-build Poly NO value grid (shared across all qty combos for this pair)
      const polyUpperNoGrid = new Float64Array(NUM_GRID);
      const polyLowerNoGrid = new Float64Array(NUM_GRID);
      for (let i = 0; i < NUM_GRID; i++) {
        const S = gridLower + gridStep * i;
        if (tauPolyRem <= 0) {
          polyUpperNoGrid[i] = S >= K_upper ? 0 : 1;
          polyLowerNoGrid[i] = S <= K_lower ? 0 : 1;
        } else {
          polyUpperNoGrid[i] = 1 - priceHit(S, K_upper, polyUpperIv, tauPolyRem, true,  hPolyRem);
          polyLowerNoGrid[i] = 1 - priceHit(S, K_lower, polyLowerIv, tauPolyRem, false, hPolyRem);
        }
      }

      // Pre-build options intrinsic grid (shared across qty combos)
      const optionsBaseGrid = new Float64Array(NUM_GRID);
      for (let i = 0; i < NUM_GRID; i++) {
        const S = gridLower + gridStep * i;
        optionsBaseGrid[i] =
          (Math.max(0, S - kMid)          - longCallAsk) * bybitQty - longCallFee
        + (Math.max(0, kMid - S)          - longPutAsk)  * bybitQty - longPutFee
        - Math.max(0, S - shortCallStrike)  // scaled by shortCallQty below
        - Math.max(0, shortPutStrike - S);  // scaled by shortPutQty below
        // Note: sign-correct but partial; we add the bid credits + qty in the inner loop
      }

      // --- Independent qty grid search ---
      for (const qShortCall of qShortRatios) {
        const shortCallQty = bybitQty * qShortCall;
        const shortCallFee = bybitTradingFee(spotPrice, shortCallBid, shortCallQty);
        const shortCallCredit = shortCallBid * shortCallQty - shortCallFee;

        for (const qShortPut of qShortRatios) {
          const shortPutQty = bybitQty * qShortPut;
          const shortPutFee = bybitTradingFee(spotPrice, shortPutBid, shortPutQty);
          const shortPutCredit = shortPutBid * shortPutQty - shortPutFee;

          for (const qPolyUp of qPolyRatios) {
            const polyUpperQty = bybitQty * qPolyUp;

            for (const qPolyLo of qPolyRatios) {
              const polyLowerQty = bybitQty * qPolyLo;

              const totalEntryCost =
                bybitQty * longCallAsk + longCallFee
                + bybitQty * longPutAsk  + longPutFee
                - shortCallQty * shortCallBid + shortCallFee
                - shortPutQty  * shortPutBid  + shortPutFee
                + polyUpperQty * noAskUpper
                + polyLowerQty * noAskLower;

              if (totalEntryCost <= 0) continue;

              // --- Evaluate P&L at each grid point ---
              let sum3 = 0, count3 = 0;
              let sum7 = 0, count7 = 0;
              let sumDip = 0, countDip = 0;
              let minPnl = Infinity;

              for (let i = 0; i < NUM_GRID; i++) {
                const S = gridLower + gridStep * i;

                const pnl =
                  (Math.max(0, S - kMid) - longCallAsk) * bybitQty - longCallFee
                  + (Math.max(0, kMid - S) - longPutAsk)  * bybitQty - longPutFee
                  + shortCallCredit - Math.max(0, S - shortCallStrike) * shortCallQty
                  + shortPutCredit  - Math.max(0, shortPutStrike - S)  * shortPutQty
                  + (polyUpperNoGrid[i] - noAskUpper) * polyUpperQty
                  + (polyLowerNoGrid[i] - noAskLower) * polyLowerQty;

                if (pnl < minPnl) minPnl = pnl;

                const pct = Math.abs(S / spotPrice - 1);
                if (pct < 0.01)                 { sumDip += pnl; countDip++; }
                if (pct >= 0.01 && pct <= 0.03) { sum3   += pnl; count3++;   }
                if (pct >= 0.01 && pct <= 0.07) { sum7   += pnl; count7++;   }
              }

              const avgPnl3pct = count3   > 0 ? sum3   / count3   : 0;
              const avgPnl7pct = count7   > 0 ? sum7   / count7   : 0;
              const centralDip = countDip > 0 ? sumDip / countDip : 0;
              const maxLoss    = minPnl;

              if (avgPnl7pct <= 0) continue;

              results.push({
                longStrike: kMid,
                shortCallStrike,
                shortPutStrike,
                longCallInstrument:  longCallInst,
                longPutInstrument:   longPutInst,
                shortCallInstrument: shortCallInst,
                shortPutInstrument:  shortPutInst,
                polyUpperMarket:     polyUpper,
                polyLowerMarket:     polyLower,
                longQty:      bybitQty,
                shortCallQty,
                shortPutQty,
                polyUpperQty,
                polyLowerQty,
                longCallEntry:    longCallAsk,
                longPutEntry:     longPutAsk,
                shortCallEntry:   shortCallBid,
                shortPutEntry:    shortPutBid,
                polyUpperNoEntry: noAskUpper,
                polyLowerNoEntry: noAskLower,
                polyUpperIv,
                polyLowerIv,
                tauPolyRem,
                avgPnl3pct,
                avgPnl7pct,
                centralDip,
                maxLoss,
                totalEntryCost,
              });
            }
          }
        }
      }
    }
  }

  // Return top 30 sorted by avgPnl7pct descending
  return results
    .sort((a, b) => b.avgPnl7pct - a.avgPnl7pct)
    .slice(0, 30);
}
