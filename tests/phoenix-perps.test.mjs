/**
 * Phoenix Eternal perps integration checks.
 * Run: node tests/phoenix-perps.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isSolanaAddress,
  isUsablePhoenixWallet,
  phoenixHourlyRateFromPoint,
  phoenixQuoteLotsToUsd,
  phoenixPositionUnrealizedPnl,
  createTokenBucket,
  phoenixIsRateLimited,
  createPhoenixApi,
} = require('../lib/phoenix-perps.js');
const {
  buildPairedAnalysis,
  buildRateSpreadRows,
  computeCombinedNetDeposits,
  fetchPhoenixState,
  fetchPhoenixRates,
  fetchPhoenixFunding,
  fetchPhoenixFills,
  fetchPhoenixCapitalFlows,
} = require('../lib/perps.js');

function pass(name) {
  console.log(`PASS: ${name}`);
}

{
  assert.equal(isSolanaAddress('3ctHNWw9NtU2Vwnx2fAhLpcgHHqjEV4nY9BQvxSrtuFr'), true);
  assert.equal(isUsablePhoenixWallet('3ctHNWw9NtU2Vwnx2fAhLpcgHHqjEV4nY9BQvxSrtuFr'), false, 'demo authority must not be usable as user wallet');
  assert.equal(isSolanaAddress('0x1111111111111111111111111111111111111111'), false);
  assert.equal(isSolanaAddress(''), false);
  pass('isSolanaAddress');
}

{
  const fromAmt = phoenixHourlyRateFromPoint({
    fundingAmountPerUnit: '-0.0001',
    markPrice: '72.76',
  });
  assert.ok(Math.abs(fromAmt - (-0.0001 / 72.76)) < 1e-12);
  const fromPct = phoenixHourlyRateFromPoint({ fundingRatePercentage: '-0.000137' });
  assert.ok(Math.abs(fromPct - (-0.000137 / 100)) < 1e-15);
  assert.equal(phoenixQuoteLotsToUsd(25000000000), 25000);
  // virtualQuote + size*mark (not size*(mark-entry) which drifts with rounded entry)
  const upnl = phoenixPositionUnrealizedPnl({
    virtualQuoteLots: 52050407400,
    size: -714.24,
    markPx: 73.66,
    entryPx: 72.87,
  });
  assert.ok(Math.abs(upnl - (-560.511)) < 0.001);
  const naive = -714.24 * (73.66 - 72.87);
  assert.ok(Math.abs(naive - upnl) > 1, 'naive mark-entry must differ from Phoenix formula');
  // Missing quote lots must fall back to mark−entry (not treat lots as 0 → ±notional).
  const fallback = phoenixPositionUnrealizedPnl({
    virtualQuoteLots: null,
    size: -714.24,
    markPx: 73.66,
    entryPx: 72.87,
  });
  assert.ok(Math.abs(fallback - naive) < 1e-9, 'missing quote lots uses mark-entry fallback');
  const zeroLotsTrap = phoenixQuoteLotsToUsd(null) + (-714.24) * 73.66;
  assert.ok(Math.abs(zeroLotsTrap) > 1000, 'sanity: treating missing lots as 0 would yield large bogus uPNL');
  assert.ok(Math.abs(fallback) < 1000, 'fallback must not look like ±notional');
  pass('phoenix rate + quote lots + uPNL formula');
}

{
  const {
    phoenixTicksToUsd,
    phoenixTpslFromPositionRow,
  } = require('../lib/phoenix-perps.js');
  assert.equal(phoenixTicksToUsd(7488, 100), 74.88);
  const tpsl = phoenixTpslFromPositionRow({
    entryPriceTicks: '7000',
    entryPriceUsd: '70',
    takeProfitTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '8000' } }],
    stopLossTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '6000' } }],
  }, 100);
  assert.equal(tpsl.tpPx, 80);
  assert.equal(tpsl.slPx, 60);
  // Fallback from entry ticks when market tickSize missing.
  const fallback = phoenixTpslFromPositionRow({
    entryPriceTicks: '7000',
    entryPriceUsd: '70',
    takeProfitTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '7700' } }],
    stopLossTriggers: [],
  }, null);
  assert.equal(fallback.tpPx, 77);
  pass('phoenix TP/SL tick conversion');
}

{
  // VVV: the markets API tickSize (10) is NOT the price divisor — the entry-
  // derived divisor (entryPriceTicks / entryPriceUsd = 1000) must win, or the
  // TP/SL come out 100x too high (SL $2300 instead of $23).
  const { phoenixTpslFromPositionRow } = require('../lib/phoenix-perps.js');
  const tpsl = phoenixTpslFromPositionRow({
    entryPriceTicks: '14631',
    entryPriceUsd: '14.631',
    takeProfitTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '10890' } }],
    stopLossTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '23000' } }],
  }, 10);
  assert.ok(Math.abs(tpsl.slPx - 23) < 0.01, `VVV SL must be ~23 (got ${tpsl.slPx})`);
  assert.ok(Math.abs(tpsl.tpPx - 10.89) < 0.01, `VVV TP must be ~10.89 (got ${tpsl.tpPx})`);
  // MON: tickSize 1 but divisor 1,000,000 → TP $0.049, not 49000.
  const mon = phoenixTpslFromPositionRow({
    entryPriceTicks: '28404',
    entryPriceUsd: '0.028404',
    takeProfitTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '49000' } }],
    stopLossTriggers: [],
  }, 1);
  assert.ok(Math.abs(mon.tpPx - 0.049) < 0.001, `MON TP must be ~0.049 (got ${mon.tpPx})`);
  pass('phoenix TP/SL entry-derived divisor (VVV/MON 100x fix)');
}

{
  const rows = buildRateSpreadRows(
    ['SOL'],
    {},
    {},
    {},
    {},
    {},
    { SOL: { fundingRateHourly: 0.000001, fundingRate8h: 0.000008, markPx: 100 } },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phoenix8h, 0.000008);
  assert.equal(rows[0].phoenixHourly, 0.000001);
  pass('buildRateSpreadRows phoenix 8h');
}

{
  const arb = buildPairedAnalysis({
    hlState: {
      positions: [{
        venue: 'hyperliquid', symbol: 'SOL', size: 10, side: 'long',
        entryPx: 70, markPx: 72, notional: 720, unrealizedPnl: 20,
        cumFundingSinceOpen: 1,
      }],
    },
    nadoState: { positions: [] },
    phoenixState: {
      positions: [{
        venue: 'phoenix', symbol: 'SOL', size: -10, side: 'short',
        entryPx: 71, markPx: 72, notional: 720, unrealizedPnl: -10,
        fundingSinceOpen: 2,
      }],
    },
    hlFunding: { payments: [], totalFunding: 0 },
    nadoFunding: { payments: [], totalFunding: 0 },
    phoenixFunding: {
      payments: [{ venue: 'phoenix', symbol: 'SOL', time: Date.now() - 1000, usdc: 2 }],
      totalFunding: 2,
    },
    hlFills: { fills: [], totalFees: 0, totalRealized: 0 },
    nadoMatches: { matches: [], totalFees: 0, totalRealized: 0 },
    phoenixFills: { fills: [], totalFees: 0, totalRealized: 0 },
    spreadRows: [{
      symbol: 'SOL',
      hyperliquid8h: 0.0001,
      phoenix8h: -0.00005,
      spreadHlPhoenix8h: 0.00015,
    }],
    days: 30,
  });
  assert.equal(arb.paired.length, 1);
  assert.equal(arb.paired[0].pairType, 'hl_phoenix');
  assert.equal(arb.paired[0].pairLabel, 'HL + Phoenix');
  assert.equal(arb.unhedged.length, 0);
  pass('buildPairedAnalysis HL + Phoenix');
}

{
  // Ext 30 long + Phoenix 45 short (~33% mismatch) must pair as partial hedge, not two unhedged rows.
  const arb = buildPairedAnalysis({
    hlState: { positions: [] },
    nadoState: { positions: [] },
    extendedState: {
      positions: [{
        venue: 'extended', symbol: 'BNB', size: 30, side: 'long',
        entryPx: 580, markPx: 592.67, notional: 17780.27, unrealizedPnl: 212.43,
      }],
    },
    phoenixState: {
      positions: [{
        venue: 'phoenix', symbol: 'BNB', size: -45, side: 'short',
        entryPx: 590, markPx: 595.81, notional: 26811.45, unrealizedPnl: -331.67,
        fundingSinceOpen: 1.7,
      }],
    },
    hlFunding: { payments: [], totalFunding: 0 },
    nadoFunding: { payments: [], totalFunding: 0 },
    extendedFunding: { payments: [], totalFunding: 0 },
    phoenixFunding: { payments: [], totalFunding: 1.7 },
    hlFills: { fills: [], totalFees: 0, totalRealized: 0 },
    nadoMatches: { matches: [], totalFees: 0, totalRealized: 0 },
    extendedFills: { fills: [], totalFees: 0, totalRealized: 0 },
    phoenixFills: { fills: [], totalFees: 0, totalRealized: 0 },
    spreadRows: [{
      symbol: 'BNB',
      extended8h: 0.0001,
      phoenix8h: -0.00005,
      spreadExtendedPhoenix8h: 0.00015,
    }],
    days: 30,
  });
  assert.equal(arb.paired.length, 1, 'partial Ext+Phoenix must pair');
  assert.equal(arb.paired[0].pairType, 'extended_phoenix');
  assert.ok(arb.paired[0].alerts.includes('size_mismatch'), 'partial hedge must warn size mismatch');
  assert.ok(arb.paired[0].sizeMismatchPct > 25 && arb.paired[0].sizeMismatchPct <= 50);
  assert.equal(arb.unhedged.length, 0);
  pass('buildPairedAnalysis Extended + Phoenix partial hedge');
}

{
  // Pair-all: any two opposite legs pair regardless of mismatch (smaller leg is
  // fully consumed as a partial hedge; residual stays on the bigger leg). The
  // client then offers a Variational hedge for the residual — so a tiny leg is
  // no longer left "unhedged".
  const arb = buildPairedAnalysis({
    hlState: {
      positions: [{
        venue: 'hyperliquid', symbol: 'ETH', size: 10, side: 'long',
        entryPx: 3000, markPx: 3010, notional: 30100, unrealizedPnl: 100,
      }],
    },
    nadoState: { positions: [] },
    extendedState: {
      positions: [{
        venue: 'extended', symbol: 'ETH', size: -0.2, side: 'short',
        entryPx: 3000, markPx: 3010, notional: 602, unrealizedPnl: -2,
      }],
    },
    hlFunding: { payments: [], totalFunding: 0 },
    nadoFunding: { payments: [], totalFunding: 0 },
    extendedFunding: { payments: [], totalFunding: 0 },
    hlFills: { fills: [], totalFees: 0, totalRealized: 0 },
    nadoMatches: { matches: [], totalFees: 0, totalRealized: 0 },
    extendedFills: { fills: [], totalFees: 0, totalRealized: 0 },
    spreadRows: [{ symbol: 'ETH', hl8h: 0.0001, extended8h: -0.00005, spreadHlExtended8h: 0.00015 }],
    days: 30,
  });
  assert.equal(arb.paired.length, 1, 'opposite legs must pair even with 98% mismatch');
  assert.equal(arb.paired[0].pairType, 'hl_extended');
  assert.ok(arb.paired[0].alerts.includes('size_mismatch'), 'partial pair must flag size mismatch');
  assert.equal(arb.unhedged.length, 0);
  pass('buildPairedAnalysis pairs opposite legs regardless of mismatch');
}

{
  // User MON scenario: Nado small short × Phoenix large long must pair as a
  // nado_phoenix partial hedge (Nado fully consumed), leaving the Phoenix
  // residual in the pair — NOT an unhedged Nado row.
  const arb = buildPairedAnalysis({
    hlState: { positions: [] },
    nadoState: {
      positions: [{
        venue: 'nado', symbol: 'MON', size: -183900, side: 'short',
        entryPx: 0.026, markPx: 0.026, notional: 4781.4, unrealizedPnl: 0, fundingSinceOpen: 0,
      }],
    },
    phoenixState: {
      positions: [{
        venue: 'phoenix', symbol: 'MON', size: 1652170, side: 'long',
        entryPx: 0.026, markPx: 0.026, notional: 42956.42, unrealizedPnl: 0, fundingSinceOpen: 0,
      }],
    },
    hlFunding: { payments: [], totalFunding: 0 },
    nadoFunding: { payments: [], totalFunding: 0 },
    phoenixFunding: { payments: [], totalFunding: 0 },
    hlFills: { fills: [], totalFees: 0, totalRealized: 0 },
    nadoMatches: { matches: [], totalFees: 0, totalRealized: 0 },
    phoenixFills: { fills: [], totalFees: 0, totalRealized: 0 },
    spreadRows: [],
    days: 30,
  });
  assert.equal(arb.paired.length, 1, 'MON Nado×Phoenix must pair');
  assert.equal(arb.paired[0].pairType, 'nado_phoenix');
  assert.ok(arb.paired[0].alerts.includes('size_mismatch'));
  const nadoSize = Math.abs(arb.paired[0].crossLegA.venue === 'nado' ? arb.paired[0].crossLegA.size : arb.paired[0].crossLegB.size);
  const phxSize = Math.abs(arb.paired[0].crossLegA.venue === 'phoenix' ? arb.paired[0].crossLegA.size : arb.paired[0].crossLegB.size);
  assert.equal(nadoSize, 183900, 'smaller Nado leg fully consumed in the pair');
  assert.equal(phxSize, 1652170, 'bigger Phoenix leg keeps the residual in the pair');
  assert.equal(arb.unhedged.length, 0, 'Nado must not show as unhedged');
  pass('buildPairedAnalysis MON Nado×Phoenix partial pair');
}

{
  // User SKY scenario: Nado small long × HL large short pairs as hl_nado with
  // the residual (bigger minus smaller) available for a Variational hedge.
  const arb = buildPairedAnalysis({
    hlState: {
      positions: [{
        venue: 'hyperliquid', symbol: 'SKY', size: -601000, side: 'short',
        entryPx: 0.066, markPx: 0.066, notional: 39666, unrealizedPnl: 0, cumFundingSinceOpen: 0,
      }],
    },
    nadoState: {
      positions: [{
        venue: 'nado', symbol: 'SKY', size: 301000, side: 'long',
        entryPx: 0.066, markPx: 0.066, notional: 19866, unrealizedPnl: 0, fundingSinceOpen: 0,
      }],
    },
    hlFunding: { payments: [], totalFunding: 0 },
    nadoFunding: { payments: [], totalFunding: 0 },
    hlFills: { fills: [], totalFees: 0, totalRealized: 0 },
    nadoMatches: { matches: [], totalFees: 0, totalRealized: 0 },
    spreadRows: [],
    days: 30,
  });
  assert.equal(arb.paired.length, 1, 'SKY Nado×HL must pair');
  assert.equal(arb.paired[0].pairType, 'hl_nado');
  assert.equal(arb.paired[0].hlSize, -601000);
  assert.equal(arb.paired[0].nadoSize, 301000);
  assert.equal(arb.unhedged.length, 0);
  pass('buildPairedAnalysis SKY Nado×HL partial pair');
}

{
  const out = computeCombinedNetDeposits(
    { payments: [{ time: 1, usdc: 100, kind: 'deposit' }] },
    { payments: [] },
    null,
    null,
    { payments: [{ time: 2, usdc: 50, type: 'deposit' }] },
  );
  assert.equal(out.rawCombinedNetDeposits, 150);
  assert.equal(out.phoenixNetDeposits, 50);
  // New shape uses kind (matches HL/Nado/GRVT/Extended).
  const outKind = computeCombinedNetDeposits(
    { payments: [{ time: 1, usdc: 100, kind: 'deposit' }] },
    { payments: [] },
    null,
    null,
    { payments: [{ time: 2, usdc: 50, kind: 'deposit' }] },
  );
  assert.equal(outKind.phoenixNetDeposits, 50);
  pass('computeCombinedNetDeposits phoenix');
}

{
  // Rate limiter + 429 retry + funding-overview dedupe (mock transport, no network).
  assert.equal(phoenixIsRateLimited({ error: 'rate_limited' }, ''), true);
  assert.equal(phoenixIsRateLimited({}, 'rate_limited'), true);
  assert.equal(phoenixIsRateLimited({ error: 'unknown' }, ''), false);
  pass('phoenixIsRateLimited');

  const fast = createTokenBucket({ ratePerSec: 1000, burst: 1000 });
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 50 }, () => fast()));
  assert.ok(Date.now() - t0 < 500, 'high-rate bucket must not stall 50 acquires');
  const slow = createTokenBucket({ ratePerSec: 20, burst: 1 });
  const t1 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => slow()));
  const elapsed = Date.now() - t1;
  assert.ok(elapsed >= 150, `5 acquires at 20/s must take >=150ms (got ${elapsed}ms)`);
  pass('createTokenBucket');

  let calls = 0;
  const responses = [
    { status: 429, body: JSON.stringify({ error: 'rate_limited' }) },
    { status: 429, body: JSON.stringify({ error: 'rate_limited' }) },
    { status: 200, body: JSON.stringify({ series: [{ symbol: 'SOL-PERP', points: [{ fundingRatePercentage: '-0.000137', markPrice: '72' }] }] }) },
  ];
  const mockFetch = async () => {
    calls += 1;
    const next = responses.shift() || { status: 200, body: '{}' };
    return {
      ok: next.status < 300,
      status: next.status,
      headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? '0.01' : null) },
      text: async () => next.body,
    };
  };
  const api = createPhoenixApi({
    fetchWithTimeout: mockFetch,
    withTimeout: (p) => p,
    errorMessage: (e) => e?.message || String(e || ''),
    toBaseSymbol: (s) => String(s || '').toUpperCase().replace(/-PERP$/i, ''),
    timeoutMs: 5000,
  });
  const rates = await api.fetchPhoenixRates(['SOL']);
  assert.equal(rates.length, 1);
  assert.equal(rates[0].symbol, 'SOL');
  assert.equal(calls, 3, '429 must be retried until success');
  const again = await api.fetchPhoenixRates(['SOL']);
  assert.equal(again.length, 1);
  assert.equal(calls, 3, 'funding overview must be cached after first fetch');
  pass('phoenixGet 429 retry + funding overview cache');
}

{
  // Empty / invalid wallet soft-empty
  const empty = await fetchPhoenixState('');
  assert.equal(empty.configured, false);
  assert.equal(empty.positions.length, 0);

  const missing = await fetchPhoenixState('11111111111111111111111111111111');
  assert.equal(missing.configured, true);
  assert.equal(missing.exists, false);

  // Live trader smoke (public API) — compare state mapping to TraderView in lockstep.
  const auth = '3ctHNWw9NtU2Vwnx2fAhLpcgHHqjEV4nY9BQvxSrtuFr';
  const traderKey = 'AgjgbWKZBFau9zEAS4udhMvgEjVBHjGMkZj3TFaKfESD';
  const [state, rates, funding, fills, capital, view] = await Promise.all([
    fetchPhoenixState(auth),
    fetchPhoenixRates(['SOL', 'BTC']),
    fetchPhoenixFunding(auth, 7),
    fetchPhoenixFills(auth, 7),
    fetchPhoenixCapitalFlows(auth),
    fetch(`https://perp-api.phoenix.trade/v1/view/trader/${traderKey}`).then((r) => r.json()),
  ]);
  assert.equal(state.configured, true);
  assert.ok(Number.isFinite(state.accountValue));
  assert.ok(state.positions.some((p) => p.symbol === 'SOL'));
  const sol = state.positions.find((p) => p.symbol === 'SOL');
  assert.ok(sol && Number.isFinite(sol.unrealizedPnl));
  const viewUpnl = Number(view.positions?.[0]?.unrealizedPnl?.ui);
  const viewPortfolio = Number(view.portfolioValue?.ui);
  assert.ok(Number.isFinite(viewUpnl));
  assert.ok(Math.abs(sol.unrealizedPnl - viewUpnl) < 6, `uPNL ${sol.unrealizedPnl} vs view ${viewUpnl}`);
  assert.ok(Math.abs(state.accountValue - viewPortfolio) < 2, `equity ${state.accountValue} vs view ${viewPortfolio}`);
  assert.ok(rates.some((r) => r.symbol === 'SOL' && Number.isFinite(r.fundingRate8h)));
  assert.ok(Array.isArray(funding.payments));
  assert.ok(Array.isArray(fills.fills));
  assert.ok(capital.payments.some((p) => p.kind === 'deposit' && p.usdc > 0), 'Phoenix deposits must emit kind=deposit');
  assert.ok(capital.payments.every((p) => p.kind === 'deposit' || p.kind === 'withdraw'), 'Phoenix capital rows must use kind');
  pass('live Phoenix trader + rates smoke');
}

console.log('PASS: phoenix perps integration checks');
