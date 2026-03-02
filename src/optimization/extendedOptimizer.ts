import type { ParsedMarket, BybitOptionChain, ExtendedMatch } from '../types';

export interface DiagnosticsReport {
  // Bybit structure (computed once, shared across all poly pairs)
  bybitBlockedAt: string | null;  // null = structure OK
  tauBybitDays: number;
  dualStrikesCount: number;
  kMid: number | null;
  longCallAsk: number;
  longPutAsk: number;
  outerPutPoolSize: number;
  outerCallPoolSize: number;
  outerPutStrike: number | null;
  outerCallTarget: number | null;
  outerCallStrike: number | null;
  shortPutBid: number;
  shortCallBid: number;
  optionsNetDebit: number | null;
  // Polymarket pairs
  polyUpperCount: number;
  polyLowerCount: number;
  totalPairsChecked: number;
  pairFailures: { reason: string; count: number; examples: string[] }[];
  passedCount: number;
}
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
 * Bybit structure is chosen deterministically (no combinatorial search):
 *   - kMid (long straddle): nearest dual strike to spot
 *   - K_outer_put (short put): most OTM put with a non-zero bid
 *   - K_outer_call (short call): nearest available call to the symmetric target
 *     (2 × spot − K_outer_put), giving maximum symmetric distance
 *   - All 4 option legs use the same quantity: bybitQty
 *
 * For each valid (upper, lower) Polymarket barrier pair:
 *   Step 1 — Screen pairs by symmetry.
 *   Step 2 — Analytically solve polyQty so that the combined NOW P&L at the
 *             two barrier strikes equals −targetLoss% of total entry cost.
 *   Step 3 — Compute NOW and EXPIRY metrics; emit one result per pair.
 *
 * Returns results sorted by |avgNOW% + targetLoss%| ascending
 * (closest to the requested target first).
 */
export function runExtendedOptimization(
  polyMarkets: ParsedMarket[],
  spotPrice: number,
  nowSec: number,
  bybitChain: BybitOptionChain,
  bybitQty: number = 0.01,
  targetLossFrac: number = 0.02,   // 0.02 = 2% loss at ½-distance points
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

  // ── kMid: single nearest dual strike to spot ─────────────────────────────
  const kMid = dualStrikes.reduce((best, k) =>
    Math.abs(k - spotPrice) < Math.abs(best - spotPrice) ? k : best, dualStrikes[0]);

  const lcInst = calls.find(c => c.strike === kMid);
  const lpInst = puts.find(p => p.strike === kMid);
  if (!lcInst || !lpInst) return [];

  const longCallAsk = getAsk(lcInst.symbol);
  const longPutAsk  = getAsk(lpInst.symbol);
  if (longCallAsk <= 0 || longPutAsk <= 0) return [];

  // ── Outer put: most OTM put below kMid with non-zero bid ─────────────────
  const outerPutPool = puts
    .filter(p => p.strike < kMid && getBid(p.symbol) > 0)
    .sort((a, b) => a.strike - b.strike);  // ascending = most OTM first

  // ── Outer call pool: all calls above kMid with non-zero bid ──────────────
  const outerCallsAbove = calls
    .filter(c => c.strike > kMid && getBid(c.symbol) > 0)
    .sort((a, b) => a.strike - b.strike);

  if (outerPutPool.length === 0 || outerCallsAbove.length === 0) return [];

  // Find best outer combo: try most OTM puts first, pick nearest symmetric call.
  // K_outer_call_target = 2 × spot − K_outer_put  (symmetric distance from spot)
  let opInst: (typeof puts)[0] | null = null;
  let ocInst: (typeof calls)[0] | null = null;
  let shortPutBid = 0;
  let shortCallBid = 0;

  for (const candidate of outerPutPool) {
    const opBid = getBid(candidate.symbol);
    if (opBid <= 0) continue;
    const ocTarget = 2 * spotPrice - candidate.strike;
    const oc = outerCallsAbove.reduce((best, c) =>
      Math.abs(c.strike - ocTarget) < Math.abs(best.strike - ocTarget) ? c : best,
      outerCallsAbove[0]);
    const ocBid = getBid(oc.symbol);
    if (ocBid <= 0) continue;
    opInst = candidate;
    ocInst = oc;
    shortPutBid  = opBid;
    shortCallBid = ocBid;
    break;  // use the most OTM valid combination
  }

  if (!opInst || !ocInst) return [];

  const ocStrike = ocInst.strike;
  const opStrike = opInst.strike;

  const iv_lc = bybitChain.tickers.get(lcInst.symbol)?.markIv ?? 0.8;
  const iv_lp = bybitChain.tickers.get(lpInst.symbol)?.markIv ?? 0.8;
  const iv_sc = bybitChain.tickers.get(ocInst.symbol)?.markIv ?? 0.8;
  const iv_sp = bybitChain.tickers.get(opInst.symbol)?.markIv ?? 0.8;

  // All 4 legs use the same bybitQty
  const fee_lc = bybitTradingFee(spotPrice, longCallAsk,  bybitQty);
  const fee_lp = bybitTradingFee(spotPrice, longPutAsk,   bybitQty);
  const fee_sc = bybitTradingFee(spotPrice, shortCallBid, bybitQty);
  const fee_sp = bybitTradingFee(spotPrice, shortPutBid,  bybitQty);

  const optionsNetDebit =
    bybitQty * longCallAsk  + fee_lc
    + bybitQty * longPutAsk   + fee_lp
    - bybitQty * shortCallBid + fee_sc
    - bybitQty * shortPutBid  + fee_sp;
  if (optionsNetDebit <= 0) return [];

  // ── Options P&L helpers (all 4 legs, same qty) ───────────────────────────
  const optsNow = (S: number) =>
    bybitQty * (bsCallPrice(S, kMid,     iv_lc, tauBybit) - longCallAsk) - fee_lc
    + bybitQty * (bsPutPrice(S, kMid,    iv_lp, tauBybit) - longPutAsk)  - fee_lp
    + bybitQty * (shortCallBid - bsCallPrice(S, ocStrike, iv_sc, tauBybit)) - fee_sc
    + bybitQty * (shortPutBid  - bsPutPrice(S,  opStrike, iv_sp, tauBybit)) - fee_sp;

  const optsExpiry = (S: number) =>
    bybitQty * (Math.max(0, S - kMid)        - longCallAsk)  - fee_lc
    + bybitQty * (Math.max(0, kMid - S)      - longPutAsk)   - fee_lp
    + bybitQty * (shortCallBid - Math.max(0, S - ocStrike))  - fee_sc
    + bybitQty * (shortPutBid  - Math.max(0, opStrike - S))  - fee_sp;

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
      if (tauPolyNow < tauBybit * 0.9) continue;  // poly must outlive options

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
        spotPrice, K_upper, tauPolyUpper, polyUpper.currentPrice, 'hit', true, hPolyNow,
      );
      const polyLowerIv = solveImpliedVol(
        spotPrice, K_lower, tauPolyLower, polyLower.currentPrice, 'hit', false, hPolyNow,
      );
      if (!polyUpperIv || polyUpperIv <= 0 || !polyLowerIv || polyLowerIv <= 0) continue;

      // ── Poly unit P&L at the two barrier strikes ─────────────────────────
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

      // Half-distance evaluation points for the solve
      const halfUpper = spotPrice + (K_upper - spotPrice) / 2;
      const halfLower = spotPrice - (spotPrice - K_lower) / 2;

      const polyNowAtHalfUpper = polyUnitNow(halfUpper);
      const polyNowAtHalfLower = polyUnitNow(halfLower);
      const avgPolyNowAtHalf   = (polyNowAtHalfUpper + polyNowAtHalfLower) / 2;

      // Full-barrier points for output metrics only
      const polyNowAtUpper  = polyUnitNow(K_upper);
      const polyNowAtLower  = polyUnitNow(K_lower);

      const polyExpiryAtUpper = polyUnitExpiry(K_upper);
      const polyExpiryAtLower = polyUnitExpiry(K_lower);

      // ── Options P&L ───────────────────────────────────────────────────────
      const optsNowAtHalfUpper = optsNow(halfUpper);
      const optsNowAtHalfLower = optsNow(halfLower);
      const avgOptsNowAtHalf   = (optsNowAtHalfUpper + optsNowAtHalfLower) / 2;

      const optsNowAtUpper    = optsNow(K_upper);
      const optsNowAtLower    = optsNow(K_lower);
      const optsExpiryAtUpper = optsExpiry(K_upper);
      const optsExpiryAtLower = optsExpiry(K_lower);

      const avgOptsExpiryAtStrikes = (optsExpiryAtUpper + optsExpiryAtLower) / 2;

      // ── Analytically solve polyQty: NOW P&L at ½-distance points = −T × cost ──
      // avgOpts_half + polyQty × avgPolyUnit_half = −T × (optionsNetDebit + polyQty × noAskSum)
      // → polyQty = (−avgOpts_half − T × optionsNetDebit) / (avgPolyUnit_half + T × noAskSum)
      const T = targetLossFrac;
      const noAskSum = noAskUpper + noAskLower;

      const denom = avgPolyNowAtHalf + T * noAskSum;
      if (denom <= 0) continue;

      const polyQty = (-avgOptsNowAtHalf - T * optionsNetDebit) / denom;
      if (!isFinite(polyQty) || polyQty < 0.1 || polyQty > 2000) continue;

      // ── Total entry cost and final metrics ───────────────────────────────
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
      void avgOptsExpiryAtStrikes; // computed but only used via pnlExpiry above

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
        shortCallQty:        bybitQty,   // same as longQty
        shortPutQty:         bybitQty,   // same as longQty
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

  // Sort by how close the NOW @ barriers metric is to target (closest first)
  return results.sort((a, b) => {
    const errA = Math.abs(a.avgPnl1pct / a.totalEntryCost + targetLossFrac);
    const errB = Math.abs(b.avgPnl1pct / b.totalEntryCost + targetLossFrac);
    return errA - errB;
  });
}

/** Diagnostic version — mirrors the optimizer logic and reports the first failure at each step. */
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
    tauBybitDays: 0,
    dualStrikesCount: 0,
    kMid: null,
    longCallAsk: 0, longPutAsk: 0,
    outerPutPoolSize: 0, outerCallPoolSize: 0,
    outerPutStrike: null, outerCallTarget: null, outerCallStrike: null,
    shortPutBid: 0, shortCallBid: 0,
    optionsNetDebit: null,
    polyUpperCount: 0, polyLowerCount: 0,
    totalPairsChecked: 0,
    pairFailures: [],
    passedCount: 0,
  };

  const calls = bybitChain.instruments.filter(i => i.optionsType === 'Call');
  const puts  = bybitChain.instruments.filter(i => i.optionsType === 'Put');
  const callStrikeSet = new Set(calls.map(c => c.strike));
  const putStrikeSet  = new Set(puts.map(p => p.strike));
  const dualStrikes   = [...callStrikeSet].filter(k => putStrikeSet.has(k)).sort((a, b) => a - b);

  const tauBybit = Math.max(((bybitChain.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0);
  rep.tauBybitDays = tauBybit * 365.25;
  rep.dualStrikesCount = dualStrikes.length;

  if (dualStrikes.length === 0) { rep.bybitBlockedAt = 'No dual strikes (both C+P at same strike)'; return rep; }
  if (tauBybit <= 0) { rep.bybitBlockedAt = 'Bybit expiry already passed (tauBybit = 0)'; return rep; }

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
  if (rep.longCallAsk <= 0) { rep.bybitBlockedAt = `Long call at kMid=${kMid} has no ask price`; return rep; }
  if (rep.longPutAsk  <= 0) { rep.bybitBlockedAt = `Long put at kMid=${kMid} has no ask price`; return rep; }

  const outerPutPool = puts.filter(p => p.strike < kMid && getBid(p.symbol) > 0).sort((a, b) => a.strike - b.strike);
  const outerCallsAbove = calls.filter(c => c.strike > kMid && getBid(c.symbol) > 0).sort((a, b) => a.strike - b.strike);
  rep.outerPutPoolSize  = outerPutPool.length;
  rep.outerCallPoolSize = outerCallsAbove.length;

  if (outerPutPool.length === 0)    { rep.bybitBlockedAt = 'No puts below kMid with a non-zero bid'; return rep; }
  if (outerCallsAbove.length === 0) { rep.bybitBlockedAt = 'No calls above kMid with a non-zero bid'; return rep; }

  let opInst: (typeof puts)[0] | null = null;
  let ocInst: (typeof calls)[0] | null = null;
  let shortPutBid = 0, shortCallBid = 0;
  for (const candidate of outerPutPool) {
    const opBid = getBid(candidate.symbol);
    if (opBid <= 0) continue;
    const ocTarget = 2 * spotPrice - candidate.strike;
    const oc = outerCallsAbove.reduce((best, c) =>
      Math.abs(c.strike - ocTarget) < Math.abs(best.strike - ocTarget) ? c : best, outerCallsAbove[0]);
    const ocBid = getBid(oc.symbol);
    if (ocBid <= 0) continue;
    opInst = candidate; ocInst = oc;
    shortPutBid = opBid; shortCallBid = ocBid;
    rep.outerPutStrike  = candidate.strike;
    rep.outerCallTarget = ocTarget;
    rep.outerCallStrike = oc.strike;
    rep.shortPutBid  = opBid;
    rep.shortCallBid = ocBid;
    break;
  }
  if (!opInst || !ocInst) { rep.bybitBlockedAt = 'No valid outer put+call combo (symmetric call has no bid)'; return rep; }

  const ocStrike = ocInst.strike;
  const opStrike = opInst.strike;
  const iv_lc = bybitChain.tickers.get(lcInst.symbol)?.markIv ?? 0.8;
  const iv_lp = bybitChain.tickers.get(lpInst.symbol)?.markIv ?? 0.8;
  const iv_sc = bybitChain.tickers.get(ocInst.symbol)?.markIv ?? 0.8;
  const iv_sp = bybitChain.tickers.get(opInst.symbol)?.markIv ?? 0.8;

  const fee_lc = bybitTradingFee(spotPrice, rep.longCallAsk,  bybitQty);
  const fee_lp = bybitTradingFee(spotPrice, rep.longPutAsk,   bybitQty);
  const fee_sc = bybitTradingFee(spotPrice, shortCallBid, bybitQty);
  const fee_sp = bybitTradingFee(spotPrice, shortPutBid,  bybitQty);
  const netDebit =
    bybitQty * rep.longCallAsk + fee_lc
    + bybitQty * rep.longPutAsk  + fee_lp
    - bybitQty * shortCallBid + fee_sc
    - bybitQty * shortPutBid  + fee_sp;
  rep.optionsNetDebit = netDebit;
  if (netDebit <= 0) { rep.bybitBlockedAt = `Options net debit ≤ 0 (${netDebit.toFixed(4)}): short strangle credit exceeds straddle cost`; return rep; }

  const optsNow = (S: number) =>
    bybitQty * (bsCallPrice(S, kMid, iv_lc, tauBybit) - rep.longCallAsk) - fee_lc
    + bybitQty * (bsPutPrice(S, kMid, iv_lp, tauBybit) - rep.longPutAsk)  - fee_lp
    + bybitQty * (shortCallBid - bsCallPrice(S, ocStrike, iv_sc, tauBybit)) - fee_sc
    + bybitQty * (shortPutBid  - bsPutPrice(S,  opStrike, iv_sp, tauBybit)) - fee_sp;

  const upperPoly = polyMarkets.filter(m => m.strikePrice > spotPrice);
  const lowerPoly = polyMarkets.filter(m => m.strikePrice < spotPrice);
  rep.polyUpperCount = upperPoly.length;
  rep.polyLowerCount = lowerPoly.length;

  if (upperPoly.length === 0 || lowerPoly.length === 0) {
    rep.bybitBlockedAt = `Not enough poly strikes: ${upperPoly.length} above spot, ${lowerPoly.length} below spot`;
    return rep;
  }

  // Count failure reasons per pair
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
      const tauPolyDays = tauPolyNow * 365.25;
      const tauBybitDays = tauBybit * 365.25;
      if (tauPolyNow < tauBybit * 0.9) {
        addFail(
          `Poly TTX (${tauPolyDays.toFixed(1)}d) < Bybit TTX (${tauBybitDays.toFixed(1)}d) × 0.9`,
          pairLabel,
        );
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

      // Solve at ½-distance points (same as main optimizer)
      const halfUpper = spotPrice + (K_upper - spotPrice) / 2;
      const halfLower = spotPrice - (spotPrice - K_lower) / 2;
      const polyUnitNow = (S: number) =>
        (1 - priceHit(S, K_upper, polyUpperIv, tauPolyNow, true,  hPolyNow) - noAskUpper)
        + (1 - priceHit(S, K_lower, polyLowerIv, tauPolyNow, false, hPolyNow) - noAskLower);
      const avgPolyNow = (polyUnitNow(halfUpper) + polyUnitNow(halfLower)) / 2;

      const avgOptsNow = (optsNow(halfUpper) + optsNow(halfLower)) / 2;
      const noAskSum = noAskUpper + noAskLower;
      const T = targetLossFrac;
      const denom = avgPolyNow + T * noAskSum;
      if (denom <= 0) { addFail(`Solve denom ≤ 0 (avgPolyNow=${avgPolyNow.toFixed(4)})`, pairLabel); continue; }

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
