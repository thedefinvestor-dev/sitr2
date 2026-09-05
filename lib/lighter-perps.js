/**
 * Robinhood Chain (Lighter zkSync) perps adapter.
 * Public REST: https://api.rh.lighter.xyz
 * Docs: https://apidocs.rh.lighter.xyz
 *
 * Accounts bind to an EVM "L1 address" — the same 0x wallet used on HL/Nado
 * resolves the Lighter account publicly (no auth needed for state/positions).
 * Funding interval is hourly (per market fundings feed).
 */

const LIGHTER_API = 'https://api.rh.lighter.xyz';
const LIGHTER_FUNDING_INTERVAL_HOURS = 1;

function isEthAddress(v) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(v || '').trim());
}

async function lighterGet(path, params = {}, label = 'Lighter') {
  const url = new URL(`${LIGHTER_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) {
    const err = new Error(`${label} failed (${res.status}): ${(data && data.message) || text.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function lighterNum(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** All perp markets → { symbol: { marketId, markPx } } (public, no auth). */
async function fetchLighterMarkets() {
  const j = await lighterGet('/api/v1/orderBookDetails', { filter: 'perp' }, 'Lighter markets');
  const rows = Array.isArray(j?.order_book_details) ? j.order_book_details : [];
  const bySymbol = {};
  for (const m of rows) {
    const symbol = String(m.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    const markPx = lighterNum(m.mark_price, NaN);
    bySymbol[symbol] = {
      symbol,
      marketId: Number(m.market_id),
      markPx: Number.isFinite(markPx) && markPx > 0 ? markPx : null,
      status: m.status || null,
    };
  }
  return bySymbol;
}

/** Funding rates across venues; "lighter" rows are ours (rate is per interval). */
async function fetchLighterRates(bases = []) {
  const j = await lighterGet('/api/v1/funding-rates', {}, 'Lighter funding rates');
  const rows = Array.isArray(j?.funding_rates) ? j.funding_rates : [];
  const want = new Set((bases || []).map(s => String(s).toUpperCase()).filter(Boolean));
  const out = [];
  for (const row of rows) {
    if (row.exchange !== 'lighter') continue;
    const symbol = String(row.symbol || '').trim().toUpperCase();
    if (!symbol || (want.size && !want.has(symbol))) continue;
    const rate = lighterNum(row.rate, NaN);
    if (!Number.isFinite(rate)) continue;
    out.push({
      venue: 'lighter',
      symbol,
      fundingRateHourly: rate,
      fundingRate8h: rate * (8 / LIGHTER_FUNDING_INTERVAL_HOURS),
      fundingRateInterval: rate,
      fundingIntervalHours: LIGHTER_FUNDING_INTERVAL_HOURS,
    });
  }
  return out;
}

/** Account state + open positions by EVM L1 address (public read). */
async function fetchLighterState(authority) {
  const empty = {
    venue: 'lighter',
    wallet: authority || null,
    exists: false,
    configured: false,
    accountValue: 0,
    balance: 0,
    positions: [],
  };
  const wallet = String(authority || '').trim();
  if (!isEthAddress(wallet)) return empty;

  let markets;
  try {
    markets = await fetchLighterMarkets();
  } catch (e) {
    return { ...empty, configured: true, error: e.message };
  }

  let account;
  try {
    account = await lighterGet('/api/v1/account', {
      by: 'l1_address',
      value: wallet,
      active_only: 'true',
    }, 'Lighter account');
  } catch (e) {
    return { ...empty, configured: true, error: e.message };
  }
  const acc = Array.isArray(account?.accounts) ? account.accounts[0] : null;
  if (!acc) return { ...empty, configured: true, exists: false, fetchedAt: Date.now() };

  const positions = [];
  for (const row of acc.positions || []) {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    const size = lighterNum(row.position, 0) * (Number(row.sign) < 0 ? -1 : 1);
    if (!Number.isFinite(size) || Math.abs(size) < 1e-12) continue;
    const meta = markets[symbol] || {};
    positions.push({
      venue: 'lighter',
      symbol,
      size,
      side: size >= 0 ? 'long' : 'short',
      entryPx: lighterNum(row.avg_entry_price, NaN) || null,
      markPx: meta.markPx ?? null,
      liquidationPx: lighterNum(row.liquidation_price, NaN) || null,
      notional: Math.abs(lighterNum(row.position_value, NaN)) || null,
      unrealizedPnl: lighterNum(row.unrealized_pnl, NaN) || null,
      fundingSinceOpen: -lighterNum(row.total_funding_paid_out, 0), // API reports PAID OUT (positive = cost)
      leverage: null,
    });
  }

  const collateral = lighterNum(acc.collateral, NaN);
  const upnl = positions.reduce((s, p) => s + (Number(p.unrealizedPnl) || 0), 0);
  return {
    venue: 'lighter',
    wallet,
    accountIndex: acc.index ?? null,
    configured: true,
    exists: positions.length > 0 || (Number.isFinite(collateral) && collateral > 0),
    fetchedAt: Date.now(),
    accountValue: Number.isFinite(collateral) ? collateral + upnl : 0,
    balance: Number.isFinite(collateral) ? collateral : 0,
    unrealizedPnl: upnl,
    positions,
  };
}

/** Funding payment history per account. NOTE: Lighter requires an `auth`
 *  token for main accounts' funding history — public read-only callers get
 *  HTTP 400 "auth required". Returns an empty result with `authRequired` so
 *  the dashboard can degrade gracefully (live `fundingSinceOpen` still comes
 *  from the state endpoint's total_funding_paid_out). */
async function fetchLighterFunding(authority, days = 30, accountIndex = null, auth = null) {
  const empty = { venue: 'lighter', wallet: authority, days, payments: [], totalFunding: 0 };
  const wallet = String(authority || '').trim();
  if (!isEthAddress(wallet)) return empty;
  const windowStart = Date.now() - days * 86400000;

  let idx = accountIndex;
  if (idx == null) {
    try {
      const account = await lighterGet('/api/v1/account', { by: 'l1_address', value: wallet }, 'Lighter account');
      idx = Array.isArray(account?.accounts) ? account.accounts[0]?.index ?? null : null;
    } catch (e) {
      return { ...empty, error: e.message };
    }
  }
  if (idx == null) return empty;
  if (!auth) {
    return { ...empty, accountIndex: idx, authRequired: true, error: 'Lighter funding history requires an auth token (read-only API key)' };
  }

  const payments = [];
  let cursor = '';
  for (let page = 0; page < 40; page++) {
    let j;
    try {
      j = await lighterGet('/api/v1/positionFunding', {
        account_index: idx,
        limit: 100,
        start_timestamp: Math.floor(windowStart / 1000),
        ...(cursor ? { cursor } : {}),
      }, 'Lighter funding');
    } catch (e) {
      if (!payments.length) return { ...empty, error: e.message };
      break;
    }
    const rows = Array.isArray(j?.position_fundings) ? j.position_fundings : [];
    if (!rows.length) break;
    for (const row of rows) {
      const time = Number(row.timestamp) * 1000;
      if (!time || time < windowStart) continue;
      payments.push({
        venue: 'lighter',
        time,
        symbol: String(row.market_id ?? ''),
        usdc: -lighterNum(row.change, 0), // change > 0 = paid out by trader → cost (negative cashflow)
        size: lighterNum(row.position_size, null),
        fundingRate: lighterNum(row.rate, NaN) || null,
        intervalHours: LIGHTER_FUNDING_INTERVAL_HOURS,
      });
    }
    if (!j?.next_cursor) break;
    cursor = j.next_cursor;
  }

  payments.sort((a, b) => b.time - a.time);
  // Resolve market_ids → symbols once (funding rows carry market_id only).
  let markets = {};
  try { markets = await fetchLighterMarkets(); } catch (_) {}
  const idToSymbol = {};
  for (const [symbol, meta] of Object.entries(markets)) idToSymbol[meta.marketId] = symbol;
  for (const p of payments) {
    const n = Number(p.symbol);
    if (Number.isFinite(n) && idToSymbol[n]) p.symbol = idToSymbol[n];
  }
  const known = payments.filter(p => typeof p.symbol === 'string' && !/^\d+$/.test(p.symbol));
  return {
    venue: 'lighter',
    wallet,
    accountIndex: idx,
    days,
    payments: known,
    totalFunding: known.reduce((s, p) => s + p.usdc, 0),
  };
}

module.exports = {
  LIGHTER_API,
  LIGHTER_FUNDING_INTERVAL_HOURS,
  isEthAddress,
  fetchLighterMarkets,
  fetchLighterRates,
  fetchLighterState,
  fetchLighterFunding,
};
