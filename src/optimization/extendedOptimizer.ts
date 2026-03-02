import type { ParsedMarket, BybitOptionChain, ExtendedMatch } from '../types';
import { priceHit, bybitTradingFee, solveImpliedVol, autoH } from '../pricing/engine';

const YEAR_SEC = 365.25 * 24 * 3600;
const NUM_GRID = 200;

/**
 * Run optimization for the 6-leg symmetric BTC strategy:
 *   1. Long straddle at K_mid (buy call + put at same strike near spot)
 *   2. Short strangle at outer strikes (sell call at K_outer_call, sell put at K_outer_put)
 *   3. 2× Polymarket NO (upper HIT + lower HIT barriers)
 *
 * Evaluated at options expiry (tau_bybit → 0, poly still has tauPolyRem remaining).
 * W-shaped P&L target: peaks at ±3–7% from spot, small dip at spot, loss beyond barriers.
 */
export function runExtendedOptimization(
  polyUpperMarket: ParsedMarket,
  polyLowerMarket: ParsedMarket,
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
): ExtendedMatch[] {
  const results: ExtendedMatch[] = [];

  // --- Compute taus ---
  const tauPolyUpper = Math.max((polyUpperMarket.endDate - nowSec) / YEAR_SEC, 0);
  const tauPolyLower = Math.max((polyLowerMarket.endDate - nowSec) / YEAR_SEC, 0);
  if (tauPolyUpper <= 0 || tauPolyLower <= 0) return [];

  const tauBybit = Math.max(((bybitChain.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0);
  if (tauBybit <= 0) return [];

  // Use the earlier poly expiry as reference (they're usually the same for weekly events)
  const tauPoly = Math.min(tauPolyUpper, tauPolyLower);
  // tauPolyRem = poly time remaining AFTER options expire
  const tauPolyRem = Math.max(tauPoly - tauBybit, 0);

  // --- Calibrate Polymarket IVs ---
  const hPoly = autoH(tauPoly);

  const yesBidUpper = (polyUpperMarket.bestBid != null && polyUpperMarket.bestBid > 0)
    ? polyUpperMarket.bestBid : polyUpperMarket.currentPrice;
  const noAskUpper = 1 - yesBidUpper;
  if (noAskUpper < 0.01 || noAskUpper > 0.9999) return [];

  const yesBidLower = (polyLowerMarket.bestBid != null && polyLowerMarket.bestBid > 0)
    ? polyLowerMarket.bestBid : polyLowerMarket.currentPrice;
  const noAskLower = 1 - yesBidLower;
  if (noAskLower < 0.01 || noAskLower > 0.9999) return [];

  const polyUpperIv = solveImpliedVol(
    spotPrice, polyUpperMarket.strikePrice, tauPolyUpper,
    polyUpperMarket.currentPrice, 'hit', true, hPoly,
  );
  const polyLowerIv = solveImpliedVol(
    spotPrice, polyLowerMarket.strikePrice, tauPolyLower,
    polyLowerMarket.currentPrice, 'hit', false, hPoly,
  );

  if (!polyUpperIv || polyUpperIv <= 0 || !polyLowerIv || polyLowerIv <= 0) return [];

  const K_upper = polyUpperMarket.strikePrice;
  const K_lower = polyLowerMarket.strikePrice;

  // --- Build candidate sets ---
  const calls = bybitChain.instruments.filter(i => i.optionsType === 'Call');
  const puts = bybitChain.instruments.filter(i => i.optionsType === 'Put');

  // midCandidates: strikes with BOTH call and put available, within ±2% of spot
  const midCallMap = new Map<number, typeof calls[0]>();
  const midPutMap = new Map<number, typeof puts[0]>();

  for (const c of calls) {
    if (c.strike >= spotPrice * 0.98 && c.strike <= spotPrice * 1.02) {
      midCallMap.set(c.strike, c);
    }
  }
  for (const p of puts) {
    if (p.strike >= spotPrice * 0.98 && p.strike <= spotPrice * 1.02) {
      midPutMap.set(p.strike, p);
    }
  }

  const midStrikes: number[] = [];
  for (const k of midCallMap.keys()) {
    if (midPutMap.has(k)) midStrikes.push(k);
  }

  if (midStrikes.length === 0) return [];

  // Grid: ±25% around spot
  const gridLower = 0.75 * spotPrice;
  const gridUpper = 1.25 * spotPrice;
  const gridStep = (gridUpper - gridLower) / (NUM_GRID - 1);

  // Short call: CALL strikes between (K_mid * 1.02, K_upper]
  // Short put:  PUT  strikes between [K_lower, K_mid * 0.98)
  const qShortRatios = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const qPolyRatios  = [0, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0];

  for (const kMid of midStrikes) {
    const longCallInst = midCallMap.get(kMid)!;
    const longPutInst  = midPutMap.get(kMid)!;

    const longCallTicker = bybitChain.tickers.get(longCallInst.symbol);
    const longPutTicker  = bybitChain.tickers.get(longPutInst.symbol);
    if (!longCallTicker || !longPutTicker) continue;

    const longCallAsk = longCallTicker.ask1Price;
    const longPutAsk  = longPutTicker.ask1Price;
    if (longCallAsk <= 0 || longPutAsk <= 0) continue;

    const outerCalls = calls.filter(c =>
      c.strike > kMid * 1.02 && c.strike <= K_upper,
    );
    const outerPuts = puts.filter(p =>
      p.strike < kMid * 0.98 && p.strike >= K_lower,
    );

    if (outerCalls.length === 0 || outerPuts.length === 0) continue;

    for (const shortCallInst of outerCalls) {
      const shortCallTicker = bybitChain.tickers.get(shortCallInst.symbol);
      if (!shortCallTicker) continue;
      const shortCallBid = shortCallTicker.bid1Price;
      if (shortCallBid <= 0) continue;

      for (const shortPutInst of outerPuts) {
        const shortPutTicker = bybitChain.tickers.get(shortPutInst.symbol);
        if (!shortPutTicker) continue;
        const shortPutBid = shortPutTicker.bid1Price;
        if (shortPutBid <= 0) continue;

        for (const qShortRatio of qShortRatios) {
          const shortCallQty = bybitQty * qShortRatio;
          const shortPutQty  = bybitQty * qShortRatio;

          // Pre-compute fees
          const longCallFee  = bybitTradingFee(spotPrice, longCallAsk,  bybitQty);
          const longPutFee   = bybitTradingFee(spotPrice, longPutAsk,   bybitQty);
          const shortCallFee = bybitTradingFee(spotPrice, shortCallBid, shortCallQty);
          const shortPutFee  = bybitTradingFee(spotPrice, shortPutBid,  shortPutQty);

          for (const qPolyRatio of qPolyRatios) {
            const polyUpperQty = bybitQty * qPolyRatio;
            const polyLowerQty = bybitQty * qPolyRatio;

            // Total entry cost (gross, all premiums + fees)
            const totalEntryCost =
              bybitQty * longCallAsk + longCallFee
              + bybitQty * longPutAsk  + longPutFee
              - shortCallQty * shortCallBid + shortCallFee
              - shortPutQty  * shortPutBid  + shortPutFee
              + polyUpperQty * noAskUpper
              + polyLowerQty * noAskLower;

            if (totalEntryCost <= 0) continue;

            // Evaluate P&L at 200 grid points AT OPTIONS EXPIRY (tau_bybit=0)
            const gridPnl = new Float64Array(NUM_GRID);

            const hPolyRem = autoH(tauPolyRem);

            for (let i = 0; i < NUM_GRID; i++) {
              const S = gridLower + gridStep * i;

              // Long straddle (intrinsic at expiry)
              const longCallPnl = (Math.max(0, S - kMid) - longCallAsk) * bybitQty - longCallFee;
              const longPutPnl  = (Math.max(0, kMid - S) - longPutAsk)  * bybitQty - longPutFee;

              // Short strangle (intrinsic at expiry)
              const shortCallPnl = (shortCallBid - Math.max(0, S - shortCallInst.strike)) * shortCallQty - shortCallFee;
              const shortPutPnl  = (shortPutBid  - Math.max(0, shortPutInst.strike - S))  * shortPutQty  - shortPutFee;

              // Polymarket NO positions (poly still alive at options expiry)
              let upperNoVal: number;
              let lowerNoVal: number;

              if (tauPolyRem <= 0) {
                // Poly also expired at the same time
                upperNoVal = S >= K_upper ? 0 : 1;
                lowerNoVal = S <= K_lower ? 0 : 1;
              } else {
                const upperYes = priceHit(S, K_upper, polyUpperIv, tauPolyRem, true,  hPolyRem);
                const lowerYes = priceHit(S, K_lower, polyLowerIv, tauPolyRem, false, hPolyRem);
                upperNoVal = 1 - upperYes;
                lowerNoVal = 1 - lowerYes;
              }

              const polyUpperPnl = (upperNoVal - noAskUpper) * polyUpperQty;
              const polyLowerPnl = (lowerNoVal - noAskLower) * polyLowerQty;

              gridPnl[i] = longCallPnl + longPutPnl + shortCallPnl + shortPutPnl + polyUpperPnl + polyLowerPnl;
            }

            // Score: avg P&L in ±1–3% and ±1–7% bands
            let sum3 = 0, count3 = 0;
            let sum7 = 0, count7 = 0;
            let minPnl = Infinity;

            for (let i = 0; i < NUM_GRID; i++) {
              const S = gridLower + gridStep * i;
              const pct = Math.abs(S / spotPrice - 1);
              const pnl = gridPnl[i];

              if (pnl < minPnl) minPnl = pnl;

              if (pct >= 0.01 && pct <= 0.03) { sum3 += pnl; count3++; }
              if (pct >= 0.01 && pct <= 0.07) { sum7 += pnl; count7++; }
            }

            const avgPnl3pct = count3 > 0 ? sum3 / count3 : 0;
            const avgPnl7pct = count7 > 0 ? sum7 / count7 : 0;
            const maxLoss = minPnl;

            // Keep results with positive avg P&L in ±7% band
            if (avgPnl7pct <= 0) continue;

            results.push({
              longStrike: kMid,
              shortCallStrike: shortCallInst.strike,
              shortPutStrike: shortPutInst.strike,
              longCallInstrument: longCallInst,
              longPutInstrument: longPutInst,
              shortCallInstrument: shortCallInst,
              shortPutInstrument: shortPutInst,
              polyUpperMarket,
              polyLowerMarket,
              longQty: bybitQty,
              shortCallQty,
              shortPutQty,
              polyUpperQty,
              polyLowerQty,
              longCallEntry: longCallAsk,
              longPutEntry: longPutAsk,
              shortCallEntry: shortCallBid,
              shortPutEntry: shortPutBid,
              polyUpperNoEntry: noAskUpper,
              polyLowerNoEntry: noAskLower,
              polyUpperIv,
              polyLowerIv,
              tauPolyRem,
              avgPnl3pct,
              avgPnl7pct,
              maxLoss,
              totalEntryCost,
            });
          }
        }
      }
    }
  }

  // Return top 20 sorted by avgPnl7pct descending
  return results
    .sort((a, b) => b.avgPnl7pct - a.avgPnl7pct)
    .slice(0, 20);
}
