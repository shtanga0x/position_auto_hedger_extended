# Pricing Engine — Mathematical Documentation

This document describes the mathematical models, equations, and design decisions behind the pricing engine in [`src/pricing/engine.ts`](../src/pricing/engine.ts).

## Table of Contents

- [Normal CDF Approximation](#normal-cdf-approximation)
- [Black-Scholes Vanilla Options (Bybit)](#black-scholes-vanilla-options-bybit)
- [European Binary Option ("above")](#european-binary-option-above)
- [One-Touch Barrier Option ("hit")](#one-touch-barrier-option-hit)
- [Time-Scaling Exponent H](#time-scaling-exponent-h)
- [Implied Volatility Calibration](#implied-volatility-calibration)
- [IV Smile and Sticky-Moneyness](#iv-smile-and-sticky-moneyness)
- [Combined Portfolio P&L](#combined-portfolio-pnl)
- [Expiry Payoff](#expiry-payoff)
- [Design Decisions](#design-decisions)

---

## Normal CDF Approximation

The cumulative distribution function of the standard normal distribution Φ(x) is approximated using the Abramowitz & Stegun rational approximation (formula 26.2.17):

For x ≥ 0:
```
Φ(x) = 1 − φ(x) · (b₁t + b₂t² + b₃t³ + b₄t⁴ + b₅t⁵)
where t = 1 / (1 + p·x)
```

For x < 0:
```
Φ(x) = 1 − Φ(−x)
```

Coefficients:
```
p  = 0.2316419
b₁ = 0.319381530
b₂ = −0.356563782
b₃ = 1.781477937
b₄ = −1.821255978
b₅ = 1.330274429
```

Maximum error: |ε| < 7.5 × 10⁻⁸. For |x| > 8, the function returns 0 or 1 directly.

> **Note on a historical bug (fixed in v3.0.1):** An earlier version used a different set of coefficients (p = 0.3275911, a₁ = 0.254829592, …) from a less accurate polynomial family. These produced errors of 2–4% in Φ(x) for values near the strike, causing Black-Scholes call/put prices to be off by $700–$1200 and the price slope (delta) to become non-monotone — manifesting as a visible kink/elbow in the P&L curve at the strike price. The fix was to switch to the correct A&S 26.2.17 coefficients above.

**Implementation:** `normalCDF(x)` in `engine.ts`

---

## Black-Scholes Vanilla Options (Bybit)

Bybit positions are standard European vanilla calls and puts priced with the Black-Scholes model (zero risk-free rate, zero dividends).

### Call Price

```
C = S·Φ(d₁) − K·Φ(d₂)

d₁ = [ln(S/K) + σ²τ/2] / (σ√τ)
d₂ = d₁ − σ√τ = [ln(S/K) − σ²τ/2] / (σ√τ)
```

### Put Price

```
P = K·Φ(−d₂) − S·Φ(−d₁)
```

(Equivalent by put-call parity: P = C − S + K for r = 0.)

Where:
- **S** — current spot price
- **K** — strike price
- **σ** — implied volatility (annualized, taken from Bybit's `markIv` field)
- **τ** — time to expiry in years
- **Φ** — standard normal CDF

### Boundary Conditions

- τ ≤ 0 (expired): `max(S−K, 0)` for call, `max(K−S, 0)` for put
- σ ≤ 0: same as expired

**Implementation:** `bsCallPrice(S, K, sigma, tau)`, `bsPutPrice(S, K, sigma, tau)`, `bsPrice(S, K, sigma, tau, type)` in `engine.ts`

### Bybit Trading Fee

Bybit charges a taker fee on options trades. The fee per contract is:
```
fee = 0.0006 × max(entryPremium, 0.001 × S) × quantity
```
(0.06% of premium, minimum 0.1% of notional spot value.)

**Implementation:** `bybitTradingFee(spotPrice, entryPrice, quantity)` in `engine.ts`

---

## European Binary Option ("above")

A European binary (digital) option that pays $1 if the underlying price S is above the strike K at expiry.

### Standard Formula (H = 0.5)

Under the Black-Scholes framework with r = 0:

```
P(YES) = Φ(d₂)

d₂ = [ln(S/K) − σ²τ/2] / (σ√τ)
```

### Generalized Formula (arbitrary H)

With the time-scaling exponent H (see [Time-Scaling Exponent H](#time-scaling-exponent-h)):

```
P(YES) = Φ(d₂)

d₂ = [ln(S/K) − σ²·τ^(2H)/2] / (σ·τ^H)
```

When H = 0.5 this reduces to the standard formula.

### Boundary Conditions

- τ ≤ 0 (expired): Returns 1 if S ≥ K, else 0
- σ ≤ 0: Returns 1 if S ≥ K, else 0

**Implementation:** `priceAbove(S, K, sigma, tau, H)` in `engine.ts`

---

## One-Touch Barrier Option ("hit")

A one-touch barrier option that pays $1 if the underlying price touches the barrier level at any point before expiry.

### Direction Detection

Determined at entry (when IV is calibrated):
- **UP barrier** (`isUpBarrier = true`): strike > spot at entry → price must rise to hit
- **DOWN barrier** (`isUpBarrier = false`): strike < spot at entry → price must drop to hit

### UP Barrier Formula

When S < barrier (not yet hit):

```
P(YES) = Φ(d₁) + (S/B)·Φ(d₂)

d₁ = [ln(S/B) − σ²·τ^(2H)/2] / (σ·τ^H)
d₂ = [ln(S/B) + σ²·τ^(2H)/2] / (σ·τ^H)
```

Where B = barrier level.

### DOWN Barrier Formula

When S > barrier (not yet hit):

```
P(YES) = Φ(e₁) + (S/B)·Φ(e₂)

e₁ = [ln(B/S) + σ²·τ^(2H)/2] / (σ·τ^H)
e₂ = [ln(B/S) − σ²·τ^(2H)/2] / (σ·τ^H)
```

### Boundary Conditions

- S = barrier: Returns 1 (already touching)
- S ≥ barrier (UP) or S ≤ barrier (DOWN): Returns 1 (breached)
- τ ≤ 0 or σ ≤ 0 (expired, not breached): Returns 0
- Output clamped to [0, 1]

**Implementation:** `priceHit(S, barrier, sigma, tau, isUpBarrier, H)` in `engine.ts`

---

## Time-Scaling Exponent H

### Problem

Standard Black-Scholes uses τ^0.5 for time scaling (Brownian motion). Comparing model projections against Polymarket data showed the model underestimates convergence speed near ATM strikes — the implied "time to convergence" is shorter than √τ predicts.

### Solution

Replace fixed τ^0.5 with a tunable τ^H:

```
Standard:    σ·√τ  = σ·τ^0.5    and   σ²·τ = σ²·τ^1.0
Generalized: σ·τ^H              and   σ²·τ^(2H)
```

**Effects of H:**

| H value | Behavior |
|---------|----------|
| H = 0.50 | Standard Black-Scholes (Brownian motion) |
| H > 0.50 | Faster time decay → faster ATM convergence |
| H < 0.50 | Slower time decay |
| H ≈ 0.60–0.70 | Empirically best fit for crypto Polymarket events |

**Default:** H = 0.65 (changed from 0.50 in V2).

> H is only applied to **Polymarket** pricing. Bybit vanilla options use the standard H = 0.5 Black-Scholes formula, as they follow exchange-traded convention.

**Connection to Fractional Brownian Motion:** H is analogous to the Hurst exponent in fBM. H > 0.5 implies persistent/trending increments. The implementation is a pragmatic approximation — only the time scaling is modified, not the full fBM framework.

**UI Control:** Purple slider, range 0.40–0.80, step 0.01, default 0.65. Changing H triggers recalibration of all Polymarket IVs and recomputes all projection curves.

---

## Implied Volatility Calibration

### Purpose

Each Polymarket strike has a live YES price. We solve for σ such that:

```
priceOptionYes(S, K, σ, τ, optionType, isUpBarrier, H) = marketYesPrice
```

This ensures the model exactly reproduces the current market price at the current spot.

### Method: Brent's Root-Finding

Solves `f(σ) = model(σ) − marketYesPrice = 0` over σ ∈ [0.01, 10.0] using Brent's method (bisection + secant + inverse quadratic interpolation).

**Parameters:**
- Search interval: σ ∈ [0.01, 10.0]
- Tolerance: 10⁻⁶
- Max iterations: 100

**Edge cases:**
- YES price ≤ 0.001 → σ = 0.01
- YES price ≥ 0.999 → σ = 10.0
- τ ≤ 0 → null (expired)
- No sign change found → grid search fallback in steps of 0.05

> Bybit IVs are **not** calibrated — they are read directly from Bybit's `markIv` field.

**Implementation:** `solveImpliedVol(S, K, tau, yesPrice, optionType, isUpBarrier, H)` in `engine.ts`

---

## IV Smile and Sticky-Moneyness

### Problem

With constant IV per strike (sticky-strike), the model underestimates construction cost when spot moves, because it ignores the vol smile shifting with the spot.

### Polymarket Smile

**Build:** For each market strike K_i with valid price:
```
moneyness_i = ln(S_current / K_i)
IV_i = solveImpliedVol(S_current, K_i, τ, yesPrice_i, …, H)
```
Result: sorted array of `{moneyness, iv}` pairs.

**Apply:** For projected spot S' and each position strike K_j:
```
m' = ln(S' / K_j)
σ' = interpolateSmile(smile, m')     ← piecewise linear, flat extrapolation
yesPrice = priceOptionYes(S', K_j, σ', τ, …)
```

### Bybit Smile

**Build:** For each Bybit instrument in the chain:
```
moneyness_i = ln(S_current / K_i)
IV_i = ticker.markIv
```

**Apply:** Same interpolation approach as Polymarket. When projecting at S', the IV for each position is looked up from the smile at the new moneyness, producing a smooth curve without the constant-IV kink.

### Key Properties

- Both smiles are rebuilt automatically when spot price, H, or the option chain changes
- The Bybit smile uses `markIv` directly (not solved); no Brent's step needed
- At calibration spot (S' = S_current), interpolated IV = calibrated IV → P&L = 0 at current spot is preserved
- Minimum IV clamp of 0.001 prevents degenerate σ ≤ 0 branches in the BS formula

**Data type:** `SmilePoint { moneyness: number; iv: number }` in `engine.ts`

**Implementation:** `interpolateSmile(smile, moneyness)` in `engine.ts`; smile construction in `ChartScreen.tsx`

---

## Combined Portfolio P&L

The portfolio combines Polymarket and Bybit positions into a single P&L curve at each time snapshot.

### Formula

```
P&L(S') = Σ_poly [projectedPoly_i(S') − entryPrice_i] × qty_i
         + Σ_bybit [projectedBybit_j(S') − entryPrice_j] × sideMultiplier_j × qty_j
         − Σ_bybit entryFee_j
```

Where:
- `projectedPoly_i` = `priceOptionYes(…)` for YES side, `1 − priceOptionYes(…)` for NO side
- `projectedBybit_j` = `bsPrice(S', K_j, σ'(S',K_j), τ_j, type_j)` with smile-interpolated IV
- `sideMultiplier_j` = +1 for buy, −1 for sell

### Time Snapshots

Four snapshots are computed; labels adapt based on which sources are loaded:

**Single source:**

| Index | τ used |
|-------|--------|
| Now | τ_now |
| 1/3 to expiry | τ_now × 2/3 |
| 2/3 to expiry | τ_now × 1/3 |
| At expiry | 0 |

**Both sources (different expiry dates):**

| Index | Label | τ used |
|-------|-------|--------|
| 0 | Now | τ_now for each source |
| 1 | ½ to earlier expiry | midpoint to earlier expiry |
| 2 | At earlier expiry | τ = 0 for earlier, τ_remaining for later |
| 3 | At later expiry | τ = 0 for both |

**Individual overlay curves** (shown when both sources are active):
- Poly Now, Poly Expiry — Polymarket-only P&L
- Bybit Now, Bybit Expiry — Bybit-only P&L

These allow visual separation of each source's contribution.

**Implementation:** `computeCombinedPnlCurve(…)` in `engine.ts`; `usePortfolioCurves` hook in `hooks/usePortfolioCurves.ts`

---

## Expiry Payoff

At τ = 0, options become step functions:

**"Above":**
```
YES payoff = 1 if S ≥ K, else 0
```

**"Hit":**
```
UP barrier:   YES payoff = 1 if S ≥ K, else 0
DOWN barrier: YES payoff = 1 if S ≤ K, else 0
```

**Bybit call:** `max(S − K, 0)`
**Bybit put:** `max(K − S, 0)`

---

## Design Decisions

### Why r = 0?

Polymarket options are short-dated (hours to days), making the discount factor negligible. Crypto markets lack a well-defined risk-free rate and Polymarket prices already embed any discounting.

### Why calibrate from YES price?

Implied volatility is the same from YES or NO: `f(σ) = model(σ) − YES = 0` iff `(1−model(σ)) − NO = 0`. We always use YES for consistency.

### Why Brent's over Newton-Raphson?

No vega computation needed, guaranteed convergence, and superlinear speed in practice. The small performance cost (~10 strikes per recalc) is irrelevant.

### Why separate UP/DOWN barrier formulas?

Easier to verify against textbook derivations, clearer boundary conditions, less risk of sign-flip bugs.

### Why build Bybit smile from the full chain, not just selected positions?

Selected positions may be 1–2 contracts. Using all available instruments (typically 20–40 per expiry) gives a much denser and more accurate smile, especially at the wings.

### Why linear interpolation for the smile?

Simple, no oscillation artifacts, sufficient for 5–40 data points in a roughly monotone-per-wing curve. Flat extrapolation prevents extreme values outside the observed range. Cubic spline or SABR would add complexity without clear benefit at this data density.

### Why clamp IV to 0.001 minimum for Bybit?

The BS formula has a degenerate branch when σ → 0 (delta becomes a step function, gamma spikes to infinity). Clamping prevents numerical instability in the smile-interpolated regions between strikes where the interpolated IV might fall very close to zero.
