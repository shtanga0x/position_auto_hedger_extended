# Grapher V3 — Polymarket + Bybit Options P&L Visualizer

**Live:** [shtanga0x.github.io/grapher_v3](https://shtanga0x.github.io/grapher_v3/)

A browser-based portfolio tool that combines **Polymarket binary options** (crypto price events) with **Bybit vanilla options** into a single projected P&L chart. It calibrates implied volatility from live market prices, projects value across different price levels and time horizons, and renders interactive charts with dynamic % labels.

---

## What's New in V3 vs V2

| Feature | V2 | V3 |
|---------|----|----|
| Bybit vanilla options (calls/puts) | ✗ | ✓ |
| Combined Polymarket + Bybit portfolio | ✗ | ✓ |
| IV smile for Bybit option chain | ✗ | ✓ |
| Corrected normalCDF (A&S 26.2.17) | ✗ | ✓ |
| Time-snapshot labels based on actual expiry dates | ✗ | ✓ |
| Tooltip % change labels per curve | ✗ | ✓ |
| Expiry dates in UTC+1 in strike panels | ✗ | ✓ |
| H default value | 0.50 | 0.65 |

---

## How It Works

### 1. Setup Screen

Two independent data sources can be loaded simultaneously:

**Polymarket** — paste a crypto event URL (e.g. `https://polymarket.com/event/bitcoin-above-100k-feb`). The app:
- Extracts the slug and fetches event data via the Polymarket Gamma API (proxied through a Cloudflare Worker to bypass CORS)
- Auto-detects the cryptocurrency (BTC, ETH, SOL, XRP) from the series metadata
- Auto-detects option type — `"above"` (European binary) or `"hit"` (one-touch barrier)
- Parses strike prices from each market's `groupItemTitle`
- Fetches the current spot price from Binance

**Bybit** — select an expiry from the Bybit option chain. The app fetches all available calls and puts for that expiry, including mark price, bid/ask, delta, and markIv.

### 2. Strike Selection

**Polymarket** (1/3 column): select YES or NO for any strike, set quantity in contracts. Entry price = market YES price (YES side) or 1 − YES price (NO side).

**Bybit** (2/3 column): select buy or sell for any call or put at any strike, set quantity in BTC/ETH. Entry price = ask (buy) or bid (sell). Trading fees are computed and displayed.

Both sources can be used simultaneously to build a combined portfolio (e.g. long a Bybit call + short a Polymarket NO).

### 3. Pricing Engine

Full mathematical details are in [`docs/PRICING.md`](docs/PRICING.md).

**Polymarket positions** use the generalized Black-Scholes binary/barrier pricing:
- `"above"` — European binary: pays $1 if S ≥ K at expiry → priced as Φ(d₂)
- `"hit"` — One-touch barrier: pays $1 if S ever touches K → reflection-principle formula
- IV is calibrated per-strike from the live YES price using Brent's root-finding
- Time scaling uses τ^H (Hurst-style exponent, default H = 0.65)

**Bybit positions** use standard Black-Scholes vanilla call/put pricing:
- `bsCall(S, K, σ, τ)` = S·Φ(d₁) − K·Φ(d₂)
- `bsPut(S, K, σ, τ)` = K·Φ(−d₂) − S·Φ(−d₁)
- IV is taken directly from Bybit's `markIv` field (annualized, 0–1 scale)

**Normal CDF** uses the correct Abramowitz & Stegun 26.2.17 approximation with coefficients p = 0.2316419, b₁ = 0.319381530, …, b₅ = 1.330274429. Maximum error |ε| < 7.5 × 10⁻⁸. An earlier version (pre-v3.0.1) used wrong coefficients (p = 0.3275911 from a different formula family), causing BS prices to be off by $700–$1200 near the strike and producing a visible kink/elbow in the P&L curve at the strike price — fixed in v3.0.1.

### 4. IV Smile (Sticky-Moneyness)

Both Polymarket and Bybit builds have an independent IV smile:

**Polymarket smile** — built from all market strikes at the current spot. When projecting at a different spot S', the moneyness `ln(S'/K)` is recomputed and IV is linearly interpolated from the smile (flat extrapolation at edges). This eliminates the sticky-strike artifact.

**Bybit smile** — built from the full option chain's `markIv` values. When projecting at different spot levels, the vol smile follows sticky-moneyness, producing a smooth curve instead of the kinked constant-IV shape.

### 5. Time Snapshots

The chart shows 4 snapshot curves. Labels and timestamps adapt based on which sources are active:

**Single source (Poly or Bybit only):**
- Now (Xd Yh to exp)
- 1/3 to expiry
- 2/3 to expiry
- At expiry

**Both sources active:**
- Now (time to earlier expiry shown)
- ½ to earlier expiry
- At earlier expiry ("Options" or "Event")
- At later expiry ("Options" or "Event")

### 6. P&L Formula

```
P&L(S') = Σ projectedValue_i(S') − Σ entryPrice_i

Polymarket YES:  projectedValue = priceOptionYes(S', K, IV(S',K), τ, …)
Polymarket NO:   projectedValue = 1 − priceOptionYes(…)
Bybit buy:       projectedValue = bsPrice(S', K, IV(S',K), τ, type)
Bybit sell:      projectedValue = −bsPrice(…)
```

Plus fees: `entryFee = 0.0006 × max(entryPremium, 0.1% × notional)`.

### 7. Chart Features

- **Green/red split lines** — positive P&L segments in green, negative in red, with bridging at sign changes
- **Combined curves** (solid→dashed) for time snapshots
- **Poly overlay** (blue) — Poly-only Now and Expiry curves when both sources are active
- **Bybit overlay** (orange) — Bybit-only Now and Expiry curves
- **Interactive legend** — click any item to toggle visibility
- **Hover tooltip** — shows P&L at hovered price for all visible curves, plus relative % change vs reference curve:
  - Snapshot curves (1/3, 2/3, Expiry): Δ% vs Now, relative to total entry cost
  - Poly Expiry: Δ% vs Poly Now
  - Bybit Expiry: Δ% vs Bybit Now
  - Now / Poly Now / Bybit Now: absolute value only (reference points, no Δ%)
- **Spot price reference line** (vertical dashed)
- **Zero P&L reference line** (horizontal dashed)
- **Price range slider** — adjusts the X-axis window
- **H exponent slider** — tunes Polymarket time scaling (range 0.40–0.80, default 0.65)

---

## Architecture

```
src/
├── api/
│   ├── binance.ts            # Spot price from Binance API
│   ├── bybit.ts              # Bybit option chain (instruments + tickers)
│   ├── config.ts             # API base URLs
│   └── polymarket.ts         # Event fetch, slug parsing, auto-detection
├── components/
│   ├── SetupScreen.tsx        # URL input, Bybit expiry selector
│   ├── BybitOptionChain.tsx   # Bybit expiry selection UI
│   ├── PolymarketPanel.tsx    # Polymarket URL/event loading UI
│   ├── ChartScreen.tsx        # Strike tables, positions summary, chart integration
│   └── ProjectionChart.tsx    # Recharts chart: split lines, legend, tooltip, dual axes
├── hooks/
│   └── usePortfolioCurves.ts  # Memoized portfolio curve computation for all snapshots
├── pricing/
│   └── engine.ts              # normalCDF (A&S 26.2.17), BS call/put, binary/barrier
│                              #   pricing, IV solver (Brent's), smile interpolation,
│                              #   combined P&L curve, Bybit fee calculation
├── types/
│   └── index.ts               # TypeScript interfaces
└── App.tsx                    # Screen routing
worker/
└── src/index.ts               # Cloudflare Worker (CORS proxy for Polymarket API)
docs/
└── PRICING.md                 # Full mathematical documentation
```

---

## Tech Stack

- **React 19** + **TypeScript** + **Vite**
- **Material UI (MUI)** — components and dark theming
- **Recharts** — charting library
- **Cloudflare Workers** — CORS proxy for Polymarket API

---

## Development

```bash
npm install
npm run dev
```

Requires `VITE_WORKER_URL` environment variable pointing to the Cloudflare Worker proxy (see [`worker/README.md`](worker/README.md)).

The Bybit API is proxied through the local Vite dev server (`/api/bybit` → `https://api.bybit.com`). No additional secrets needed for Bybit.

## Deployment

Deployed to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`. Uses Node 22, `npm ci`, `npm run build`, and the `actions/deploy-pages` action.

The app version is injected at build time from `package.json` via Vite's `define` and displayed as a small version tag at the bottom of both screens.
