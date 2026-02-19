# Pricing Engine — Mathematical Documentation

This document describes the mathematical models, equations, and design decisions behind the pricing engine in [`src/pricing/engine.ts`](../src/pricing/engine.ts).

## Table of Contents

- [Normal CDF Approximation](#normal-cdf-approximation)
- [European Binary Option ("above")](#european-binary-option-above)
- [One-Touch Barrier Option ("hit")](#one-touch-barrier-option-hit)
- [Time-Scaling Exponent H](#time-scaling-exponent-h)
- [Implied Volatility Calibration](#implied-volatility-calibration)
- [IV Smile and Sticky-Moneyness](#iv-smile-and-sticky-moneyness)
- [P&L Curve Computation](#pnl-curve-computation)
- [Expiry Payoff](#expiry-payoff)
- [Design Decisions](#design-decisions)

---

## Normal CDF Approximation

The cumulative distribution function of the standard normal distribution Φ(x) is approximated using the Abramowitz & Stegun rational approximation (formula 26.2.17):

```
Φ(x) = 1 - φ(x)(a₁t + a₂t² + a₃t³ + a₄t⁴ + a₅t⁵)
where t = 1 / (1 + 0.3275911·|x|)
```

Coefficients: a₁ = 0.254829592, a₂ = −0.284496736, a₃ = 1.421413741, a₄ = −1.453152027, a₅ = 1.061405429.

Maximum error: |ε| < 1.5 × 10⁻⁷. For |x| > 8, the function returns 0 or 1 directly.

**Implementation:** `normalCDF(x)` in `engine.ts`

---

## European Binary Option ("above")

A European binary (digital) option that pays $1 if the underlying price S is above the strike K at expiry.

### Standard Formula (H = 0.5)

Under the Black-Scholes framework with zero risk-free rate (r = 0) and zero dividend yield:

```
P(YES) = Φ(d₂)

d₂ = [ln(S/K) − σ²τ/2] / (σ√τ)
```

Where:
- **S** — current spot price of the underlying
- **K** — strike price
- **σ** — implied volatility (annualized)
- **τ** — time to expiry in years (seconds_remaining / 365.25 / 24 / 3600)
- **Φ** — standard normal CDF

### Generalized Formula (arbitrary H)

With the time-scaling exponent H (see [Time-Scaling Exponent H](#time-scaling-exponent-h)):

```
P(YES) = Φ(d₂)

d₂ = [ln(S/K) − σ²·τ^(2H)/2] / (σ·τ^H)
```

When H = 0.5, this reduces to the standard formula since τ^0.5 = √τ and τ^1.0 = τ.

### Boundary Conditions

- τ ≤ 0 (expired): Returns 1 if S ≥ K, else 0
- σ ≤ 0: Returns 1 if S ≥ K, else 0

**Implementation:** `priceAbove(S, K, sigma, tau, H)` in `engine.ts`

---

## One-Touch Barrier Option ("hit")

A one-touch barrier option that pays $1 if the underlying price touches the barrier level at any point before expiry. Unlike the "above" type, this depends on the **path** of the price, not just the terminal value.

### Direction Detection

The barrier direction is determined at entry:
- **UP barrier** (`isUpBarrier = true`): Strike > Spot at entry → price must **rise** to hit
- **DOWN barrier** (`isUpBarrier = false`): Strike < Spot at entry → price must **drop** to hit

### UP Barrier Formula

When S < barrier (not yet hit):

```
P(YES) = Φ(d₁) + (S/H)·Φ(d₂)

d₁ = [ln(S/H) − σ²·τ^(2H)/2] / (σ·τ^H)
d₂ = [ln(S/H) + σ²·τ^(2H)/2] / (σ·τ^H)
```

Where H (in the formula) is the barrier level (not the time exponent — the function parameter is named `barrier` to avoid ambiguity).

### DOWN Barrier Formula

When S > barrier (not yet hit):

```
P(YES) = Φ(e₁) + (S/H)·Φ(e₂)

e₁ = [ln(H/S) + σ²·τ^(2H)/2] / (σ·τ^H)
e₂ = [ln(H/S) − σ²·τ^(2H)/2] / (σ·τ^H)
```

### Boundary Conditions

- S = barrier: Returns 1 (barrier already touched)
- S ≥ barrier (UP) or S ≤ barrier (DOWN): Returns 1 (barrier breached)
- τ ≤ 0 or σ ≤ 0 (expired, not breached): Returns 0
- Output is clamped to [0, 1]

### Derivation Context

These formulas come from the reflection principle of Brownian motion. The standard one-touch barrier price under geometric Brownian motion with r = 0 is:

```
P = (S/H)^(1 − 2r/σ²) · Φ(d)  +  Φ(−d + σ√τ)
```

With r = 0, the (S/H) exponent simplifies to 1, giving the formulas above.

**Implementation:** `priceHit(S, barrier, sigma, tau, isUpBarrier, H)` in `engine.ts`

---

## Time-Scaling Exponent H

### Problem

The standard Black-Scholes model uses √τ (τ^0.5) for time scaling, which assumes the underlying follows geometric Brownian motion (GBM). This implies returns scale as √t — the square-root-of-time rule.

Comparing model projections against real Polymarket data across multiple events with different expirations revealed:

| Strike position | Model accuracy |
|----------------|---------------|
| Near ATM | Underestimates convergence speed (theta too slow) |
| Far OTM | Good estimation |
| Very far OTM | Slight overestimation |

### Root Cause

Crypto markets exhibit:
- **Faster mean-reversion** for near-ATM moves
- **Heavier tails** in return distributions
- Returns that scale faster than √t for short time horizons

This means the effective "time speed" is faster than Brownian motion predicts for ATM strikes.

### Solution

Replace the fixed τ^0.5 time scaling with a tunable τ^H:

```
Standard:    σ√τ  = σ·τ^0.5     and    σ²τ = σ²·τ^1.0
Generalized: σ·τ^H              and    σ²·τ^(2H)
```

**Effects of H:**

| H value | Behavior |
|---------|----------|
| H = 0.50 | Standard Black-Scholes (Brownian motion) |
| H > 0.50 | Faster time decay → faster ATM convergence |
| H < 0.50 | Slower time decay → slower convergence |
| H ≈ 0.55–0.65 | Empirically best fit for crypto markets |

**Why it works:** Increasing H makes τ^H < τ^0.5 (since τ < 1 for sub-annual options), which effectively reduces the "time value" faster. This causes:
- ATM options to converge to their intrinsic value more quickly
- OTM options to remain relatively unaffected (they're dominated by the moneyness term ln(S/K), not the time term)

### Connection to Fractional Brownian Motion

The exponent H is analogous to the **Hurst exponent** in fractional Brownian motion (fBM):
- H = 0.5: Standard Brownian motion (independent increments)
- H > 0.5: Persistent/trending behavior (positive autocorrelation)
- H < 0.5: Mean-reverting behavior (negative autocorrelation)

However, our implementation is a pragmatic approximation — we only replace the time scaling, not the full fBM framework. This keeps the model simple while capturing the primary effect.

### UI Control

The H parameter is controlled via a purple slider in the UI:
- Range: 0.40 to 0.80
- Step: 0.01
- Default: 0.50

Changing H recalibrates all IVs (since IV depends on H) and recomputes all projection curves.

---

## Implied Volatility Calibration

### Purpose

Each strike has a live market YES price from Polymarket. We need to find the implied volatility σ such that:

```
priceOptionYes(S, K, σ, τ, optionType, isUpBarrier, H) = marketYesPrice
```

This ensures the model reproduces the current market price exactly at the current spot.

### Method: Brent's Root-Finding

We solve for σ in the equation f(σ) = priceOptionYes(…, σ, …) − marketYesPrice = 0 using **Brent's method**, which combines:
- Bisection (guaranteed convergence)
- Secant method (fast convergence)
- Inverse quadratic interpolation (superlinear convergence)

**Parameters:**
- Search interval: σ ∈ [0.01, 10.0] (1% to 1000% annualized vol)
- Tolerance: 10⁻⁶
- Max iterations: 100

**Edge cases:**
- YES price ≤ 0.001 → returns σ = 0.01 (near-zero option)
- YES price ≥ 0.999 → returns σ = 10.0 (near-certain option)
- τ ≤ 0 → returns null (expired)
- If f(a)·f(b) > 0 (no sign change): falls back to a grid search over σ in steps of 0.05

### Round-Trip Property

By construction: `price → solveImpliedVol(H) → priceOptionYes(H)` returns the original price. This holds for any value of H, since H is passed consistently through both calibration and pricing.

**Implementation:** `solveImpliedVol(S, K, tau, yesPrice, optionType, isUpBarrier, H)` in `engine.ts`

---

## IV Smile and Sticky-Moneyness

### Problem: Sticky-Strike Inaccuracy

The basic model calibrates one fixed IV per strike at the current spot, then uses that same IV when projecting at different spot levels. This is the **sticky-strike** assumption.

Real market observation: buying a 72000 NO + 68000 YES spread (cost 1.54), then assuming a 2000-point spot move, the market showed construction cost of 1.51 but the model predicted 1.44 — a significant underestimate.

**Root cause:** When spot moves, the **moneyness** of each strike changes. The market reprices based on the new moneyness (sticky-moneyness or sticky-delta), but the model was using the old IV calibrated at the original moneyness.

**Why shorter expirations amplify the effect:** The vol smile is steeper for short-dated options — the IV difference between ATM and OTM is larger. So the error from using the "wrong" moneyness IV grows as expiry approaches.

### Solution: IV Smile Interpolation

Instead of fixed IV per strike, we build a **volatility smile** from all available market strikes:

**Step 1 — Build the smile:**
For each market strike K_i with valid price (0.001 < price < 0.999):
```
moneyness_i = ln(S_current / K_i)
IV_i = solveImpliedVol(S_current, K_i, τ, yesPrice_i, optionType, isUpBarrier_i, H)
```
Result: array of `{moneyness, iv}` pairs, sorted by moneyness.

**Step 2 — Interpolation at projection:**
For each projected spot S' and each portfolio strike K_j:
```
m' = ln(S' / K_j)    ← new moneyness at projected spot
IV' = interpolateSmile(smile, m')    ← look up from smile
```
The interpolation is piecewise linear between smile points, with flat extrapolation at both edges.

**Step 3 — Pricing with smile IV:**
```
yesPrice = priceOptionYes(S', K_j, IV', τ, optionType, isUpBarrier_j, H)
```

### Key Properties

- At the calibration spot (S' = S_current), the moneyness matches the original calibration, so the interpolated IV equals the calibrated IV — P&L = 0 at current spot is preserved.
- The smile is built from **all** market strikes (not just selected ones), giving richer interpolation with more data points.
- The smile is automatically rebuilt when spot price, H, or expiry changes.
- No additional user controls needed — the smile is fully automatic.

### Data Types

```typescript
interface SmilePoint {
  moneyness: number;  // ln(S_calibration / K)
  iv: number;         // calibrated implied volatility
}
```

**Implementation:** `SmilePoint`, `interpolateSmile()` in `engine.ts`; smile construction in `SecondScreen.tsx`

---

## P&L Curve Computation

### Formula

For a portfolio of selected strikes at a given time-to-expiry τ:

```
P&L(S') = Σ projectedValue_i(S') − Σ entryPrice_i
```

Where for each strike i:
```
If side = YES:  projectedValue = priceOptionYes(S', K_i, IV(S',K_i), τ, …)
If side = NO:   projectedValue = 1 − priceOptionYes(S', K_i, IV(S',K_i), τ, …)
```

IV(S', K_i) is obtained from smile interpolation when a smile is available, otherwise from the strike's fixed calibrated IV.

### Four Projection Curves

| Index | Label | τ used |
|-------|-------|--------|
| 0 | Now | τ_now (full time to expiry) |
| 1 | 1/3 to expiry | τ_now × 2/3 |
| 2 | 2/3 to expiry | τ_now × 1/3 |
| 3 | At expiry | τ = 0 (step function) |

Each curve is computed at 200 evenly-spaced spot prices between the user-defined lower and upper bounds.

**Implementation:** `computePnlCurve(strikes, lower, upper, tau, optionType, H, smile)` in `engine.ts`

---

## Expiry Payoff

At expiry (τ → 0), option values become step functions:

### "Above" type
```
YES payoff = 1 if S ≥ K, else 0
NO payoff  = 1 if S < K, else 0
```

### "Hit" type
The hit-type payoff at expiry depends on barrier direction:
```
UP barrier:   YES payoff = 1 if S ≥ K, else 0
DOWN barrier: YES payoff = 1 if S ≤ K, else 0
```

Note: This is the payoff if the barrier has not been hit before expiry. In practice, if the barrier was touched at any earlier point, the option would have already paid out. The expiry step function represents the worst case (never touched).

**Implementation:** `computeExpiryPnl(strikes, lower, upper, optionType)` in `engine.ts`

---

## Design Decisions

### Why r = 0?

The risk-free rate is set to zero because:
1. Polymarket options are short-dated (hours to days), making the discount factor negligible
2. Crypto markets don't have a well-defined risk-free rate
3. Polymarket prices already embed any discounting

### Why calibrate from YES price?

Implied volatility is the same whether calibrated from the YES or NO price:
```
NO price = 1 − YES price
f(σ) = model(σ) − YES price = 0   ⟺   (1 − model(σ)) − NO price = 0
```

We always calibrate from YES for consistency.

### Why Brent's method over Newton-Raphson?

1. Brent's doesn't require the derivative (vega), keeping the code simpler
2. Guaranteed convergence (falls back to bisection)
3. Still achieves superlinear convergence in practice
4. The slight performance cost is irrelevant for our use case (~10 strikes)

### Why separate UP/DOWN barrier formulas?

A single formula could handle both directions with appropriate sign changes, but separate formulas are:
1. Easier to verify against textbook formulas
2. Clearer about the boundary conditions (S ≥ H vs S ≤ H)
3. Less error-prone (no sign-flip bugs)

### Why build smile from ALL strikes, not just selected?

Selected strikes may be just 1–2 positions, giving poor interpolation. Using all available market strikes (typically 5–15) provides a much richer smile curve, especially at the edges.

### Why linear interpolation for the smile?

1. Simple and predictable — no oscillation artifacts
2. Sufficient for 5–15 data points in a roughly monotonic-by-wing curve
3. Flat extrapolation prevents extreme values outside the observed range
4. More sophisticated methods (cubic spline, SABR) would add complexity without clear benefit given the data density
