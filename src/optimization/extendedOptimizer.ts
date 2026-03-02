import type { ParsedMarket, BybitOptionChain, ExtendedMatch } from '../types';
import {
  priceHit, bybitTradingFee, solveImpliedVol, autoH,
  bsCallPrice, bsPutPrice,
} from '../pricing/engine';

const YEAR_SEC = 365.25 * 24 * 3600;

/** Maximum asymmetry ratio between the two Poly barrier distances. */
const SYMMETRY_RATIO_MAX = 1.3;

/** Minimum barrier distance from spot (as fraction of spot) to consider. */
const MIN_BARRIER_DIST_PCT = 0.02;

function sortedByDistance(values: number[], target: number): number[] {
  return [...values].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
}

/**
 * 6-step NOW-curve optimization for the symmetric BTC strategy:
 *
 * Step 1 — Screen Poly pairs by symmetry (max/min barrier distance ≤ 1.3).
 * Step 2 — Fix Bybit straddle at the closest dual-strike (call+put) to spot.
 * Step 3 — Try ±2 outer-call and ±2 outer-put Bybit strikes; pick the combo that
 *           produces the flattest NOW P&L curve for the options-only structure in ±5%.
 * Step 4 — Analytically solve equal Poly qty so that the combined NOW P&L averages
 *           to zero in the ±1% range (break-even constraint).
 * Step 5 — Compute final avgPnl1pct and avgPnl7pct on the combined NOW curve.
 * Step 6 — Return top 30 by avgPnl7pct.
 */
export function runExtendedOptimization(
  polyMarkets: ParsedMarket[],
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
): ExtendedMatch[] {
  const results: ExtendedMatch[] = [];

  const calls = bybitChain.instruments.filter(i => i.optionsType === 'Call');
  const puts  = bybitChain.instruments.filter(i => i.optionsType === 'Put');

  const callStrikeSet = new Set(calls.map(c => c.strike));
  const putStrikeSet  = new Set(puts.map(p => p.strike));
  const dualStrikes   = [...callStrikeSet].filter(k => putStrikeSet.has(k)).sort((a, b) => a - b);
  if (dualStrikes.length === 0) return [];

  const tauBybit = Math.max(((bybitChain.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0);
  if (tauBybit <= 0) return [];

  // Helpers
  const getTicker = (sym: string) => bybitChain.tickers.get(sym);
  const getAsk    = (sym: string) => getTicker(sym)?.ask1Price  ?? 0;
  const getBid    = (sym: string) => getTicker(sym)?.bid1Price  ?? 0;
  const getMarkIv = (sym: string) => {
    const iv = getTicker(sym)?.markIv ?? 0;
    return iv > 0 ? iv : 0.8;
  };

  // Evaluation grids
  const FLAT_N = 200; // flatness evaluation: ±12% of spot
  const SCORE_N = 300; // scoring: ±25% of spot

  const flatLo = spotPrice * 0.88;
  const flatHi = spotPrice * 1.12;
  const flatStep = (flatHi - flatLo) / (FLAT_N - 1);

  const scoreLo = spotPrice * 0.75;
  const scoreHi = spotPrice * 1.25;
  const scoreStep = (scoreHi - scoreLo) / (SCORE_N - 1);

  const flatGrid  = Float64Array.from({ length: FLAT_N },  (_, i) => flatLo  + flatStep  * i);
  const scoreGrid = Float64Array.from({ length: SCORE_N }, (_, i) => scoreLo + scoreStep * i);

  // Pre-separate upper/lower poly markets
  const upperPoly = polyMarkets.filter(m => m.strikePrice > spotPrice);
  const lowerPoly = polyMarkets.filter(m => m.strikePrice < spotPrice);
  if (upperPoly.length === 0 || lowerPoly.length === 0) return [];

  for (const polyUpper of upperPoly) {
    for (const polyLower of lowerPoly) {
      const K_upper = polyUpper.strikePrice;
      const K_lower = polyLower.strikePrice;

      // ── Step 1: Symmetry filter ──────────────────────────────────────────────
      const D_upper = K_upper - spotPrice;
      const D_lower = spotPrice - K_lower;
      if (D_upper < spotPrice * MIN_BARRIER_DIST_PCT) continue;
      if (D_lower < spotPrice * MIN_BARRIER_DIST_PCT) continue;
      const symRatio = Math.max(D_upper, D_lower) / Math.min(D_upper, D_lower);
      if (symRatio > SYMMETRY_RATIO_MAX) continue;

      // ── Poly tau / IV calibration ────────────────────────────────────────────
      const tauPolyUpper = Math.max((polyUpper.endDate - nowSec) / YEAR_SEC, 0);
      const tauPolyLower = Math.max((polyLower.endDate - nowSec) / YEAR_SEC, 0);
      if (tauPolyUpper <= 0 || tauPolyLower <= 0) continue;

      const tauPolyNow = Math.min(tauPolyUpper, tauPolyLower);
      const hPolyNow   = autoH(tauPolyNow);

      const yesBidUpper = (polyUpper.bestBid != null && polyUpper.bestBid > 0)
        ? polyUpper.bestBid : polyUpper.currentPrice;
      const noAskUpper = 1 - yesBidUpper;
      if (noAskUpper < 0.01 || noAskUpper > 0.9999) continue;

      const yesBidLower = (polyLower.bestBid != null && polyLower.bestBid > 0)
        ? polyLower.bestBid : polyLower.currentPrice;
      const noAskLower = 1 - yesBidLower;
      if (noAskLower < 0.01 || noAskLower > 0.9999) continue;

      const polyUpperIv = solveImpliedVol(
        spotPrice, K_upper, tauPolyUpper, polyUpper.currentPrice, 'hit', true, hPolyNow,
      );
      const polyLowerIv = solveImpliedVol(
        spotPrice, K_lower, tauPolyLower, polyLower.currentPrice, 'hit', false, hPolyNow,
      );
      if (!polyUpperIv || polyUpperIv <= 0 || !polyLowerIv || polyLowerIv <= 0) continue;

      // ── Pre-build poly-unit NOW value grid (score range) ─────────────────────
      // poly_unit(S) = (1 - upperYes(S) - noAskUpper) + (1 - lowerYes(S) - noAskLower)
      // Total poly P&L = polyQty × poly_unit(S)
      const polyUnitGrid = new Float64Array(SCORE_N);
      for (let i = 0; i < SCORE_N; i++) {
        const S = scoreGrid[i];
        const upperYes = priceHit(S, K_upper, polyUpperIv, tauPolyNow, true,  hPolyNow);
        const lowerYes = priceHit(S, K_lower, polyLowerIv, tauPolyNow, false, hPolyNow);
        polyUnitGrid[i] = (1 - upperYes - noAskUpper) + (1 - lowerYes - noAskLower);
      }

      // ── Step 2: Straddle candidates — 3 nearest dual strikes to spot ─────────
      const kMidCandidates = sortedByDistance(dualStrikes, spotPrice).slice(0, 3);

      // ── Step 3: Outer-strike candidates for symmetric strangle ───────────────
      // Use D_sym = min of the two barrier distances for the symmetric target
      const D_sym = Math.min(D_upper, D_lower);
      const outerCallTarget = spotPrice + D_sym;
      const outerPutTarget  = spotPrice - D_sym;

      // All call strikes > target zone (we want 5 nearest to target, excluding kMid)
      const allCallStrikes = calls.map(c => c.strike);
      const allPutStrikes  = puts.map(p => p.strike);

      // ── Search for best (kMid, outer_call, outer_put) by flatness ────────────
      let bestFlatness = Infinity;
      type Combo = {
        kMid: number;
        longCallAsk: number; longPutAsk: number;
        shortCallBid: number; shortPutBid: number;
        iv_lc: number; iv_lp: number; iv_sc: number; iv_sp: number;
        shortCallStrike: number; shortPutStrike: number;
      };
      let bestCombo: Combo | null = null;

      for (const kMid of kMidCandidates) {
        const lcInst = calls.find(c => c.strike === kMid);
        const lpInst = puts.find(p => p.strike === kMid);
        if (!lcInst || !lpInst) continue;

        const longCallAsk = getAsk(lcInst.symbol);
        const longPutAsk  = getAsk(lpInst.symbol);
        if (longCallAsk <= 0 || longPutAsk <= 0) continue;

        const iv_lc = getMarkIv(lcInst.symbol);
        const iv_lp = getMarkIv(lpInst.symbol);

        // Outer call candidates: 5 nearest to target that are strictly > kMid
        const ocCandidates = sortedByDistance(
          allCallStrikes.filter(k => k > kMid),
          outerCallTarget,
        ).slice(0, 5);

        // Outer put candidates: 5 nearest to target that are strictly < kMid
        const opCandidates = sortedByDistance(
          allPutStrikes.filter(k => k < kMid),
          outerPutTarget,
        ).slice(0, 5);

        if (ocCandidates.length === 0 || opCandidates.length === 0) continue;

        for (const ocStrike of ocCandidates) {
          const ocInst = calls.find(c => c.strike === ocStrike)!;
          const shortCallBid = getBid(ocInst.symbol);
          if (shortCallBid <= 0) continue;
          const iv_sc = getMarkIv(ocInst.symbol);

          for (const opStrike of opCandidates) {
            const opInst = puts.find(p => p.strike === opStrike)!;
            const shortPutBid = getBid(opInst.symbol);
            if (shortPutBid <= 0) continue;
            const iv_sp = getMarkIv(opInst.symbol);

            // Compute options-only NOW P&L on flat grid, measure range in ±5%
            let maxPnl5 = -Infinity;
            let minPnl5 =  Infinity;
            const fee_lc = bybitTradingFee(spotPrice, longCallAsk, bybitQty);
            const fee_lp = bybitTradingFee(spotPrice, longPutAsk,  bybitQty);
            const fee_sc = bybitTradingFee(spotPrice, shortCallBid, bybitQty);
            const fee_sp = bybitTradingFee(spotPrice, shortPutBid,  bybitQty);

            let hasPoints = false;
            for (let i = 0; i < FLAT_N; i++) {
              const S = flatGrid[i];
              const pct = Math.abs(S / spotPrice - 1);
              if (pct > 0.05) continue;
              hasPoints = true;

              const pnl =
                (bsCallPrice(S, kMid,    iv_lc, tauBybit) - longCallAsk)  * bybitQty - fee_lc
                + (bsPutPrice(S, kMid,   iv_lp, tauBybit) - longPutAsk)   * bybitQty - fee_lp
                + (shortCallBid - bsCallPrice(S, ocStrike, iv_sc, tauBybit)) * bybitQty - fee_sc
                + (shortPutBid  - bsPutPrice(S,  opStrike, iv_sp, tauBybit)) * bybitQty - fee_sp;

              if (pnl > maxPnl5) maxPnl5 = pnl;
              if (pnl < minPnl5) minPnl5 = pnl;
            }

            if (!hasPoints) continue;
            const flatRange = maxPnl5 - minPnl5;

            if (flatRange < bestFlatness) {
              bestFlatness = flatRange;
              bestCombo = {
                kMid,
                longCallAsk, longPutAsk, shortCallBid, shortPutBid,
                iv_lc, iv_lp, iv_sc, iv_sp,
                shortCallStrike: ocStrike, shortPutStrike: opStrike,
              };
            }
          }
        }
      }

      if (!bestCombo) continue;

      const {
        kMid,
        longCallAsk, longPutAsk, shortCallBid, shortPutBid,
        iv_lc, iv_lp, iv_sc, iv_sp,
        shortCallStrike, shortPutStrike,
      } = bestCombo;

      const lcInst = calls.find(c => c.strike === kMid)!;
      const lpInst = puts.find(p => p.strike === kMid)!;
      const scInst = calls.find(c => c.strike === shortCallStrike)!;
      const spInst = puts.find(p => p.strike === shortPutStrike)!;

      const fee_lc = bybitTradingFee(spotPrice, longCallAsk, bybitQty);
      const fee_lp = bybitTradingFee(spotPrice, longPutAsk,  bybitQty);
      const fee_sc = bybitTradingFee(spotPrice, shortCallBid, bybitQty);
      const fee_sp = bybitTradingFee(spotPrice, shortPutBid,  bybitQty);

      // ── Step 4: Build options P&L on score grid ───────────────────────────────
      const optsGrid = new Float64Array(SCORE_N);
      for (let i = 0; i < SCORE_N; i++) {
        const S = scoreGrid[i];
        optsGrid[i] =
          (bsCallPrice(S, kMid,          iv_lc, tauBybit) - longCallAsk)  * bybitQty - fee_lc
          + (bsPutPrice(S, kMid,         iv_lp, tauBybit) - longPutAsk)   * bybitQty - fee_lp
          + (shortCallBid - bsCallPrice(S, shortCallStrike, iv_sc, tauBybit)) * bybitQty - fee_sc
          + (shortPutBid  - bsPutPrice(S, shortPutStrike,   iv_sp, tauBybit)) * bybitQty - fee_sp;
      }

      // ── Step 4: Solve polyQty for break-even at ±1% ──────────────────────────
      let sumOpts1 = 0, sumPolyUnit1 = 0, n1 = 0;
      for (let i = 0; i < SCORE_N; i++) {
        if (Math.abs(scoreGrid[i] / spotPrice - 1) <= 0.01) {
          sumOpts1     += optsGrid[i];
          sumPolyUnit1 += polyUnitGrid[i];
          n1++;
        }
      }
      if (n1 === 0 || sumPolyUnit1 <= 0) continue;

      const avgOpts1     = sumOpts1     / n1;
      const avgPolyUnit1 = sumPolyUnit1 / n1;

      // We need: avgOpts1 + polyQty × avgPolyUnit1 = 0
      if (avgPolyUnit1 <= 0) continue;   // poly doesn't gain near spot
      if (avgOpts1 >= 0) continue;       // options already profitable near spot — unusual, skip

      const polyQty = -avgOpts1 / avgPolyUnit1;
      if (polyQty <= 0 || polyQty > 20) continue; // sanity cap

      // ── Step 5: Final metrics on combined NOW curve ───────────────────────────
      let sum1 = 0, n1f = 0;
      let sum7 = 0, n7  = 0;
      let minPnl = Infinity;

      for (let i = 0; i < SCORE_N; i++) {
        const pnl = optsGrid[i] + polyQty * polyUnitGrid[i];
        if (pnl < minPnl) minPnl = pnl;
        const pct = Math.abs(scoreGrid[i] / spotPrice - 1);
        if (pct <= 0.01) { sum1 += pnl; n1f++; }
        if (pct <= 0.07) { sum7 += pnl; n7++;  }
      }

      const avgPnl1pct = n1f > 0 ? sum1 / n1f : 0;
      const avgPnl7pct = n7  > 0 ? sum7 / n7  : 0;
      if (avgPnl7pct <= 0) continue;

      const totalEntryCost =
        bybitQty * longCallAsk + fee_lc
        + bybitQty * longPutAsk  + fee_lp
        - bybitQty * shortCallBid + fee_sc
        - bybitQty * shortPutBid  + fee_sp
        + polyQty * noAskUpper
        + polyQty * noAskLower;

      results.push({
        longStrike:          kMid,
        shortCallStrike,
        shortPutStrike,
        longCallInstrument:  lcInst,
        longPutInstrument:   lpInst,
        shortCallInstrument: scInst,
        shortPutInstrument:  spInst,
        polyUpperMarket:     polyUpper,
        polyLowerMarket:     polyLower,
        longQty:      bybitQty,
        shortCallQty: bybitQty,
        shortPutQty:  bybitQty,
        polyUpperQty: polyQty,
        polyLowerQty: polyQty,
        longCallEntry:    longCallAsk,
        longPutEntry:     longPutAsk,
        shortCallEntry:   shortCallBid,
        shortPutEntry:    shortPutBid,
        polyUpperNoEntry: noAskUpper,
        polyLowerNoEntry: noAskLower,
        polyUpperIv,
        polyLowerIv,
        tauPolyRem: 0,
        avgPnl1pct,
        avgPnl7pct,
        centralDip: avgPnl1pct,
        maxLoss:    minPnl,
        totalEntryCost,
      });
    }
  }

  return results
    .sort((a, b) => b.avgPnl7pct - a.avgPnl7pct)
    .slice(0, 30);
}
