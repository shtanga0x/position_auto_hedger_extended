import { useMemo } from 'react';
import type { OptionType, ProjectionPoint, PolymarketPosition, BybitPosition } from '../types';
import {
  computeCombinedPnlCurve,
  bsPrice,
  priceOptionYes,
  interpolateSmile,
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
  H: number;
  smile?: SmilePoint[];
  numPoints?: number;
}

interface PortfolioCurvesOutput {
  combinedCurves: ProjectionPoint[][];   // Time snapshot curves
  combinedLabels: string[];
  polyNowCurve: ProjectionPoint[];
  polyExpiryCurve: ProjectionPoint[];
  bybitNowCurve: ProjectionPoint[];
  bybitExpiryCurve: ProjectionPoint[];
  totalEntryCost: number;
  totalFees: number;
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
  lower: number,
  upper: number,
  tau: number,
  optionType: OptionType,
  H: number,
  smile: SmilePoint[] | undefined,
  numPoints: number,
): ProjectionPoint[] {
  if (positions.length === 0 || numPoints < 2) return [];
  const step = (upper - lower) / (numPoints - 1);
  const points: ProjectionPoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const cryptoPrice = lower + step * i;
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

/** Compute P&L curve for only Bybit positions at given taus (includes fees) */
function computeBybitOnlyCurve(
  positions: BybitPosition[],
  lower: number,
  upper: number,
  taus: Map<string, number>,
  numPoints: number,
): ProjectionPoint[] {
  if (positions.length === 0 || numPoints < 2) return [];
  const step = (upper - lower) / (numPoints - 1);
  const points: ProjectionPoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const cryptoPrice = lower + step * i;
    let pnl = 0;
    for (const pos of positions) {
      const tau = taus.get(pos.symbol) ?? 0;
      const currentValue = bsPrice(cryptoPrice, pos.strike, pos.markIv, tau, pos.optionsType);
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
    H,
    smile,
    numPoints = 200,
  } = input;

  return useMemo(() => {
    const empty: PortfolioCurvesOutput = {
      combinedCurves: [],
      combinedLabels: [],
      polyNowCurve: [],
      polyExpiryCurve: [],
      bybitNowCurve: [],
      bybitExpiryCurve: [],
      totalEntryCost: 0,
      totalFees: 0,
    };

    if (lowerPrice <= 0 || upperPrice <= lowerPrice) return empty;
    if (polyPositions.length === 0 && bybitPositions.length === 0) return empty;

    const nowSec = Math.floor(Date.now() / 1000);

    // Compute time snapshots based on actual expiry dates
    const snapshots = computeSnapshots(polyPositions, bybitPositions, nowSec, polyExpiryTs);

    // Compute combined curve at each snapshot
    const combinedCurves: ProjectionPoint[][] = snapshots.map(snap => {
      const polyTau = polyExpiryTs > 0
        ? Math.max((polyExpiryTs - snap.timestamp) / YEAR_SEC, 0)
        : 0;
      const bybitTaus = new Map<string, number>();
      for (const pos of bybitPositions) {
        bybitTaus.set(pos.symbol, Math.max(((pos.expiryTimestamp / 1000) - snap.timestamp) / YEAR_SEC, 0));
      }
      return computeCombinedPnlCurve(
        polyPositions, bybitPositions,
        lowerPrice, upperPrice,
        polyTau, bybitTaus,
        optionType, H, smile, numPoints,
      );
    });

    const combinedLabels = snapshots.map(s => s.label);

    // Individual source overlay curves (for when both sources present)
    // Poly: now and at poly's own expiry
    const polyNowCurve = computePolyOnlyCurve(
      polyPositions, lowerPrice, upperPrice,
      polyTauNow, optionType, H, smile, numPoints,
    );
    const polyExpiryCurve = computePolyOnlyCurve(
      polyPositions, lowerPrice, upperPrice,
      0, optionType, H, smile, numPoints,
    );

    // Bybit: now and at bybit's own expiry (tau=0)
    const bybitTausNow = new Map<string, number>();
    const bybitTausExpiry = new Map<string, number>();
    for (const pos of bybitPositions) {
      bybitTausNow.set(pos.symbol, Math.max(((pos.expiryTimestamp / 1000) - nowSec) / YEAR_SEC, 0));
      bybitTausExpiry.set(pos.symbol, 0);
    }
    const bybitNowCurve = computeBybitOnlyCurve(bybitPositions, lowerPrice, upperPrice, bybitTausNow, numPoints);
    const bybitExpiryCurve = computeBybitOnlyCurve(bybitPositions, lowerPrice, upperPrice, bybitTausExpiry, numPoints);

    // Total entry cost and fees
    let totalEntryCost = 0;
    let totalFees = 0;
    for (const p of polyPositions) totalEntryCost += p.entryPrice * p.quantity;
    for (const b of bybitPositions) {
      const mult = b.side === 'buy' ? 1 : -1;
      totalEntryCost += b.entryPrice * mult * b.quantity;
      totalFees += b.entryFee;
    }

    return {
      combinedCurves,
      combinedLabels,
      polyNowCurve,
      polyExpiryCurve,
      bybitNowCurve,
      bybitExpiryCurve,
      totalEntryCost,
      totalFees,
    };
  }, [polyPositions, bybitPositions, lowerPrice, upperPrice, polyTauNow, polyExpiryTs, optionType, H, smile, numPoints]);
}
