#!/usr/bin/env node
/**
 * H Exponent Analysis — find optimal time-scaling exponent for Polymarket pricing
 *
 * Tests which H produces the most stationary implied volatility across time.
 * A correct H = IV calibrated from market price doesn't drift systematically.
 *
 * Metrics:
 *   StdDev  — std dev of IV across time (lower = more stable)
 *   Trend   — dIV/d(tauDays); near-zero = model time-decay matches market
 *             Negative → IV rises near expiry → model decays too FAST → raise H
 *             Positive → IV falls near expiry → model decays too SLOW → lower H
 *   PredRMSE— out-of-sample: calibrate IV on early half, predict late half
 *
 * Usage:
 *   node scripts/analyze_h.mjs [slug] [days]           # single event
 *   node scripts/analyze_h.mjs --above [days]          # all Feb 13-24 above events
 *   node scripts/analyze_h.mjs --hit [days]            # Jan + Feb hit events
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

const ABOVE_SLUGS = [13,14,15,16,17,18,19,20,21,22,23,24]
  .map(n => `bitcoin-above-on-february-${n}`);
const HIT_SLUGS = [
  'what-price-will-bitcoin-hit-in-january-2026',
  'what-price-will-bitcoin-hit-in-february-2026',
];

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

// ─── Core analysis ────────────────────────────────────────────────────────────

async function analyzeEvent(slug, daysOverride, verbose = true) {
  if (verbose) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${slug}`);
    console.log(`${'═'.repeat(70)}\n`);
  } else {
    process.stdout.write(`  ${slug.padEnd(45)} `);
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

  if (verbose) {
    console.log(`Title:  ${event.title}`);
    console.log(`Type:   ${optType}`);
    console.log(`Expiry: ${new Date(expiry * 1000).toUTCString()}`);
    console.log(isLive
      ? `Status: LIVE (${((expiry - nowTs) / 86400).toFixed(1)}d remaining)`
      : `Status: EXPIRED (${((nowTs - expiry) / 86400).toFixed(1)}d ago)`);
  }

  // Parse markets — "above" events have resolved strikes (price=0/1), filter later
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

  // Time window: go back `days` from min(expiry, now)
  const winEnd   = Math.min(expiry, nowTs);
  const winStart = winEnd - days * 86400;

  // Choose fidelity based on window length: 1h for >2 days, 5min for shorter
  const fidelity = days >= 2 ? 60 : 5;

  if (verbose) {
    console.log(`Window: ${new Date(winStart * 1000).toISOString().slice(0, 16)}Z → ` +
      `${new Date(winEnd * 1000).toISOString().slice(0, 16)}Z (fidelity: ${fidelity}min)`);
  }

  // BTC spot
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

  // Polymarket price history
  if (verbose) console.log('Fetching Polymarket price history...');
  const mktData = [];
  for (const m of markets) {
    await sleep(DELAY_MS);
    try {
      const url = `${CLOB}/prices-history?market=${m.yesTokenId}` +
        `&startTs=${winStart}&endTs=${winEnd}&fidelity=${fidelity}`;
      const data = await fetchJson(url);
      // For "above": filter aggressively — resolved markets spend most time at 0/1
      const hist = (data.history || []).filter(pt => pt.p > 0.01 && pt.p < 0.99);
      if (hist.length < 5) continue;
      mktData.push({ ...m, history: hist });
      if (verbose) console.log(`  ok    ${m.title}: ${hist.length} pts`);
    } catch (e) {
      if (verbose) console.log(`  error ${m.title}: ${e.message}`);
    }
  }

  if (mktData.length === 0) {
    if (verbose) console.log('\nNo usable market data (all strikes resolved at 0 or 1).\n');
    else console.log('no usable data');
    return null;
  }

  // Build aligned dataset
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
  const earlyPts = dataset.filter(d => d.tauDays > midTau);
  const latePts  = dataset.filter(d => d.tauDays <= midTau);

  if (verbose) {
    const spotMin = Math.min(...dataset.map(d => d.spot));
    const spotMax = Math.max(...dataset.map(d => d.spot));
    console.log(`\nAligned: ${dataset.length} pts | tau: ${tauMin.toFixed(2)}-${tauMax.toFixed(2)}d` +
      ` | BTC: $${spotMin.toFixed(0)}-$${spotMax.toFixed(0)}`);
    console.log(`Split: ${earlyPts.length} early / ${latePts.length} late (mid ${midTau.toFixed(2)}d)\n`);
  }

  // Compute metrics per H
  const results = [];

  for (const H of H_VALUES) {
    const ivsByStrike  = new Map();
    const tausByStrike = new Map();

    for (const pt of dataset) {
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

    // Prediction RMSE: calibrate from early, predict late
    const meanIvByStrike = new Map();
    for (const [strike, ivs] of ivsByStrike) {
      const earlyIvs = [];
      const taus = tausByStrike.get(strike);
      for (let i = 0; i < ivs.length; i++) {
        if (taus[i] > midTau) earlyIvs.push(ivs[i]);
      }
      if (earlyIvs.length > 0) meanIvByStrike.set(strike, mean(earlyIvs));
    }
    const predP = [], actP = [];
    for (const pt of latePts) {
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

  const valid    = results.filter(r => r.avgSD != null);
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
    console.log('─'.repeat(80));
    console.log(col('H', 6) + col('AvgIV', 8) + col('StdDev↓', 10) + col('Trend/day', 13) + col('PredRMSE↓', 12) + 'Verdict');
    console.log('─'.repeat(80));

    for (const r of results) {
      if (r.avgSD == null) { console.log(`${r.H.toFixed(2).padEnd(6)} (no data)`); continue; }
      const marks = [];
      if (r.H === bestSD.H)              marks.push('★SD');
      if (r.H === bestTrend.H)           marks.push('★Trend');
      if (bestRmse && r.H === bestRmse.H) marks.push('★RMSE');
      if (r.H === 0.65 && marks.length === 0) marks.push('(default)');
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

    // Trend direction
    const trendAtBest = results.find(r => r.H === bestSD.H)?.avgTrend ?? 0;
    if (Math.abs(trendAtBest) < 0.003)
      console.log('Trend: ✓ IV stationary');
    else if (trendAtBest < 0)
      console.log(`Trend: IV rises near expiry → model decays too fast → raise H above ${bestSD.H}`);
    else
      console.log(`Trend: IV falls near expiry → model decays too slow → lower H below ${bestSD.H}`);

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

  return {
    slug, optType, isLive,
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
    results,
  };
}

// ─── Cross-event summary ──────────────────────────────────────────────────────

function printCrossSummary(allRes) {
  console.log('\n' + '═'.repeat(90));
  console.log('  CROSS-EVENT SUMMARY');
  console.log('═'.repeat(90));

  // Separate by type
  const above = allRes.filter(r => r.optType === 'above');
  const hit   = allRes.filter(r => r.optType === 'hit');

  for (const [label, group] of [['ABOVE (European binary)', above], ['HIT (one-touch barrier)', hit]]) {
    if (group.length === 0) continue;
    console.log(`\n── ${label} ──`);
    console.log(
      col('Event', 38) + col('τ range', 12) + col('H*(SD)', 8) + col('H*(RMSE)', 10) +
      col('Trend@H*', 10) + col('RMSE H=0.50', 12) + col('RMSE H=0.65', 12) + 'Status'
    );
    console.log('─'.repeat(102));

    for (const r of group) {
      const tauStr = `${r.tauMin.toFixed(1)}-${r.tauMax.toFixed(1)}d`;
      const trend  = (r.trendAtBestSD >= 0 ? '+' : '') + r.trendAtBestSD.toFixed(3);
      const r50    = r.rmseAt50 != null ? r.rmseAt50.toFixed(4) : '   n/a';
      const r65    = r.rmseAt65 != null ? r.rmseAt65.toFixed(4) : '   n/a';
      console.log(
        col(r.slug.slice(-36), 38) + col(tauStr, 12) +
        col(r.bestSD.toFixed(2), 8) + col(r.bestRmse?.toFixed(2) ?? 'n/a', 10) +
        col(trend, 10) + col(r50, 12) + col(r65, 12) +
        (r.isLive ? 'LIVE' : 'exp')
      );
    }

    // Aggregate stats
    const sdVals   = group.map(r => r.bestSD);
    const rmseVals = group.filter(r => r.bestRmse != null).map(r => r.bestRmse);
    console.log('─'.repeat(102));
    console.log(`  Median H* by StdDev: ${median(sdVals).toFixed(2)}  |  Median H* by RMSE: ${rmseVals.length > 0 ? median(rmseVals).toFixed(2) : 'n/a'}`);
  }

  // Trend interpretation guide
  console.log('\nTrend direction guide:');
  console.log('  Negative → IV rises approaching expiry → model decays too FAST → raise H');
  console.log('  Positive → IV falls approaching expiry → model decays too SLOW → lower H');
  console.log('  Near zero → ✓ model time-decay matches market\n');

  // H recommendation
  const allSD = allRes.map(r => r.bestSD);
  const allRM = allRes.filter(r => r.bestRmse != null).map(r => r.bestRmse);
  console.log('Overall recommendation across all events:');
  console.log(`  Best H by StdDev stability: median = ${median(allSD).toFixed(2)}`);
  if (allRM.length > 0) console.log(`  Best H by OOS prediction:   median = ${median(allRM).toFixed(2)}`);
  console.log(`  App current default: 0.65`);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  console.log('\n' + '═'.repeat(70));
  console.log('   H EXPONENT ANALYSIS — Polymarket binary/barrier options');
  console.log('═'.repeat(70));

  // Batch modes
  if (mode === '--above' || mode === '--hit' || mode === '--all') {
    const daysArg = args[1] ? parseInt(args[1]) : undefined;
    const slugs = mode === '--above' ? ABOVE_SLUGS
                : mode === '--hit'   ? HIT_SLUGS
                : [...ABOVE_SLUGS, ...HIT_SLUGS];

    console.log(`\nBatch mode: ${mode} | ${slugs.length} events | days=${daysArg ?? 'auto'}\n`);
    const allResults = [];

    for (const slug of slugs) {
      const res = await analyzeEvent(slug, daysArg, false);  // compact output
      if (res) allResults.push(res);
      await sleep(500);
    }

    if (allResults.length > 0) printCrossSummary(allResults);
    return;
  }

  // Single event (or default hit pair)
  if (!mode || mode.startsWith('what-price') || mode.startsWith('bitcoin-above')) {
    const slug = mode || null;
    const days = args[1] ? parseInt(args[1]) : 7;

    if (slug) {
      await analyzeEvent(slug, days, true);
    } else {
      // Default: run both hit events
      console.log('\nNo args — running January & February hit events.\n');
      const allResults = [];
      for (const s of HIT_SLUGS) {
        const r = await analyzeEvent(s, days, true);
        if (r) allResults.push(r);
      }
      if (allResults.length > 1) printCrossSummary(allResults);
    }
    return;
  }

  console.log(`\nUsage: node scripts/analyze_h.mjs [slug|--above|--hit|--all] [days]`);
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
