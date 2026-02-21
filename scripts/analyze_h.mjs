#!/usr/bin/env node
/**
 * H Exponent Analysis — find optimal time-scaling exponent for Polymarket pricing
 *
 * Tests which H value produces the most stationary (stable) implied volatility
 * across a 1–7 day window before expiry.  A correct H means IV calibrated from
 * the market price does not drift systematically over time.
 *
 * Two metrics:
 *   1. IV StdDev   — lower = IV more stable over time
 *   2. IV Trend    — slope of IV vs. tau; near-zero = model time-decay matches market
 *   3. Pred RMSE   — out-of-sample: calibrate IV on early data, predict late prices
 *
 * Usage:
 *   node scripts/analyze_h.mjs [slug] [days]
 *
 * Examples:
 *   node scripts/analyze_h.mjs what-price-will-bitcoin-hit-in-january-2026 7
 *   node scripts/analyze_h.mjs what-price-will-bitcoin-hit-in-february-2026 7
 *
 * Requires: Node 18+ (uses global fetch)
 */

const GAMMA  = 'https://gamma-api.polymarket.com';
const CLOB   = 'https://clob.polymarket.com';
const BINANCE = 'https://api.binance.com';

const H_VALUES = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
const YEARS    = 365.25 * 24 * 3600;
const DELAY_MS = 300; // delay between CLOB requests (rate limiting)

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
const rmse   = (pred, actual) => Math.sqrt(mean(pred.map((p, i) => (p - actual[i]) ** 2)));

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
  const slug = (event.series?.seriesSlug || '').toLowerCase();
  if (slug.includes('hit') || slug.includes('reach')) return 'hit';
  if (slug.includes('above')) return 'above';
  for (const m of (event.markets || [])) {
    const q = (m.question || '').toLowerCase();
    if (q.includes('reach') || q.includes('hit')) return 'hit';
    if (q.includes('above')) return 'above';
  }
  return 'above';
}

function col(s, n) { return String(s).padEnd(n); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function analyzeEvent(slug, days) {
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`  ${slug}`);
  console.log(`${'═'.repeat(68)}\n`);

  // 1. Fetch event
  const event = await fetchJson(`${GAMMA}/events/slug/${slug}`);
  const expiry  = parseTs(event.endDate);
  const optType = detectType(event);
  const nowTs   = Math.floor(Date.now() / 1000);
  const isLive  = expiry > nowTs;

  console.log(`Title:  ${event.title}`);
  console.log(`Type:   ${optType}`);
  console.log(`Expiry: ${new Date(expiry * 1000).toUTCString()}`);
  console.log(isLive ? `Status: LIVE (${((expiry - nowTs) / 86400).toFixed(1)}d remaining)` : 'Status: EXPIRED');

  // 2. Parse markets
  const markets = (event.markets || [])
    .map(m => {
      const tids = JSON.parse(m.clobTokenIds || '[]');
      let mid = 0;
      try { mid = parseFloat(JSON.parse(m.outcomePrices)[0]); } catch {}
      return {
        id: m.id,
        title: m.groupItemTitle || m.question,
        strike: parseStrike(m.groupItemTitle || m.question),
        yesTokenId: tids[0],
        mid,
      };
    })
    .filter(m => m.strike > 0 && m.yesTokenId);

  console.log(`Markets: ${markets.length} strikes\n`);

  // 3. Time window
  const winEnd   = Math.min(expiry, nowTs);
  const winStart = winEnd - days * 86400;
  console.log(`Window: ${new Date(winStart * 1000).toISOString().slice(0, 16)}Z → ${new Date(winEnd * 1000).toISOString().slice(0, 16)}Z`);

  // 4. BTC spot (Binance 1h klines)
  process.stdout.write('Fetching BTC spot... ');
  const klines = await fetchJson(
    `${BINANCE}/api/v3/klines?symbol=BTCUSDT&interval=1h` +
    `&startTime=${winStart * 1000}&endTime=${winEnd * 1000}&limit=1000`
  );
  const btcHourly = new Map();
  for (const k of klines) {
    btcHourly.set(Math.floor(k[0] / 3600000) * 3600, parseFloat(k[4]));
  }
  console.log(`${btcHourly.size} hourly prices`);

  function lookupBtc(ts) {
    const h = Math.floor(ts / 3600) * 3600;
    return btcHourly.get(h) ?? btcHourly.get(h - 3600) ?? btcHourly.get(h + 3600);
  }

  // 5. Polymarket price history (CLOB, 1h fidelity)
  console.log('Fetching Polymarket price history...');
  const mktData = [];
  for (const m of markets) {
    await sleep(DELAY_MS);
    try {
      const url = `${CLOB}/prices-history?market=${m.yesTokenId}` +
        `&startTs=${winStart}&endTs=${winEnd}&fidelity=60`;
      const data = await fetchJson(url);
      const hist = (data.history || []).filter(pt => pt.p > 0.008 && pt.p < 0.992);
      if (hist.length < 5) {
        console.log(`  skip  ${m.title} (${hist.length} pts)`);
        continue;
      }
      mktData.push({ ...m, history: hist });
      console.log(`  ok    ${m.title}: ${hist.length} pts`);
    } catch (e) {
      console.log(`  error ${m.title}: ${e.message}`);
    }
  }

  if (mktData.length === 0) {
    console.log('\nNo usable data. CLOB history may not be available for this event yet.\n');
    return null;
  }

  // 6. Build aligned dataset
  // Determine isUpBarrier per strike from earliest available spot (furthest from expiry)
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
      dataset.push({
        strike: m.strike, title: m.title,
        tau, tauDays: tau * 365.25,
        spot, yesPrice: pt.p,
      });
    }
  }
  // Note: for live events the tau range will be >days (e.g. 8-15d for February with 7d history)
  // That is expected and valid — the analysis covers whatever tau range is available.

  if (dataset.length < 20) {
    console.log('\nInsufficient aligned data points.\n');
    return null;
  }

  const tauRange  = [Math.min(...dataset.map(d => d.tauDays)), Math.max(...dataset.map(d => d.tauDays))];
  const spotRange = [Math.min(...dataset.map(d => d.spot)),    Math.max(...dataset.map(d => d.spot))];
  console.log(`\nAligned: ${dataset.length} pts`);
  console.log(`Tau:     ${tauRange[0].toFixed(2)}d – ${tauRange[1].toFixed(2)}d`);
  console.log(`BTC:     $${spotRange[0].toFixed(0)} – $${spotRange[1].toFixed(0)}`);

  // Split: early (tau > midpoint) for calibration, late (tau < midpoint) for prediction test
  const midTau  = (tauRange[0] + tauRange[1]) / 2;
  const earlyPts = dataset.filter(d => d.tauDays > midTau);
  const latePts  = dataset.filter(d => d.tauDays <= midTau);
  console.log(`Split:   ${earlyPts.length} early / ${latePts.length} late pts (midpoint ${midTau.toFixed(2)}d)\n`);

  // 7. Compute metrics per H
  const results = [];

  for (const H of H_VALUES) {
    const ivsByStrike   = new Map();
    const tausByStrike  = new Map();

    // Full dataset: IV stability
    for (const pt of dataset) {
      const isUp = barrierDir.get(pt.strike) ?? (pt.strike > pt.spot);
      const iv = solveIV(pt.spot, pt.strike, pt.tau, pt.yesPrice, optType, isUp, H);
      if (iv == null || !isFinite(iv) || iv <= 0.01 || iv >= 9.9) continue;
      if (!ivsByStrike.has(pt.strike))  { ivsByStrike.set(pt.strike, []); tausByStrike.set(pt.strike, []); }
      ivsByStrike.get(pt.strike).push(iv);
      tausByStrike.get(pt.strike).push(pt.tauDays);
    }

    const strikeSDs = [], strikeTrends = [], allIvs = [];
    for (const [strike, ivs] of ivsByStrike) {
      const taus = tausByStrike.get(strike);
      if (ivs.length < 4) continue;
      strikeSDs.push(stdDev(ivs));
      strikeTrends.push(linSlope(taus, ivs)); // dIV/d(tau_days); +ve = IV rises as tau rises
      allIvs.push(...ivs);
    }

    // Prediction test: calibrate mean IV on early data, predict late prices
    const meanIvByStrike = new Map();
    for (const [strike, ivs] of ivsByStrike) {
      // Only use early-period IVs for calibration
      const earlyIvs = [];
      for (let i = 0; i < ivs.length; i++) {
        if (tausByStrike.get(strike)[i] > midTau) earlyIvs.push(ivs[i]);
      }
      if (earlyIvs.length > 0) meanIvByStrike.set(strike, mean(earlyIvs));
    }

    const predPrices = [], actualPrices = [];
    for (const pt of latePts) {
      const calibIv = meanIvByStrike.get(pt.strike);
      if (!calibIv) continue;
      const isUp = barrierDir.get(pt.strike) ?? (pt.strike > pt.spot);
      const pred = optType === 'above'
        ? priceAbove(pt.spot, pt.strike, calibIv, pt.tau, H)
        : priceHit(pt.spot, pt.strike, calibIv, pt.tau, isUp, H);
      if (!isFinite(pred)) continue;
      predPrices.push(pred);
      actualPrices.push(pt.yesPrice);
    }

    results.push({
      H,
      n: strikeSDs.length,
      avgIv:    allIvs.length > 0 ? mean(allIvs) : null,
      avgSD:    strikeSDs.length > 0 ? mean(strikeSDs) : null,
      avgTrend: strikeTrends.length > 0 ? mean(strikeTrends) : null,
      predRmse: predPrices.length >= 5 ? rmse(predPrices, actualPrices) : null,
      nPred:    predPrices.length,
    });
  }

  // 8. Print results
  const valid    = results.filter(r => r.avgSD != null);
  const bestSD   = valid.reduce((b, r) => r.avgSD < b.avgSD ? r : b, valid[0]);
  const bestTrend = valid.reduce((b, r) => Math.abs(r.avgTrend) < Math.abs(b.avgTrend) ? r : b, valid[0]);
  const validPred = valid.filter(r => r.predRmse != null);
  const bestRmse  = validPred.length > 0
    ? validPred.reduce((b, r) => r.predRmse < b.predRmse ? r : b, validPred[0])
    : null;

  console.log(`${'─'.repeat(80)}`);
  console.log(`IV Stability — ${optType.toUpperCase()} type | ${mktData.length} strikes`);
  console.log(`${'─'.repeat(80)}`);
  console.log(
    col('H', 6) +
    col('AvgIV', 8) +
    col('StdDev↓', 10) +
    col('Trend/day', 13) +
    col('PredRMSE↓', 12) +
    'Verdict'
  );
  console.log('─'.repeat(80));

  for (const r of results) {
    if (r.avgSD == null) { console.log(`${r.H.toFixed(2).padEnd(6)} (no data)`); continue; }

    const marks = [];
    if (r.H === bestSD.H)              marks.push('★StdDev');
    if (r.H === bestTrend.H)           marks.push('★Trend');
    if (bestRmse && r.H === bestRmse.H) marks.push('★RMSE');
    if (r.H === 0.65 && marks.length === 0) marks.push('(app default)');

    const trendStr = (r.avgTrend >= 0 ? '+' : '') + r.avgTrend.toFixed(4);
    const rmseStr  = r.predRmse != null ? r.predRmse.toFixed(4) : '  n/a';

    console.log(
      col(r.H.toFixed(2), 6) +
      col(r.avgIv.toFixed(3), 8) +
      col(r.avgSD.toFixed(4), 10) +
      col(trendStr, 13) +
      col(rmseStr, 12) +
      marks.join(' ')
    );
  }
  console.log('─'.repeat(80));

  const winners = [`Min StdDev → H=${bestSD.H}`, `Min |Trend| → H=${bestTrend.H}`];
  if (bestRmse) winners.push(`Min PredRMSE → H=${bestRmse.H}`);
  console.log('\nWinners: ' + winners.join('   |   '));

  // Trend direction advice
  // dIV/d(tauDays): tau rises = moving AWAY from expiry
  // Negative slope → IV is lower far from expiry, higher near expiry
  //   → model price decays too fast near expiry → raise H to slow decay
  // Positive slope → IV is higher far from expiry, lower near expiry
  //   → model price decays too slow near expiry → lower H to speed decay
  console.log('\nTrend/day interpretation (for min-StdDev H):');
  const trend = results.find(r => r.H === bestSD.H)?.avgTrend ?? 0;
  if (Math.abs(trend) < 0.005)
    console.log(`  ✓ IV stationary — model time-decay matches market at H=${bestSD.H}`);
  else if (trend < 0)
    console.log(`  IV higher near expiry → model decays too fast → try higher H (> ${bestSD.H})`);
  else
    console.log(`  IV lower near expiry → model decays too slow → try lower H (< ${bestSD.H})`);

  // Per-strike summary at best H
  console.log(`\nPer-strike at H=${bestSD.H}:`);
  console.log(col('Strike', 10) + col('Dir', 5) + col('AvgIV', 8) + col('SD', 8) + col('Trend', 10) + col('N', 5) + 'MidPrice');
  console.log('─'.repeat(58));

  const bestH = bestSD.H;
  const perStrike = new Map();
  for (const pt of dataset) {
    const isUp = barrierDir.get(pt.strike) ?? (pt.strike > pt.spot);
    const iv = solveIV(pt.spot, pt.strike, pt.tau, pt.yesPrice, optType, isUp, bestH);
    if (iv == null || !isFinite(iv) || iv <= 0.01 || iv >= 9.9) continue;
    if (!perStrike.has(pt.strike)) perStrike.set(pt.strike, { ivs: [], taus: [], title: pt.title, mids: [] });
    perStrike.get(pt.strike).ivs.push(iv);
    perStrike.get(pt.strike).taus.push(pt.tauDays);
    perStrike.get(pt.strike).mids.push(pt.yesPrice);
  }

  for (const [strike, s] of [...perStrike.entries()].sort((a, b) => a[0] - b[0])) {
    if (s.ivs.length < 3) continue;
    const dir = barrierDir.get(strike) ? 'UP↑' : 'DN↓';
    const t = linSlope(s.taus, s.ivs);
    const midNow = s.mids[s.mids.length - 1];
    console.log(
      col(`$${strike}`, 10) + col(dir, 5) +
      col(mean(s.ivs).toFixed(3), 8) + col(stdDev(s.ivs).toFixed(4), 8) +
      col((t >= 0 ? '+' : '') + t.toFixed(4), 10) +
      col(s.ivs.length, 5) +
      (midNow * 100).toFixed(1) + '%'
    );
  }

  return { bestH: bestSD.H, bestTrend: bestTrend.H, bestRmse: bestRmse?.H };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const slug = process.argv[2];
  const days = parseInt(process.argv[3] ?? '7', 10);

  console.log('\n' + '═'.repeat(68));
  console.log('   H EXPONENT ANALYSIS — Polymarket binary/barrier options');
  console.log('═'.repeat(68));
  console.log(`\nMetrics:`);
  console.log(`  StdDev  — std dev of IV across time (lower = more stable)`)
  console.log(`  Trend   — dIV/d(tauDays); near-zero = model time-decay matches market`);
  console.log(`  PredRMSE— out-of-sample: calibrate on early half, predict late half`);

  if (slug) {
    await analyzeEvent(slug, days);
  } else {
    // Run both events
    console.log('\nNo slug provided — running both January and February 2026 events.\n');

    const jan = await analyzeEvent('what-price-will-bitcoin-hit-in-january-2026', days);
    const feb = await analyzeEvent('what-price-will-bitcoin-hit-in-february-2026', days);

    console.log('\n' + '═'.repeat(68));
    console.log('  SUMMARY');
    console.log('═'.repeat(68));
    if (jan) console.log(`January  (expired): best H=${jan.bestH} (StdDev), ${jan.bestTrend} (Trend), ${jan.bestRmse ?? 'n/a'} (RMSE)`);
    if (feb) console.log(`February (live):    best H=${feb.bestH} (StdDev), ${feb.bestTrend} (Trend), ${feb.bestRmse ?? 'n/a'} (RMSE)`);
    if (jan && feb && jan.bestH === feb.bestH) {
      console.log(`\n✓ Both events agree: optimal H ≈ ${jan.bestH}`);
    } else if (jan && feb) {
      const avg = ((jan.bestH + feb.bestH) / 2).toFixed(2);
      console.log(`\nEvents disagree: ${jan.bestH} vs ${feb.bestH}. Midpoint = ${avg}`);
      console.log(`This suggests H is event/duration dependent — use the slider to tune per-event.`);
    }
    console.log('');
  }
}

main().catch(e => { console.error('\nFailed:', e.message, e.stack); process.exit(1); });
