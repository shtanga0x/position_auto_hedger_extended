import { useMemo } from 'react';
import type { OptionType, ProjectionPoint, PolymarketPosition, BybitPosition } from '../types';
import {
  computeCombinedPnlCurve,
  buildPriceGrid,
  bsPrice,
  priceOptionYes,
  interpolateSmile,
  autoH,
  type SmilePoint,
} from '../pricing/engine';

interface PortfolioCurvesInput {
  polyPositions: PolymarketPosition[];
  bybitPositions: BybitPosition[];
  lowerPrice: number;
  upperPrice: number;
  polyTauNow: number;        // Polymarket time to expiry in years
  polyExpiryTs: number;      // Polymarket expiry Unix seconds
  optionType: OptionType;
  smile?: SmilePoint[];
  bybitSmile?: SmilePoint[]; // IV smile from Bybit option chain (sticky-moneyness)
  numPoints?: number; // default 500
}

interface PortfolioCurvesOutput {
  combinedCurves: ProjectionPoint[][];   // Time snapshot curves
  combinedLabels: string[];
  polyNowCurve: ProjectionPoint[];
  polyExpiryCurve: ProjectionPoint[];
  bybitNowCurve: ProjectionPoint[];
  bybitExpiryCurve: ProjectionPoint[];
  polyAtBybitExpiryCurve: ProjectionPoint[];
  polyEntryCost: number;
  bybitEntryCost: number;
  totalEntryCost: number;  // gross: all premiums + fees (unsigned)
  totalFees: number;
  bybitMMNowCurve: ProjectionPoint[]; // portfolio margin requirement curve (NOW)
}

const YEAR_SEC = 365.25 * 24 * 3600;

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0h';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

interface Snapshot {
  label: string;
  timestamp: number; // absolute unix seconds
}

/** Compute meaningful time snapshots based on actual expiry dates */
function computeSnapshots(
  polyPositions: PolymarketPosition[],
  bybitPositions: BybitPosition[],
  nowSec: number,
  polyExpiryTs: number,
): Snapshot[] {
  const hasPoly = polyPositions.length > 0 && polyExpiryTs > nowSec;
  const hasBybit = bybitPositions.length > 0;

  const bybitExpirySec = hasBybit
    ? Math.min(...bybitPositions.map(p => p.expiryTimestamp)) / 1000
    : 0;
  const bybitHasExpiry = hasBybit && bybitExpirySec > nowSec;

  if (hasPoly && bybitHasExpiry) {
    // Both sources: snapshots at actual expiry dates
    const earlierSec = Math.min(bybitExpirySec, polyExpiryTs);
    const laterSec = Math.max(bybitExpirySec, polyExpiryTs);
    const bybitFirst = bybitExpirySec <= polyExpiryTs;

    const earlierLabel = bybitFirst ? 'Options' : 'Event';
    const laterLabel = bybitFirst ? 'Event' : 'Options';

    return [
      { label: `Now (${formatDuration(earlierSec - nowSec)} to ${earlierLabel.toLowerCase()} exp)`, timestamp: nowSec },
      { label: `½ to ${earlierLabel} Exp (${formatDuration((earlierSec - nowSec) / 2)})`, timestamp: nowSec + (earlierSec - nowSec) / 2 },
      { label: `At ${earlierLabel} Expiry`, timestamp: earlierSec },
      { label: `At ${laterLabel} Expiry`, timestamp: laterSec },
    ];
  }

  // Single source: use its expiry with 1/3, 2/3 fractions
  const expirySec = hasPoly ? polyExpiryTs : (bybitHasExpiry ? bybitExpirySec : nowSec + 86400);
  const ttx = expirySec - nowSec;

  return [
    { label: `Now (${formatDuration(ttx)} to exp)`, timestamp: nowSec },
    { label: `1/3 to expiry (${formatDuration(ttx * 2 / 3)})`, timestamp: nowSec + ttx / 3 },
    { label: `2/3 to expiry (${formatDuration(ttx / 3)})`, timestamp: nowSec + ttx * 2 / 3 },
    { label: 'At expiry', timestamp: expirySec },
  ];
}

/** Compute P&L curve for only Polymarket positions at a given tau */
function computePolyOnlyCurve(
  positions: PolymarketPosition[],
  grid: number[],
  tau: number,
  optionType: OptionType,
  H: number,
  smile: SmilePoint[] | undefined,
): ProjectionPoint[] {
  if (positions.length === 0 || grid.length === 0) return [];
  const points: ProjectionPoint[] = [];

  for (const cryptoPrice of grid) {
    let pnl = 0;
    for (const pos of positions) {
      const iv = smile
        ? interpolateSmile(smile, Math.log(cryptoPrice / pos.strikePrice))
        : pos.impliedVol;
      const yesPrice = tau <= 0
        ? (optionType === 'above'
          ? (cryptoPrice >= pos.strikePrice ? 1 : 0)
          : (pos.isUpBarrier
            ? (cryptoPrice >= pos.strikePrice ? 1 : 0)
            : (cryptoPrice <= pos.strikePrice ? 1 : 0)))
        : priceOptionYes(cryptoPrice, pos.strikePrice, iv, tau, optionType, pos.isUpBarrier, H);
      const projectedValue = pos.side === 'YES' ? yesPrice : (1 - yesPrice);
      pnl += (projectedValue - pos.entryPrice) * pos.quantity;
    }
    points.push({ cryptoPrice, pnl });
  }
  return points;
}

/** Compute P&L curve for only Bybit positions at given taus (includes fees).
 *  When bybitSmile is provided, the IV is interpolated per-spot to avoid the
 *  flat-vol kink artifact that appears at the strike with a constant markIv. */
function computeBybitOnlyCurve(
  positions: BybitPosition[],
  grid: number[],
  taus: Map<string, number>,
  bybitSmile?: SmilePoint[],
): ProjectionPoint[] {
  if (positions.length === 0 || grid.length === 0) return [];
  const points: ProjectionPoint[] = [];

  for (const cryptoPrice of grid) {
    let pnl = 0;
    for (const pos of positions) {
      const tau = taus.get(pos.symbol) ?? 0;
      const rawIv = bybitSmile && bybitSmile.length > 0
        ? interpolateSmile(bybitSmile, Math.log(cryptoPrice / pos.strike))
        : pos.markIv;
      const iv = Math.max(rawIv, 0.001); // clamp: never hit the kinked sigma≤0 branch
      const currentValue = bsPrice(cryptoPrice, pos.strike, iv, tau, pos.optionsType);
      const sideMultiplier = pos.side === 'buy' ? 1 : -1;
      pnl += (currentValue - pos.entryPrice) * sideMultiplier * pos.quantity - pos.entryFee;
    }
    points.push({ cryptoPrice, pnl });
  }
  return points;
}

export function usePortfolioCurves(input: PortfolioCurvesInput): PortfolioCurvesOutput {
  const {
    polyPositions,
    bybitPositions,
    lowerPrice,
    upperPrice,
    polyTauNow,
    polyExpiryTs,
    optionType,
    smile,
    bybitSmile,
    numPoints = 2000,
  } = input;

  return useMemo(() => {
    const empty: PortfolioCurvesOutput = {
      combinedCurves: [],
      combinedLabels: [],
      polyNowCurve: [],
      polyExpiryCurve: [],
      bybitNowCurve: [],
      bybitExpiryCurve: [],
      polyAtBybitExpiryCurve: [],
      polyEntryCost: 0,
      bybitEntryCost: 0,
      totalEntryCost: 0,
      totalFees: 0,
      bybitMMNowCurve: [],
    };

    if (lowerPrice <= 0 || upperPrice <= lowerPrice) return empty;
    if (polyPositions.length === 0 && bybitPositions.length === 0) return empty;

    const nowSec = Math.floor(Date.now() / 1000);

    // Compute time snapshots based on actual expiry dates
    const snapshots = computeSnapshots(polyPositions, bybitPositions, nowSec, polyExpiryTs);

    // Build shared uniform grid (500 points for smooth linear interpolation)
    const grid = buildPriceGrid(lowerPrice, upperPrice, numPoints);

    // Compute combined curve at each snapshot — each gets H auto-assigned by its τ
    const combinedCurves: ProjectionPoint[][] = snapshots.map(snap => {
      const polyTau = polyExpiryTs > 0
        ? Math.max((polyExpiryTs - snap.timestamp) / YEAR_SEC, 0)
        : 0;
      const hForSnap = autoH(polyTau);
      const bybitTaus = new Map<string, number>();
      for (const pos of bybitPositions) {
        bybitTaus.set(pos.symbol, Math.max(((pos.expiryTimestamp / 1000) - snap.timestamp) / YEAR_SEC, 0));
      }
      return computeCombinedPnlCurve(
        polyPositions, bybitPositions,
        lowerPrice, upperPrice,
        polyTau, bybitTaus,
        optionType, hForSnap, smile, bybitSmile, numPoints, grid,
      );
    });

    const combinedLabels = snapshots.map(s => s.label);

    // Individual source overlay curves (for when both sources present)
    // Use shared grid so all curves align by index
    const polyNowCurve = computePolyOnlyCurve(
      polyPositions, grid,
      polyTauNow, optionType, autoH(polyTauNow), smile,
    );
    const polyExpiryCurve = computePolyOnlyCurve(
      polyPositions, grid,
      0, optionType, autoH(0), smile,
    );

    // Bybit: now and at bybit's own expiry (tau=0)
    const bybitTausNow = new Map<string, number>();
    const bybitTausExpiry = new Map<string, number>();
    for (const pos of bybitPositions) {
      bybitTausNow.set(pos.symbol, Math.max(((pos.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0));
      bybitTausExpiry.set(pos.symbol, 0);
    }
    const bybitNowCurve = computeBybitOnlyCurve(bybitPositions, grid, bybitTausNow, bybitSmile);
    const bybitExpiryCurve = computeBybitOnlyCurve(bybitPositions, grid, bybitTausExpiry, bybitSmile);

    // Poly at Bybit option expiry (only when Bybit expires before Poly)
    const bybitEarliestExpirySec = bybitPositions.length > 0
      ? Math.min(...bybitPositions.map(p => p.expiryTimestamp)) / 1000
      : 0;
    const polyTauAtBybitExpiry = (bybitEarliestExpirySec > 0 && polyExpiryTs > bybitEarliestExpirySec)
      ? Math.max((polyExpiryTs - bybitEarliestExpirySec) / YEAR_SEC, 0)
      : -1; // sentinel: -1 means "don't show"
    const polyAtBybitExpiryCurve = polyTauAtBybitExpiry >= 0
      ? computePolyOnlyCurve(polyPositions, grid, polyTauAtBybitExpiry, optionType, autoH(polyTauAtBybitExpiry), smile)
      : [];

    // Total entry cost (gross, unsigned) and fees
    // totalEntryCost = sum of all premiums + fees, regardless of buy/sell
    // This is the correct denominator for P&L % (at NOW: P&L ≈ -fees, at expiry loss: P&L = -(premium+fee) = -100%)
    let totalEntryCost = 0;
    let totalFees = 0;
    let polyEntryCost = 0;
    let bybitEntryCost = 0;
    for (const p of polyPositions) {
      totalEntryCost += p.entryPrice * p.quantity;
      polyEntryCost += p.entryPrice * p.quantity;
    }
    for (const b of bybitPositions) {
      const premium = b.entryPrice * b.quantity;
      totalEntryCost += premium + b.entryFee; // gross: always add, include fee
      const mult = b.side === 'buy' ? 1 : -1;
      bybitEntryCost += (premium + b.entryFee) * mult; // signed with fee for overlay % calc
      totalFees += b.entryFee;
    }

    // Portfolio Margin curve (Bybit Portfolio Margin mode)
    // MM at price X = max(0, -portfolio_pnl) + max(0, netShortQty) × PM_COEFF × X
    // Long options reduce max-loss component; net-short exposure adds contingency floor.
    // PM_COEFF ≈ 1.5% per net-short contract × index price (Bybit short options contingency).
    const PM_COEFF = 0.015;
    const netShortQty = bybitPositions.reduce(
      (sum, b) => sum + (b.side === 'sell' ? b.quantity : -b.quantity), 0,
    );
    const bybitMMNowCurve: ProjectionPoint[] = bybitPositions.length > 0
      ? grid.map((cryptoPrice, i) => {
          const bybitPnl = bybitNowCurve[i]?.pnl ?? 0;
          const maxLoss = Math.max(0, -bybitPnl);
          const contingency = Math.max(0, netShortQty) * PM_COEFF * cryptoPrice;
          return { cryptoPrice, pnl: maxLoss + contingency };
        })
      : [];

    return {
      combinedCurves,
      combinedLabels,
      polyNowCurve,
      polyExpiryCurve,
      bybitNowCurve,
      bybitExpiryCurve,
      polyAtBybitExpiryCurve,
      polyEntryCost,
      bybitEntryCost,
      totalEntryCost,
      totalFees,
      bybitMMNowCurve,
    };
  }, [polyPositions, bybitPositions, lowerPrice, upperPrice, polyTauNow, polyExpiryTs, optionType, smile, bybitSmile, numPoints]);
}
