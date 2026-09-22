#!/usr/bin/env node
// Smoke test. Run from the skill directory:  node test/smoke.mjs
//
// No ServiceNow instance required. A local mock server stands in for the Table
// API and for a miniature Service Portal, so the read-only guarantees, the
// blocklist, the crawl engine, the findings validator and the report assembler
// are all exercised for real rather than asserted in a comment.

import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReadOnlyTableApi } from '../lib/table-api.mjs';
import { SessionAuth } from '../lib/session-auth.mjs';
import { buildWriteException, FORBIDDEN_ACTION } from '../lib/write-exception.mjs';
import { Cache } from '../lib/cache.mjs';
import { clickAllowed, WRITE_VERBS } from '../lib/blocklist.mjs';
import { validateFinding, validateFindings, makeFinding, recordDeepLink } from '../lib/findings.mjs';
import { nodeKey, extractPageIds, extractParameterNames, findHardcodedPortalPaths, parsePortalUrl } from '../lib/portal-url.mjs';
import { ReadOnlyBrowser, ReadOnlyTab } from '../lib/browser.mjs';
import { runCrawl, emptyState, reconcile } from '../lib/crawl.mjs';
import { assembleReport, compareRuns } from '../lib/report.mjs';
import { buildPdfData } from '../lib/pdf/data.mjs';

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
// Mock instance
// ---------------------------------------------------------------------------
const seenRequests = [];
let flaky401Requests = 0;
// Flips true partway through the captureSession() regression test below, to
// simulate a human finishing an interactive login mid-poll -- decoupled from
// real cookies, since this is testing the polling logic itself, not a real
// login flow.
let loginCompletedForCaptureTest = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  seenRequests.push({ method: req.method, pathname: url.pathname, params: Object.fromEntries(url.searchParams), headers: req.headers });

  if (url.pathname === '/login.do') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Mock login page</body></html>');
    return;
  }

  // Stands in for /navpage.do: a session-authenticated page load carrying the
  // literal `window.g_ck = '...'` this skill's SessionAuth regexes out (see
  // lib/session-auth.mjs and reference/13-data-access.md). Only "issues" the
  // token to a request presenting the expected session cookie, so a stale or
  // missing cookie is distinguishable from a valid one, same as a real instance.
  if (url.pathname === '/navpage.do') {
    const cookie = req.headers.cookie || '';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (cookie.includes('sid=good') || loginCompletedForCaptureTest) {
      res.end("<html><script>window.g_ck = 'facade00cafe';</script></html>");
    } else {
      res.end('<html><body>Please log in.</body></html>'); // no g_ck: expired/absent session
    }
    return;
  }

  if (url.pathname.startsWith('/api/now/table/')) {
    const table = url.pathname.split('/').pop();
    if (table === 'forbidden_table') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no' } }));
      return;
    }
    // Session auth only: a token that has gone stale mid-run. Rejects the
    // first request regardless of token, accepts every one after, so the
    // test can confirm the client refreshes and retries exactly once rather
    // than treating this like a permission error or retrying forever.
    if (table === 'flaky_401_table') {
      flaky401Requests += 1;
      if (flaky401Requests === 1) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'session token expired' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: [{ sys_id: 'ok-after-refresh' }] }));
      return;
    }
    // Session auth only: a genuinely dead session (or a real permission
    // problem masquerading as one). Always 401s, even after the one
    // forced-refresh retry, so the test can confirm this terminates cleanly
    // as a permission error rather than looping or crashing.
    if (table === 'persistent_401_table') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'still not authenticated' } }));
      return;
    }
    // Reproduces a real bug, confirmed on a live instance: sc_cat_item had
    // 197 rows by the Aggregate API's own count, but a sysparm_limit=100
    // request for page one returned only 99 -- a page SHORTER than the
    // requested limit that was nonetheless not the last page (offset=99
    // still returned 98 more real rows). ACL-filtered rows can apparently
    // shorten a page without ending the result set. get({all:true}) must
    // never treat "page.length < limit" as "done"; only an empty page means
    // that. 15 real rows, deliberately shorted to 7 on the very first page
    // regardless of the requested limit, mirrors that shape at a testable size.
    if (table === 'acl_short_page_table') {
      const off = Number(url.searchParams.get('sysparm_offset') || 0);
      const lim = Number(url.searchParams.get('sysparm_limit') || 10);
      const aclTotal = 15;
      const firstPageSize = 7; // short on purpose, on the very first page
      const rows = [];
      if (off === 0) {
        for (let i = 0; i < Math.min(firstPageSize, lim); i += 1) rows.push({ sys_id: `acl${i}` });
      } else {
        for (let i = off; i < Math.min(off + lim, aclTotal); i += 1) rows.push({ sys_id: `acl${i}` });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: rows }));
      return;
    }
    const offset = Number(url.searchParams.get('sysparm_offset') || 0);
    const limit = Number(url.searchParams.get('sysparm_limit') || 10);
    const total = 25;
    const rows = [];
    for (let i = offset; i < Math.min(offset + limit, total); i += 1) rows.push({ sys_id: `id${i}`, id: `page${i}` });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: rows }));
    return;
  }
  if (url.pathname.startsWith('/api/now/stats/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { stats: { count: '42' } } }));
    return;
  }

  // Miniature portal, served with a strict CSP like a hardened instance.
  if (url.pathname.startsWith('/esc')) {
    const id = url.searchParams.get('id') || 'index';
    const sysId = url.searchParams.get('sys_id');
    const body = portalPage(id, sysId);
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'",
    });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end('<html lang="en"><body><h1>Page not found</h1></body></html>');
});

function portalPage(id, sysId) {
  const links = {
    index: ['?id=catalog', '?id=kb_article&sys_id=KB001', '?id=kb_article&sys_id=KB002', '?id=orphan_target', '/sp?id=index'],
    catalog: ['?id=index', '?id=kb_article&sys_id=KB003'],
    kb_article: ['?id=index'],
    orphan_target: [],
  };
  const hrefs = (links[id] ?? []).map((h) => `<a href="${h}">Go to ${h}</a>`).join('\n');
  return `<!doctype html><html lang="en"><head><title>${id}${sysId ? ` ${sysId}` : ''}</title></head>
<body>
  <main>
    <h1>${id}</h1>
    <!--
      Widget markup, in both shapes the detector has to handle.

      The first two divs are the attribute-annotated shape. Real Service
      Portal does not emit these, but custom containers and other releases
      might, and lib/browser.mjs still keeps WIDGET_ATTRIBUTE_SELECTOR for
      them, so the fixture keeps exercising that path.

      The rest is what Service Portal actually renders: a wrapper carrying a
      v-plus-32-hex-sp_widget-sys_id class and nothing else identifying it.
      A widget-detection bug shipped and passed this suite precisely because
      the fixture had no element of this shape. The near-miss classes below
      must NOT be counted, so a loosened pattern fails here too.
    -->
    <div widget-id="sp-header" instance-id="inst1"></div>
    <div widget-id="runtime-embedded"></div>
    <div class="v6f2a1c9d4b8e7305af16d2c8b904e7f1"><p>Real SP widget wrapper, no instance</p></div>
    <div class="panel v0b1c2d3e4f50617283940a1b2c3d4e5f" instance-id="inst2"><p>Real SP widget wrapper, instance-backed</p></div>
    <div class="v6f2a1c9d4b8e7305af16d2c8b904e7f"><p>31 hex, not a widget</p></div>
    <div class="v6f2a1c9d4b8e7305af16d2c8b904e7f1a"><p>33 hex, not a widget</p></div>
    <div class="v6f2a1c9d4b8e7305afg6d2c8b904e7f1"><p>32 chars but non-hex, not a widget</p></div>
    <div class="version-banner"><p>v-prefixed word, not a widget</p></div>
    ${id === 'index' ? '<span ng-click="nav.go()">Angular nav control with no data-page-id</span>' : ''}
    ${hrefs}
    <a href="?id=order_thing">Order something</a>
    <form><button type="submit">Save</button><a href="?id=inside_form">Inner link</a></form>
    <img src="x.png">
  </main>
</body></html>`;
}

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const tmp = await mkdtemp(path.join(tmpdir(), 'portal-audit-test-'));

try {
  // -------------------------------------------------------------------
  // 1. The Table API client is read-only by construction.
  // -------------------------------------------------------------------
  const publicMethods = Object.getOwnPropertyNames(ReadOnlyTableApi.prototype).filter((n) => n !== 'constructor');
  check(
    'table api exposes only get, count and stats',
    publicMethods.sort().join(',') === 'count,get,stats',
    `found: ${publicMethods.join(', ')}`,
  );
  for (const verb of ['post', 'put', 'patch', 'delete', 'create', 'update', 'insert', 'request', 'write']) {
    check(`table api has no ${verb}()`, typeof ReadOnlyTableApi.prototype[verb] === 'undefined');
  }
  const source = await readFile(new URL('../lib/table-api.mjs', import.meta.url), 'utf8');
  check('table api source contains no non-GET method literal', !/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(source));

  const cache = new Cache(path.join(tmp, 'cache'));
  const api = new ReadOnlyTableApi({ base, authHeader: 'Basic test', cache });

  let threw = false;
  try {
    await api.get('sp_page', {});
  } catch {
    threw = true;
  }
  check('get() refuses a call without fields', threw);

  const got = await api.get('sp_page', { fields: ['sys_id', 'id'], limit: 10, all: true });
  check('get() paginates to exhaustion', got.rows.length === 25, `got ${got.rows.length}`);
  const lastTableReq = seenRequests.filter((r) => r.pathname.includes('/table/sp_page')).pop();
  check('get() always sets sysparm_fields', lastTableReq.params.sysparm_fields === 'sys_id,id');
  check('get() always sets sysparm_exclude_reference_link', lastTableReq.params.sysparm_exclude_reference_link === 'true');
  check('get() only issues GET', seenRequests.every((r) => r.method === 'GET'));

  const aclShort = await api.get('acl_short_page_table', { fields: ['sys_id'], limit: 10, all: true, refresh: true });
  check(
    'a page shorter than the limit does not end pagination early (real bug: ACL-filtered rows can shorten a non-final page)',
    aclShort.rows.length === 15,
    `got ${aclShort.rows.length}`,
  );
  const aclShortOffsets = seenRequests.filter((r) => r.pathname.includes('acl_short_page_table')).map((r) => r.params.sysparm_offset);
  check(
    'pagination advances by rows actually received, not the requested limit (advancing by limit would have skipped rows here)',
    aclShortOffsets.join(',') === '0,7,15',
    aclShortOffsets.join(','),
  );

  const cached = await api.get('sp_page', { fields: ['sys_id', 'id'], limit: 10, all: true });
  check('second identical get() is served from the disk cache', cached.fromCache === true);

  const counted = await api.count('sp_widget', {});
  check('count() uses the Aggregate API', counted.total === 42 && seenRequests.some((r) => r.pathname.startsWith('/api/now/stats/')));

  const forbidden = await api.get('forbidden_table', { fields: ['sys_id'] });
  check('403 is not retried and is returned as a gap', forbidden.status === 403 && forbidden.rows.length === 0);
  const forbiddenCalls = seenRequests.filter((r) => r.pathname.includes('forbidden_table')).length;
  check('403 produced exactly one request', forbiddenCalls === 1, `made ${forbiddenCalls}`);

  // -------------------------------------------------------------------
  // 1b. Session-based auth: the default path (reference/13-data-access.md).
  // No SN_USER/SN_PASSWORD/SN_TOKEN anywhere below -- just a captured
  // storage state, standing in for what bin/capture-session.mjs produces.
  // -------------------------------------------------------------------
  const goodStatePath = path.join(tmp, 'good-storage-state.json');
  await writeFile(
    goodStatePath,
    JSON.stringify({ cookies: [{ name: 'sid', value: 'good', domain: '127.0.0.1', path: '/' }] }),
    'utf8',
  );
  const badStatePath = path.join(tmp, 'bad-storage-state.json');
  await writeFile(
    badStatePath,
    JSON.stringify({ cookies: [{ name: 'sid', value: 'expired', domain: '127.0.0.1', path: '/' }] }),
    'utf8',
  );

  const goodAuth = new SessionAuth({ instanceBase: base, storageStatePath: goodStatePath });
  const headers = await goodAuth.headers();
  check('session auth builds a Cookie header from the captured storage state', headers.Cookie === 'sid=good');
  check('session auth resolves X-UserToken from a plain GET, no browser', headers['X-UserToken'] === 'facade00cafe');

  const badAuth = new SessionAuth({ instanceBase: base, storageStatePath: badStatePath });
  let badAuthThrew = null;
  try {
    await badAuth.headers();
  } catch (err) {
    badAuthThrew = String(err);
  }
  check(
    'an expired/stale session produces a clear re-run-capture-session error, not a silent failure',
    badAuthThrew?.includes('capture-session.mjs'),
    badAuthThrew ?? '(did not throw)',
  );

  const missingAuth = new SessionAuth({ instanceBase: base, storageStatePath: path.join(tmp, 'no-such-file.json') });
  let missingThrew = null;
  try {
    await missingAuth.headers();
  } catch (err) {
    missingThrew = String(err);
  }
  check('a never-captured session also names bin/capture-session.mjs as the fix', missingThrew?.includes('bin/capture-session.mjs'));

  let noAuthThrew = false;
  try {
    // eslint-disable-next-line no-new
    new ReadOnlyTableApi({ base, cache });
  } catch {
    noAuthThrew = true;
  }
  check('the client refuses to be built with neither authHeader nor sessionAuth', noAuthThrew);

  const sessionCache = new Cache(path.join(tmp, 'session-cache'));
  const sessionApi = new ReadOnlyTableApi({ base, sessionAuth: goodAuth, cache: sessionCache });
  const sessionGot = await sessionApi.get('sp_page', { fields: ['sys_id', 'id'], limit: 5 });
  check('a session-authenticated get() succeeds', sessionGot.status === 200 && sessionGot.rows.length === 5);
  const lastSessionReq = seenRequests.filter((r) => r.pathname.includes('/table/sp_page')).pop();
  check('the request carried the replayed cookie', lastSessionReq.headers.cookie === 'sid=good');
  check('the request carried the token as X-UserToken, not Authorization', lastSessionReq.headers['x-usertoken'] === 'facade00cafe');
  check('session auth never sends a static Authorization header', !('authorization' in lastSessionReq.headers));

  const flaky = await sessionApi.get('flaky_401_table', { fields: ['sys_id'] });
  check(
    'a 401 under session auth triggers exactly one refresh-and-retry, then succeeds',
    flaky.status === 200 && flaky.rows[0]?.sys_id === 'ok-after-refresh',
  );
  const flakyRequestCount = seenRequests.filter((r) => r.pathname.includes('flaky_401_table')).length;
  check('the refresh-and-retry made exactly two requests, not a retry loop', flakyRequestCount === 2, `made ${flakyRequestCount}`);

  const persistentFailure = await sessionApi.get('persistent_401_table', { fields: ['sys_id'] });
  check(
    'a 401 that survives the refresh terminates as a clean permission error, not a loop or a crash',
    persistentFailure.status === 401 && persistentFailure.rows.length === 0,
  );
  const persistentRequestCount = seenRequests.filter((r) => r.pathname.includes('persistent_401_table')).length;
  check('the persistent-401 case still made exactly two requests total (one retry, not endless)', persistentRequestCount === 2, `made ${persistentRequestCount}`);

  // Regression coverage for a real bug: SessionAuth.headers() throwing (no
  // captured session, or one confirmed expired) was previously caught by
  // #request's network try/catch, retried three times as if it were a
  // transient connectivity blip, and returned as an opaque status: 0 with no
  // trace of the real error. It must now surface immediately and plainly.
  const deadApi = new ReadOnlyTableApi({ base, sessionAuth: missingAuth, cache: new Cache(path.join(tmp, 'dead-session-cache')) });
  const requestsBeforeDeadCall = seenRequests.length;
  const deadResult = await deadApi.get('sp_page', { fields: ['sys_id'], limit: 5 });
  check(
    'a session that was never captured fails immediately through get(), not after retries',
    deadResult.status === 0 && deadResult.error?.includes('bin/capture-session.mjs'),
    JSON.stringify(deadResult),
  );
  check(
    'resolving a never-captured session made no network request at all (the failure is a local file read, not a fetch)',
    seenRequests.length === requestsBeforeDeadCall,
    `${seenRequests.length - requestsBeforeDeadCall} unexpected request(s)`,
  );

  // -------------------------------------------------------------------
  // 1c. The one write exception's validation guards (lib/write-exception.mjs).
  // Not wired into any bin/ entry point yet -- see bin/init-run.mjs's note --
  // but its guards are the safety-critical part and had zero coverage.
  // perform()'s actual HTTP behavior is not exercised here for the same
  // reason: nothing calls it yet.
  // -------------------------------------------------------------------
  check('no declaration means no write exception object at all', buildWriteException(null, { base, log: null }) === null);

  function expectThrow(decl, label) {
    let threw = null;
    try {
      buildWriteException(decl, { base, log: null });
    } catch (err) {
      threw = String(err);
    }
    check(label, threw !== null, threw ?? '(did not throw)');
    return threw;
  }

  expectThrow(
    { name: 'test', action: 'update', target: { table: 'sc_cat_item_producer', sys_id: 'abc' }, reason: 'x', approved: false },
    'an unapproved declaration is refused',
  );
  expectThrow(
    { name: 'test', action: 'delete', target: { table: 'sc_cat_item_producer', sys_id: 'abc' }, reason: 'x', approved: true },
    'a delete action is refused with no override',
  );
  for (const verb of ['remove', 'destroy', 'purge', 'drop', 'truncate']) {
    check(`FORBIDDEN_ACTION matches "${verb}"`, FORBIDDEN_ACTION.test(verb));
  }
  expectThrow({ name: 'test', action: 'insert', target: {}, reason: 'x', approved: true }, 'a missing target.table is refused');
  expectThrow(
    { name: 'test', action: 'update', target: { table: 'sc_cat_item_producer' }, reason: 'x', approved: true },
    'an update with no exact sys_id is refused',
  );
  expectThrow(
    { name: 'test', action: 'whatever', target: { table: 'sc_cat_item_producer', sys_id: 'abc' }, reason: 'x', approved: true },
    'an action outside update/insert is refused',
  );

  const validException = buildWriteException(
    { name: 'producer-submit-test', action: 'update', target: { table: 'sc_cat_item_producer', sys_id: 'abc123' }, reason: 'confirm submission', approved: true },
    { base, log: null },
  );
  check('a well-formed declaration builds a usable exception object', validException?.name === 'producer-submit-test');
  check(
    'describe() names the exact action, table and target',
    validException.describe().includes('sc_cat_item_producer/abc123') && validException.describe().includes('producer-submit-test'),
  );
  check('the exception object exposes exactly perform() and describe(), nothing broader', Object.keys(validException).sort().join(',') === 'describe,name,perform');

  // -------------------------------------------------------------------
  // 2. The click blocklist
  // -------------------------------------------------------------------
  check('blocklist holds exactly the 14 documented verbs', WRITE_VERBS.length === 14);
  check('a plain link is allowed', clickAllowed({ visibleText: 'Knowledge base', insideForm: false }).allowed);
  check('a link inside a form is refused', !clickAllowed({ visibleText: 'Knowledge base', insideForm: true }).allowed);
  check('"Order something" is refused', !clickAllowed({ visibleText: 'Order something', insideForm: false }).allowed);
  check('"Submit request" is refused', !clickAllowed({ visibleText: 'Submit request', insideForm: false }).allowed);
  check('"APPROVE" is refused, case insensitively', !clickAllowed({ visibleText: 'APPROVE', insideForm: false }).allowed);
  check(
    'the skip reason is the documented wording',
    clickAllowed({ visibleText: 'Save', insideForm: false }).reason.startsWith('skipped: looked like a mutating control'),
  );

  // -------------------------------------------------------------------
  // 3. The browser wrapper is read-only by construction.
  // -------------------------------------------------------------------
  const tabMethods = Object.getOwnPropertyNames(ReadOnlyTab.prototype).filter((n) => n !== 'constructor');
  for (const verb of ['fill', 'type', 'press', 'submit', 'setInputFiles', 'evaluate', 'check', 'selectOption', 'dragAndDrop']) {
    check(`browser tab has no ${verb}()`, !tabMethods.includes(verb), `found: ${tabMethods.join(', ')}`);
  }
  check(
    'browser tab exposes the documented actions',
    ['navigate', 'clickLink', 'observe', 'screenshot'].every((m) => tabMethods.includes(m)),
    tabMethods.join(', '),
  );
  const browserMethods = Object.getOwnPropertyNames(ReadOnlyBrowser.prototype).filter((n) => n !== 'constructor');
  check(
    'impersonation start and stop exist on the session, not the tab',
    browserMethods.includes('startImpersonation') && browserMethods.includes('stopImpersonation') && !tabMethods.includes('startImpersonation'),
  );

  // -------------------------------------------------------------------
  // 4. URL normalization and static extraction
  // -------------------------------------------------------------------
  check(
    'a thousand articles collapse to one node',
    nodeKey('kb_article', { sys_id: 'KB001' }) === nodeKey('kb_article', { sys_id: 'KB999' }),
  );
  check('lang is not material for structural dedup', nodeKey('index', { lang: 'es' }) === nodeKey('index', {}));
  check('table is material', nodeKey('ticket', { table: 'incident', sys_id: 'a' }) !== nodeKey('ticket', { table: 'sc_request', sys_id: 'a' }));
  check('page ids come out of widget templates', extractPageIds('<a href="?id=sc_home">x</a>').includes('sc_home'));
  check('required parameters come out of server scripts', extractParameterNames("$sp.getParameter('sys_id')").includes('sys_id'));
  check('hardcoded foreign portal paths are found', findHardcodedPortalPaths('href="/sp?id=index"', 'esc').includes('sp'));
  check(
    'another portal\'s link is not treated as this portal\'s page',
    parsePortalUrl(`${base}/sp?id=index`, { instanceBase: base, suffix: 'esc' }).otherPortalOrPlatform === true,
  );

  // -------------------------------------------------------------------
  // 5. Live browser: navigate, observe, axe under CSP, blocked clicks, crawl
  // -------------------------------------------------------------------
  let browserOk = true;
  let browser;
  try {
    browser = await ReadOnlyBrowser.launch({
      instanceBase: base,
      storageStatePath: null,
      screenshotsDir: path.join(tmp, 'screenshots'),
      log: null,
      headless: true,
    });
  } catch (err) {
    browserOk = false;
    failures.push(`browser unavailable, phases 5 and 6 untested here: ${err.message}`);
  }

  if (browserOk) {
    // Regression coverage for a real bug found by actually running this
    // against a live instance: captureSession()'s readiness poll used to hit
    // the Table API directly, which requires X-UserToken (lib/session-auth.mjs)
    // that this check has no way to attach before a page has loaded. That
    // meant it could never see anything but 401, so it would spin for the
    // full timeout and fail even after a perfect login. Nothing else in this
    // file exercises captureSession() at all, so this would have shipped
    // silently. headless: true here only so this runs without a real display;
    // production always launches headed, for the operator to log in.
    const capturePath = path.join(tmp, 'captured-storage-state.json');
    loginCompletedForCaptureTest = false;
    const capturePromise = ReadOnlyBrowser.captureSession({ instanceBase: base, storageStatePath: capturePath, timeoutMs: 6000, headless: true });
    setTimeout(() => {
      loginCompletedForCaptureTest = true;
    }, 1000);
    let captureThrew = null;
    try {
      await capturePromise;
    } catch (err) {
      captureThrew = String(err);
    }
    check(
      'captureSession resolves once the readiness signal appears, without depending on the Table API',
      captureThrew === null,
      captureThrew ?? '',
    );
    const capturedState = JSON.parse(await readFile(capturePath, 'utf8').catch(() => 'null'));
    check('captureSession writes a storage state file with a cookies array', Array.isArray(capturedState?.cookies));

    const tabs = await browser.openTabs(3);
    check('three tabs open from one saved login', tabs.length === 3);

    const nav = await tabs[0].navigate(`${base}/esc?id=index`);
    check('navigate reports the final url', nav.url.includes('id=index'));
    const observed = await tabs[0].observe({ accessibility: true, aria: true });
    check('observe finds anchors after render', observed.anchors.length > 3);
    check(
      'observe finds widgets, both attribute-marked and .v<sys_id>-classed',
      observed.widgets.length === 4,
      `got ${observed.widgets.length}: ${observed.widgets.map((w) => w.widgetId).join(', ')}`,
    );
    check('observe distinguishes instance-backed from runtime-embedded widgets', observed.widgets.filter((w) => !w.instanceId).length === 2);
    // The real Service Portal shape: no widget-id attribute, identity carried
    // only by the `v<sp_widget sys_id>` wrapper class.
    const classWidgets = observed.widgets.filter((w) => w.matchedBy === 'class');
    check('observe matches real .v<sys_id> widget wrappers', classWidgets.length === 2, `got ${classWidgets.length}`);
    check(
      'a .v<sys_id> widget reports the sys_id as both widgetSysId and widgetId',
      classWidgets.every((w) => /^[0-9a-f]{32}$/.test(w.widgetSysId ?? '') && w.widgetId === w.widgetSysId),
      JSON.stringify(classWidgets),
    );
    check(
      'both real widget sys_ids are recovered from the class',
      classWidgets.map((w) => w.widgetSysId).sort().join(',') ===
        ['6f2a1c9d4b8e7305af16d2c8b904e7f1', '0b1c2d3e4f50617283940a1b2c3d4e5f'].sort().join(','),
      classWidgets.map((w) => w.widgetSysId).join(','),
    );
    check(
      'near-miss classes (31 hex, 33 hex, non-hex, version-banner) are not counted as widgets',
      observed.widgets.every((w) => w.widgetSysId === null || /^[0-9a-f]{32}$/.test(w.widgetSysId)) && observed.widgets.length === 4,
    );
    check(
      'attribute-marked widgets still match and keep their widget-id',
      observed.widgets.filter((w) => w.matchedBy === 'attribute').map((w) => w.widgetId).sort().join(',') === 'runtime-embedded,sp-header',
    );
    check('observe returns an aria snapshot', typeof observed.aria === 'string' && observed.aria.length > 0);
    check('axe-core injects under a strict CSP', Boolean(observed.axe) && !observed.axe.error, JSON.stringify(observed.axe?.error ?? '').slice(0, 200));
    check('axe reports the missing-alt violation', (observed.axe?.violations ?? []).some((v) => v.id === 'image-alt'));

    const blockedVerb = await tabs[0].clickLink('a:has-text("Order something")');
    check('a write-verb link is skipped, not clicked', blockedVerb.skipped === true && blockedVerb.clicked === false);
    const blockedForm = await tabs[0].clickLink('form a');
    check('a link inside a form is skipped, not clicked', blockedForm.skipped === true && blockedForm.clicked === false);
    const allowedClick = await tabs[0].clickLink('a:has-text("Go to ?id=catalog")');
    check('an ordinary link is clicked', allowedClick.clicked === true);

    const shot = await tabs[0].screenshot('index__desktop__admin', { width: 390 });
    check('screenshot lands in the run screenshots folder', shot.endsWith('index__desktop__admin.png'));

    // Crawl, with a deliberately tiny budget to prove the budget gate.
    const state = emptyState('admin');
    const persisted = [];
    const summary = await runCrawl({
      tabs,
      portal: { instanceBase: base, suffix: 'esc' },
      seeds: [{ pageId: 'index', params: {}, source: 'portal.homepage' }],
      persona: 'admin',
      state,
      budget: { maxNodes: 3, maxMinutes: 100 },
      // Placement is decided by joining the rendered widget's sys_id against
      // the sp_instance index, not by a DOM instance-id attribute. This call
      // used to pass no index at all, which meant classifyPlacement() short
      // circuited to "unknown" for every widget and the placement assertion
      // below could not pass however the classifier behaved. One row here,
      // covering the second of the two .v<sys_id> widgets in the mock, on
      // page "index" only -- so the same widget seen on "catalog" has to come
      // back as sp_instance_elsewhere.
      widgetInstanceIndex: {
        '0b1c2d3e4f50617283940a1b2c3d4e5f': [{ pageId: 'index', instanceSysId: 'inst-row-1' }],
      },
      widgetInstanceIndexComplete: true,
      persist: async (s) => persisted.push(Object.keys(s.visited).length),
      log: null,
    });
    check('crawl stops on the node budget', summary.status === 'budget_exceeded' && summary.budgetLimitHit === 'maxNodes');
    check('crawl reports what remains queued', summary.nodesQueued > 0);
    check('crawl state is persisted as it goes', persisted.length > 0);
    check('every visited node records the persona', Object.values(state.visited).every((v) => v.persona === 'admin'));
    const placement = (pageId, sysId) =>
      state.widgetInventory.find((w) => w.hostPageId === pageId && w.widgetSysId === sysId)?.placement;
    check(
      'widget inventory separates runtime-embedded placements',
      state.widgetInventory.some((w) => w.placement === 'runtime_getWidget'),
      JSON.stringify(state.widgetInventory.map((w) => [w.widgetSysId, w.placement])),
    );
    check(
      'a widget with an sp_instance row on this page is placed, not runtime-embedded',
      placement('index', '0b1c2d3e4f50617283940a1b2c3d4e5f') === 'sp_instance',
      String(placement('index', '0b1c2d3e4f50617283940a1b2c3d4e5f')),
    );
    check(
      'a widget absent from a complete sp_instance index is runtime-embedded',
      placement('index', '6f2a1c9d4b8e7305af16d2c8b904e7f1') === 'runtime_getWidget',
      String(placement('index', '6f2a1c9d4b8e7305af16d2c8b904e7f1')),
    );
    check(
      'the same widget on a page it has no sp_instance row for is sp_instance_elsewhere',
      placement('catalog', '0b1c2d3e4f50617283940a1b2c3d4e5f') === 'sp_instance_elsewhere',
      String(placement('catalog', '0b1c2d3e4f50617283940a1b2c3d4e5f')),
    );
    check(
      'an attribute-marked widget with no sys_id to join on stays unknown, not guessed',
      state.widgetInventory.filter((w) => w.widgetSysId === null).every((w) => w.placement === 'unknown'),
    );
    check('links to another portal are recorded separately', state.otherPortalLinks.length > 0);
    check(
      'an [ng-click] control with no data-page-id is recorded in skippedClicks, not silently dropped',
      state.skippedClicks.some((c) => c.text.includes('Angular nav control')),
      JSON.stringify(state.skippedClicks),
    );
    check('summarize() reports a non-zero skippedClicks count when there is one', summary.skippedClicks > 0, summary.skippedClicks);

    const full = emptyState('admin');
    const fullSummary = await runCrawl({
      tabs,
      portal: { instanceBase: base, suffix: 'esc' },
      seeds: [{ pageId: 'index', params: {}, source: 'portal.homepage' }],
      persona: 'admin',
      state: full,
      budget: { maxNodes: 500, maxMinutes: 100 },
      persist: async () => {},
      log: null,
    });
    check('a complete crawl reports complete', fullSummary.status === 'complete');
    const articleNodes = Object.keys(full.visited).filter((k) => k.startsWith('kb_article'));
    check('three articles collapsed into one kb_article node', articleNodes.length === 1, articleNodes.join(' / '));

    const rec = reconcile({ crawlState: full, configuredPageIds: ['index', 'catalog', 'never_linked'] });
    check('reconciliation names configured-but-unreachable pages', rec.configuredButUnreachable.includes('never_linked'));
    check('reconciliation names reachable-but-not-configured pages', rec.reachableButNotConfigured.includes('kb_article'));

    await browser.close();
  }

  // -------------------------------------------------------------------
  // 6. The findings schema is enforced
  // -------------------------------------------------------------------
  const ctx = { personas: ['admin', 'employee'], writeExceptions: ['producer-submit'], portalBase: `${base}/esc` };

  const valid = makeFinding({
    id: 'p3-014',
    phase: 3,
    title: "Topic 'Payroll' is invisible to all users",
    description: 'Enable user criteria check is on, but Available For and Not Available For are both empty.',
    status: 'published',
    evidence_type: 'CONFIG',
    // The Employee Center topic table is `topic`. `emp_taxonomy_topic` is a
    // Service Portal *page* id (?id=emp_taxonomy_topic), not a table, and a
    // deep link built from it resolves to nothing.
    evidence_detail: 'topic sys_id abc123, both criteria fields blank',
    severity: 'Critical',
    record_refs: [{ topic: 'abc123' }],
    url: recordDeepLink(base, 'topic', 'abc123'),
    quantification: { count: 1, of_total: 47, unit: 'topics affected' },
    remediation: 'Populate Available For, or disable the toggle to revert to content-level security.',
  });
  check('a well-formed finding passes', validateFinding(valid, ctx).errors.length === 0, JSON.stringify(validateFinding(valid, ctx).errors));

  const noPersona = { ...valid, id: 'p6-001', phase: 6, evidence_type: 'RENDERED', persona: null };
  check('a RENDERED finding without a persona is rejected', validateFinding(noPersona, ctx).errors.some((e) => e.includes('persona is mandatory')));

  const freeTextPersona = { ...valid, id: 'p6-002', phase: 6, evidence_type: 'RENDERED', persona: 'some random user' };
  check('a free-text persona is rejected', validateFinding(freeTextPersona, ctx).errors.some((e) => e.includes('persona registry')));

  const sharedNoNames = { ...valid, id: 'p8-1', phase: 8, portal_scope: 'shared', shared_with: [], tier: '1' };
  check('tier 1 shared with no named portals is rejected', validateFinding(sharedNoNames, ctx).errors.some((e) => e.includes('tier "2"')));

  const tier2NoCaveat = { ...valid, id: 'p8-2', phase: 8, portal_scope: 'shared', shared_with: [], tier: '2', caveat: null };
  check('tier 2 shared without a caveat is rejected', validateFinding(tier2NoCaveat, ctx).errors.some((e) => e.includes('caveat')));

  const stalenessTierInTierField = { ...valid, id: 'p8-3', phase: 8, tier: 'B' };
  check('a staleness tier in the tier field is rejected', validateFinding(stalenessTierInTierField, ctx).errors.some((e) => e.includes('blast-radius')));

  const badException = { ...valid, id: 'p9-1', write_exception_used: 'made-up' };
  check('an undeclared write exception is rejected', validateFinding(badException, ctx).errors.some((e) => e.includes('does not match a declared exception')));

  const badUrl = { ...valid, id: 'p3-9', url: `${base}/sp?id=whatever` };
  check('a CONFIG finding with a non deep-link url is rejected', validateFinding(badUrl, ctx).errors.some((e) => e.includes('deep link')));

  const emDash = { ...valid, id: 'p3-8', description: 'This finding uses an em dash — which is not allowed.' };
  check('an em dash is rejected', validateFinding(emDash, ctx).errors.some((e) => e.includes('em or en dash')));

  const rangePhase = { ...valid, id: 'p3-7', phase: '3' };
  check('a range or string phase is rejected', validateFinding(rangePhase, ctx).errors.some((e) => e.includes('integer 0 to 10')));

  const withheldNoCaveat = { ...valid, id: 'p5-000', phase: 5, status: 'withheld', persona: 'admin', caveat: null };
  check('a withheld finding without a caveat is rejected', validateFinding(withheldNoCaveat, ctx).errors.some((e) => e.includes('withheld')));

  const adminOnlyPhase5 = validateFindings([], { ...ctx, phase: 5, adminOnlyRun: true });
  check(
    'an admin-only run must not silently drop the phase 5 reconciliation',
    adminOnlyPhase5.fileErrors.some((e) => e.includes('withheld')),
  );

  const unknownField = { ...valid, id: 'p3-6', invented_field: true };
  check('an invented field is rejected', validateFinding(unknownField, ctx).errors.some((e) => e.includes('unknown field')));

  // -------------------------------------------------------------------
  // 7. Report assembly
  // -------------------------------------------------------------------
  const withheldPlaceholder = makeFinding({
    id: 'p5-000',
    phase: 5,
    title: 'Reachability reconciliation withheld: admin-only run',
    description: 'The Phase 5 reconciliation was not published for this run.',
    status: 'withheld',
    evidence_type: 'CONFIG',
    evidence_detail: 'Only the admin persona was crawled',
    severity: 'Informational',
    persona: 'admin',
    caveat: 'This finding only means something relative to a real, non-admin view.',
    remediation: 'Re-run with at least one operator-declared persona.',
  });
  const context = {
    instanceBase: base,
    portalSuffix: 'esc',
    portalName: 'Employee Center',
    portalSysId: 'abc',
    releaseFamily: 'Australia',
    personaRegistry: [{ name: 'admin', description: 'audit credential', acquisition: 'direct', underlying_user: 'auditor', effective_roles: ['admin'] }],
    adminOnlyRun: true,
    adminUpdateXmlAccess: true,
  };
  const markdown = await assembleReport({
    runFolder: { root: tmp },
    metadata: { startedAt: '2026-09-10', environment: 'non-production', authorization: { confirmed: true } },
    context,
    findings: [
      { ...valid, _file: 'phase-3-taxonomy.json' },
      { ...withheldPlaceholder, _file: 'phase-5-crawl.json' },
    ],
    inventory: { pageInventory: [{ pageId: 'index', title: 'Home', depth: 0, reachedFrom: 'seed', outcome: 'ok', routeMapped: false, persona: 'admin' }], widgetInventory: [] },
  });
  check('report leads with the executive summary', markdown.indexOf('## Executive summary') < markdown.indexOf('## Content visibility'));
  check(
    'content visibility outranks portal configuration in the ordering',
    markdown.indexOf('## Content visibility') < markdown.indexOf('## Portal configuration'),
  );
  check('appendices come last', markdown.lastIndexOf('## Appendices') > markdown.indexOf('## Portal configuration'));
  check('report contains no em dashes', !/[—–]/.test(markdown));
  check('report renders the withheld placeholder', markdown.includes('WITHHELD'));
  check('report records the persona on the finding line', markdown.includes('as admin'));
  check('report states the admin-only limitation nowhere silently', markdown.includes('Withheld'));

  const cmp = compareRuns(
    [makeFinding({ ...valid, id: 'cur-1' })],
    [makeFinding({ ...valid, id: 'old-99' }), makeFinding({ ...valid, id: 'old-1', record_refs: [{ sp_widget: 'zzz' }] })],
  );
  check('runs are matched by record_refs, not by id', cmp.stillOpen.length === 1 && cmp.resolved.length === 1);
  const cmpNoRefs = compareRuns([makeFinding({ ...valid, id: 'x', record_refs: [] })], []);
  check('a finding with no record_refs is not comparable, not new', cmpNoRefs.notComparable.length === 1 && cmpNoRefs.added.length === 0);

  // -------------------------------------------------------------------
  // 8. PDF data shaping (lib/pdf/data.mjs). Pure functions, no browser and
  // no instance -- reuses lib/report.mjs's SECTIONS, so this is really
  // checking that reuse holds, not re-testing the sectioning rules.
  // -------------------------------------------------------------------
  const highRendered = makeFinding({
    ...valid,
    id: 'p6-020',
    phase: 6,
    severity: 'High',
    evidence_type: 'RENDERED',
    persona: 'admin',
    screenshot_ref: 'screenshots/homepage__desktop__admin.png',
    title: 'Homepage renders an invalid list for the header menu',
  });
  const pdfData = buildPdfData({
    context,
    metadata: { startedAt: '2026-09-10', environment: 'non-production' },
    findings: [
      { ...valid, _file: 'phase-3-taxonomy.json' },
      { ...highRendered, _file: 'phase-6-frontend.json' },
      { ...withheldPlaceholder, _file: 'phase-5-crawl.json' },
    ],
    narrative: null,
  });
  check('pdf data sections by the same rules as report.md', pdfData.sections.some((s) => s.key === 'visibility') && pdfData.sections.some((s) => s.key === 'experience'));
  check('pdf data lifts Critical and High findings into the spotlight list', pdfData.highFindings.length === 2);
  check('pdf data derives a gallery item from the RENDERED finding with a screenshot', pdfData.galleryItems.length === 1 && pdfData.galleryItems[0].screenshotRef === highRendered.screenshot_ref);
  check('pdf data carries the withheld finding through for Appendix A', pdfData.withheldFindings.length === 1);
  check('pdf data flags a mechanically generated narrative when none is supplied', pdfData.narrative.generated === true);

  const pdfDataWithNarrative = buildPdfData({
    context,
    metadata: { startedAt: '2026-09-10', environment: 'non-production' },
    findings: [{ ...valid, _file: 'phase-3-taxonomy.json' }],
    narrative: { headline: 'Authored headline.', nextSteps: [{ title: 'Do this first.', detail: 'Because.' }] },
  });
  check('an authored narrative is used verbatim and not marked generated', pdfDataWithNarrative.narrative.generated === false && pdfDataWithNarrative.narrative.headline === 'Authored headline.');

  // -------------------------------------------------------------------
  // 8b. PDF triage. buildPdfData() must route through lib/report.mjs's
  // triageFindings() the same way assembleReport() does for report.md, so
  // the PDF never publishes a finding report.md holds back, and its own
  // appendix (lib/pdf/html.mjs Appendix B) can carry the same accounting
  // report.md's Appendix G does. Offline: runFacts is a plain object, not
  // read off disk.
  // -------------------------------------------------------------------
  const triageRunFacts = { screenshotCount: 120, crawlRan: true, crawlVisited: 237, crawlStatus: 'complete' };

  const crawlNotRunFinding = makeFinding({
    ...valid,
    id: 'p7-013',
    phase: 7,
    title: 'Phase 5 crawl has not run',
    description: 'The Phase 5 crawl has not run, so reachability could not be confirmed.',
    evidence_type: 'CONFIG',
  });
  const staleCaveatFinding = makeFinding({
    ...valid,
    id: 'p7-014',
    phase: 7,
    title: 'Employee Center Pro widget is unused',
    description: 'Usage Insights records zero interactions with this widget in the lookback window.',
    evidence_type: 'USAGE',
    caveat: 'The crawl has not run, so this could not be cross-checked against rendered pages.',
  });
  const supersededFinding = makeFinding({ ...valid, id: 'p3-old', phase: 3, title: 'Superseded finding' });
  const supersedingFinding = makeFinding({ ...valid, id: 'p3-new', phase: 3, title: 'Corrected finding', supersedes: ['p3-old'] });

  const pdfDataTriaged = buildPdfData({
    context,
    metadata: { startedAt: '2026-09-10', environment: 'non-production' },
    findings: [
      { ...crawlNotRunFinding, _file: 'phase-7-adoption.json' },
      { ...staleCaveatFinding, _file: 'phase-7-adoption.json' },
      { ...supersededFinding, _file: 'phase-3-taxonomy.json' },
      { ...supersedingFinding, _file: 'phase-3-taxonomy.json' },
    ],
    narrative: null,
    runFacts: triageRunFacts,
  });

  const triagedHigh = pdfDataTriaged.highFindings.map((h) => h.finding);
  check(
    "a finding contradicted by this run's own artifacts is held out of the PDF body",
    !triagedHigh.some((f) => f.id === 'p7-013'),
  );
  check('a finding superseded by another is held out of the PDF body', !triagedHigh.some((f) => f.id === 'p3-old'));
  check(
    'both are accounted for in heldBackFindings, with phase, for the PDF appendix',
    pdfDataTriaged.heldBackFindings.some((h) => h.id === 'p7-013' && h.phase === 7) &&
      pdfDataTriaged.heldBackFindings.some((h) => h.id === 'p3-old' && h.phase === 3),
  );
  check('pdf totals.heldBack matches what triage held back', pdfDataTriaged.totals.heldBack === 2);

  const staleCaveatInPdf = triagedHigh.find((f) => f.id === 'p7-014');
  check('a finding whose caveat alone is stale is still published in the PDF body', Boolean(staleCaveatInPdf));
  check(
    'its stale caveat is replaced in the PDF body, not the original wording',
    Boolean(staleCaveatInPdf) &&
      staleCaveatInPdf.caveat.includes('replaced at assembly') &&
      !staleCaveatInPdf.caveat.includes('could not be cross-checked'),
  );
  check(
    'the amended finding is recorded in amendedFindings, with phase, for the PDF appendix',
    pdfDataTriaged.amendedFindings.some((a) => a.id === 'p7-014' && a.phase === 7),
  );
  check('pdf totals.amended matches what triage amended', pdfDataTriaged.totals.amended === 1);
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
