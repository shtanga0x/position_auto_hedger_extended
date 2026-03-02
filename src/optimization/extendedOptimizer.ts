import type { ParsedMarket, BybitOptionChain, ExtendedMatch } from '../types';
import {
  priceHit, bybitTradingFee, solveImpliedVol, autoH,
  bsCallPrice, bsPutPrice,
} from '../pricing/engine';

const YEAR_SEC = 365.25 * 24 * 3600;

/** Maximum asymmetry ratio between the two Poly barrier distances. */
const SYMMETRY_RATIO_MAX = 1.4;

/** Minimum barrier distance from spot (as fraction of spot). */
const MIN_BARRIER_DIST_PCT = 0.02;

/**
 * 6-leg symmetric BTC strategy optimizer.
 *
 * For each valid (upper, lower) Polymarket barrier pair the algorithm:
 *
 *   Step 1 — Screen pairs by symmetry.
 *   Step 2 — Find the Bybit structure (kMid, shortQtyRatio, outerCallStrike,
 *             outerPutStrike) that produces the FLATTEST options-only NOW P&L
 *             curve in the price range [K_lower, K_upper].
 *   Step 3 — Analytically solve polyQty so that the combined P&L at the two
 *             barrier strikes equals ‑targetLoss% of total entry cost.
 *             "optimizeFor='now'"  → size for NOW curve at barriers
 *             "optimizeFor='expiry'" → size for EXPIRY curve at barriers
 *   Step 4 — Compute NOW and EXPIRY metrics; emit one result per pair.
 *
 * Returns one ExtendedMatch per poly pair, sorted by |avgPnl1pct / cost + targetLoss| ascending
 * (closest to the requested NOW target) with EXPIRY metric as secondary info.
 */
export function runExtendedOptimization(
  polyMarkets: ParsedMarket[],
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
  targetLossFrac: number = 0.05,   // 0.05 = 5% loss at barriers
  optimizeFor: 'now' | 'expiry' = 'now',
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

  // Separate poly markets
  const upperPoly = polyMarkets.filter(m => m.strikePrice > spotPrice);
  const lowerPoly = polyMarkets.filter(m => m.strikePrice < spotPrice);
  if (upperPoly.length === 0 || lowerPoly.length === 0) return [];

  // kMid candidates: 3 nearest dual strikes to spot
  const kMidCandidates = [...dualStrikes]
    .sort((a, b) => Math.abs(a - spotPrice) - Math.abs(b - spotPrice))
    .slice(0, 3);

  // Outer call candidates: all calls above spot, MOST OTM first (highest strike first)
  const outerCallPool = calls
    .map(c => c.strike)
    .filter(k => k > spotPrice)
    .sort((a, b) => b - a);   // descending = most OTM first

  // Outer put candidates: all puts below spot, MOST OTM first (lowest strike first)
  const outerPutPool = puts
    .map(p => p.strike)
    .filter(k => k < spotPrice)
    .sort((a, b) => a - b);   // ascending = most OTM first

  if (outerCallPool.length === 0 || outerPutPool.length === 0) return [];

  const shortQtyRatios = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

  const results: ExtendedMatch[] = [];

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

      // ── Poly time ────────────────────────────────────────────────────────────
      const tauPolyUpper = Math.max((polyUpper.endDate - nowSec) / YEAR_SEC, 0);
      const tauPolyLower = Math.max((polyLower.endDate - nowSec) / YEAR_SEC, 0);
      if (tauPolyUpper <= 0 || tauPolyLower <= 0) continue;

      const tauPolyNow = Math.min(tauPolyUpper, tauPolyLower);
      if (tauPolyNow < tauBybit * 0.9) continue;  // poly must outlive options

      const tauPolyRem = Math.max(tauPolyNow - tauBybit, 0);

      const hPolyNow = autoH(tauPolyNow);
      const hPolyRem = autoH(tauPolyRem);

      // ── NO entry prices ──────────────────────────────────────────────────────
      const yesBidUpper = (polyUpper.bestBid != null && Number(polyUpper.bestBid) > 0)
        ? Number(polyUpper.bestBid) : polyUpper.currentPrice;
      const noAskUpper = 1 - yesBidUpper;
      if (noAskUpper < 0.01 || noAskUpper > 0.9999) continue;

      const yesBidLower = (polyLower.bestBid != null && Number(polyLower.bestBid) > 0)
        ? Number(polyLower.bestBid) : polyLower.currentPrice;
      const noAskLower = 1 - yesBidLower;
      if (noAskLower < 0.01 || noAskLower > 0.9999) continue;

      // ── Calibrate poly IVs ───────────────────────────────────────────────────
      const polyUpperIv = solveImpliedVol(
        spotPrice, K_upper, tauPolyUpper, polyUpper.currentPrice, 'hit', true, hPolyNow,
      );
      const polyLowerIv = solveImpliedVol(
        spotPrice, K_lower, tauPolyLower, polyLower.currentPrice, 'hit', false, hPolyNow,
      );
      if (!polyUpperIv || polyUpperIv <= 0 || !polyLowerIv || polyLowerIv <= 0) continue;

      // ── Poly unit P&L at the two barrier strikes ─────────────────────────────
      // evaluated at NOW (tauPolyNow) and EXPIRY (tauPolyRem)
      const polyUnitNow = (S: number) =>
        (1 - priceHit(S, K_upper, polyUpperIv, tauPolyNow, true,  hPolyNow) - noAskUpper)
        + (1 - priceHit(S, K_lower, polyLowerIv, tauPolyNow, false, hPolyNow) - noAskLower);

      const polyUnitExpiry = (S: number) => {
        const upYes = tauPolyRem > 1e-6
          ? priceHit(S, K_upper, polyUpperIv, tauPolyRem, true,  hPolyRem)
          : (S >= K_upper ? 1.0 : 0.0);
        const loYes = tauPolyRem > 1e-6
          ? priceHit(S, K_lower, polyLowerIv, tauPolyRem, false, hPolyRem)
          : (S <= K_lower ? 1.0 : 0.0);
        return (1 - upYes - noAskUpper) + (1 - loYes - noAskLower);
      };

      const polyNowAtUpper = polyUnitNow(K_upper);
      const polyNowAtLower = polyUnitNow(K_lower);
      const avgPolyNowAtStrikes = (polyNowAtUpper + polyNowAtLower) / 2;

      const polyExpiryAtUpper = polyUnitExpiry(K_upper);
      const polyExpiryAtLower = polyUnitExpiry(K_lower);
      const avgPolyExpiryAtStrikes = (polyExpiryAtUpper + polyExpiryAtLower) / 2;

      // ── Flatness evaluation grid: N points in [K_lower, K_upper] ─────────────
      const FLAT_N = 80;
      const flatStep = (K_upper - K_lower) / (FLAT_N - 1);
      const flatGrid = Float64Array.from({ length: FLAT_N }, (_, i) => K_lower + flatStep * i);

      // ── Expiry / max-loss scoring grid: ±25% of spot ─────────────────────────
      const SCORE_N   = 200;
      const scoreLo   = spotPrice * 0.75;
      const scoreHi   = spotPrice * 1.25;
      const scoreStep = (scoreHi - scoreLo) / (SCORE_N - 1);
      const scoreGrid = Float64Array.from({ length: SCORE_N }, (_, i) => scoreLo + scoreStep * i);

      // ── Find best Bybit structure: flattest options-only NOW P&L in [K_lower,K_upper] ──
      let bestCurvature = Infinity;
      type Combo = {
        kMid: number;
        ocStrike: number; opStrike: number;
        sqr: number;
        lcInst: (typeof calls)[0]; lpInst: (typeof puts)[0];
        ocInst: (typeof calls)[0]; opInst: (typeof puts)[0];
        longCallAsk: number; longPutAsk: number;
        shortCallBid: number; shortPutBid: number;
        fee_lc: number; fee_lp: number; fee_sc: number; fee_sp: number;
        shortQty: number;
        optionsNetDebit: number;
      };
      let bestCombo: Combo | null = null;

      for (const kMid of kMidCandidates) {
        const lcInst = calls.find(c => c.strike === kMid);
        const lpInst = puts.find(p => p.strike === kMid);
        if (!lcInst || !lpInst) continue;

        const longCallAsk = getAsk(lcInst.symbol);
        const longPutAsk  = getAsk(lpInst.symbol);
        if (longCallAsk <= 0 || longPutAsk <= 0) continue;

        // Outer candidates: most OTM first, must be strictly beyond kMid
        const ocCandidates = outerCallPool.filter(k => k > kMid).slice(0, 7);
        const opCandidates = outerPutPool.filter(k => k < kMid).slice(0, 7);
        if (ocCandidates.length === 0 || opCandidates.length === 0) continue;

        const iv_lc = bybitChain.tickers.get(lcInst.symbol)?.markIv ?? 0.8;
        const iv_lp = bybitChain.tickers.get(lpInst.symbol)?.markIv ?? 0.8;

        for (const sqr of shortQtyRatios) {
          const shortQty = bybitQty * sqr;
          const fee_lc = bybitTradingFee(spotPrice, longCallAsk, bybitQty);
          const fee_lp = bybitTradingFee(spotPrice, longPutAsk,  bybitQty);

          for (const ocStrike of ocCandidates) {
            const ocInst = calls.find(c => c.strike === ocStrike);
            if (!ocInst) continue;
            const shortCallBid = getBid(ocInst.symbol);
            if (shortCallBid <= 0) continue;
            const iv_sc = bybitChain.tickers.get(ocInst.symbol)?.markIv ?? 0.8;

            for (const opStrike of opCandidates) {
              const opInst = puts.find(p => p.strike === opStrike);
              if (!opInst) continue;
              const shortPutBid = getBid(opInst.symbol);
              if (shortPutBid <= 0) continue;

              const fee_sc = bybitTradingFee(spotPrice, shortCallBid, shortQty);
              const fee_sp = bybitTradingFee(spotPrice, shortPutBid,  shortQty);

              const optionsNetDebit =
                bybitQty * longCallAsk + fee_lc
                + bybitQty * longPutAsk  + fee_lp
                - shortQty * shortCallBid + fee_sc
                - shortQty * shortPutBid  + fee_sp;
              if (optionsNetDebit <= 0) continue;

              const iv_sp = bybitChain.tickers.get(opInst.symbol)?.markIv ?? 0.8;

              // Options-only NOW P&L in [K_lower, K_upper]
              let maxPnl = -Infinity, minPnl = Infinity;
              for (let i = 0; i < FLAT_N; i++) {
                const S = flatGrid[i];
                const pnl =
                  bybitQty * (bsCallPrice(S, kMid,    iv_lc, tauBybit) - longCallAsk) - fee_lc
                  + bybitQty * (bsPutPrice(S, kMid,   iv_lp, tauBybit) - longPutAsk)  - fee_lp
                  + shortQty * (shortCallBid - bsCallPrice(S, ocStrike, iv_sc, tauBybit)) - fee_sc
                  + shortQty * (shortPutBid  - bsPutPrice(S,  opStrike, iv_sp, tauBybit)) - fee_sp;
                if (pnl > maxPnl) maxPnl = pnl;
                if (pnl < minPnl) minPnl = pnl;
              }
              const curvature = maxPnl - minPnl;

              if (curvature < bestCurvature) {
                bestCurvature = curvature;
                bestCombo = {
                  kMid, ocStrike, opStrike, sqr,
                  lcInst, lpInst, ocInst, opInst,
                  longCallAsk, longPutAsk, shortCallBid, shortPutBid,
                  fee_lc, fee_lp, fee_sc, fee_sp,
                  shortQty, optionsNetDebit,
                };
              }
            }
          }
        }
      }

      if (!bestCombo) continue;

      const {
        kMid, ocStrike, opStrike,
        lcInst, lpInst, ocInst, opInst,
        longCallAsk, longPutAsk, shortCallBid, shortPutBid,
        fee_lc, fee_lp, fee_sc, fee_sp,
        shortQty, optionsNetDebit,
      } = bestCombo;

      const iv_lc = bybitChain.tickers.get(lcInst.symbol)?.markIv ?? 0.8;
      const iv_lp = bybitChain.tickers.get(lpInst.symbol)?.markIv ?? 0.8;
      const iv_sc = bybitChain.tickers.get(ocInst.symbol)?.markIv ?? 0.8;
      const iv_sp = bybitChain.tickers.get(opInst.symbol)?.markIv ?? 0.8;

      // ── Options P&L helpers ──────────────────────────────────────────────────
      const optsNow = (S: number) =>
        bybitQty * (bsCallPrice(S, kMid, iv_lc, tauBybit) - longCallAsk) - fee_lc
        + bybitQty * (bsPutPrice(S, kMid, iv_lp, tauBybit) - longPutAsk)  - fee_lp
        + shortQty * (shortCallBid - bsCallPrice(S, ocStrike, iv_sc, tauBybit)) - fee_sc
        + shortQty * (shortPutBid  - bsPutPrice(S,  opStrike, iv_sp, tauBybit)) - fee_sp;

      const optsExpiry = (S: number) =>
        bybitQty * (Math.max(0, S - kMid)    - longCallAsk) - fee_lc
        + bybitQty * (Math.max(0, kMid - S)  - longPutAsk)  - fee_lp
        + shortQty * (shortCallBid - Math.max(0, S - ocStrike)) - fee_sc
        + shortQty * (shortPutBid  - Math.max(0, opStrike - S)) - fee_sp;

      // ── Options P&L at the two barrier strikes ───────────────────────────────
      const optsNowAtUpper  = optsNow(K_upper);
      const optsNowAtLower  = optsNow(K_lower);
      const optsExpiryAtUpper = optsExpiry(K_upper);
      const optsExpiryAtLower = optsExpiry(K_lower);

      const avgOptsNowAtStrikes    = (optsNowAtUpper  + optsNowAtLower)  / 2;
      const avgOptsExpiryAtStrikes = (optsExpiryAtUpper + optsExpiryAtLower) / 2;

      // ── Analytically solve polyQty for target loss at barriers ───────────────
      // We want: avgOpts + polyQty × avgPolyUnit = −T × (optionsNetDebit + polyQty × (noAskU + noAskL))
      // → polyQty = (−avgOpts − T × optionsNetDebit) / (avgPolyUnit + T × (noAskU + noAskL))
      const T = targetLossFrac;
      const noAskSum = noAskUpper + noAskLower;

      const avgOpts    = optimizeFor === 'now'    ? avgOptsNowAtStrikes    : avgOptsExpiryAtStrikes;
      const avgPolyUnit = optimizeFor === 'now'   ? avgPolyNowAtStrikes    : avgPolyExpiryAtStrikes;

      const denom = avgPolyUnit + T * noAskSum;
      if (denom <= 0) continue;

      const polyQty = (-avgOpts - T * optionsNetDebit) / denom;
      if (!isFinite(polyQty) || polyQty < 0.1 || polyQty > 2000) continue;

      // ── Total entry cost and final metrics ───────────────────────────────────
      const totalEntryCost = optionsNetDebit + polyQty * noAskSum;
      if (totalEntryCost <= 0) continue;

      // NOW P&L at barriers
      const pnlNowAtUpper = optsNowAtUpper + polyQty * polyNowAtUpper;
      const pnlNowAtLower = optsNowAtLower + polyQty * polyNowAtLower;
      const avgPnl1pct = (pnlNowAtUpper + pnlNowAtLower) / 2;

      // EXPIRY P&L at barriers
      const pnlExpiryAtUpper = optsExpiryAtUpper + polyQty * polyExpiryAtUpper;
      const pnlExpiryAtLower = optsExpiryAtLower + polyQty * polyExpiryAtLower;
      const avgPnl7pct = (pnlExpiryAtUpper + pnlExpiryAtLower) / 2;

      // NOW P&L at spot (central dip)
      const centralDip = optsNow(spotPrice) + polyQty * polyUnitNow(spotPrice);

      // EXPIRY max loss in ±25%
      let maxLossExpiry = 0;
      for (let i = 0; i < SCORE_N; i++) {
        const S = scoreGrid[i];
        const pnl = optsExpiry(S) + polyQty * polyUnitExpiry(S);
        if (pnl < maxLossExpiry) maxLossExpiry = pnl;
      }

      results.push({
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
        centralDip,
        maxLoss:   maxLossExpiry,
        totalEntryCost,
        optionsCurvature: bestCurvature,
      });
    }
  }

  // Sort by how close the NOW @ barriers metric is to target (closest first)
  return results.sort((a, b) => {
    const errA = Math.abs(a.avgPnl1pct / a.totalEntryCost + targetLossFrac);
    const errB = Math.abs(b.avgPnl1pct / b.totalEntryCost + targetLossFrac);
    return errA - errB;
  });
}
