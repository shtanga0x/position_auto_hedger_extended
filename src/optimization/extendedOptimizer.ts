import type { ParsedMarket, BybitOptionChain, ExtendedMatch } from '../types';
import {
  priceHit, bybitTradingFee, solveImpliedVol, autoH,
} from '../pricing/engine';

const YEAR_SEC = 365.25 * 24 * 3600;

/** Maximum asymmetry ratio between the two Poly barrier distances. */
const SYMMETRY_RATIO_MAX = 1.4;

/** Minimum barrier distance from spot (as fraction of spot) to consider. */
const MIN_BARRIER_DIST_PCT = 0.02;

/**
 * 6-leg symmetric BTC strategy optimizer.
 *
 * Evaluates P&L at Bybit OPTIONS EXPIRY (tau_opts=0) with Polymarket
 * contracts still having tauPolyRem = tauPoly - tauBybit remaining time.
 *
 * Key design decisions vs prior version:
 *  1. Evaluation at OPTIONS EXPIRY — options use intrinsic values, poly uses tauPolyRem.
 *  2. Outer strikes searched MOST OTM first (not nearest to symmetric target).
 *  3. polyQty grid-searched as polyQtyRef × k where polyQtyRef = optionsNetDebit / (noAsk1+noAsk2).
 *  4. No analytic break-even constraint that fails when barriers are far from spot.
 */
export function runExtendedOptimization(
  polyMarkets: ParsedMarket[],
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
): ExtendedMatch[] {
  const calls = bybitChain.instruments.filter(i => i.optionsType === 'Call');
  const puts  = bybitChain.instruments.filter(i => i.optionsType === 'Put');

  const callStrikeSet = new Set(calls.map(c => c.strike));
  const putStrikeSet  = new Set(puts.map(p => p.strike));
  const dualStrikes   = [...callStrikeSet].filter(k => putStrikeSet.has(k)).sort((a, b) => a - b);
  if (dualStrikes.length === 0) return [];

  const tauBybit = Math.max(((bybitChain.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0);
  if (tauBybit <= 0) return [];

  const getTicker = (sym: string) => bybitChain.tickers.get(sym);
  const getAsk    = (sym: string) => getTicker(sym)?.ask1Price ?? 0;
  const getBid    = (sym: string) => getTicker(sym)?.bid1Price ?? 0;

  // Score grid: ±25% of spot, evaluated AT OPTIONS EXPIRY
  const SCORE_N   = 300;
  const scoreLo   = spotPrice * 0.75;
  const scoreHi   = spotPrice * 1.25;
  const scoreStep = (scoreHi - scoreLo) / (SCORE_N - 1);
  const scoreGrid = Float64Array.from({ length: SCORE_N }, (_, i) => scoreLo + scoreStep * i);

  // Separate poly markets
  const upperPoly = polyMarkets.filter(m => m.strikePrice > spotPrice);
  const lowerPoly = polyMarkets.filter(m => m.strikePrice < spotPrice);
  if (upperPoly.length === 0 || lowerPoly.length === 0) return [];

  // kMid candidates: 3 nearest dual strikes to spot
  const kMidCandidates = [...dualStrikes]
    .sort((a, b) => Math.abs(a - spotPrice) - Math.abs(b - spotPrice))
    .slice(0, 3);

  // Outer call candidates: all calls above spot, sorted MOST OTM first (highest strike first)
  const outerCallPool = calls
    .map(c => c.strike)
    .filter(k => k > spotPrice)
    .sort((a, b) => b - a);  // descending = most OTM first

  // Outer put candidates: all puts below spot, sorted MOST OTM first (lowest strike first)
  const outerPutPool = puts
    .map(p => p.strike)
    .filter(k => k < spotPrice)
    .sort((a, b) => a - b);  // ascending = most OTM first

  if (outerCallPool.length === 0 || outerPutPool.length === 0) return [];

  const shortQtyRatios = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const polyQtyFactors = [0.5, 1.0, 2.0, 5.0, 10.0];

  // Accumulate results, dedup by structural key keeping best avgPnl7pct
  const best = new Map<string, ExtendedMatch>();

  for (const polyUpper of upperPoly) {
    for (const polyLower of lowerPoly) {
      const K_upper = polyUpper.strikePrice;
      const K_lower = polyLower.strikePrice;

      // ── Symmetry filter ─────────────────────────────────────────────────────
      const D_upper = K_upper - spotPrice;
      const D_lower = spotPrice - K_lower;
      if (D_upper < spotPrice * MIN_BARRIER_DIST_PCT) continue;
      if (D_lower < spotPrice * MIN_BARRIER_DIST_PCT) continue;
      const symRatio = Math.max(D_upper, D_lower) / Math.min(D_upper, D_lower);
      if (symRatio > SYMMETRY_RATIO_MAX) continue;

      // ── Poly time calculations ───────────────────────────────────────────────
      const tauPolyUpper = Math.max((polyUpper.endDate - nowSec) / YEAR_SEC, 0);
      const tauPolyLower = Math.max((polyLower.endDate - nowSec) / YEAR_SEC, 0);
      if (tauPolyUpper <= 0 || tauPolyLower <= 0) continue;

      const tauPolyNow = Math.min(tauPolyUpper, tauPolyLower);

      // Skip if poly expires before Bybit (no meaningful hedge at options expiry)
      if (tauPolyNow < tauBybit * 0.9) continue;

      // Poly time remaining AFTER Bybit expires
      const tauPolyRem = Math.max(tauPolyNow - tauBybit, 0);

      // ── NO entry prices ──────────────────────────────────────────────────────
      const yesBidUpper = (polyUpper.bestBid != null && Number(polyUpper.bestBid) > 0)
        ? Number(polyUpper.bestBid) : polyUpper.currentPrice;
      const noAskUpper = 1 - yesBidUpper;
      if (noAskUpper < 0.01 || noAskUpper > 0.9999) continue;

      const yesBidLower = (polyLower.bestBid != null && Number(polyLower.bestBid) > 0)
        ? Number(polyLower.bestBid) : polyLower.currentPrice;
      const noAskLower = 1 - yesBidLower;
      if (noAskLower < 0.01 || noAskLower > 0.9999) continue;

      // ── Calibrate poly IVs from current YES prices ───────────────────────────
      const hPoly = autoH(tauPolyNow);
      const polyUpperIv = solveImpliedVol(
        spotPrice, K_upper, tauPolyUpper, polyUpper.currentPrice, 'hit', true, hPoly,
      );
      const polyLowerIv = solveImpliedVol(
        spotPrice, K_lower, tauPolyLower, polyLower.currentPrice, 'hit', false, hPoly,
      );
      if (!polyUpperIv || polyUpperIv <= 0 || !polyLowerIv || polyLowerIv <= 0) continue;

      // ── Pre-build poly P&L-per-share grid at OPTIONS EXPIRY ──────────────────
      // poly_unit(S) = (1 - priceHit_upper - noAskUpper) + (1 - priceHit_lower - noAskLower)
      const hPolyRem = autoH(tauPolyRem);
      const polyUnitGrid = new Float64Array(SCORE_N);
      for (let i = 0; i < SCORE_N; i++) {
        const S = scoreGrid[i];
        const upperYes = tauPolyRem > 1e-6
          ? priceHit(S, K_upper, polyUpperIv, tauPolyRem, true,  hPolyRem)
          : (S >= K_upper ? 1.0 : 0.0);
        const lowerYes = tauPolyRem > 1e-6
          ? priceHit(S, K_lower, polyLowerIv, tauPolyRem, false, hPolyRem)
          : (S <= K_lower ? 1.0 : 0.0);
        polyUnitGrid[i] = (1 - upperYes - noAskUpper) + (1 - lowerYes - noAskLower);
      }

      // ── Iterate straddle + strangle ──────────────────────────────────────────
      for (const kMid of kMidCandidates) {
        const lcInst = calls.find(c => c.strike === kMid);
        const lpInst = puts.find(p => p.strike === kMid);
        if (!lcInst || !lpInst) continue;

        const longCallAsk = getAsk(lcInst.symbol);
        const longPutAsk  = getAsk(lpInst.symbol);
        if (longCallAsk <= 0 || longPutAsk <= 0) continue;

        // Fees for long legs (fixed regardless of shortQtyRatio)
        const fee_lc = bybitTradingFee(spotPrice, longCallAsk, bybitQty);
        const fee_lp = bybitTradingFee(spotPrice, longPutAsk,  bybitQty);

        // Pre-compute long leg options pnl grid (doesn't depend on short or poly)
        const longGrid = new Float64Array(SCORE_N);
        for (let i = 0; i < SCORE_N; i++) {
          const S = scoreGrid[i];
          longGrid[i] =
            bybitQty * (Math.max(0, S - kMid) - longCallAsk) - fee_lc
            + bybitQty * (Math.max(0, kMid - S) - longPutAsk) - fee_lp;
        }

        // Outer call candidates: most OTM first, must be above kMid
        const ocCandidates = outerCallPool.filter(k => k > kMid).slice(0, 7);
        // Outer put candidates: most OTM first, must be below kMid
        const opCandidates = outerPutPool.filter(k => k < kMid).slice(0, 7);

        if (ocCandidates.length === 0 || opCandidates.length === 0) continue;

        for (const ocStrike of ocCandidates) {
          const ocInst = calls.find(c => c.strike === ocStrike);
          if (!ocInst) continue;
          const shortCallBid = getBid(ocInst.symbol);
          if (shortCallBid <= 0) continue;

          for (const opStrike of opCandidates) {
            const opInst = puts.find(p => p.strike === opStrike);
            if (!opInst) continue;
            const shortPutBid = getBid(opInst.symbol);
            if (shortPutBid <= 0) continue;

            for (const sqr of shortQtyRatios) {
              const shortQty = bybitQty * sqr;
              const fee_sc = bybitTradingFee(spotPrice, shortCallBid, shortQty);
              const fee_sp = bybitTradingFee(spotPrice, shortPutBid,  shortQty);

              // Options net debit = net cash paid for options position (positive = debit)
              const optionsNetDebit =
                bybitQty * longCallAsk + fee_lc
                + bybitQty * longPutAsk  + fee_lp
                - shortQty * shortCallBid + fee_sc
                - shortQty * shortPutBid  + fee_sp;
              if (optionsNetDebit <= 0) continue;

              // Reference poly qty sized so that poly cost ≈ options debit
              const polyQtyRef = optionsNetDebit / (noAskUpper + noAskLower);

              // Pre-compute short leg options pnl grid
              const shortGrid = new Float64Array(SCORE_N);
              for (let i = 0; i < SCORE_N; i++) {
                const S = scoreGrid[i];
                shortGrid[i] =
                  shortQty * (shortCallBid - Math.max(0, S - ocStrike)) - fee_sc
                  + shortQty * (shortPutBid  - Math.max(0, opStrike - S)) - fee_sp;
              }

              for (const kf of polyQtyFactors) {
                const polyQty = polyQtyRef * kf;
                if (polyQty < 0.1 || polyQty > 1000) continue;

                // Score at OPTIONS EXPIRY
                let sum1 = 0, n1 = 0;
                let sum7 = 0, n7 = 0;
                let minPnl = Infinity;

                for (let i = 0; i < SCORE_N; i++) {
                  const pnl = longGrid[i] + shortGrid[i] + polyQty * polyUnitGrid[i];
                  const pct = Math.abs(scoreGrid[i] / spotPrice - 1);
                  if (pnl < minPnl) minPnl = pnl;
                  if (pct <= 0.01) { sum1 += pnl; n1++; }
                  if (pct <= 0.07) { sum7 += pnl; n7++; }
                }

                const avgPnl1pct = n1 > 0 ? sum1 / n1 : 0;
                const avgPnl7pct = n7 > 0 ? sum7 / n7 : 0;
                if (avgPnl7pct <= 0) continue;

                const totalEntryCost =
                  bybitQty * longCallAsk + fee_lc
                  + bybitQty * longPutAsk  + fee_lp
                  - shortQty * shortCallBid + fee_sc
                  - shortQty * shortPutBid  + fee_sp
                  + polyQty * noAskUpper
                  + polyQty * noAskLower;

                const match: ExtendedMatch = {
                  longStrike:          kMid,
                  shortCallStrike:     ocStrike,
                  shortPutStrike:      opStrike,
                  longCallInstrument:  lcInst,
                  longPutInstrument:   lpInst,
                  shortCallInstrument: ocInst,
                  shortPutInstrument:  opInst,
                  polyUpperMarket:     polyUpper,
                  polyLowerMarket:     polyLower,
                  longQty:             bybitQty,
                  shortCallQty:        shortQty,
                  shortPutQty:         shortQty,
                  polyUpperQty:        polyQty,
                  polyLowerQty:        polyQty,
                  longCallEntry:       longCallAsk,
                  longPutEntry:        longPutAsk,
                  shortCallEntry:      shortCallBid,
                  shortPutEntry:       shortPutBid,
                  polyUpperNoEntry:    noAskUpper,
                  polyLowerNoEntry:    noAskLower,
                  polyUpperIv,
                  polyLowerIv,
                  tauPolyRem,
                  avgPnl1pct,
                  avgPnl7pct,
                  centralDip: avgPnl1pct,
                  maxLoss:    minPnl,
                  totalEntryCost,
                };

                // Dedup: keep best avgPnl7pct per structure+shortQty (vary polyQty factor)
                const key = `${polyUpper.id}|${polyLower.id}|${kMid}|${ocStrike}|${opStrike}|${sqr}`;
                const existing = best.get(key);
                if (!existing || avgPnl7pct > existing.avgPnl7pct) {
                  best.set(key, match);
                }
              }
            }
          }
        }
      }
    }
  }

  return [...best.values()]
    .sort((a, b) => b.avgPnl7pct - a.avgPnl7pct)
    .slice(0, 30);
}
