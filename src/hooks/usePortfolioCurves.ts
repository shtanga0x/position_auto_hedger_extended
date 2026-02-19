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
  combinedCurves: ProjectionPoint[][];   // Now, 1/3, 2/3, Expiry
  combinedLabels: string[];
  polyNowCurve: ProjectionPoint[];
  polyExpiryCurve: ProjectionPoint[];
  bybitNowCurve: ProjectionPoint[];
  bybitExpiryCurve: ProjectionPoint[];
  totalEntryCost: number;
}

function formatHours(seconds: number): string {
  const h = Math.round(seconds / 3600);
  return `${h}h`;
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

/** Compute P&L curve for only Bybit positions at given taus */
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
      pnl += (currentValue - pos.entryPrice) * sideMultiplier * pos.quantity;
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
    };

    if (lowerPrice <= 0 || upperPrice <= lowerPrice) return empty;
    if (polyPositions.length === 0 && bybitPositions.length === 0) return empty;

    const nowSec = Math.floor(Date.now() / 1000);
    const timeToExpirySec = polyExpiryTs - nowSec;

    // Time fractions for Polymarket reference expiry
    const polyTaus = [
      polyTauNow,
      polyTauNow * (2 / 3),
      polyTauNow * (1 / 3),
      0,
    ];

    // For each time snapshot, compute Bybit taus
    const YEAR_SEC = 365.25 * 24 * 3600;
    const elapsedFractions = [0, 1 / 3, 2 / 3, 1]; // fraction of poly time elapsed

    function getBybitTaus(elapsedFraction: number): Map<string, number> {
      const taus = new Map<string, number>();
      const elapsedSec = timeToExpirySec * elapsedFraction;
      for (const pos of bybitPositions) {
        const bybitExpirySecFromNow = (pos.expiryTimestamp / 1000) - nowSec;
        const remaining = bybitExpirySecFromNow - elapsedSec;
        taus.set(pos.symbol, Math.max(remaining / YEAR_SEC, 0));
      }
      return taus;
    }

    // Combined curves
    const combinedCurves: ProjectionPoint[][] = polyTaus.map((pTau, idx) => {
      const bTaus = getBybitTaus(elapsedFractions[idx]);
      return computeCombinedPnlCurve(
        polyPositions, bybitPositions,
        lowerPrice, upperPrice,
        pTau, bTaus,
        optionType, H, smile, numPoints,
      );
    });

    const combinedLabels = [
      `Now (${formatHours(timeToExpirySec)} to exp)`,
      `1/3 to expiry (${formatHours(timeToExpirySec * 2 / 3)})`,
      `2/3 to expiry (${formatHours(timeToExpirySec / 3)})`,
      'At expiry',
    ];

    // Individual source curves
    const bybitTausNow = getBybitTaus(0);
    const bybitTausExpiry = getBybitTaus(1);

    const polyNowCurve = computePolyOnlyCurve(polyPositions, lowerPrice, upperPrice, polyTauNow, optionType, H, smile, numPoints);
    const polyExpiryCurve = computePolyOnlyCurve(polyPositions, lowerPrice, upperPrice, 0, optionType, H, smile, numPoints);
    const bybitNowCurve = computeBybitOnlyCurve(bybitPositions, lowerPrice, upperPrice, bybitTausNow, numPoints);
    const bybitExpiryCurve = computeBybitOnlyCurve(bybitPositions, lowerPrice, upperPrice, bybitTausExpiry, numPoints);

    // Total entry cost
    let totalEntryCost = 0;
    for (const p of polyPositions) totalEntryCost += p.entryPrice * p.quantity;
    for (const b of bybitPositions) {
      const mult = b.side === 'buy' ? 1 : -1;
      totalEntryCost += b.entryPrice * mult * b.quantity;
    }

    return {
      combinedCurves,
      combinedLabels,
      polyNowCurve,
      polyExpiryCurve,
      bybitNowCurve,
      bybitExpiryCurve,
      totalEntryCost,
    };
  }, [polyPositions, bybitPositions, lowerPrice, upperPrice, polyTauNow, polyExpiryTs, optionType, H, smile, numPoints]);
}
