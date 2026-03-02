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

export interface DiagnosticsReport {
  // Bybit shared structure check (kMid long legs only)
  bybitBlockedAt: string | null;  // null = shared structure OK
  tauBybitDays: number;
  dualStrikesCount: number;
  kMid: number | null;
  longCallAsk: number;
  longPutAsk: number;
  callPoolAboveKMid: number;  // candidates with bid > 0
  putPoolBelowKMid: number;   // candidates with bid > 0
  // Polymarket pairs
  polyUpperCount: number;
  polyLowerCount: number;
  totalPairsChecked: number;
  pairFailures: { reason: string; count: number; examples: string[] }[];
  passedCount: number;
}

/**
 * 6-leg symmetric BTC strategy optimizer.
 *
 * Bybit structure per poly pair:
 *   - kMid (long straddle): nearest dual strike to spot  [shared across pairs]
 *   - K_outer_call (short call): nearest call above kMid to K_upper (poly upper barrier)
 *   - K_outer_put  (short put):  nearest put  below kMid to K_lower (poly lower barrier)
 *   - All 4 option legs use the same quantity: bybitQty
 *
 * For each valid (upper, lower) Polymarket barrier pair:
 *   Step 1 — Screen pairs by symmetry and TTX.
 *   Step 2 — Find outer call nearest to K_upper, outer put nearest to K_lower.
 *   Step 3 — Analytically solve polyQty so combined NOW P&L at ½-distance
 *             points equals −targetLoss% of total entry cost.
 *   Step 4 — Compute NOW and EXPIRY metrics; emit one result per pair.
 *
 * Returns results sorted by |avgNOW% + targetLoss%| ascending.
 */
export function runExtendedOptimization(
  polyMarkets: ParsedMarket[],
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
  targetLossFrac: number = 0.02,
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

  // ── kMid: nearest dual strike to spot (shared) ───────────────────────────
  const kMid = dualStrikes.reduce((best, k) =>
    Math.abs(k - spotPrice) < Math.abs(best - spotPrice) ? k : best, dualStrikes[0]);

  const lcInst = calls.find(c => c.strike === kMid);
  const lpInst = puts.find(p => p.strike === kMid);
  if (!lcInst || !lpInst) return [];

  const longCallAsk = getAsk(lcInst.symbol);
  const longPutAsk  = getAsk(lpInst.symbol);
  if (longCallAsk <= 0 || longPutAsk <= 0) return [];

  const iv_lc = bybitChain.tickers.get(lcInst.symbol)?.markIv ?? 0.8;
  const iv_lp = bybitChain.tickers.get(lpInst.symbol)?.markIv ?? 0.8;

  const fee_lc = bybitTradingFee(spotPrice, longCallAsk, bybitQty);
  const fee_lp = bybitTradingFee(spotPrice, longPutAsk,  bybitQty);

  // ── Candidate pools for per-pair outer strike lookup ─────────────────────
  const callsAboveKMid = calls.filter(c => c.strike > kMid && getBid(c.symbol) > 0)
    .sort((a, b) => a.strike - b.strike);
  const putsBelowKMid  = puts.filter(p => p.strike < kMid && getBid(p.symbol) > 0)
    .sort((a, b) => a.strike - b.strike);
  if (callsAboveKMid.length === 0 || putsBelowKMid.length === 0) return [];

  // ── Polymarket pairs ──────────────────────────────────────────────────────
  const upperPoly = polyMarkets.filter(m => m.strikePrice > spotPrice);
  const lowerPoly = polyMarkets.filter(m => m.strikePrice < spotPrice);
  if (upperPoly.length === 0 || lowerPoly.length === 0) return [];

  // Max-loss scoring grid: ±25% of spot
  const SCORE_N   = 200;
  const scoreLo   = spotPrice * 0.75;
  const scoreHi   = spotPrice * 1.25;
  const scoreStep = (scoreHi - scoreLo) / (SCORE_N - 1);
  const scoreGrid = Float64Array.from({ length: SCORE_N }, (_, i) => scoreLo + scoreStep * i);

  const results: ExtendedMatch[] = [];

  for (const polyUpper of upperPoly) {
    for (const polyLower of lowerPoly) {
      const K_upper = polyUpper.strikePrice;
      const K_lower = polyLower.strikePrice;

      // ── Symmetry filter ─────────────────────────────────────────────────
      const D_upper = K_upper - spotPrice;
      const D_lower = spotPrice - K_lower;
      if (D_upper < spotPrice * MIN_BARRIER_DIST_PCT) continue;
      if (D_lower < spotPrice * MIN_BARRIER_DIST_PCT) continue;
      const symRatio = Math.max(D_upper, D_lower) / Math.min(D_upper, D_lower);
      if (symRatio > SYMMETRY_RATIO_MAX) continue;

      // ── Poly time ────────────────────────────────────────────────────────
      const tauPolyUpper = Math.max((polyUpper.endDate - nowSec) / YEAR_SEC, 0);
      const tauPolyLower = Math.max((polyLower.endDate - nowSec) / YEAR_SEC, 0);
      if (tauPolyUpper <= 0 || tauPolyLower <= 0) continue;
      const tauPolyNow = Math.min(tauPolyUpper, tauPolyLower);
      if (tauPolyNow < tauBybit * 0.9) continue;
      const tauPolyRem = Math.max(tauPolyNow - tauBybit, 0);
      const hPolyNow = autoH(tauPolyNow);
      const hPolyRem = autoH(tauPolyRem);

      // ── NO entry prices ──────────────────────────────────────────────────
      const yesBidUpper = (polyUpper.bestBid != null && Number(polyUpper.bestBid) > 0)
        ? Number(polyUpper.bestBid) : polyUpper.currentPrice;
      const noAskUpper = 1 - yesBidUpper;
      if (noAskUpper < 0.01 || noAskUpper > 0.9999) continue;

      const yesBidLower = (polyLower.bestBid != null && Number(polyLower.bestBid) > 0)
        ? Number(polyLower.bestBid) : polyLower.currentPrice;
      const noAskLower = 1 - yesBidLower;
      if (noAskLower < 0.01 || noAskLower > 0.9999) continue;

      // ── Calibrate poly IVs ───────────────────────────────────────────────
      const polyUpperIv = solveImpliedVol(
        spotPrice, K_upper, tauPolyUpper, polyUpper.currentPrice, 'hit', true, hPolyNow);
      const polyLowerIv = solveImpliedVol(
        spotPrice, K_lower, tauPolyLower, polyLower.currentPrice, 'hit', false, hPolyNow);
      if (!polyUpperIv || polyUpperIv <= 0 || !polyLowerIv || polyLowerIv <= 0) continue;

      // ── Outer option legs: nearest call to K_upper, nearest put to K_lower ──
      const ocInst = callsAboveKMid.reduce((best, c) =>
        Math.abs(c.strike - K_upper) < Math.abs(best.strike - K_upper) ? c : best,
        callsAboveKMid[0]);
      const opInst = putsBelowKMid.reduce((best, p) =>
        Math.abs(p.strike - K_lower) < Math.abs(best.strike - K_lower) ? p : best,
        putsBelowKMid[0]);

      const shortCallBid = getBid(ocInst.symbol);
      const shortPutBid  = getBid(opInst.symbol);
      if (shortCallBid <= 0 || shortPutBid <= 0) continue;

      const ocStrike = ocInst.strike;
      const opStrike = opInst.strike;
      const iv_sc = bybitChain.tickers.get(ocInst.symbol)?.markIv ?? 0.8;
      const iv_sp = bybitChain.tickers.get(opInst.symbol)?.markIv ?? 0.8;

      const fee_sc = bybitTradingFee(spotPrice, shortCallBid, bybitQty);
      const fee_sp = bybitTradingFee(spotPrice, shortPutBid,  bybitQty);

      const optionsNetDebit =
        bybitQty * longCallAsk  + fee_lc
        + bybitQty * longPutAsk   + fee_lp
        - bybitQty * shortCallBid + fee_sc
        - bybitQty * shortPutBid  + fee_sp;
      if (optionsNetDebit <= 0) continue;

      // ── Options P&L helpers ───────────────────────────────────────────────
      const optsNow = (S: number) =>
        bybitQty * (bsCallPrice(S, kMid,    iv_lc, tauBybit) - longCallAsk) - fee_lc
        + bybitQty * (bsPutPrice(S, kMid,   iv_lp, tauBybit) - longPutAsk)  - fee_lp
        + bybitQty * (shortCallBid - bsCallPrice(S, ocStrike, iv_sc, tauBybit)) - fee_sc
        + bybitQty * (shortPutBid  - bsPutPrice(S,  opStrike, iv_sp, tauBybit)) - fee_sp;

      const optsExpiry = (S: number) =>
        bybitQty * (Math.max(0, S - kMid)           - longCallAsk)  - fee_lc
        + bybitQty * (Math.max(0, kMid - S)         - longPutAsk)   - fee_lp
        + bybitQty * (shortCallBid - Math.max(0, S - ocStrike))     - fee_sc
        + bybitQty * (shortPutBid  - Math.max(0, opStrike - S))     - fee_sp;

      // ── Poly unit P&L ─────────────────────────────────────────────────────
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

      // ── Solve polyQty: NOW P&L at ½-distance points = −T × total cost ────
      // halfUpper/halfLower are midpoints between spot and each barrier
      const halfUpper = spotPrice + (K_upper - spotPrice) / 2;
      const halfLower = spotPrice - (spotPrice - K_lower) / 2;

      const avgOptsNowAtHalf  = (optsNow(halfUpper)       + optsNow(halfLower))       / 2;
      const avgPolyNowAtHalf  = (polyUnitNow(halfUpper)   + polyUnitNow(halfLower))   / 2;

      const T = targetLossFrac;
      const noAskSum = noAskUpper + noAskLower;
      const denom = avgPolyNowAtHalf + T * noAskSum;
      // denom can be negative when options are profitable at ½-distance — both
      // numerator and denominator are negative, giving a valid positive polyQty.
      // Only skip when denom is exactly zero (division by zero).
      if (denom === 0) continue;

      const polyQty = (-avgOptsNowAtHalf - T * optionsNetDebit) / denom;
      if (!isFinite(polyQty) || polyQty < 0.1 || polyQty > 2000) continue;

      // ── Total entry cost ─────────────────────────────────────────────────
      const totalEntryCost = optionsNetDebit + polyQty * noAskSum;
      if (totalEntryCost <= 0) continue;

      // ── Output metrics ───────────────────────────────────────────────────
      const polyNowAtUpper    = polyUnitNow(K_upper);
      const polyNowAtLower    = polyUnitNow(K_lower);
      const polyExpiryAtUpper = polyUnitExpiry(K_upper);
      const polyExpiryAtLower = polyUnitExpiry(K_lower);

      const optsNowAtUpper    = optsNow(K_upper);
      const optsNowAtLower    = optsNow(K_lower);
      const optsExpiryAtUpper = optsExpiry(K_upper);
      const optsExpiryAtLower = optsExpiry(K_lower);

      const avgPnl1pct = ((optsNowAtUpper    + polyQty * polyNowAtUpper)
                        + (optsNowAtLower    + polyQty * polyNowAtLower))   / 2;
      const avgPnl7pct = ((optsExpiryAtUpper + polyQty * polyExpiryAtUpper)
                        + (optsExpiryAtLower + polyQty * polyExpiryAtLower)) / 2;
      const centralDip = optsNow(spotPrice) + polyQty * polyUnitNow(spotPrice);

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
        shortCallQty:        bybitQty,
        shortPutQty:         bybitQty,
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
        maxLoss:        maxLossExpiry,
        totalEntryCost,
      });
    }
  }

  return results.sort((a, b) => {
    const errA = Math.abs(a.avgPnl1pct / a.totalEntryCost + targetLossFrac);
    const errB = Math.abs(b.avgPnl1pct / b.totalEntryCost + targetLossFrac);
    return errA - errB;
  });
}

/** Diagnostic version — mirrors the optimizer and reports the failure at each step. */
export function diagnoseExtendedOptimization(
  polyMarkets: ParsedMarket[],
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
  targetLossFrac: number = 0.02,
): DiagnosticsReport {
  const rep: DiagnosticsReport = {
    bybitBlockedAt: null,
    tauBybitDays: 0, dualStrikesCount: 0,
    kMid: null, longCallAsk: 0, longPutAsk: 0,
    callPoolAboveKMid: 0, putPoolBelowKMid: 0,
    polyUpperCount: 0, polyLowerCount: 0,
    totalPairsChecked: 0, pairFailures: [], passedCount: 0,
  };

  const calls = bybitChain.instruments.filter(i => i.optionsType === 'Call');
  const puts  = bybitChain.instruments.filter(i => i.optionsType === 'Put');
  const callStrikeSet = new Set(calls.map(c => c.strike));
  const putStrikeSet  = new Set(puts.map(p => p.strike));
  const dualStrikes   = [...callStrikeSet].filter(k => putStrikeSet.has(k)).sort((a, b) => a - b);

  const tauBybit = Math.max(((bybitChain.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0);
  rep.tauBybitDays     = tauBybit * 365.25;
  rep.dualStrikesCount = dualStrikes.length;

  if (dualStrikes.length === 0) { rep.bybitBlockedAt = 'No dual strikes (C+P at same strike)'; return rep; }
  if (tauBybit <= 0)            { rep.bybitBlockedAt = 'Bybit expiry already passed'; return rep; }

  const getTicker = (sym: string) => bybitChain.tickers.get(sym);
  const getAsk    = (sym: string) => getTicker(sym)?.ask1Price ?? 0;
  const getBid    = (sym: string) => getTicker(sym)?.bid1Price ?? 0;

  const kMid = dualStrikes.reduce((best, k) =>
    Math.abs(k - spotPrice) < Math.abs(best - spotPrice) ? k : best, dualStrikes[0]);
  rep.kMid = kMid;

  const lcInst = calls.find(c => c.strike === kMid);
  const lpInst = puts.find(p => p.strike === kMid);
  if (!lcInst || !lpInst) { rep.bybitBlockedAt = `No C+P instruments found at kMid=${kMid}`; return rep; }

  rep.longCallAsk = getAsk(lcInst.symbol);
  rep.longPutAsk  = getAsk(lpInst.symbol);
  if (rep.longCallAsk <= 0) { rep.bybitBlockedAt = `Long call at kMid=$${kMid.toLocaleString()} has no ask`; return rep; }
  if (rep.longPutAsk  <= 0) { rep.bybitBlockedAt = `Long put at kMid=$${kMid.toLocaleString()} has no ask`; return rep; }

  const callsAboveKMid = calls.filter(c => c.strike > kMid && getBid(c.symbol) > 0)
    .sort((a, b) => a.strike - b.strike);
  const putsBelowKMid  = puts.filter(p => p.strike < kMid && getBid(p.symbol) > 0)
    .sort((a, b) => a.strike - b.strike);
  rep.callPoolAboveKMid = callsAboveKMid.length;
  rep.putPoolBelowKMid  = putsBelowKMid.length;

  if (callsAboveKMid.length === 0) { rep.bybitBlockedAt = 'No calls above kMid with a non-zero bid'; return rep; }
  if (putsBelowKMid.length  === 0) { rep.bybitBlockedAt = 'No puts below kMid with a non-zero bid';  return rep; }

  const iv_lc = bybitChain.tickers.get(lcInst.symbol)?.markIv ?? 0.8;
  const iv_lp = bybitChain.tickers.get(lpInst.symbol)?.markIv ?? 0.8;
  const fee_lc = bybitTradingFee(spotPrice, rep.longCallAsk, bybitQty);
  const fee_lp = bybitTradingFee(spotPrice, rep.longPutAsk,  bybitQty);

  const upperPoly = polyMarkets.filter(m => m.strikePrice > spotPrice);
  const lowerPoly = polyMarkets.filter(m => m.strikePrice < spotPrice);
  rep.polyUpperCount = upperPoly.length;
  rep.polyLowerCount = lowerPoly.length;

  if (upperPoly.length === 0 || lowerPoly.length === 0) {
    rep.bybitBlockedAt = `Not enough poly strikes: ${upperPoly.length} above, ${lowerPoly.length} below spot`;
    return rep;
  }

  const failCounts: Record<string, { count: number; examples: string[] }> = {};
  const addFail = (reason: string, label: string) => {
    if (!failCounts[reason]) failCounts[reason] = { count: 0, examples: [] };
    failCounts[reason].count++;
    if (failCounts[reason].examples.length < 3) failCounts[reason].examples.push(label);
  };

  let totalChecked = 0;
  let passed = 0;

  for (const polyUpper of upperPoly) {
    for (const polyLower of lowerPoly) {
      totalChecked++;
      const K_upper = polyUpper.strikePrice;
      const K_lower = polyLower.strikePrice;
      const pairLabel = `↑${K_upper.toLocaleString()} / ↓${K_lower.toLocaleString()}`;

      const D_upper = K_upper - spotPrice;
      const D_lower = spotPrice - K_lower;
      if (D_upper < spotPrice * MIN_BARRIER_DIST_PCT) { addFail('Upper strike < 2% from spot', pairLabel); continue; }
      if (D_lower < spotPrice * MIN_BARRIER_DIST_PCT) { addFail('Lower strike < 2% from spot', pairLabel); continue; }
      const symRatio = Math.max(D_upper, D_lower) / Math.min(D_upper, D_lower);
      if (symRatio > SYMMETRY_RATIO_MAX) { addFail(`Asymmetric pair (ratio ${symRatio.toFixed(2)} > ${SYMMETRY_RATIO_MAX})`, pairLabel); continue; }

      const tauPolyUpper = Math.max((polyUpper.endDate - nowSec) / YEAR_SEC, 0);
      const tauPolyLower = Math.max((polyLower.endDate - nowSec) / YEAR_SEC, 0);
      if (tauPolyUpper <= 0 || tauPolyLower <= 0) { addFail('Poly market already expired', pairLabel); continue; }

      const tauPolyNow = Math.min(tauPolyUpper, tauPolyLower);
      if (tauPolyNow < tauBybit * 0.9) {
        addFail(`Poly TTX (${(tauPolyNow * 365.25).toFixed(1)}d) < Bybit TTX (${(tauBybit * 365.25).toFixed(1)}d) × 0.9`, pairLabel);
        continue;
      }

      const yesBidUpper = (polyUpper.bestBid != null && Number(polyUpper.bestBid) > 0)
        ? Number(polyUpper.bestBid) : polyUpper.currentPrice;
      const noAskUpper = 1 - yesBidUpper;
      if (noAskUpper < 0.01 || noAskUpper > 0.9999) { addFail(`Upper NO price out of range (${noAskUpper.toFixed(4)})`, pairLabel); continue; }

      const yesBidLower = (polyLower.bestBid != null && Number(polyLower.bestBid) > 0)
        ? Number(polyLower.bestBid) : polyLower.currentPrice;
      const noAskLower = 1 - yesBidLower;
      if (noAskLower < 0.01 || noAskLower > 0.9999) { addFail(`Lower NO price out of range (${noAskLower.toFixed(4)})`, pairLabel); continue; }

      const hPolyNow = autoH(tauPolyNow);
      const polyUpperIv = solveImpliedVol(spotPrice, K_upper, tauPolyUpper, polyUpper.currentPrice, 'hit', true, hPolyNow);
      const polyLowerIv = solveImpliedVol(spotPrice, K_lower, tauPolyLower, polyLower.currentPrice, 'hit', false, hPolyNow);
      if (!polyUpperIv || polyUpperIv <= 0 || !polyLowerIv || polyLowerIv <= 0) { addFail('IV calibration failed', pairLabel); continue; }

      // Outer legs: nearest call to K_upper, nearest put to K_lower
      const ocInst = callsAboveKMid.reduce((best, c) =>
        Math.abs(c.strike - K_upper) < Math.abs(best.strike - K_upper) ? c : best, callsAboveKMid[0]);
      const opInst = putsBelowKMid.reduce((best, p) =>
        Math.abs(p.strike - K_lower) < Math.abs(best.strike - K_lower) ? p : best, putsBelowKMid[0]);

      const shortCallBid = getBid(ocInst.symbol);
      const shortPutBid  = getBid(opInst.symbol);
      if (shortCallBid <= 0) { addFail(`Short call at $${ocInst.strike.toLocaleString()} (nearest to $${K_upper.toLocaleString()}) has no bid`, pairLabel); continue; }
      if (shortPutBid  <= 0) { addFail(`Short put at $${opInst.strike.toLocaleString()} (nearest to $${K_lower.toLocaleString()}) has no bid`,  pairLabel); continue; }

      const fee_sc = bybitTradingFee(spotPrice, shortCallBid, bybitQty);
      const fee_sp = bybitTradingFee(spotPrice, shortPutBid,  bybitQty);
      const netDebit =
        bybitQty * rep.longCallAsk + fee_lc
        + bybitQty * rep.longPutAsk  + fee_lp
        - bybitQty * shortCallBid + fee_sc
        - bybitQty * shortPutBid  + fee_sp;
      if (netDebit <= 0) {
        addFail(`Options net debit ≤ 0 ($${netDebit.toFixed(4)}): short ${ocInst.strike.toLocaleString()}C/${opInst.strike.toLocaleString()}P credit ≥ straddle cost`, pairLabel);
        continue;
      }

      const iv_sc = bybitChain.tickers.get(ocInst.symbol)?.markIv ?? 0.8;
      const iv_sp = bybitChain.tickers.get(opInst.symbol)?.markIv ?? 0.8;
      const ocStrike = ocInst.strike;
      const opStrike = opInst.strike;

      const optsNow = (S: number) =>
        bybitQty * (bsCallPrice(S, kMid, iv_lc, tauBybit) - rep.longCallAsk) - fee_lc
        + bybitQty * (bsPutPrice(S, kMid, iv_lp, tauBybit) - rep.longPutAsk)  - fee_lp
        + bybitQty * (shortCallBid - bsCallPrice(S, ocStrike, iv_sc, tauBybit)) - fee_sc
        + bybitQty * (shortPutBid  - bsPutPrice(S,  opStrike, iv_sp, tauBybit)) - fee_sp;

      const polyUnitNow = (S: number) =>
        (1 - priceHit(S, K_upper, polyUpperIv, tauPolyNow, true,  hPolyNow) - noAskUpper)
        + (1 - priceHit(S, K_lower, polyLowerIv, tauPolyNow, false, hPolyNow) - noAskLower);

      const halfUpper = spotPrice + (K_upper - spotPrice) / 2;
      const halfLower = spotPrice - (spotPrice - K_lower) / 2;

      const avgPolyNow = (polyUnitNow(halfUpper) + polyUnitNow(halfLower)) / 2;
      const avgOptsNow = (optsNow(halfUpper)     + optsNow(halfLower))     / 2;

      const noAskSum = noAskUpper + noAskLower;
      const T = targetLossFrac;
      const denom = avgPolyNow + T * noAskSum;
      if (denom === 0) { addFail('Solve denom exactly zero (degenerate)', pairLabel); continue; }

      const polyQty = (-avgOptsNow - T * netDebit) / denom;
      if (!isFinite(polyQty) || polyQty < 0.1 || polyQty > 2000) {
        addFail(`polyQty out of range (${isFinite(polyQty) ? polyQty.toFixed(2) : 'Inf'})`, pairLabel);
        continue;
      }

      const totalCost = netDebit + polyQty * noAskSum;
      if (totalCost <= 0) { addFail(`totalEntryCost ≤ 0 (${totalCost.toFixed(4)})`, pairLabel); continue; }

      passed++;
    }
  }

  rep.totalPairsChecked = totalChecked;
  rep.passedCount = passed;
  rep.pairFailures = Object.entries(failCounts)
    .map(([reason, { count, examples }]) => ({ reason, count, examples }))
    .sort((a, b) => b.count - a.count);

  return rep;
}
