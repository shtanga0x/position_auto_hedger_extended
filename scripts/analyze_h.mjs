#!/usr/bin/env node
/**
 * H Exponent Analysis — find optimal time-scaling exponent for Polymarket pricing
 *
 * Tests which H produces the most stationary implied volatility across time.
 * A correct H = IV calibrated from market price doesn't drift systematically.
 *
 * Metrics:
 *   StdDev  — std dev of IV across time (lower = more stable; BIASED — see note)
 *   Trend   — dIV/d(tauDays); near-zero = model time-decay matches market
 *             Negative → IV rises near expiry → model decays too FAST → raise H
 *             Positive → IV falls near expiry → model decays too SLOW → lower H
 *   PredRMSE— out-of-sample: calibrate IV on early half, predict late half
 *
 * StdDev metric note: StdDev is biased toward low H (lower H → larger τ^H →
 *   lower calibrated IV → smaller absolute variance). Prefer PredRMSE for H selection.
 *
 * Usage:
 *   node scripts/analyze_h.mjs [slug] [days]           # single event
 *   node scripts/analyze_h.mjs --above [days]          # all Feb 13-24 above events
 *   node scripts/analyze_h.mjs --hit [days]            # monthly Jan+Feb hit events
 *   node scripts/analyze_h.mjs --weekly [days]         # Feb 2-8, 9-15, 16-22 weekly hit events
 *   node scripts/analyze_h.mjs --all [days]            # everything
 *
 * Requires: Node 18+ (uses global fetch)
 */

const GAMMA   = 'https://gamma-api.polymarket.com';
const CLOB    = 'https://clob.polymarket.com';
const BINANCE = 'https://api.binance.com';

const H_VALUES = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
const YEARS    = 365.25 * 24 * 3600;
const DELAY_MS = 250;

// Weekly 7-day hit events (two expired, one near end of life)
const WEEKLY_HIT_SLUGS = [
  'what-price-will-bitcoin-hit-february-2-8',
  'what-price-will-bitcoin-hit-february-9-15',
  'what-price-will-bitcoin-hit-february-16-22',
];

const ABOVE_SLUGS = [13,14,15,16,17,18,19,20,21,22,23,24]
  .map(n => `bitcoin-above-on-february-${n}`);

// Monthly hit events (multi-week; keep separate from weekly for comparison)
const MONTHLY_HIT_SLUGS = [
  'what-price-will-bitcoin-hit-in-january-2026',
  'what-price-will-bitcoin-hit-in-february-2026',
];

const HIT_SLUGS = [...MONTHLY_HIT_SLUGS, ...WEEKLY_HIT_SLUGS];

// ─── Math (identical to src/pricing/engine.ts) ───────────────────────────────

function normalCDF(x) {
  if (x > 8)  return 1;
  if (x < -8) return 0;
  if (x < 0)  return 1 - normalCDF(-x);
  const b1 =  0.319381530, b2 = -0.356563782, b3 = 1.781477937,
        b4 = -1.821255978, b5 =  1.330274429, p  = 0.2316419;
  const t = 1 / (1 + p * x);
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  return 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-x * x / 2) * poly;
}

function priceAbove(S, K, sigma, tau, H) {
  if (tau <= 0 || sigma <= 0) return S >= K ? 1 : 0;
  const tauH = Math.pow(tau, H);
  const d2 = (Math.log(S / K) - sigma * sigma * Math.pow(tau, 2 * H) / 2) / (sigma * tauH);
  return normalCDF(d2);
}

function priceHit(S, B, sigma, tau, isUp, H) {
  if (tau <= 0 || sigma <= 0) return isUp ? (S >= B ? 1 : 0) : (S <= B ? 1 : 0);
  if (isUp  && S >= B) return 1;
  if (!isUp && S <= B) return 1;
  const tauH = Math.pow(tau, H), tau2H = Math.pow(tau, 2 * H), s2 = sigma * sigma;
  if (isUp) {
    const d1 = (Math.log(S / B) - s2 * tau2H / 2) / (sigma * tauH);
    const d2 = (Math.log(S / B) + s2 * tau2H / 2) / (sigma * tauH);
    return Math.min(1, Math.max(0, normalCDF(d1) + (S / B) * normalCDF(d2)));
  } else {
    const e1 = (Math.log(B / S) + s2 * tau2H / 2) / (sigma * tauH);
    const e2 = (Math.log(B / S) - s2 * tau2H / 2) / (sigma * tauH);
    return Math.min(1, Math.max(0, normalCDF(e1) + (S / B) * normalCDF(e2)));
  }
}

function bisect(f, lo, hi, tol = 1e-6, maxIter = 100) {
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    if (hi - lo < tol) return mid;
    if (Math.sign(f(mid)) !== Math.sign(f(lo))) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

function solveIV(S, K, tau, yesPrice, type, isUp, H) {
  if (!isFinite(yesPrice) || yesPrice <= 0.005) return 0.01;
  if (yesPrice >= 0.995) return 10.0;
  if (tau <= 0) return null;
  const model = s => type === 'above' ? priceAbove(S, K, s, tau, H) : priceHit(S, K, s, tau, isUp, H);
  const f = s => model(s) - yesPrice;
  const fLo = f(0.01), fHi = f(10.0);
  if (Math.sign(fLo) === Math.sign(fHi)) {
    let prev = fLo, pS = 0.01;
    for (let s = 0.10; s <= 10.0; s += 0.10) {
      const curr = f(s);
      if (Math.sign(prev) !== Math.sign(curr)) return bisect(f, pS, s);
      prev = curr; pS = s;
    }
    return null;
  }
  return bisect(f, 0.01, 10.0);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

const mean   = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const rmse   = (pred, act) => Math.sqrt(mean(pred.map((p, i) => (p - act[i]) ** 2)));

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function linSlope(xs, ys) {
  if (xs.length < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseTs(raw) {
  if (typeof raw === 'string') return Math.floor(new Date(raw).getTime() / 1000);
  return Number(raw);
}

function parseStrike(title) {
  const n = parseFloat((title || '').replace(/[↑↓$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function detectType(event) {
  const slug = (event.series?.seriesSlug || event.slug || '').toLowerCase();
  if (slug.includes('hit') || slug.includes('reach')) return 'hit';
  if (slug.includes('above')) return 'above';
  for (const m of (event.markets || [])) {
    const q = (m.question || '').toLowerCase();
    if (q.includes('reach') || q.includes('hit')) return 'hit';
    if (q.includes('above')) return 'above';
  }
  return 'above';
}

function col(s, n, right = false) {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

// ─── H scan (core metric engine) ─────────────────────────────────────────────
// pts: array of { strike, tau, tauDays, spot, yesPrice }
// Returns array of per-H result objects.

function scanH(pts, optType, barrierDir, midTau) {
  const results = [];

  for (const H of H_VALUES) {
    const ivsByStrike  = new Map();
    const tausByStrike = new Map();

    for (const pt of pts) {
      const isUp = barrierDir.get(pt.strike) ?? (pt.strike > pt.spot);
      const iv = solveIV(pt.spot, pt.strike, pt.tau, pt.yesPrice, optType, isUp, H);
      if (iv == null || !isFinite(iv) || iv <= 0.01 || iv >= 9.9) continue;
      if (!ivsByStrike.has(pt.strike)) { ivsByStrike.set(pt.strike, []); tausByStrike.set(pt.strike, []); }
      ivsByStrike.get(pt.strike).push(iv);
      tausByStrike.get(pt.strike).push(pt.tauDays);
    }

    const strikeSDs = [], strikeTrends = [], allIvs = [];
    for (const [strike, ivs] of ivsByStrike) {
      const taus = tausByStrike.get(strike);
      if (ivs.length < 4) continue;
      strikeSDs.push(stdDev(ivs));
      strikeTrends.push(linSlope(taus, ivs));
      allIvs.push(...ivs);
    }

    // Prediction RMSE: calibrate from early portion (tau > midTau), predict late
    const meanIvByStrike = new Map();
    for (const [strike, ivs] of ivsByStrike) {
      const taus = tausByStrike.get(strike);
      const earlyIvs = ivs.filter((_, i) => taus[i] > midTau);
      if (earlyIvs.length > 0) meanIvByStrike.set(strike, mean(earlyIvs));
    }
    const predP = [], actP = [];
    for (const pt of pts.filter(p => p.tauDays <= midTau)) {
      const calibIv = meanIvByStrike.get(pt.strike);
      if (!calibIv) continue;
      const isUp = barrierDir.get(pt.strike) ?? (pt.strike > pt.spot);
      const pred = optType === 'above'
        ? priceAbove(pt.spot, pt.strike, calibIv, pt.tau, H)
        : priceHit(pt.spot, pt.strike, calibIv, pt.tau, isUp, H);
      if (!isFinite(pred)) continue;
      predP.push(pred); actP.push(pt.yesPrice);
    }

    results.push({
      H,
      n: strikeSDs.length,
      avgIv:    allIvs.length > 0 ? mean(allIvs) : null,
      avgSD:    strikeSDs.length > 0 ? mean(strikeSDs) : null,
      avgTrend: strikeTrends.length > 0 ? mean(strikeTrends) : null,
      predRmse: predP.length >= 5 ? rmse(predP, actP) : null,
      nPred:    predP.length,
    });
  }

  return results;
}

// ─── Print H table ────────────────────────────────────────────────────────────

function printHTable(results, label = '') {
  const valid    = results.filter(r => r.avgSD != null);
  if (valid.length === 0) { console.log('  (no valid results)'); return null; }

  const bestSD    = valid.reduce((b, r) => r.avgSD < b.avgSD ? r : b, valid[0]);
  const bestTrend = valid.reduce((b, r) => Math.abs(r.avgTrend) < Math.abs(b.avgTrend) ? r : b, valid[0]);
  const validPred = valid.filter(r => r.predRmse != null);
  const bestRmse  = validPred.length > 0
    ? validPred.reduce((b, r) => r.predRmse < b.predRmse ? r : b, validPred[0])
    : null;

  if (label) console.log(`\n${label}`);
  console.log(`${'─'.repeat(80)}`);
  console.log(col('H', 6) + col('AvgIV', 8) + col('StdDev↓', 10) + col('Trend/day', 13) + col('PredRMSE↓', 12) + 'Verdict');
  console.log('─'.repeat(80));

  for (const r of results) {
    if (r.avgSD == null) { console.log(`${r.H.toFixed(2).padEnd(6)} (no data)`); continue; }
    const marks = [];
    if (r.H === bestSD.H)               marks.push('★SD');
    if (r.H === bestTrend.H)            marks.push('★Trend');
    if (bestRmse && r.H === bestRmse.H) marks.push('★RMSE');
    if (r.H === 0.65 && marks.length === 0) marks.push('(app default)');
    const tStr = (r.avgTrend >= 0 ? '+' : '') + r.avgTrend.toFixed(4);
    const rStr = r.predRmse != null ? r.predRmse.toFixed(4) : '   n/a';
    console.log(
      col(r.H.toFixed(2), 6) + col(r.avgIv.toFixed(3), 8) +
      col(r.avgSD.toFixed(4), 10) + col(tStr, 13) +
      col(rStr, 12) + marks.join(' ')
    );
  }
  console.log('─'.repeat(80));
  console.log(`Best → StdDev:H=${bestSD.H}  Trend:H=${bestTrend.H}  RMSE:H=${bestRmse?.H ?? 'n/a'}`);
  return { bestSD, bestTrend, bestRmse };
}

// ─── Core analysis ────────────────────────────────────────────────────────────

async function analyzeEvent(slug, daysOverride, verbose = true) {
  if (verbose) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${slug}`);
    console.log(`${'═'.repeat(70)}\n`);
  } else {
    process.stdout.write(`  ${slug.padEnd(47)} `);
  }

  let event;
  try {
    event = await fetchJson(`${GAMMA}/events/slug/${slug}`);
  } catch (e) {
    if (!verbose) console.log(`FETCH ERROR: ${e.message}`);
    return null;
  }

  const expiry    = parseTs(event.endDate);
  const startDate = parseTs(event.startDate);
  const optType   = detectType(event);
  const nowTs     = Math.floor(Date.now() / 1000);
  const isLive    = expiry > nowTs;
  const eventDays = Math.min((expiry - startDate) / 86400, 30);
  const days      = daysOverride ?? Math.ceil(eventDays);
  const isWeekly  = days <= 8;  // weekly 7-day events get phase analysis

  if (verbose) {
    console.log(`Title:  ${event.title}`);
    console.log(`Type:   ${optType}`);
    console.log(`Expiry: ${new Date(expiry * 1000).toUTCString()}`);
    console.log(isLive
      ? `Status: LIVE (${((expiry - nowTs) / 86400).toFixed(1)}d remaining)`
      : `Status: EXPIRED (${((nowTs - expiry) / 86400).toFixed(1)}d ago)`);
  }

  const markets = (event.markets || [])
    .map(m => {
      const tids = JSON.parse(m.clobTokenIds || '[]');
      let mid = 0;
      try { mid = parseFloat(JSON.parse(m.outcomePrices)[0]); } catch {}
      return {
        id: m.id, title: m.groupItemTitle || m.question,
        strike: parseStrike(m.groupItemTitle || m.question),
        yesTokenId: tids[0], mid,
      };
    })
    .filter(m => m.strike > 0 && m.yesTokenId);

  if (verbose) console.log(`Markets: ${markets.length} strikes\n`);

  const winEnd   = Math.min(expiry, nowTs);
  const winStart = winEnd - days * 86400;
  const fidelity = days >= 2 ? 60 : 5;

  if (verbose) {
    console.log(`Window: ${new Date(winStart * 1000).toISOString().slice(0, 16)}Z → ` +
      `${new Date(winEnd * 1000).toISOString().slice(0, 16)}Z (fidelity: ${fidelity}min)`);
  }

  if (verbose) process.stdout.write('Fetching BTC spot... ');
  let klines;
  try {
    klines = await fetchJson(
      `${BINANCE}/api/v3/klines?symbol=BTCUSDT&interval=${fidelity >= 60 ? '1h' : '5m'}` +
      `&startTime=${winStart * 1000}&endTime=${winEnd * 1000}&limit=1000`
    );
  } catch (e) {
    if (!verbose) console.log(`BTC FETCH ERROR`);
    return null;
  }
  const btcMap = new Map();
  const fSec = fidelity * 60;
  for (const k of klines) {
    btcMap.set(Math.floor(k[0] / (fSec * 1000)) * fSec, parseFloat(k[4]));
  }
  if (verbose) console.log(`${btcMap.size} prices`);

  function lookupBtc(ts) {
    const h = Math.floor(ts / fSec) * fSec;
    return btcMap.get(h) ?? btcMap.get(h - fSec) ?? btcMap.get(h + fSec);
  }

  if (verbose) console.log('Fetching Polymarket price history...');
  const mktData = [];
  for (const m of markets) {
    await sleep(DELAY_MS);
    try {
      const url = `${CLOB}/prices-history?market=${m.yesTokenId}` +
        `&startTs=${winStart}&endTs=${winEnd}&fidelity=${fidelity}`;
      const data = await fetchJson(url);
      const hist = (data.history || []).filter(pt => pt.p > 0.01 && pt.p < 0.99);
      if (hist.length < 5) continue;
      mktData.push({ ...m, history: hist });
      if (verbose) console.log(`  ok    ${m.title}: ${hist.length} pts`);
    } catch (e) {
      if (verbose) console.log(`  error ${m.title}: ${e.message}`);
    }
  }

  if (mktData.length === 0) {
    if (verbose) console.log('\nNo usable market data.\n');
    else console.log('no usable data');
    return null;
  }

  const barrierDir = new Map();
  const dataset = [];

  for (const m of mktData) {
    const sorted = [...m.history].sort((a, b) => a.t - b.t);
    for (const pt of sorted) {
      const spot = lookupBtc(pt.t);
      if (!spot) continue;
      const tau = (expiry - pt.t) / YEARS;
      if (tau <= 0) continue;
      if (!barrierDir.has(m.strike)) {
        barrierDir.set(m.strike, m.strike > spot);
      }
      dataset.push({ strike: m.strike, tau, tauDays: tau * 365.25, spot, yesPrice: pt.p });
    }
  }

  if (dataset.length < 15) {
    if (verbose) console.log('\nInsufficient aligned data.\n');
    else console.log(`only ${dataset.length} pts`);
    return null;
  }

  const tauMin  = Math.min(...dataset.map(d => d.tauDays));
  const tauMax  = Math.max(...dataset.map(d => d.tauDays));
  const midTau  = (tauMin + tauMax) / 2;

  if (verbose) {
    const spotMin = Math.min(...dataset.map(d => d.spot));
    const spotMax = Math.max(...dataset.map(d => d.spot));
    console.log(`\nAligned: ${dataset.length} pts | tau: ${tauMin.toFixed(2)}-${tauMax.toFixed(2)}d` +
      ` | BTC: $${spotMin.toFixed(0)}-$${spotMax.toFixed(0)}`);
    console.log(`OOS split midpoint: ${midTau.toFixed(2)}d\n`);
  }

  // ── Full-window H scan ─────────────────────────────────────────────────────
  const results = scanH(dataset, optType, barrierDir, midTau);

  const valid   = results.filter(r => r.avgSD != null);
  if (valid.length === 0) {
    if (!verbose) console.log('no valid H results');
    return null;
  }
  const bestSD    = valid.reduce((b, r) => r.avgSD < b.avgSD ? r : b, valid[0]);
  const bestTrend = valid.reduce((b, r) => Math.abs(r.avgTrend) < Math.abs(b.avgTrend) ? r : b, valid[0]);
  const validPred = valid.filter(r => r.predRmse != null);
  const bestRmse  = validPred.length > 0
    ? validPred.reduce((b, r) => r.predRmse < b.predRmse ? r : b, validPred[0])
    : null;

  if (verbose) {
    console.log(`${'─'.repeat(80)}`);
    console.log(`IV Stability — ${optType.toUpperCase()} | ${mktData.length} strikes | ${dataset.length} pts`);
    printHTable(results, '── Full window ──');

    // Trend direction
    const trendAtBest = results.find(r => r.H === bestSD.H)?.avgTrend ?? 0;
    if (Math.abs(trendAtBest) < 0.003)
      console.log('Trend: ✓ IV stationary');
    else if (trendAtBest < 0)
      console.log(`Trend: IV rises near expiry → model decays too fast → raise H above ${bestSD.H}`);
    else
      console.log(`Trend: IV falls near expiry → model decays too slow → lower H below ${bestSD.H}`);

    // ── Phase analysis for weekly events ──────────────────────────────────
    if (isWeekly) {
      const phaseSplit = 3.5; // days
      const earlyPts = dataset.filter(d => d.tauDays > phaseSplit);
      const latePts  = dataset.filter(d => d.tauDays <= phaseSplit);

      console.log(`\n${'─'.repeat(80)}`);
      console.log(`Phase analysis: Early (tau > ${phaseSplit}d) vs Late (tau ≤ ${phaseSplit}d)`);
      console.log(`  Early: ${earlyPts.length} pts (days 7→3.5, start of week)`);
      console.log(`  Late:  ${latePts.length} pts (days 3.5→0, approaching expiry)`);

      if (earlyPts.length >= 15) {
        const earlyMid = (Math.min(...earlyPts.map(d => d.tauDays)) + Math.max(...earlyPts.map(d => d.tauDays))) / 2;
        printHTable(scanH(earlyPts, optType, barrierDir, earlyMid), `\n── Phase: EARLY (tau ${phaseSplit}–${tauMax.toFixed(1)}d) ──`);
      } else {
        console.log('\nEarly phase: insufficient data');
      }

      if (latePts.length >= 15) {
        const lateMid = (Math.min(...latePts.map(d => d.tauDays)) + Math.max(...latePts.map(d => d.tauDays))) / 2;
        printHTable(scanH(latePts, optType, barrierDir, lateMid), `\n── Phase: LATE (tau 0–${phaseSplit}d) ──`);
      } else {
        console.log('\nLate phase: insufficient data');
      }
    }

    // Per-strike table at best H
    console.log(`\nPer-strike at H=${bestSD.H}:`);
    console.log(col('Strike', 10) + col('Dir', 5) + col('AvgIV', 8) + col('SD', 8) + col('Trend', 10) + col('N', 5) + 'LatestP');
    console.log('─'.repeat(56));
    const psMap = new Map();
    for (const pt of dataset) {
      const isUp = barrierDir.get(pt.strike) ?? (pt.strike > pt.spot);
      const iv = solveIV(pt.spot, pt.strike, pt.tau, pt.yesPrice, optType, isUp, bestSD.H);
      if (iv == null || !isFinite(iv) || iv <= 0.01 || iv >= 9.9) continue;
      if (!psMap.has(pt.strike)) psMap.set(pt.strike, { ivs: [], taus: [], latest: pt.yesPrice });
      const s = psMap.get(pt.strike);
      s.ivs.push(iv); s.taus.push(pt.tauDays); s.latest = pt.yesPrice;
    }
    for (const [strike, s] of [...psMap.entries()].sort((a, b) => a[0] - b[0])) {
      if (s.ivs.length < 3) continue;
      const dir = barrierDir.get(strike) ? 'UP↑' : 'DN↓';
      const t = linSlope(s.taus, s.ivs);
      console.log(
        col(`$${strike}`, 10) + col(dir, 5) +
        col(mean(s.ivs).toFixed(3), 8) + col(stdDev(s.ivs).toFixed(4), 8) +
        col((t >= 0 ? '+' : '') + t.toFixed(4), 10) + col(s.ivs.length, 5) +
        (s.latest * 100).toFixed(1) + '%'
      );
    }
  } else {
    // Compact output for batch mode
    const trendStr = (bestSD.avgTrend >= 0 ? '+' : '') + bestSD.avgTrend.toFixed(3);
    const rmseStr  = bestRmse?.H?.toFixed(2) ?? 'n/a';
    console.log(
      `SD:${bestSD.H.toFixed(2)} RMSE:${rmseStr} Trend:${trendStr}` +
      ` [${tauMin.toFixed(1)}-${tauMax.toFixed(1)}d] ${mktData.length}strikes ${isLive ? 'LIVE' : 'exp'}`
    );
  }

  // Phase-specific best H for weekly events (used in cross-summary)
  let earlyBestRmse = null, lateBestRmse = null;
  if (isWeekly) {
    const phaseSplit = 3.5;
    const earlyPts = dataset.filter(d => d.tauDays > phaseSplit);
    const latePts  = dataset.filter(d => d.tauDays <= phaseSplit);
    if (earlyPts.length >= 15) {
      const earlyMid = (Math.min(...earlyPts.map(d => d.tauDays)) + Math.max(...earlyPts.map(d => d.tauDays))) / 2;
      const er = scanH(earlyPts, optType, barrierDir, earlyMid).filter(r => r.predRmse != null);
      if (er.length > 0) earlyBestRmse = er.reduce((b, r) => r.predRmse < b.predRmse ? r : b, er[0]).H;
    }
    if (latePts.length >= 15) {
      const lateMid = (Math.min(...latePts.map(d => d.tauDays)) + Math.max(...latePts.map(d => d.tauDays))) / 2;
      const lr = scanH(latePts, optType, barrierDir, lateMid).filter(r => r.predRmse != null);
      if (lr.length > 0) lateBestRmse = lr.reduce((b, r) => r.predRmse < b.predRmse ? r : b, lr[0]).H;
    }
  }

  return {
    slug, optType, isLive, isWeekly,
    tauMin, tauMax,
    nStrikes: mktData.length,
    nPts: dataset.length,
    bestSD:    bestSD.H,
    bestRmse:  bestRmse?.H ?? null,
    bestTrend: bestTrend.H,
    trendAtBestSD: bestSD.avgTrend,
    avgIvAtBestSD: bestSD.avgIv,
    sdAtBestSD:    bestSD.avgSD,
    rmseAt50:   results.find(r => r.H === 0.50)?.predRmse ?? null,
    rmseAt65:   results.find(r => r.H === 0.65)?.predRmse ?? null,
    earlyBestRmse,  // H best by RMSE in tau > 3.5d window
    lateBestRmse,   // H best by RMSE in tau <= 3.5d window
    results,
  };
}

// ─── Cross-event summary ──────────────────────────────────────────────────────

function printCrossSummary(allRes) {
  console.log('\n' + '═'.repeat(100));
  console.log('  CROSS-EVENT SUMMARY');
  console.log('═'.repeat(100));

  const above   = allRes.filter(r => r.optType === 'above');
  const hit     = allRes.filter(r => r.optType === 'hit');
  const weekly  = hit.filter(r => r.isWeekly);
  const monthly = hit.filter(r => !r.isWeekly);

  for (const [label, group] of [
    ['ABOVE (European binary, daily ~24h events)', above],
    ['HIT monthly (multi-week events)',            monthly],
    ['HIT weekly (7-day events)',                  weekly],
  ]) {
    if (group.length === 0) continue;
    const isWeeklyGroup = group.some(r => r.isWeekly);
    console.log(`\n── ${label} ──`);

    if (isWeeklyGroup) {
      // Extra columns for early/late phase
      console.log(
        col('Event (suffix)', 30) + col('τ range', 10) + col('H*(SD)', 8) + col('H*(RMSE)', 10) +
        col('H*(early)', 10) + col('H*(late)', 10) + col('RMSE@0.50', 10) + col('RMSE@0.65', 10) + 'Status'
      );
      console.log('─'.repeat(98));
      for (const r of group) {
        const suffix = r.slug.replace('what-price-will-bitcoin-hit-', '');
        const tauStr = `${r.tauMin.toFixed(1)}-${r.tauMax.toFixed(1)}d`;
        const r50 = r.rmseAt50 != null ? r.rmseAt50.toFixed(4) : '  n/a';
        const r65 = r.rmseAt65 != null ? r.rmseAt65.toFixed(4) : '  n/a';
        const eH  = r.earlyBestRmse != null ? r.earlyBestRmse.toFixed(2) : '  n/a';
        const lH  = r.lateBestRmse  != null ? r.lateBestRmse.toFixed(2)  : '  n/a';
        console.log(
          col(suffix, 30) + col(tauStr, 10) +
          col(r.bestSD.toFixed(2), 8) + col(r.bestRmse?.toFixed(2) ?? 'n/a', 10) +
          col(eH, 10) + col(lH, 10) + col(r50, 10) + col(r65, 10) +
          (r.isLive ? 'LIVE' : 'exp')
        );
      }
      const sdVals   = group.map(r => r.bestSD);
      const rmseVals = group.filter(r => r.bestRmse != null).map(r => r.bestRmse);
      const eVals    = group.filter(r => r.earlyBestRmse != null).map(r => r.earlyBestRmse);
      const lVals    = group.filter(r => r.lateBestRmse  != null).map(r => r.lateBestRmse);
      console.log('─'.repeat(98));
      console.log(
        `  Median: SD=${median(sdVals).toFixed(2)}  RMSE=${rmseVals.length>0?median(rmseVals).toFixed(2):'n/a'}  ` +
        `Early=${eVals.length>0?median(eVals).toFixed(2):'n/a'}  Late=${lVals.length>0?median(lVals).toFixed(2):'n/a'}`
      );
    } else {
      console.log(
        col('Event (suffix)', 38) + col('τ range', 12) + col('H*(SD)', 8) + col('H*(RMSE)', 10) +
        col('Trend@H*', 10) + col('RMSE@0.50', 11) + col('RMSE@0.65', 11) + 'Status'
      );
      console.log('─'.repeat(100));
      for (const r of group) {
        const tauStr = `${r.tauMin.toFixed(1)}-${r.tauMax.toFixed(1)}d`;
        const trend  = (r.trendAtBestSD >= 0 ? '+' : '') + r.trendAtBestSD.toFixed(3);
        const r50    = r.rmseAt50 != null ? r.rmseAt50.toFixed(4) : '   n/a';
        const r65    = r.rmseAt65 != null ? r.rmseAt65.toFixed(4) : '   n/a';
        const shortSlug = r.slug.length > 36 ? r.slug.slice(-36) : r.slug;
        console.log(
          col(shortSlug, 38) + col(tauStr, 12) +
          col(r.bestSD.toFixed(2), 8) + col(r.bestRmse?.toFixed(2) ?? 'n/a', 10) +
          col(trend, 10) + col(r50, 11) + col(r65, 11) +
          (r.isLive ? 'LIVE' : 'exp')
        );
      }
      const sdVals   = group.map(r => r.bestSD);
      const rmseVals = group.filter(r => r.bestRmse != null).map(r => r.bestRmse);
      console.log('─'.repeat(100));
      console.log(`  Median H* by StdDev: ${median(sdVals).toFixed(2)}  |  Median H* by RMSE: ${rmseVals.length > 0 ? median(rmseVals).toFixed(2) : 'n/a'}`);
    }
  }

  console.log('\nTrend direction guide:');
  console.log('  Negative → IV rises approaching expiry → model decays too FAST → raise H');
  console.log('  Positive → IV falls approaching expiry → model decays too SLOW → lower H');
  console.log('  Near zero → ✓ model time-decay matches market');
  console.log('  StdDev metric: biased toward H=0.40 (lower H → lower IV → lower variance). Use RMSE.\n');

  const allSD = allRes.map(r => r.bestSD);
  const allRM = allRes.filter(r => r.bestRmse != null).map(r => r.bestRmse);
  const earlyAll = allRes.filter(r => r.earlyBestRmse != null).map(r => r.earlyBestRmse);
  const lateAll  = allRes.filter(r => r.lateBestRmse  != null).map(r => r.lateBestRmse);
  console.log('Overall recommendation (all events):');
  console.log(`  Best H by OOS prediction (full):  median = ${allRM.length > 0 ? median(allRM).toFixed(2) : 'n/a'}`);
  if (earlyAll.length > 0) console.log(`  Best H by OOS prediction (early, tau>3.5d): median = ${median(earlyAll).toFixed(2)}`);
  if (lateAll.length  > 0) console.log(`  Best H by OOS prediction (late,  tau≤3.5d): median = ${median(lateAll).toFixed(2)}`);
  console.log(`  App current default: 0.65`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  console.log('\n' + '═'.repeat(70));
  console.log('   H EXPONENT ANALYSIS — Polymarket binary/barrier options');
  console.log('═'.repeat(70));

  if (mode === '--above' || mode === '--hit' || mode === '--weekly' || mode === '--all') {
    const daysArg = args[1] ? parseInt(args[1]) : undefined;
    const slugs = mode === '--above'  ? ABOVE_SLUGS
                : mode === '--hit'    ? HIT_SLUGS
                : mode === '--weekly' ? WEEKLY_HIT_SLUGS
                : [...ABOVE_SLUGS, ...HIT_SLUGS];

    console.log(`\nBatch mode: ${mode} | ${slugs.length} events | days=${daysArg ?? 'auto'}\n`);
    const allResults = [];

    for (const slug of slugs) {
      const res = await analyzeEvent(slug, daysArg, false);
      if (res) allResults.push(res);
      await sleep(500);
    }

    if (allResults.length > 0) printCrossSummary(allResults);
    return;
  }

  // Single event
  const slug = mode || null;
  const days = args[1] ? parseInt(args[1]) : undefined;

  if (slug && (slug.startsWith('what-price') || slug.startsWith('bitcoin-above'))) {
    await analyzeEvent(slug, days, true);
    return;
  }

  // Default: run weekly hit events (the new batch)
  console.log('\nNo args — running 3 weekly HIT events with phase analysis.\n');
  const allResults = [];
  for (const s of WEEKLY_HIT_SLUGS) {
    const r = await analyzeEvent(s, days, true);
    if (r) allResults.push(r);
    await sleep(500);
  }
  if (allResults.length > 0) printCrossSummary(allResults);
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
