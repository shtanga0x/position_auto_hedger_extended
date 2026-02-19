# Grapher V2 — Polymarket Crypto Options P&L Visualizer

**Live:** [shtanga0x.github.io/grapher_v2](https://shtanga0x.github.io/grapher_v2/)

A browser-based tool that takes a Polymarket crypto event URL and projects profit & loss curves across different underlying price levels and time horizons. It auto-detects the cryptocurrency and option type, calibrates implied volatility from live market prices, and renders interactive P&L charts.

## How It Works

### 1. Input & Detection

Paste a Polymarket event URL (e.g., `https://polymarket.com/event/bitcoin-above-100k-feb`). The app:

- **Extracts the slug** from the URL and fetches event data via the Polymarket Gamma API (proxied through a Cloudflare Worker to bypass CORS).
- **Auto-detects the cryptocurrency** (BTC, ETH, SOL, XRP) from the event's `series.cgAssetName`, series slug, or title keywords.
- **Auto-detects the option type** — `"above"` (European binary) or `"hit"` (one-touch barrier) — from series slug patterns (`hit`, `reach`, `dip` → hit; `above`, `strike` → above) and market question text.
- **Parses strike prices** from each market's `groupItemTitle` (e.g., `"↑$100,000"` → `100000`).
- **Fetches the current spot price** from Binance (`/api/v3/ticker/price`).

### 2. Strike Selection & Sides

Each market (strike) can be selected as **YES** or **NO**:

| Side | Entry Cost | Projected Value | Meaning |
|------|-----------|----------------|---------|
| YES  | Market YES price | Model YES price | Bet the condition will be met |
| NO   | 1 − YES price | 1 − Model YES price | Bet the condition won't be met |

Multiple strikes can be combined into a portfolio. The total entry cost is the sum of individual entry costs.

### 3. Pricing Engine

The core pricing lives in [`src/pricing/engine.ts`](src/pricing/engine.ts). Full mathematical details are in [`docs/PRICING.md`](docs/PRICING.md).

**Two option types:**

- **"Above" (European binary):** Pays $1 if the underlying is above the strike at expiry. Priced using the Black-Scholes d₂ formula with a generalized time-scaling exponent H.
- **"Hit" (one-touch barrier):** Pays $1 if the underlying touches the barrier at any point before expiry. Supports both UP barriers (price must rise) and DOWN barriers (price must drop). Direction is auto-detected: `strikePrice > spotPrice` → UP, otherwise DOWN.

**IV Calibration:** For each strike, implied volatility (IV) is solved from the live Polymarket YES price using Brent's root-finding method. This ensures the model reproduces the market's current price exactly.

### 4. Model Adjustments

Two adjustments improve accuracy over the standard Black-Scholes model for crypto markets:

#### Time-Scaling Exponent H

Standard Black-Scholes uses √τ for time scaling (H = 0.5), assuming Brownian motion. Crypto markets exhibit faster mean-reversion for near-ATM moves. Replacing τ^0.5 with τ^H where H > 0.5 makes convergence faster for ATM strikes while preserving OTM behavior. Controlled via the purple slider (range 0.40–0.80, default 0.50). See [`docs/PRICING.md`](docs/PRICING.md) for the modified equations.

#### IV Smile (Sticky-Moneyness Dynamics)

The basic model calibrates one fixed IV per strike and holds it constant when projecting at different spot levels (sticky-strike). In reality, when the spot price moves, the market reprices options based on their new moneyness — the IV smile "follows" the spot.

The IV smile is built from **all** available market strikes (not just selected ones):
1. Calibrate IV for each strike at the current spot → data points `(moneyness, IV)` where `moneyness = ln(S/K)`
2. Sort by moneyness and store as the smile curve
3. When projecting at a different spot S', compute new moneyness `ln(S'/K)` for each strike and linearly interpolate IV from the smile (flat extrapolation at edges)

This produces smoother, more realistic projection curves that better match observed market behavior, especially for short-dated options where the vol smile is steepest.

### 5. P&L Projection

Four curves are computed for the selected portfolio:

| Curve | Time to Expiry | Color |
|-------|---------------|-------|
| Now | Full τ | Yellowish-orange, dashed |
| 1/3 to expiry | τ × 2/3 | Green (P&L ≥ 0) / Red (P&L < 0) |
| 2/3 to expiry | τ × 1/3 | Green / Red |
| At expiry | τ = 0 | Green / Red (step function) |

**P&L** = Projected portfolio value − Total entry cost

The chart has dual Y-axes: left shows construction cost (P&L + entry cost), right shows P&L directly.

### 6. Chart Features

- **Custom X-axis ticks** with major/minor intervals scaled to the price range
- **Split green/red lines** for positive/negative P&L (with bridging at sign changes)
- **Interactive legend** — click to toggle curve visibility
- **Custom tooltip** showing crypto price (absolute + % change from spot), construction cost, P&L (absolute + % of entry)
- **Spot price reference line** (vertical dashed)
- **Zero P&L reference line** (horizontal dashed)

## Architecture

```
src/
├── api/
│   ├── binance.ts         # Spot price from Binance API
│   ├── config.ts          # API base URLs (worker proxy)
│   └── polymarket.ts      # Event fetch, slug parsing, crypto/option detection
├── components/
│   ├── FirstScreen.tsx     # URL input, validation, auto-detection
│   ├── SecondScreen.tsx    # Strike selection, IV calibration, sliders, chart
│   └── ProjectionChart.tsx # Recharts chart with custom tooltip, legend, dual axes
├── pricing/
│   └── engine.ts          # normalCDF, pricing functions, IV solver, P&L curves
├── types/
│   └── index.ts           # TypeScript interfaces
└── App.tsx                # Screen routing
worker/
└── src/index.ts           # Cloudflare Worker (CORS proxy for Polymarket API)
docs/
└── PRICING.md             # Full mathematical documentation
```

## Tech Stack

- **React 19** + **TypeScript** + **Vite**
- **Material UI (MUI)** — components and theming
- **Recharts** — charting library
- **Axios** — HTTP client
- **Cloudflare Workers** — API proxy (see [`worker/README.md`](worker/README.md))

## Development

```bash
npm install
npm run dev
```

Requires `VITE_WORKER_URL` environment variable pointing to the Cloudflare Worker proxy (see [`worker/README.md`](worker/README.md)).

## Deployment

Deployed to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`. Uses Node 22, `npm ci`, `npm run build`, and the `actions/deploy-pages` action.
