# Grapher V4 — Polymarket + Bybit Options Optimizer

**Live:** [shtanga0x.github.io/grapher_v4](https://shtanga0x.github.io/grapher_v4/)

A browser-based optimization tool that automatically finds the best Bybit vanilla option to hedge each Polymarket crypto event strike. It constructs a combined position where the Bybit option profit at the Polymarket strike offsets the Polymarket loss, then ranks all feasible hedges by average P&L in ±5%, ±10%, ±20% ranges.

## How It Works

### 1. Setup

Load a **Polymarket event URL** (crypto above/hit type) and select a **Bybit expiry** from the option chain. Both are required for the optimizer.

The app auto-detects:
- **Cryptocurrency** (BTC, ETH, SOL, XRP)
- **Option type** (`above` = European binary, `hit` = one-touch barrier)
- **Strike prices** from each market's `groupItemTitle`
- **Current spot price** from Binance

### 2. Optimization

For each Polymarket strike, the optimizer searches all matching Bybit options and finds the best hedge:

#### Direction
- Strike > Spot → UP barrier → hedge with **CALL** options
- Strike < Spot → DOWN barrier → hedge with **PUT** options

#### Bybit Quantity
Fixed at **0.01 contracts** per hedge.

#### Poly Quantity (Derived from Hedge Constraint)
The Polymarket position (NO side) is sized so that at the strike price:

```
Poly loss (at strike) + Bybit profit (at strike) = 0

polyQty = bybitProfit_at_strike / noAskPrice

where:
  bybitProfit_at_strike = (bsPrice(K_poly, K_bybit, markIv, τ_bybit_rem) - bybitAsk) × 0.01 − fee
  noAskPrice = 1 − YES_bid  (cost to buy NO at market)
```

When the Polymarket barrier is hit (spot reaches `K_poly`), the NO position goes to zero — the loss is exactly offset by the Bybit option profit.

#### Evaluation Time
Both positions are evaluated at the **earlier of the two expiries**:
- `τ_eval = min(τ_poly, τ_bybit)`
- At evaluation: `τ_poly_rem = τ_poly − τ_eval`, `τ_bybit_rem = τ_bybit − τ_eval`
- One of these will be zero (the position at its expiry)

#### Feasibility Check
A combination is feasible only if the combined P&L is **non-negative at every price point** in the ±20% range around the Polymarket strike. 200 evenly-spaced grid points are checked.

#### Scoring
Feasible options are ranked by average combined P&L in three ranges:
| Column | Range | Score |
|--------|-------|-------|
| Best ±5% | `[0.95K, 1.05K]` | Mean P&L in range |
| Best ±10% | `[0.90K, 1.10K]` | Mean P&L in range |
| Best ±20% | `[0.80K, 1.20K]` | Mean P&L in range |

### 3. Optimization Table

The second screen shows a 4-column table:

| Poly Strike | Best ±5% | Best ±10% | Best ±20% |
|-------------|----------|-----------|-----------|
| ↑ $100,000 — NO ask: 0.9840 | BTC-27FEB26-95000-C — buy ×0.01 @ $205 ($2.05, fee: $0.14) / Poly: NO ×2.35 @ 0.984 ($2.31) / Avg ±5%: +$0.42 | ... | ... |

The `—` symbol is shown if no feasible hedge exists for that range.

### 4. P&L Visualization

Click the **chart icon** in any cell to render the combined P&L chart for that pair:
- **Combined curves**: 4 time snapshots (Now, ½ to earlier expiry, at earlier expiry, at later expiry)
- **Overlay curves**: Polymarket-only (blue) and Bybit-only (orange)
- **Green/red split**: positive P&L in green, negative in red
- **Dual Y-axes**: left = P&L ($), right = P&L (%)

### 5. Pricing Engine

Uses the same engine as Grapher V2 and V3:

- **Polymarket `hit` type**: one-touch barrier formula with auto-H time scaling
- **Bybit options**: standard Black-Scholes (`bsCallPrice` / `bsPutPrice`)
- **Auto-H tiers**: τ > 7d → H=0.50, 3–7d → H=0.60, ≤3d → H=0.65
- **IV smile**: sticky-moneyness interpolation for chart curves

## Architecture

```
src/
├── api/
│   ├── binance.ts           # Spot price from Binance
│   ├── bybit.ts             # Bybit option chain + tickers
│   ├── config.ts            # API base URLs (worker proxy)
│   └── polymarket.ts        # Event fetch, strike/crypto/type detection
├── components/
│   ├── SetupScreen.tsx       # URL input + Bybit expiry selector
│   ├── OptimizationScreen.tsx # Table + chart visualization
│   ├── PolymarketPanel.tsx   # Polymarket URL input panel
│   ├── BybitOptionChain.tsx  # Bybit expiry selector
│   └── ProjectionChart.tsx  # Recharts chart (shared with v3)
├── hooks/
│   └── usePortfolioCurves.ts # Combined P&L curves (shared with v3)
├── optimization/
│   └── optimizer.ts          # Core optimization engine
├── pricing/
│   └── engine.ts             # Pricing math (shared with v2/v3)
└── types/
    └── index.ts              # TypeScript interfaces (+ OptMatchResult, StrikeOptResult)
```

## Tech Stack

- **React 19** + **TypeScript** + **Vite**
- **Material UI (MUI)** — components and theming
- **Recharts** — chart rendering
- **Axios** — HTTP client
- **Cloudflare Workers** — API proxy (CORS bypass for Polymarket)

## Development

```bash
npm install
npm run dev
```

Requires `VITE_WORKER_URL` environment variable pointing to the Cloudflare Worker proxy.

## Deployment

Deployed to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`.
