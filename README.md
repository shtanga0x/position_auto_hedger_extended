# position_auto_hedger — Polymarket + Bybit 3-Leg Spread Optimizer

**Live:** [shtanga0x.github.io/position_auto_hedger](https://shtanga0x.github.io/position_auto_hedger/)

A browser-based optimization tool that finds the best **3-leg spread** to hedge each Polymarket crypto event strike:

1. **Poly NO** — buy the NO side of the Polymarket binary market
2. **Long Bybit option** — buy a CALL (up-barrier) or PUT (down-barrier) at any strike
3. **Short Bybit option** — sell a CALL/PUT at (or nearest to) the Polymarket strike, converting the unlimited option into a spread

The optimizer sizes the Poly NO position so the net position breaks even at the strike, then ranks all feasible 3-leg combinations by average P&L in ±1%, ±5%, ±20% ranges around the current spot price.

## How It Works

### 1. Setup

Load a **Polymarket event URL** (crypto above/hit type) and select a **Bybit expiry** from the option chain. Both are required.

The app auto-detects:
- **Cryptocurrency** (BTC, ETH, SOL, XRP)
- **Option type** (`above` = European binary, `hit` = one-touch barrier)
- **Strike prices** from each market's `groupItemTitle`
- **Current spot price** from Binance

### 2. Optimization

For each Polymarket strike the optimizer iterates all Bybit options of matching type and finds the best 3-leg spread.

#### Direction
- Strike > Spot → UP barrier → use **CALL** options
- Strike < Spot → DOWN barrier → use **PUT** options

#### Short Leg (Fixed)
The short leg is pinned to the Polymarket strike or the nearest valid Bybit strike:
- CALL (up-barrier): sell CALL at the **lowest available strike ≥ K_poly**
- PUT (down-barrier): sell PUT at the **highest available strike ≤ K_poly**

This converts unlimited option upside into a defined spread centred on `K_poly`.

#### Bybit Quantity
Fixed at **0.01 contracts** for both long and short legs.

#### Poly Quantity (Derived from Hedge Constraint)
The Poly NO position is sized so that at the Polymarket strike the combined net P&L of all three legs equals zero:

```
Poly loss (at strike) + Net option profit (at strike) = 0

polyQty = netOptionProfit_at_strike / noAskPrice

where:
  longProfitAtStrike  = (bsPrice(K_poly, K_long,  markIv_long,  τ_bybit_rem) − longAsk)  × 0.01 − longFee
  shortPnlAtStrike    = (shortBid − bsPrice(K_poly, K_short, markIv_short, τ_bybit_rem)) × 0.01 − shortFee
  netOptionProfit     = longProfitAtStrike + shortPnlAtStrike
  noAskPrice          = 1 − YES_bid   (cost to buy one NO token)
```

Only combinations where `netOptionProfit_at_strike > 0` are considered.

#### Evaluation Time
All three legs are evaluated at the **earlier of the two expiries**:
- `τ_eval = min(τ_poly, τ_bybit)`
- `τ_poly_rem = τ_poly − τ_eval`, `τ_bybit_rem = τ_bybit − τ_eval`

#### Feasibility Check
A combination is feasible only if the **combined 3-leg P&L is ≥ 0 at every point** in the ±20% range around spot. 200 evenly-spaced grid points are checked.

#### Scoring
Feasible combinations are ranked by mean 3-leg P&L in three ranges:

| Column | Range | Score |
|--------|-------|-------|
| Best ±1% | `[0.99×spot, 1.01×spot]` | Mean P&L |
| Best ±5% | `[0.95×spot, 1.05×spot]` | Mean P&L |
| Best ±20% | `[0.80×spot, 1.20×spot]` | Mean P&L |

### 3. Optimization Table

The second screen shows a 4-column table (Strike, Best ±1%, Best ±5%, Best ±20%). Each cell shows:
- **Long leg**: Bybit symbol — buy ×0.01 @ ask ($cost, fee)
- **Short leg**: Bybit symbol — sell ×0.01 @ bid ($received, fee)
- **Poly leg**: NO ×qty @ noAsk ($cost)
- **Avg ±N%**: mean combined P&L in the range

`—` is shown if no feasible 3-leg hedge exists for that range. All rows are shown even if IV calibration or short-leg selection failed — those appear as `—` across all columns.

Header chips show Polymarket and Bybit expiry times in **UTC+1** (e.g. `Poly exp: 28.02.2026 08:00`).

### 4. Snapshot Export

A **camera button** (green, top-right) appears when a visualization is active. Clicking it saves a 2× resolution screenshot of the selected 3-leg position card (long leg, short leg, Poly leg details + P&L chart) via `html2canvas`.

Filename format: `PolyAH_K{strike}_exp{expiry}_{YYYY-MM-DD_HH-MM}.jpg`
Example: `PolyAH_K95000_exp28Feb_2026-02-25_14-30.jpg`

### 5. Refresh Prices

A **↻ refresh button** (green, top-right) appears once a Polymarket event or Bybit chain is loaded. Clicking it re-fetches all live market data without changing the selected positions or sizes:

- **Spot price** — re-fetched from Binance
- **Polymarket prices** — re-fetched via the Cloudflare Worker proxy (fresh YES bid/ask per strike)
- **Bybit tickers** — cache cleared and re-fetched (fresh mark price, bid/ask, markIv per instrument)

After the refresh the optimizer reruns automatically and the table updates with the latest data. The button spins while the fetch is in progress.

### 6. P&L Visualization

Click the **chart icon** in any cell to render the combined 3-leg P&L chart:
- **Combined curves**: time snapshots (Now, ½ to earlier expiry, at earlier expiry, at later expiry)
- **Overlay curves**: Poly-only (blue) and Bybit spread-only (orange)
- **Green/red split**: positive P&L in green, negative in red
- **Dual Y-axes**: left = P&L ($), right = P&L (%)

### 7. Cost Breakdown & Margin

**Entry cost formula:**
```
Total entry cost = Σ (premium × qty) + Σ fees    (unsigned across buy and sell legs)
```
Fees are included in the denominator so tooltip percentages are consistent: a full loss at expiry always shows −100%.

**Position display in the visualization card:**
- Long Bybit leg: `{symbol} — buy ×{qty} @ ${price} (total: ${total}, fee: ${fee} / {fee%}%)`
- Short Bybit leg: `{symbol} — sell ×{qty} @ ${price} (total: ${total}, fee: ${fee} / {fee%}%)`

**Margin mode:** Bybit Portfolio Margin is used. Long and short legs offset each other at the portfolio level — no separate per-position initial margin is displayed.

### 8. Adaptive X-Axis Ticks

A `ResizeObserver` tracks the chart container width and targets ~11 major labeled ticks at 1100 px, scaling proportionally for other widths. Intervals are rounded to nice numbers (1, 2, 5, 10 × nearest power of 10).

### 9. Pricing Engine

- **Polymarket `hit` type**: one-touch barrier formula with auto-H time scaling
- **Bybit options**: standard Black-Scholes (`bsCallPrice` / `bsPutPrice`)
- **Auto-H schedule**: 10-step fixed function — H=0.70 at <1d, decreasing by 0.02/day, H=0.50 at ≥10d
- **IV smile**: sticky-moneyness interpolation for chart curves
- **Poly IV Multiplier**: purple slider (×0.25–×4.00, default ×1.00) scales all calibrated Polymarket IVs — models the leverage effect when spot moves away from the snapshot price

## What's New vs V4

| | V4 (2-leg) | V5 (3-leg) |
|---|---|---|
| Legs | Poly NO + Long Bybit | Poly NO + Long Bybit + Short Bybit at K_poly |
| Hedge P&L at strike | Long option profit | Net spread profit (long − short) |
| P&L profile | Unlimited upside | Defined spread; higher avg P&L near spot |
| Scoring ranges | ±5% / ±10% / ±20% | ±1% / ±5% / ±20% |
| Missing rows | Hidden | Shown as `—` |
| Expiry display | Date only | Date + time in UTC+1 |
| Snapshot export | ✗ | ✓ (JPG via html2canvas) |
| Adaptive X-axis ticks | ✗ | ✓ |
| Fee-inclusive entry cost (% denominator) | ✗ | ✓ |
| Long Option: clean cost display (no fee%) | ✗ | ✓ (v5.3.0) |
| Snapshot filename with strike + expiry + datetime | ✗ | ✓ (v5.3.1) |
| Refresh prices button (↻) | ✗ | ✓ (v5.3.1) |
| Poly IV multiplier slider + 10-step auto-H | ✗ | ✓ (v5.3.2) |

## Architecture

```
src/
├── api/
│   ├── binance.ts            # Spot price from Binance
│   ├── bybit.ts              # Bybit option chain + tickers
│   ├── config.ts             # API base URLs (worker proxy)
│   └── polymarket.ts         # Event fetch, strike/crypto/type detection
├── components/
│   ├── SetupScreen.tsx        # URL input + Bybit expiry selector
│   ├── OptimizationScreen.tsx # Table + chart visualization (3-leg)
│   ├── PolymarketPanel.tsx    # Polymarket URL input panel
│   ├── BybitOptionChain.tsx   # Bybit expiry selector
│   └── ProjectionChart.tsx   # Recharts chart
├── hooks/
│   └── usePortfolioCurves.ts  # Combined 3-leg P&L curves
├── optimization/
│   └── optimizer.ts           # Core 3-leg optimizer
├── pricing/
│   └── engine.ts              # Pricing math (shared with v2/v3/v4)
└── types/
    └── index.ts               # TypeScript interfaces
```

## Tech Stack

- **React 19** + **TypeScript** + **Vite**
- **Material UI (MUI)** — components and theming
- **Recharts** — chart rendering
- **Axios** — HTTP client
- **html2canvas** — DOM-to-JPG screenshot (lazy-imported)
- **Cloudflare Workers** — API proxy (CORS bypass for Polymarket)

## Development

```bash
npm install
npm run dev
```

Requires `VITE_WORKER_URL` environment variable pointing to the Cloudflare Worker proxy.

## Deployment

Deployed to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`.
