import type { OptionType, SelectedStrike, ProjectionPoint } from '../types';

export interface SmilePoint {
  moneyness: number; // ln(S_calibration / K)
  iv: number;
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
 */
export function normalCDF(x: number): number {
  if (x > 8) return 1;
  if (x < -8) return 0;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  const y = 1.0 - (a1 * t + a2 * t2 + a3 * t3 + a4 * t4 + a5 * t5) * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
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
  numPoints: number = 200
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
  numPoints: number = 200
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
