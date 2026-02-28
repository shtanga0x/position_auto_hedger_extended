import type { OptionType, SelectedStrike, ProjectionPoint, BybitPosition, PolymarketPosition } from '../types';

export interface SmilePoint {
  moneyness: number; // ln(S_calibration / K)
  iv: number;
}

/**
 * Auto-compute H based on time-to-expiry in years.
 * Step function: decreases by 0.02 for each additional day remaining,
 * from H=0.70 at <24 h down to H=0.50 at ≥10 days (constant thereafter).
 *
 *   < 1d  → 0.70
 *   1–2d  → 0.68
 *   2–3d  → 0.66
 *   3–4d  → 0.64
 *   4–5d  → 0.62
 *   5–6d  → 0.60
 *   6–7d  → 0.58
 *   7–8d  → 0.56
 *   8–9d  → 0.54
 *   9–10d → 0.52
 *   ≥10d  → 0.50
 */
export function autoH(tauYears: number): number {
  const tauDays = tauYears * 365.25;
  if (tauDays < 1)  return 0.70;
  if (tauDays < 2)  return 0.68;
  if (tauDays < 3)  return 0.66;
  if (tauDays < 4)  return 0.64;
  if (tauDays < 5)  return 0.62;
  if (tauDays < 6)  return 0.60;
  if (tauDays < 7)  return 0.58;
  if (tauDays < 8)  return 0.56;
  if (tauDays < 9)  return 0.54;
  if (tauDays < 10) return 0.52;
  return 0.50;
}

/**
 * Linear interpolation on the IV smile, flat extrapolation at edges.
 * Smile must be sorted by moneyness ascending.
 */
export function interpolateSmile(smile: SmilePoint[], moneyness: number): number {
  if (smile.length === 0) return 0.5;
  if (smile.length === 1) return smile[0].iv;
  if (moneyness <= smile[0].moneyness) return smile[0].iv;
  if (moneyness >= smile[smile.length - 1].moneyness) return smile[smile.length - 1].iv;

  for (let i = 0; i < smile.length - 1; i++) {
    if (moneyness <= smile[i + 1].moneyness) {
      const t = (moneyness - smile[i].moneyness) / (smile[i + 1].moneyness - smile[i].moneyness);
      return smile[i].iv + t * (smile[i + 1].iv - smile[i].iv);
    }
  }
  return smile[smile.length - 1].iv;
}

/**
 * Normal CDF using rational approximation (Abramowitz & Stegun 26.2.17)
 * max |error| < 7.5e-8
 */
export function normalCDF(x: number): number {
  if (x > 8) return 1;
  if (x < -8) return 0;

  if (x < 0) return 1.0 - normalCDF(-x);

  const b1 =  0.319381530;
  const b2 = -0.356563782;
  const b3 =  1.781477937;
  const b4 = -1.821255978;
  const b5 =  1.330274429;
  const p  =  0.2316419;

  const t = 1.0 / (1.0 + p * x);
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  return 1.0 - (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-x * x / 2) * poly;
}

/**
 * European binary ("above") YES price: P(S, K, σ, τ) = Φ(d₂)
 */
export function priceAbove(S: number, K: number, sigma: number, tau: number, H: number = 0.5): number {
  if (tau <= 0) return S >= K ? 1 : 0;
  if (sigma <= 0) return S >= K ? 1 : 0;

  const tauH = Math.pow(tau, H);
  const d2 = (Math.log(S / K) - (sigma * sigma * Math.pow(tau, 2 * H)) / 2) / (sigma * tauH);
  return normalCDF(d2);
}

/**
 * One-touch barrier ("hit") YES price with direction support (r=0).
 *
 * UP barrier (isUpBarrier=true, H > spot at entry):
 *   Need price to RISE to H.
 *   S ≥ H → barrier breached → 1
 *   S < H → P = Φ(d₁) + (S/H)·Φ(d₂)
 *     d₁ = (ln(S/H) − σ²τ/2) / (σ√τ)
 *     d₂ = (ln(S/H) + σ²τ/2) / (σ√τ)
 *
 * DOWN barrier (isUpBarrier=false, H < spot at entry):
 *   Need price to DROP to H.
 *   S ≤ H → barrier breached → 1
 *   S > H → P = Φ(e₁) + (S/H)·Φ(e₂)
 *     e₁ = (ln(H/S) + σ²τ/2) / (σ√τ)
 *     e₂ = (ln(H/S) − σ²τ/2) / (σ√τ)
 */
export function priceHit(S: number, barrier: number, sigma: number, tau: number, isUpBarrier: boolean, H: number = 0.5): number {
  if (S === barrier) return 1;

  if (isUpBarrier) {
    // UP barrier: need price to rise to barrier
    if (S >= barrier) return 1;
    if (tau <= 0 || sigma <= 0) return 0;

    const tauH = Math.pow(tau, H);
    const logSH = Math.log(S / barrier); // negative since S < barrier
    const halfSigmaSqTau2H = (sigma * sigma * Math.pow(tau, 2 * H)) / 2;

    const d1 = (logSH - halfSigmaSqTau2H) / (sigma * tauH);
    const d2 = (logSH + halfSigmaSqTau2H) / (sigma * tauH);

    return Math.min(1, Math.max(0, normalCDF(d1) + (S / barrier) * normalCDF(d2)));
  } else {
    // DOWN barrier: need price to drop to barrier
    if (S <= barrier) return 1;
    if (tau <= 0 || sigma <= 0) return 0;

    const tauH = Math.pow(tau, H);
    const logHS = Math.log(barrier / S); // negative since barrier < S
    const halfSigmaSqTau2H = (sigma * sigma * Math.pow(tau, 2 * H)) / 2;

    const e1 = (logHS + halfSigmaSqTau2H) / (sigma * tauH);
    const e2 = (logHS - halfSigmaSqTau2H) / (sigma * tauH);

    return Math.min(1, Math.max(0, normalCDF(e1) + (S / barrier) * normalCDF(e2)));
  }
}

/**
 * Price the YES side of an option.
 * For 'hit' type, isUpBarrier determines barrier direction.
 */
export function priceOptionYes(
  S: number, K: number, sigma: number, tau: number, optionType: OptionType, isUpBarrier: boolean = true, H: number = 0.5
): number {
  return optionType === 'above' ? priceAbove(S, K, sigma, tau, H) : priceHit(S, K, sigma, tau, isUpBarrier, H);
}

/**
 * Implied volatility solver using Brent's method.
 * Always calibrates from the YES price (IV is the same for YES and NO).
 * For hit-type, isUpBarrier determines barrier direction.
 */
export function solveImpliedVol(
  S: number,
  K: number,
  tau: number,
  yesPrice: number,
  optionType: OptionType,
  isUpBarrier: boolean = true,
  H: number = 0.5,
  tolerance: number = 1e-6,
  maxIter: number = 100
): number | null {
  if (yesPrice <= 0.001) return 0.01;
  if (yesPrice >= 0.999) return 10.0;
  if (tau <= 0) return null;

  let a = 0.01;
  let b = 10.0;

  const f = (sigma: number) => priceOptionYes(S, K, sigma, tau, optionType, isUpBarrier, H) - yesPrice;

  let fa = f(a);
  let fb = f(b);

  if (fa * fb > 0) {
    let bestSigma = a;
    let bestError = Math.abs(fa);
    for (let sigma = 0.05; sigma <= 10.0; sigma += 0.05) {
      const err = Math.abs(f(sigma));
      if (err < bestError) {
        bestError = err;
        bestSigma = sigma;
      }
    }
    return bestSigma;
  }

  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;

  for (let i = 0; i < maxIter; i++) {
    if (fb * fc > 0) {
      c = a; fc = fa; d = b - a; e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b; b = c; c = a; fa = fb; fb = fc; fc = fa;
    }

    const tol = 2 * Number.EPSILON * Math.abs(b) + tolerance;
    const m = 0.5 * (c - b);

    if (Math.abs(m) <= tol || Math.abs(fb) < tolerance) return b;

    if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
      const s_val = fb / fa;
      let p_val: number;
      let q_val: number;

      if (a === c) {
        p_val = 2 * m * s_val;
        q_val = 1 - s_val;
      } else {
        const q = fa / fc;
        const r = fb / fc;
        p_val = s_val * (2 * m * q * (q - r) - (b - a) * (r - 1));
        q_val = (q - 1) * (r - 1) * (s_val - 1);
      }

      if (p_val > 0) q_val = -q_val; else p_val = -p_val;

      if (2 * p_val < Math.min(3 * m * q_val - Math.abs(tol * q_val), Math.abs(e * q_val))) {
        e = d; d = p_val / q_val;
      } else {
        d = m; e = m;
      }
    } else {
      d = m; e = m;
    }

    a = b; fa = fb;
    b += Math.abs(d) > tol ? d : (m > 0 ? tol : -tol);
    fb = f(b);
  }

  return b;
}

/**
 * Compute P&L projection curve.
 * P&L = projected value - entry cost
 * For YES: projected value = modelYesPrice; entry cost = entryPrice
 * For NO: projected value = 1 - modelYesPrice; entry cost = entryPrice
 */
export function computePnlCurve(
  strikes: SelectedStrike[],
  lowerPrice: number,
  upperPrice: number,
  tau: number,
  optionType: OptionType,
  H: number = 0.5,
  smile?: SmilePoint[],
  numPoints: number = 2000
): ProjectionPoint[] {
  if (strikes.length === 0 || numPoints < 2) return [];

  const totalEntry = strikes.reduce((sum, s) => sum + s.entryPrice, 0);
  const step = (upperPrice - lowerPrice) / (numPoints - 1);
  const points: ProjectionPoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const cryptoPrice = lowerPrice + step * i;
    let projectedValue = 0;

    for (const strike of strikes) {
      const iv = smile
        ? interpolateSmile(smile, Math.log(cryptoPrice / strike.strikePrice))
        : strike.impliedVol;
      const yesPrice = priceOptionYes(cryptoPrice, strike.strikePrice, iv, tau, optionType, strike.isUpBarrier, H);
      projectedValue += strike.side === 'YES' ? yesPrice : (1 - yesPrice);
    }

    points.push({ cryptoPrice, pnl: projectedValue - totalEntry });
  }

  return points;
}

/**
 * Compute P&L at expiry (tau → 0).
 * For 'above': step function at strike (cryptoPrice >= strike → YES=1)
 * For 'hit': step function depends on barrier direction:
 *   UP barrier: cryptoPrice >= strike → hit → YES=1
 *   DOWN barrier: cryptoPrice <= strike → hit → YES=1
 */
export function computeExpiryPnl(
  strikes: SelectedStrike[],
  lowerPrice: number,
  upperPrice: number,
  optionType: OptionType = 'above',
  numPoints: number = 2000
): ProjectionPoint[] {
  if (strikes.length === 0 || numPoints < 2) return [];

  const totalEntry = strikes.reduce((sum, s) => sum + s.entryPrice, 0);
  const step = (upperPrice - lowerPrice) / (numPoints - 1);
  const points: ProjectionPoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const cryptoPrice = lowerPrice + step * i;
    let projectedValue = 0;

    for (const strike of strikes) {
      let yesPayoff: number;
      if (optionType === 'hit') {
        // Hit type: direction matters
        yesPayoff = strike.isUpBarrier
          ? (cryptoPrice >= strike.strikePrice ? 1 : 0)
          : (cryptoPrice <= strike.strikePrice ? 1 : 0);
      } else {
        // Above type: standard step function
        yesPayoff = cryptoPrice >= strike.strikePrice ? 1 : 0;
      }
      projectedValue += strike.side === 'YES' ? yesPayoff : (1 - yesPayoff);
    }

    points.push({ cryptoPrice, pnl: projectedValue - totalEntry });
  }

  return points;
}

/** Bybit trading fee: min(0.03% × IndexPrice, 7% × OptionPrice) × Size */
export function bybitTradingFee(indexPrice: number, optionPrice: number, quantity: number): number {
  return Math.min(0.0003 * indexPrice, 0.07 * optionPrice) * quantity;
}

/** Bybit initial margin for SHORT option: max(markPrice, 10% × indexPrice) × qty */
export function bybitInitialMargin(indexPrice: number, markPrice: number, quantity: number): number {
  return Math.max(markPrice, 0.1 * indexPrice) * quantity;
}

/** Bybit maintenance margin for SHORT option: max(markPrice, 7.5% × indexPrice) × qty */
export function bybitMaintenanceMargin(indexPrice: number, markPrice: number, quantity: number): number {
  return Math.max(markPrice, 0.075 * indexPrice) * quantity;
}

// --- Black-Scholes vanilla option pricing ---

/**
 * Black-Scholes call price: C = S*N(d1) - K*e^(-rτ)*N(d2)
 * At tau<=0 returns intrinsic value max(S-K, 0)
 */
export function bsCallPrice(S: number, K: number, sigma: number, tau: number, r: number = 0): number {
  if (tau <= 0) return Math.max(S - K, 0);
  if (sigma <= 0) return Math.max(S - K * Math.exp(-r * tau), 0);

  const sqrtTau = Math.sqrt(tau);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * tau) / (sigma * sqrtTau);
  const d2 = d1 - sigma * sqrtTau;

  return S * normalCDF(d1) - K * Math.exp(-r * tau) * normalCDF(d2);
}

/**
 * Black-Scholes put price: P = K*e^(-rτ)*N(-d2) - S*N(-d1)
 * At tau<=0 returns intrinsic value max(K-S, 0)
 */
export function bsPutPrice(S: number, K: number, sigma: number, tau: number, r: number = 0): number {
  if (tau <= 0) return Math.max(K - S, 0);
  if (sigma <= 0) return Math.max(K * Math.exp(-r * tau) - S, 0);

  const sqrtTau = Math.sqrt(tau);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * tau) / (sigma * sqrtTau);
  const d2 = d1 - sigma * sqrtTau;

  return K * Math.exp(-r * tau) * normalCDF(-d2) - S * normalCDF(-d1);
}

/** Route to call or put pricing */
export function bsPrice(S: number, K: number, sigma: number, tau: number, optionsType: 'Call' | 'Put', r: number = 0): number {
  return optionsType === 'Call' ? bsCallPrice(S, K, sigma, tau, r) : bsPutPrice(S, K, sigma, tau, r);
}

/**
 * Compute P&L curve for a single Bybit position.
 * P&L per contract = (currentOptionValue - entryPrice) * sideMultiplier * quantity
 */
export function computeBybitPnlCurve(
  position: BybitPosition,
  lowerPrice: number,
  upperPrice: number,
  tau: number,
  numPoints: number = 2000,
): ProjectionPoint[] {
  if (numPoints < 2) return [];

  const step = (upperPrice - lowerPrice) / (numPoints - 1);
  const sideMultiplier = position.side === 'buy' ? 1 : -1;
  const points: ProjectionPoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const cryptoPrice = lowerPrice + step * i;
    const currentValue = bsPrice(cryptoPrice, position.strike, position.markIv, tau, position.optionsType);
    const pnl = (currentValue - position.entryPrice) * sideMultiplier * position.quantity;
    points.push({ cryptoPrice, pnl });
  }

  return points;
}

/**
 * Build a uniform price grid. Simple and artifact-free with linear interpolation.
 */
export function buildPriceGrid(
  lower: number,
  upper: number,
  numPoints: number = 2000,
): number[] {
  const range = upper - lower;
  if (range <= 0 || numPoints < 2) return [];

  const step = range / (numPoints - 1);
  const grid: number[] = [];
  for (let i = 0; i < numPoints; i++) {
    grid.push(lower + step * i);
  }
  return grid;
}

/**
 * Compute combined portfolio P&L curve at one time snapshot.
 * Sums Polymarket P&L (in contract units, scaled by quantity) and Bybit P&L (in USD).
 * Uses adaptive grid for better resolution near strikes.
 *
 * @param bybitSmile - Optional IV smile built from the Bybit option chain (sticky-moneyness).
 *   When provided, the IV for each Bybit position is interpolated from this smile rather than
 *   held constant at markIv, producing a smoother and more realistic P&L curve.
 */
export function computeCombinedPnlCurve(
  polyPositions: PolymarketPosition[],
  bybitPositions: BybitPosition[],
  lowerPrice: number,
  upperPrice: number,
  polyTau: number,
  bybitTaus: Map<string, number>,
  optionType: OptionType,
  H: number,
  smile: SmilePoint[] | undefined,
  bybitSmile: SmilePoint[] | undefined,
  numPoints: number = 2000,
  prebuiltGrid?: number[],
): ProjectionPoint[] {
  if (polyPositions.length === 0 && bybitPositions.length === 0) return [];

  const grid = prebuiltGrid ?? buildPriceGrid(lowerPrice, upperPrice, numPoints);
  if (grid.length === 0) return [];
  const points: ProjectionPoint[] = [];

  for (const cryptoPrice of grid) {
    let totalPnl = 0;

    // Polymarket positions
    for (const pos of polyPositions) {
      const iv = smile
        ? interpolateSmile(smile, Math.log(cryptoPrice / pos.strikePrice))
        : pos.impliedVol;
      const yesPrice = priceOptionYes(cryptoPrice, pos.strikePrice, iv, polyTau, optionType, pos.isUpBarrier, H);
      const projectedValue = pos.side === 'YES' ? yesPrice : (1 - yesPrice);
      totalPnl += (projectedValue - pos.entryPrice) * pos.quantity;
    }

    // Bybit positions — use smile-interpolated IV when available so the curve
    // avoids the flat-vol kink artifact at the strike price.
    for (const pos of bybitPositions) {
      const tau = bybitTaus.get(pos.symbol) ?? 0;
      const rawIv = bybitSmile && bybitSmile.length > 0
        ? interpolateSmile(bybitSmile, Math.log(cryptoPrice / pos.strike))
        : pos.markIv;
      // Clamp to a minimum to avoid the sigma≤0 intrinsic-value branch (kinked at K).
      const iv = Math.max(rawIv, 0.001);
      const currentValue = bsPrice(cryptoPrice, pos.strike, iv, tau, pos.optionsType);
      const sideMultiplier = pos.side === 'buy' ? 1 : -1;
      totalPnl += (currentValue - pos.entryPrice) * sideMultiplier * pos.quantity - pos.entryFee;
    }

    points.push({ cryptoPrice, pnl: totalPnl });
  }

  return points;
}
