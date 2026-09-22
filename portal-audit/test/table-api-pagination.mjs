#!/usr/bin/env node
// Offline test for ReadOnlyTableApi pagination completeness and the
// concurrency cap.  Run from the skill directory:
//
//   node test/table-api-pagination.mjs
//
// No ServiceNow instance. A local http.Server stands in for the Table API and
// is scripted per test to fail on a chosen page, return short pages, or stall
// so concurrency can be observed. A real temp directory backs the disk cache.
//
// The contract under test is the one the whole skill rests on: several agents
// are told to "enumerate the small sets exhaustively", and they decide whether
// they managed it by reading `truncated` / `partial`. A pagination that dies on
// page 3 of 9 and reports complete gets its half-inventory written into the
// report as the whole truth. So:
//
//   - a genuinely complete fetch is NOT flagged partial;
//   - a mid-pagination failure IS flagged truncated AND partial, with
//     incompleteReason 'request-failed', and is never written to the cache;
//   - the maxRows ceiling is flagged too, with incompleteReason 'max-rows';
//   - a short page is not mistaken for the last page, and the next offset
//     advances by the rows actually received;
//   - SN_MAX_CONCURRENCY is enforced at the transport, not merely read.

import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReadOnlyTableApi } from '../lib/table-api.mjs';
import { Cache } from '../lib/cache.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Scriptable stand-in for /api/now/table/{table}.
//
// `plan` is set per test. It is handed the request's offset and limit and the
// running request count, and returns either { rows } or { status } to fail.
// ---------------------------------------------------------------------------
let plan = () => ({ rows: [] });
let requestLog = [];
let inFlight = 0;
let maxInFlight = 0;

const server = http.createServer(async (req, res) => {
  inFlight += 1;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  const url = new URL(req.url, 'http://127.0.0.1');
  const offset = Number(url.searchParams.get('sysparm_offset') ?? 0);
  const limit = Number(url.searchParams.get('sysparm_limit') ?? 0);
  requestLog.push({ pathname: url.pathname, offset, limit });
  const outcome = await plan({ offset, limit, index: requestLog.length - 1, pathname: url.pathname });
  inFlight -= 1;
  if (outcome.status && outcome.status >= 400) {
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'scripted failure' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ result: outcome.rows ?? [] }));
});

const rowsFrom = (start, count) => Array.from({ length: count }, (_, i) => ({ sys_id: `r${start + i}`, id: `p${start + i}` }));

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const tmp = await mkdtemp(path.join(tmpdir(), 'portal-audit-tableapi-'));

/** A fresh client with its own cache directory, so tests do not bleed. */
let clientSeq = 0;
function newApi(over = {}) {
  clientSeq += 1;
  requestLog = [];
  return new ReadOnlyTableApi({
    base,
    authHeader: 'Basic test',
    cache: over.cache === null ? null : new Cache(path.join(tmp, `cache-${clientSeq}`)),
    maxConcurrency: over.maxConcurrency ?? 8,
    timeoutMs: 5000,
  });
}

try {
  // -------------------------------------------------------------------
  // 1. Argument guards
  // -------------------------------------------------------------------
  {
    const api = newApi();
    let threw = null;
    await api.get('sp_page', {}).catch((e) => (threw = e));
    check('get() without fields throws', threw instanceof Error);
    check('the fields error names the discipline it enforces', /fields array/.test(threw?.message ?? ''), threw?.message);

    threw = null;
    await api.get('sp_page', { fields: ['sys_id'], limit: 1001 }).catch((e) => (threw = e));
    check('a page size above the 1000 cap throws', threw instanceof Error);
    check('the page-cap error names the cap', /1000/.test(threw?.message ?? ''), threw?.message);
  }

  // -------------------------------------------------------------------
  // 2. A genuinely complete fetch is not flagged partial
  // -------------------------------------------------------------------
  {
    plan = ({ offset }) => (offset >= 250 ? { rows: [] } : { rows: rowsFrom(offset, Math.min(100, 250 - offset)) });
    const api = newApi();
    const res = await api.get('sp_page', { fields: ['sys_id', 'id'], limit: 100, all: true });
    check('a complete fetch returns every row', res.rows.length === 250, `got ${res.rows.length}`);
    check('a complete fetch is not truncated', res.truncated === false);
    check('a complete fetch is not partial', res.partial === false);
    check('a complete fetch has no incompleteReason', res.incompleteReason === null, String(res.incompleteReason));
    check('a complete fetch reports the pages it took', res.pagesFetched === 4, `got ${res.pagesFetched}`);
    check('a complete fetch reports status 200', res.status === 200);
    check('a complete fetch carries no error', res.error === undefined);
  }

  // -------------------------------------------------------------------
  // 3. A single-page (all: false) read is complete by definition
  // -------------------------------------------------------------------
  {
    plan = ({ offset }) => ({ rows: rowsFrom(offset, 100) });
    const api = newApi();
    const res = await api.get('sp_widget', { fields: ['sys_id'], limit: 100 });
    check('a non-paginating read stops after one request', requestLog.length === 1, `${requestLog.length} requests`);
    check('a non-paginating read is not partial', res.partial === false && res.truncated === false);
  }

  // -------------------------------------------------------------------
  // 4. An empty table is complete, not partial
  // -------------------------------------------------------------------
  {
    plan = () => ({ rows: [] });
    const api = newApi();
    const res = await api.get('sp_instance', { fields: ['sys_id'], limit: 100, all: true });
    check('an empty table returns no rows', res.rows.length === 0);
    check('an empty table is not flagged partial', res.partial === false && res.truncated === false);
  }

  // -------------------------------------------------------------------
  // 5. THE REGRESSION: a failure partway through pagination
  // -------------------------------------------------------------------
  {
    // Three good pages of 100, then a 500 on the fourth. 300 of an unknown
    // larger total. Rows alone cannot tell this from a complete answer.
    plan = ({ index }) => (index < 3 ? { rows: rowsFrom(index * 100, 100) } : { status: 500 });
    const api = newApi();
    const res = await api.get('sp_page', { fields: ['sys_id', 'id'], limit: 100, all: true });
    check('a mid-pagination failure still returns the rows collected so far', res.rows.length === 300, `got ${res.rows.length}`);
    check('a mid-pagination failure is flagged truncated', res.truncated === true);
    check('a mid-pagination failure is flagged partial', res.partial === true);
    check(
      "a mid-pagination failure reports incompleteReason 'request-failed'",
      res.incompleteReason === 'request-failed',
      String(res.incompleteReason),
    );
    check('a mid-pagination failure surfaces the failing status', res.status === 500, String(res.status));
    check('a mid-pagination failure carries an error string', typeof res.error === 'string' && res.error.length > 0);
    check('a mid-pagination failure reports the pages that did succeed', res.pagesFetched === 3, String(res.pagesFetched));
    check('a mid-pagination failure is not reported as a cache hit', res.fromCache === false);

    // And it must never be persisted: a cached partial replays as fact.
    plan = ({ offset }) => (offset >= 500 ? { rows: [] } : { rows: rowsFrom(offset, 100) });
    const again = await api.get('sp_page', { fields: ['sys_id', 'id'], limit: 100, all: true });
    check('the failed fetch was not written to the cache', again.fromCache === false);
    check('re-running after the failure re-fetches and completes', again.rows.length === 500 && again.partial === false, `got ${again.rows.length}`);
  }

  // -------------------------------------------------------------------
  // 6. A refusal on the very first page
  // -------------------------------------------------------------------
  {
    plan = () => ({ status: 403 });
    const api = newApi();
    const res = await api.get('kb_knowledge', { fields: ['sys_id'], limit: 100, all: true });
    check('a 403 on page one returns no rows', res.rows.length === 0);
    check('a 403 is flagged partial, not reported as an empty table', res.partial === true && res.truncated === true);
    check('a 403 reports its status', res.status === 403, String(res.status));
    check("a 403 reports incompleteReason 'request-failed'", res.incompleteReason === 'request-failed');
    check('a 403 fetched zero pages', res.pagesFetched === 0, String(res.pagesFetched));
  }

  // -------------------------------------------------------------------
  // 7. The maxRows ceiling is a different kind of incomplete
  // -------------------------------------------------------------------
  {
    plan = ({ offset }) => ({ rows: rowsFrom(offset, 100) }); // endless table
    const api = newApi();
    const res = await api.get('sys_user', { fields: ['sys_id'], limit: 100, all: true, maxRows: 250 });
    check('the maxRows ceiling stops pagination', res.rows.length >= 250 && res.rows.length < 400, `got ${res.rows.length}`);
    check('hitting maxRows is flagged truncated', res.truncated === true);
    check('hitting maxRows is flagged partial', res.partial === true);
    check("hitting maxRows reports incompleteReason 'max-rows'", res.incompleteReason === 'max-rows', String(res.incompleteReason));
    check('hitting maxRows is distinguishable from a failure', res.error === undefined && res.status === 200);
  }

  // -------------------------------------------------------------------
  // 8. A short page is not the last page, and the offset follows the rows
  // -------------------------------------------------------------------
  {
    // Reproduces the live-instance behaviour recorded in lib/table-api.mjs:
    // sysparm_limit=100 returned 99 rows on page one with 98 more behind it.
    plan = ({ index }) => {
      if (index === 0) return { rows: rowsFrom(0, 99) };
      if (index === 1) return { rows: rowsFrom(99, 98) };
      return { rows: [] };
    };
    const api = newApi();
    const res = await api.get('sc_cat_item', { fields: ['sys_id'], limit: 100, all: true });
    check('a short page does not end pagination', res.rows.length === 197, `got ${res.rows.length}`);
    check('a short page does not make the result partial', res.partial === false && res.truncated === false);
    check('the second request offsets by the rows received, not the page size', requestLog[1]?.offset === 99, String(requestLog[1]?.offset));
    check('pagination continues to a genuinely empty page', requestLog.length === 3, `${requestLog.length} requests`);
    check('no rows are skipped by the short page', new Set(res.rows.map((r) => r.sys_id)).size === 197);
  }

  // -------------------------------------------------------------------
  // 9. Cache round-trip keeps the completeness flags honest
  // -------------------------------------------------------------------
  {
    plan = ({ offset }) => ({ rows: rowsFrom(offset, 100) });
    const cache = new Cache(path.join(tmp, 'cache-shared'));
    const writer = new ReadOnlyTableApi({ base, authHeader: 'Basic test', cache, maxConcurrency: 4 });
    requestLog = [];
    const fresh = await writer.get('sp_widget', { fields: ['sys_id'], limit: 100, all: true, maxRows: 200 });
    check('the seeding fetch hit the ceiling', fresh.truncated === true && fresh.fromCache === false);

    const reader = new ReadOnlyTableApi({ base, authHeader: 'Basic test', cache, maxConcurrency: 4 });
    const before = requestLog.length;
    const cached = await reader.get('sp_widget', { fields: ['sys_id'], limit: 100, all: true, maxRows: 200 });
    check('the second read is served from the cache', cached.fromCache === true);
    check('the cached read issues no new requests', requestLog.length === before, `${requestLog.length - before} extra`);
    check('the cached read returns the same rows', cached.rows.length === fresh.rows.length);
    check('a cached truncated result stays truncated', cached.truncated === true);
    check('a cached truncated result stays partial', cached.partial === true);
    check("a cached truncated result keeps incompleteReason 'max-rows'", cached.incompleteReason === 'max-rows');

    // A cache entry written before `partial` existed carries only `truncated`.
    const legacyCache = new Cache(path.join(tmp, 'cache-legacy'));
    const key = Cache.keyFor('table', 'sp_page', {
      fields: ['sys_id'],
      query: undefined,
      limit: 100,
      offset: 0,
      all: true,
      maxRows: 10000,
      displayValue: 'false',
      noDomain: false,
    });
    await legacyCache.write(key, { kind: 'table', table: 'sp_page', status: 200, truncated: true, rows: rowsFrom(0, 5) });
    const legacyApi = new ReadOnlyTableApi({ base, authHeader: 'Basic test', cache: legacyCache, maxConcurrency: 4 });
    const legacy = await legacyApi.get('sp_page', { fields: ['sys_id'], limit: 100, all: true });
    check('a legacy cache entry is read back', legacy.fromCache === true && legacy.rows.length === 5);
    check('a legacy entry derives partial from truncated rather than reporting undefined', legacy.partial === true);
    check('a legacy entry derives an incompleteReason', legacy.incompleteReason === 'max-rows', String(legacy.incompleteReason));
  }

  // -------------------------------------------------------------------
  // 10. The concurrency cap is enforced, not just configured
  // -------------------------------------------------------------------
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    plan = async ({ offset }) => {
      await sleep(40);
      return { rows: rowsFrom(offset, 10) };
    };

    maxInFlight = 0;
    const capped = newApi({ maxConcurrency: 2 });
    check('the client reports the cap it was given', capped.stats.maxConcurrency === 2, String(capped.stats.maxConcurrency));
    await Promise.all(Array.from({ length: 8 }, (_, i) => capped.get(`t_${i}`, { fields: ['sys_id'], limit: 10 })));
    check('no more than 2 requests are ever in flight under a cap of 2', maxInFlight <= 2, `observed ${maxInFlight}`);
    check('the cap was actually reached, so the check is not vacuous', maxInFlight === 2, `observed ${maxInFlight}`);
    check('all 8 requests still completed, so the gate releases', requestLog.length === 8, `${requestLog.length} requests`);
    check('the client counts what it queued behind the cap', capped.stats.queuedForConcurrency > 0, String(capped.stats.queuedForConcurrency));
    check('the client records its own peak concurrency', capped.stats.maxObservedConcurrency === 2, String(capped.stats.maxObservedConcurrency));
    check('the client counts its requests', capped.stats.requests === 8, String(capped.stats.requests));

    maxInFlight = 0;
    const serial = newApi({ maxConcurrency: 1 });
    await Promise.all(Array.from({ length: 4 }, (_, i) => serial.get(`s_${i}`, { fields: ['sys_id'], limit: 10 })));
    check('a cap of 1 serializes requests', maxInFlight === 1, `observed ${maxInFlight}`);
    check('a serialized run still completes every request', requestLog.length === 4, `${requestLog.length} requests`);

    maxInFlight = 0;
    const floored = newApi({ maxConcurrency: 0 });
    check('a cap of 0 floors to 1 rather than disabling the gate', floored.stats.maxConcurrency === 1, String(floored.stats.maxConcurrency));
    await Promise.all(Array.from({ length: 3 }, (_, i) => floored.get(`z_${i}`, { fields: ['sys_id'], limit: 10 })));
    check('a floored cap is enforced as 1', maxInFlight === 1, `observed ${maxInFlight}`);

    const nan = newApi({ maxConcurrency: Number.NaN });
    check('a non-numeric cap floors to 1 rather than NaN', nan.stats.maxConcurrency === 1, String(nan.stats.maxConcurrency));
  }
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write('\nFailures:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.exit(failed === 0 ? 0 : 1);
