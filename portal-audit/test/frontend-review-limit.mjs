#!/usr/bin/env node
// Offline test for bin/frontend-review.mjs template selection and --limit.
// Run from the skill directory:  node test/frontend-review-limit.mjs
//
// No ServiceNow instance. A local http.Server stands in for the portal, a real
// temp run folder supplies shared-context.json and inventory.json, and
// bin/frontend-review.mjs is executed as a child process exactly as an
// operator or sub-agent would run it, so the argument handling under test is
// the shipped code path rather than a copy of it.
//
// Why: Phase 6 used to default to reviewing 40 templates. On the
// esc-2026-09-11 run that silently covered 40 of 148 admin templates -- 23 of
// which rendered "Not Found" -- and reported a clean bill of health for the
// 108 it never loaded. reference/10-frontend-review.md asks for every unique
// template, and neither documented invocation passes --limit at all. So the
// default must be "everything", and --limit must stay an explicit opt-in.
//
// The second half is the valueless-flag trap: parseArgs() turns a bare
// `--limit` into boolean true, and Number(true) is 1. Left unguarded that
// reviews exactly one template and reports success, which is the worst
// possible failure mode for a coverage tool.
//
// Covers:
//   - with no --limit, every unique template is reviewed and nothing is
//     reported as skipped;
//   - --limit N reviews N, reports limitApplied and counts what it skipped;
//   - a bare --limit, 0, a negative and a non-numeric value are all rejected
//     before the browser opens, with a message naming the flag;
//   - a rejected run reviews nothing at all rather than quietly reviewing one.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// fileURLToPath, not URL#pathname: the skill can live under a path with
// spaces in it, which pathname hands back percent-encoded.
const SKILL_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(SKILL_ROOT, 'bin', 'frontend-review.mjs');

// Three unique page templates, which is what the inventory below declares.
const TEMPLATE_IDS = ['index', 'catalog', 'kb_article'];

// ---------------------------------------------------------------------------
// Mock portal. buildPageUrl() produces <base>/<suffix>/?id=<pageId>.
// ---------------------------------------------------------------------------
// When true the server accepts requests and never answers, which is how the
// large-inventory check below reads the template count without paying for a
// full review of every template. See runUntilObservations().
let hangRequests = false;

const server = http.createServer((req, res) => {
  if (hangRequests) return; // hold the socket open, answer nothing
  const url = new URL(req.url, 'http://127.0.0.1');
  const id = url.searchParams.get('id') || 'index';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(
    `<!doctype html><html lang="en"><head><title>${id}</title></head>` +
      `<body><main><h1>${id}</h1>` +
      // The real Service Portal widget wrapper shape, so the observation
      // record this script writes carries a non-empty widgetSysIds list.
      '<div class="v6f2a1c9d4b8e7305af16d2c8b904e7f1"><p>A widget</p></div>' +
      '<a href="?id=catalog">Somewhere</a>' +
      '</main></body></html>',
  );
});

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const tmp = await mkdtemp(path.join(tmpdir(), 'portal-audit-frontend-limit-'));

/** A fresh run folder with just enough on disk for openSession() to proceed. */
async function makeRun(name, templateIds = TEMPLATE_IDS) {
  const root = path.join(tmp, name);
  for (const dir of ['cache', 'screenshots', 'findings', 'logs']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await writeFile(
    path.join(root, 'shared-context.json'),
    JSON.stringify({
      portalSuffix: 'esc',
      personas: ['admin'],
      personaRegistry: [{ name: 'admin', underlying_user: null }],
      writeExceptions: [],
    }),
    'utf8',
  );
  await writeFile(
    path.join(root, 'inventory.json'),
    JSON.stringify({
      pageInventory: [
        ...templateIds.map((id) => ({ pageId: id, actualPageId: id, title: id, persona: 'admin', outcome: 'ok', params: {} })),
        // A duplicate rendering of a templated page, and another persona's
        // node. Neither should add to the template count.
        { pageId: 'kb_article', actualPageId: 'kb_article', title: 'another article', persona: 'admin', outcome: 'ok', params: { sys_id: 'KB002' } },
        { pageId: 'employee_only', actualPageId: 'employee_only', title: 'x', persona: 'employee', outcome: 'ok', params: {} },
      ],
    }),
    'utf8',
  );
  return root;
}

/** Run bin/frontend-review.mjs to completion and collect its output. */
function runScript(root, extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--run', root, '--persona', 'admin', ...extraArgs], {
      cwd: SKILL_ROOT,
      env: { ...process.env, SN_INSTANCE: base, SN_TOKEN: 'test-token', SN_MAX_CONCURRENCY: '2' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* a rejected run prints nothing to stdout */
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

/**
 * Read the template count the script committed to, without reviewing them.
 *
 * bin/frontend-review.mjs writes frontend-observations.<persona>.json with
 * `templatesTotal: list.length` before it reviews anything, so with the mock
 * portal hanging, that file is the selection decision frozen in place. This is
 * what makes a 46-template inventory affordable to assert on: a hardcoded
 * default of 40 would show up here as templatesTotal 40, whereas reviewing 46
 * templates at three widths for real costs a minute and a half.
 */
function runUntilObservations(root, extraArgs, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--run', root, '--persona', 'admin', ...extraArgs], {
      cwd: SKILL_ROOT,
      env: { ...process.env, SN_INSTANCE: base, SN_TOKEN: 'test-token' },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const observationsPath = path.join(root, 'frontend-observations.admin.json');
    const deadline = Date.now() + timeoutMs;
    const finish = (value) => {
      clearInterval(timer);
      child.kill('SIGKILL');
      resolve(value);
    };
    const timer = setInterval(async () => {
      const parsed = await readFile(observationsPath, 'utf8')
        .then((t) => JSON.parse(t))
        .catch(() => null);
      if (parsed) finish(parsed);
      else if (Date.now() > deadline) finish({ timedOut: true, stderr });
    }, 100);
    child.on('close', () => {
      /* killed by us, or died early; the interval resolves either way */
    });
  });
}

try {
  // -------------------------------------------------------------------
  // 0. A large inventory: the default must be "all of it", not a number.
  //    Named templates rather than a count, so a bad default of 40 (the
  //    value this actually shipped with) is visibly wrong here.
  // -------------------------------------------------------------------
  {
    const many = ['index', 'catalog', 'kb_article', ...Array.from({ length: 43 }, (_, i) => `page_${String(i).padStart(3, '0')}`)];
    const root = await makeRun('large-inventory', many);
    hangRequests = true;
    const observed = await runUntilObservations(root, []);
    hangRequests = false;
    server.closeAllConnections?.();
    check('the selection decision is written before any template is reviewed', observed.timedOut !== true, JSON.stringify(observed).slice(0, 300));
    check(
      'with no --limit, all 46 templates are queued for review, not a capped subset',
      observed.templatesTotal === many.length,
      `templatesTotal ${observed.templatesTotal}, expected ${many.length}`,
    );
    check('nothing is reviewed yet at that point, so the count is the plan, not the result', observed.templatesReviewed === 0, String(observed.templatesReviewed));

    const rootCapped = await makeRun('large-inventory-capped', many);
    hangRequests = true;
    const cappedObserved = await runUntilObservations(rootCapped, ['--limit', '5']);
    hangRequests = false;
    server.closeAllConnections?.();
    check('an explicit --limit narrows the queue on a large inventory', cappedObserved.templatesTotal === 5, String(cappedObserved.templatesTotal));
  }

  // -------------------------------------------------------------------
  // 1. No --limit: review every unique template.
  // -------------------------------------------------------------------
  {
    const root = await makeRun('default');
    const run = await runScript(root, []);
    check('a run with no --limit exits cleanly', run.code === 0, run.stderr.slice(-400));
    check('a run with no --limit prints a JSON summary', run.json !== null, run.stdout.slice(0, 200));
    check(
      'every unique template is reviewed when --limit is omitted',
      run.json?.templatesReviewed === TEMPLATE_IDS.length,
      `reviewed ${run.json?.templatesReviewed} of ${TEMPLATE_IDS.length}`,
    );
    check(
      'templates are deduplicated on page id, across personas',
      run.json?.templatesAvailable === TEMPLATE_IDS.length,
      `available ${run.json?.templatesAvailable}`,
    );
    check('no limit is reported as applied', run.json?.limitApplied === null, String(run.json?.limitApplied));
    check('nothing is reported as skipped by a limit', run.json?.templatesSkippedByLimit === 0, String(run.json?.templatesSkippedByLimit));
    check(
      'the observations file agrees with the summary',
      await readFile(path.join(root, 'frontend-observations.admin.json'), 'utf8')
        .then((t) => JSON.parse(t))
        .then((o) => o.templatesReviewed === TEMPLATE_IDS.length && o.templatesTotal === TEMPLATE_IDS.length)
        .catch((e) => e.message),
    );
  }

  // -------------------------------------------------------------------
  // 2. --limit N: an explicit, reported sample.
  // -------------------------------------------------------------------
  {
    const root = await makeRun('capped');
    const run = await runScript(root, ['--limit', '2']);
    check('an explicit --limit exits cleanly', run.code === 0, run.stderr.slice(-400));
    check('--limit N reviews N templates', run.json?.templatesReviewed === 2, String(run.json?.templatesReviewed));
    check('--limit N still reports how many templates exist', run.json?.templatesAvailable === 3, String(run.json?.templatesAvailable));
    check('--limit N says a limit was applied', run.json?.limitApplied === 2, String(run.json?.limitApplied));
    check(
      '--limit N counts what it left unreviewed, so coverage is never overstated',
      run.json?.templatesSkippedByLimit === 1,
      String(run.json?.templatesSkippedByLimit),
    );
  }

  // -------------------------------------------------------------------
  // 3. Garbage limits are rejected, before anything is reviewed.
  // -------------------------------------------------------------------
  {
    // A bare `--limit` with no value. parseArgs() makes this boolean true, and
    // Number(true) === 1, so an unguarded build reviews exactly one template
    // and calls it a success.
    const root = await makeRun('bare-flag');
    const run = await runScript(root, ['--limit']);
    check('a valueless --limit is rejected', run.code !== 0, `exit ${run.code}`);
    check('a valueless --limit is not silently coerced to 1', run.json === null, run.stdout.slice(0, 200));
    check('the rejection names the flag and the requirement', /--limit must be a positive number/.test(run.stderr), run.stderr.slice(0, 200));
    check('the rejection says how to review everything', /Omit --limit to review every template/.test(run.stderr), run.stderr.slice(0, 200));
    check(
      'a rejected run reviews nothing at all, leaving no observations file',
      await readFile(path.join(root, 'frontend-observations.admin.json'), 'utf8').then(
        () => false,
        (e) => e.code === 'ENOENT',
      ),
    );
  }

  for (const [label, value] of [
    ['zero', '0'],
    ['a negative number', '-3'],
    ['a non-numeric string', 'all'],
  ]) {
    const root = await makeRun(`bad-${value}`);
    const run = await runScript(root, [`--limit=${value}`]);
    check(`--limit ${label} is rejected`, run.code !== 0, `exit ${run.code}`);
    check(`--limit ${label} produces no summary`, run.json === null);
    check(`--limit ${label} explains itself`, /--limit must be a positive number/.test(run.stderr), run.stderr.slice(0, 160));
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
