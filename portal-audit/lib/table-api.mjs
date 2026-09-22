// Read-only ServiceNow Table API client.
//
// READ-ONLY BY CONSTRUCTION. This class exposes exactly two public methods:
//
//    get(table, options)     reads records   -> GET /api/now/table/{table}
//    count(table, options)   reads counts    -> GET /api/now/stats/{table}
//
// There is no create, update, patch, put, post, delete or generic request
// method on this class, and there is no way to reach one. The single transport
// (#request) is a private field, hardcodes `method: 'GET'`, and refuses any URL
// outside the two read endpoints above. Adding a write method here would be a
// violation of reference/13-data-access.md, not a feature.
//
// The narrow, operator-declared write exception is deliberately NOT implemented
// here. It lives in lib/write-exception.mjs, is built per run against one named
// target, and is logged. See reference/13-data-access.md.

import { Cache } from './cache.mjs';
import { maxConcurrencyFromEnv } from './config.mjs';

const TABLE_ENDPOINT = '/api/now/table/';
const STATS_ENDPOINT = '/api/now/stats/';
const MAX_PAGE = 1000;

/**
 * A counting semaphore: at most `limit` holders at once, FIFO for the rest.
 *
 * This is where the SN_MAX_CONCURRENCY cap documented in lib/config.mjs and
 * reference/13-data-access.md is actually enforced. It used to be enforced
 * nowhere at all -- `maxConcurrency` was read out of the environment, put on
 * the config object, and never referenced again anywhere in bin/ or lib/, so
 * the load-discipline knob an operator turns down to be polite to a shared
 * non-production instance did nothing. lib/crawl.mjs fans out with
 * Promise.all across tabs, and sub-agents hold their own clients, so the
 * unbounded case was reachable, not hypothetical.
 *
 * @param {number} limit
 */
function createRequestGate(limit) {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  let active = 0;
  const waiting = [];
  const releaseOne = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    get active() {
      return active;
    },
    get limit() {
      return max;
    },
    /** @returns {Promise<() => void>} release, safe to call more than once */
    async acquire() {
      if (active < max) active += 1;
      else await new Promise((resolve) => waiting.push(resolve));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseOne();
      };
    },
  };
}

export class ReadOnlyTableApi {
  #base;
  #authHeader;
  #sessionAuth;
  #timeoutMs;
  #cache;
  #log;
  #gate;
  #stats = { requests: 0, cacheHits: 0, retries: 0, skipped: 0, maxObservedConcurrency: 0, queuedForConcurrency: 0 };

  /**
   * Exactly one of `authHeader` or `sessionAuth` is used per request.
   *
   * @param {string|null} [authHeader]   a static Basic/Bearer header, only
   *   present when the customer has separately provisioned a dedicated
   *   credential. Optional.
   * @param {import('./session-auth.mjs').SessionAuth|null} [sessionAuth]
   *   the default: replays the interactive session captured by
   *   bin/capture-session.mjs. See reference/13-data-access.md.
   * @param {number} [maxConcurrency]  cap on in-flight requests from this
   *   client. Defaults to SN_MAX_CONCURRENCY (4), the same value
   *   loadConfig() puts on `config.maxConcurrency`, so the cap applies even
   *   when a caller constructs this client without threading config through.
   */
  constructor({
    base,
    authHeader = null,
    sessionAuth = null,
    timeoutMs = 60000,
    cache = null,
    log = null,
    maxConcurrency = maxConcurrencyFromEnv(),
  }) {
    if (!authHeader && !sessionAuth) {
      throw new Error('ReadOnlyTableApi needs either authHeader or sessionAuth. See lib/session.mjs.');
    }
    this.#base = base;
    this.#authHeader = authHeader;
    this.#sessionAuth = sessionAuth;
    this.#timeoutMs = timeoutMs;
    this.#cache = cache;
    this.#log = log;
    this.#gate = createRequestGate(maxConcurrency);
  }

  /**
   * Counters, plus the enforced concurrency cap.
   *
   * The cap is surfaced here rather than as its own getter on purpose:
   * test/smoke.mjs asserts that the public surface of this class is exactly
   * get, count and stats, and that read-only-by-construction guarantee is
   * worth more than the convenience of an `api.maxConcurrency` accessor.
   */
  get stats() {
    return { ...this.#stats, maxConcurrency: this.#gate.limit };
  }

  /**
   * Read records from a table.
   *
   * `fields` is mandatory. A record read without sysparm_fields returns every
   * field: one sp_widget row carries the whole template, client script, server
   * script, CSS and option schema. See reference/13-data-access.md.
   *
   * @param {string} table
   * @param {object} opts
   * @param {string[]} opts.fields          required, non-empty
   * @param {string} [opts.query]           encoded query, list-filter syntax
   * @param {number} [opts.limit=100]       page size (max 1000)
   * @param {number} [opts.offset=0]
   * @param {boolean} [opts.all=false]      paginate until exhausted or maxRows
   * @param {number} [opts.maxRows=10000]   hard ceiling when all=true
   * @param {'true'|'false'|'all'} [opts.displayValue='false']
   * @param {boolean} [opts.noDomain=false] sets sysparm_query_no_domain
   * @param {boolean} [opts.refresh=false]  bypass the disk cache
   * @returns {Promise<{rows: object[], truncated: boolean, partial: boolean,
   *   incompleteReason: 'max-rows'|'request-failed'|null, pagesFetched: number,
   *   fromCache: boolean, status: number, error?: string}>}
   *
   * `truncated` / `partial` mean "these rows are NOT the complete set". Both
   * are true when the maxRows ceiling was hit AND when pagination failed
   * partway, and `incompleteReason` says which. A caller enumerating a small
   * set exhaustively must check one of them; `rows.length` alone cannot tell a
   * complete answer from a half-finished one.
   */
  async get(table, opts = {}) {
    const {
      fields,
      query,
      limit = 100,
      offset = 0,
      all = false,
      maxRows = 10000,
      displayValue = 'false',
      noDomain = false,
      refresh = false,
    } = opts;

    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error(
        `get('${table}') requires a non-empty fields array. Unbounded field selection is forbidden ` +
          '(reference/13-data-access.md, context discipline).',
      );
    }
    if (limit > MAX_PAGE) throw new Error(`limit ${limit} exceeds the ${MAX_PAGE} page cap.`);

    const cacheParams = { fields: [...fields].sort(), query, limit, offset, all, maxRows, displayValue, noDomain };
    const cacheKey = Cache.keyFor('table', table, cacheParams);
    if (!refresh && this.#cache) {
      const hit = await this.#cache.read(cacheKey);
      if (hit) {
        this.#stats.cacheHits += 1;
        // Entries written before `partial` existed only carry `truncated`;
        // derive the rest from it rather than reporting undefined.
        return {
          rows: hit.rows,
          truncated: hit.truncated,
          partial: hit.partial ?? hit.truncated ?? false,
          incompleteReason: hit.incompleteReason ?? (hit.truncated ? 'max-rows' : null),
          pagesFetched: hit.pagesFetched ?? null,
          fromCache: true,
          status: hit.status ?? 200,
        };
      }
    }

    const rows = [];
    let truncated = false;
    let status = 200;
    let pageOffset = offset;
    let pagesFetched = 0;
    let incompleteReason = null;

    for (;;) {
      const params = new URLSearchParams();
      params.set('sysparm_fields', fields.join(','));
      // Always set. Reference link objects roughly double the payload.
      params.set('sysparm_exclude_reference_link', 'true');
      params.set('sysparm_display_value', String(displayValue));
      params.set('sysparm_limit', String(limit));
      params.set('sysparm_offset', String(pageOffset));
      if (query) params.set('sysparm_query', query);
      if (noDomain) params.set('sysparm_query_no_domain', 'true');

      const res = await this.#request(`${TABLE_ENDPOINT}${encodeURIComponent(table)}`, params, {
        label: `get ${table}`,
      });
      status = res.status;
      if (!res.ok) {
        // Permission or persistent failure. Surface it rather than pretending
        // the table is empty.
        //
        // truncated MUST be true here. This used to return the rows collected
        // so far with `truncated` still false, so a pagination that died on
        // page 7 of 20 was indistinguishable from one that genuinely reached
        // the end of the table. Every caller in this skill is written against
        // the "enumerate the small sets exhaustively" contract, and a silent
        // false was the exact failure mode that contract exists to prevent:
        // the partial rows get cited in the report as a complete inventory.
        // `partial` says the same thing unambiguously for callers that read
        // `truncated` as "there is more beyond maxRows".
        //
        // Deliberately NOT cached: the block below is unreachable from here,
        // so an incomplete result never gets written to disk and replayed as
        // a cache hit on a later run.
        return {
          rows,
          truncated: true,
          partial: true,
          incompleteReason: 'request-failed',
          pagesFetched,
          fromCache: false,
          status: res.status,
          error: res.error,
        };
      }
      const page = res.body?.result ?? [];
      pagesFetched += 1;
      rows.push(...page);
      if (!all) break;
      // Stop ONLY on a genuinely empty page, never on "page.length < limit".
      // Confirmed empirically on a live instance: a sysparm_limit=100 request
      // returned only 99 rows on the very first page, with 98 MORE real rows
      // sitting at offset=99 -- ACL-filtered rows apparently can shorten a
      // page without it being the last one. Treating a short page as "done"
      // silently truncated every --all query on that table (99 of 197 rows,
      // hard failure of the "enumerate the small sets exhaustively" contract
      // this whole skill exists to keep). Advancing by page.length rather
      // than the requested limit is equally load-bearing: advancing by the
      // fixed limit after a short page would have skipped exactly the rows
      // the short page failed to deliver.
      if (page.length === 0) break;
      if (rows.length >= maxRows) {
        truncated = true;
        incompleteReason = 'max-rows';
        break;
      }
      pageOffset += page.length;
    }

    if (this.#cache) {
      await this.#cache.write(cacheKey, {
        kind: 'table',
        table,
        params: cacheParams,
        fetchedAt: new Date().toISOString(),
        status,
        truncated,
        partial: truncated,
        incompleteReason,
        pagesFetched,
        rowCount: rows.length,
        rows,
      });
    }
    return { rows, truncated, partial: truncated, incompleteReason, pagesFetched, fromCache: false, status };
  }

  /**
   * Count or group via the Aggregate API. Never retrieve rows to count them.
   *
   * @param {string} table
   * @param {object} opts
   * @param {string} [opts.query]
   * @param {string[]} [opts.groupBy]     fields to group by
   * @param {string[]} [opts.avg]         numeric fields to average
   * @param {string[]} [opts.sum]
   * @param {string[]} [opts.min]
   * @param {string[]} [opts.max]
   * @param {boolean} [opts.refresh=false]
   * @returns {Promise<{total: number|null, groups: {value: object, count: number}[], status: number}>}
   */
  async count(table, opts = {}) {
    const { query, groupBy = [], avg = [], sum = [], min = [], max = [], refresh = false } = opts;
    const cacheParams = { query, groupBy, avg, sum, min, max };
    const cacheKey = Cache.keyFor('stats', table, cacheParams);
    if (!refresh && this.#cache) {
      const hit = await this.#cache.read(cacheKey);
      if (hit) {
        this.#stats.cacheHits += 1;
        return { total: hit.total, groups: hit.groups, status: hit.status ?? 200, fromCache: true };
      }
    }

    const params = new URLSearchParams();
    params.set('sysparm_count', 'true');
    if (query) params.set('sysparm_query', query);
    if (groupBy.length) params.set('sysparm_group_by', groupBy.join(','));
    if (avg.length) params.set('sysparm_avg_fields', avg.join(','));
    if (sum.length) params.set('sysparm_sum_fields', sum.join(','));
    if (min.length) params.set('sysparm_min_fields', min.join(','));
    if (max.length) params.set('sysparm_max_fields', max.join(','));

    const res = await this.#request(`${STATS_ENDPOINT}${encodeURIComponent(table)}`, params, {
      label: `count ${table}`,
    });
    if (!res.ok) return { total: null, groups: [], status: res.status, error: res.error, fromCache: false };

    const result = res.body?.result;
    const parsed = parseAggregate(result, groupBy);
    if (this.#cache) {
      await this.#cache.write(cacheKey, {
        kind: 'stats',
        table,
        params: cacheParams,
        fetchedAt: new Date().toISOString(),
        status: res.status,
        ...parsed,
      });
    }
    return { ...parsed, status: res.status, fromCache: false };
  }

  // ---------------------------------------------------------------------
  // Private transport. GET only, two endpoints only, no escape hatch.
  // ---------------------------------------------------------------------
  #request = async (pathname, params, { label }) => {
    if (!pathname.startsWith(TABLE_ENDPOINT) && !pathname.startsWith(STATS_ENDPOINT)) {
      throw new Error(`Blocked: ${pathname} is outside the read-only endpoint allow list.`);
    }
    // Every read this client can issue funnels through here, so this is the
    // one place the SN_MAX_CONCURRENCY cap has to hold. The slot is held for
    // the whole logical request, retries and backoff sleeps included: a
    // request waiting out a 429 is still load this client intends to put on
    // the instance, and holding the slot is what reference/13-data-access.md
    // means by "on a rate limit specifically, also reduce concurrency".
    if (this.#gate.active >= this.#gate.limit) this.#stats.queuedForConcurrency += 1;
    const release = await this.#gate.acquire();
    if (this.#gate.active > this.#stats.maxObservedConcurrency) {
      this.#stats.maxObservedConcurrency = this.#gate.active;
    }
    try {
      return await this.#attempt(pathname, params, { label });
    } finally {
      release();
    }
  };

  #attempt = async (pathname, params, { label }) => {
    const url = `${this.#base}${pathname}?${params.toString()}`;

    const waits = [1000, 4000, 12000];
    let attempt = 0;
    let sessionRefreshTried = false;
    for (;;) {
      this.#stats.requests += 1;

      // Resolve auth headers OUTSIDE the network try/catch below. A
      // SessionAuth failure (no captured session yet, or a session confirmed
      // dead) is a terminal, distinct problem, not a transient network
      // hiccup: retrying will not fix a session that does not exist, and its
      // deliberately clear error message (naming bin/capture-session.mjs)
      // must reach the caller, not be swallowed as "status: 0" after three
      // wasted retries.
      let authHeaders;
      try {
        authHeaders = this.#sessionAuth ? await this.#sessionAuth.headers() : { Authorization: this.#authHeader };
      } catch (err) {
        this.#stats.skipped += 1;
        await this.#log?.error('session-auth', { label, url: redact(url), error: String(err) });
        return { ok: false, status: 0, error: String(err) };
      }

      let res;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        try {
          res = await fetch(url, {
            method: 'GET', // the only verb this client can issue
            headers: {
              Accept: 'application/json',
              ...authHeaders,
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        // Network level failure counts as transient.
        if (attempt < waits.length) {
          this.#stats.retries += 1;
          await sleep(waits[attempt++]);
          continue;
        }
        this.#stats.skipped += 1;
        await this.#log?.error('api', { label, url: redact(url), error: String(err) });
        return { ok: false, status: 0, error: String(err) };
      }

      if (res.ok) {
        const body = await res.json().catch(() => null);
        return { ok: true, status: res.status, body };
      }

      const text = await res.text().catch(() => '');

      // 401 under session auth is ambiguous: it can mean the cached CSRF
      // token or cookie went stale mid-run, not that access is genuinely
      // denied. Force one token refresh and retry before treating it as a
      // permission error. Never applies to a static authHeader, where a 401
      // means the credential itself is bad and retrying cannot help.
      if (res.status === 401 && this.#sessionAuth && !sessionRefreshTried) {
        sessionRefreshTried = true;
        this.#stats.retries += 1;
        await this.#log?.event('session-auth.refresh', { label, url: redact(url) });
        try {
          await this.#sessionAuth.headers({ forceRefresh: true });
        } catch (err) {
          // The refresh itself failed: the session is confirmed dead, not
          // just the cached token. Terminal. Surface it plainly rather than
          // letting the throw escape #request unhandled and crash the caller.
          this.#stats.skipped += 1;
          await this.#log?.error('session-auth', { label, url: redact(url), error: String(err) });
          return { ok: false, status: 0, error: String(err) };
        }
        continue;
      }

      // 403 and 401: retrying will not help. Log, skip, continue.
      if (res.status === 401 || res.status === 403) {
        this.#stats.skipped += 1;
        await this.#log?.error('api-permission', { label, url: redact(url), status: res.status, body: text.slice(0, 500) });
        return { ok: false, status: res.status, error: text.slice(0, 500) };
      }
      // 429 and 5xx: transient. Back off, and on a rate limit back off harder.
      if ((res.status === 429 || res.status >= 500) && attempt < waits.length) {
        this.#stats.retries += 1;
        const extra = res.status === 429 ? 2 : 1;
        await sleep(waits[attempt++] * extra);
        continue;
      }
      this.#stats.skipped += 1;
      await this.#log?.error('api', { label, url: redact(url), status: res.status, body: text.slice(0, 500) });
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
  };
}

function parseAggregate(result, groupBy) {
  if (!result) return { total: null, groups: [] };
  if (Array.isArray(result)) {
    const groups = result.map((entry) => ({
      value: Object.fromEntries(groupBy.map((f) => [f, entry.groupby_fields?.find((g) => g.field === f)?.value ?? null])),
      count: Number(entry.stats?.count ?? 0),
      stats: entry.stats ?? {},
    }));
    return { total: groups.reduce((a, g) => a + g.count, 0), groups };
  }
  return { total: Number(result.stats?.count ?? 0), groups: [] };
}

// Auth headers never appear in a URL, so nothing here can leak a credential.
// What it can leak is the *content* of a query: usernames, sys_ids, and
// occasionally a literal value someone put in a filter. sysparm_query is the
// one parameter worth masking in a log line; the rest (fields, limit, offset,
// display value) are structural and harmless to keep for debugging.
function redact(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('sysparm_query')) u.searchParams.set('sysparm_query', '<redacted>');
    return u.toString();
  } catch {
    return url;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
