// Wires a run folder to the read-only API client, cache and log.
// Every bin/ entry point starts here.

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { Cache } from './cache.mjs';
import { RunLog } from './run-log.mjs';
import { RunFolder } from './run-folder.mjs';
import { ReadOnlyTableApi } from './table-api.mjs';
import { SessionAuth } from './session-auth.mjs';

/**
 * Choose how Table API calls will authenticate, and say so out loud.
 *
 * Preferred, and the only thing required: the interactive session captured
 * by bin/capture-session.mjs. One login (including SSO) covers the browser
 * phases AND every Table API call, replayed here as a cookie header plus a
 * CSRF token (see lib/session-auth.mjs, reference/13-data-access.md). This
 * skill never creates a user or credential on the customer's instance to get
 * one.
 *
 * Optional, secondary: a dedicated SN_TOKEN / SN_USER+SN_PASSWORD credential,
 * only if the customer has separately chosen to provision one. Preferred
 * over the session when both are present, since it doesn't depend on a
 * captured session file staying valid for the length of the run.
 *
 * Exported as well as used internally. bin/write-exception.mjs is the one
 * caller outside this file: performing the operator-declared write exception
 * means reusing the run's own credential, and re-deriving that resolution order
 * in a second place is exactly how a write ends up authenticating differently
 * from every read that preceded it. Behavior and return shape are unchanged for
 * the internal caller below.
 *
 * @returns {Promise<{authHeader: string|null, sessionAuth: SessionAuth|null}>}
 */
export async function resolveAuth({ runFolder, config, log }) {
  const storageStatePath = path.join(runFolder.root, '.auth', 'storage-state.json');
  const hasCapturedSession = await stat(storageStatePath)
    .then((s) => s.isFile())
    .catch(() => false);

  if (config.authHeader) {
    const note =
      'Using the dedicated API credential from the environment (SN_TOKEN/SN_USER) for Table API calls. ' +
      'This is optional; the interactive session alone (bin/capture-session.mjs) is enough for a customer who has not provisioned one.';
    process.stderr.write(`${note}\n`);
    await log?.event('auth.resolved', { mode: 'dedicated-credential', username: config.username });
    return { authHeader: config.authHeader, sessionAuth: null };
  }

  if (hasCapturedSession) {
    const note =
      `Using the interactive session captured at ${storageStatePath} for Table API calls, not a separate service account. ` +
      'This is the default: one login (including SSO) covers both the browser phases and every platform-side phase.';
    process.stderr.write(`${note}\n`);
    await log?.event('auth.resolved', { mode: 'captured-session', storageStatePath });
    return { authHeader: null, sessionAuth: new SessionAuth({ instanceBase: config.base, storageStatePath, log }) };
  }

  throw new Error(
    'No way to authenticate yet. Run: node bin/capture-session.mjs --run <run>  before any phase that queries the ' +
      'instance -- this single interactive login (including SSO) covers Table API access too, and nothing else is ' +
      'required. Only set SN_TOKEN or SN_USER + SN_PASSWORD instead if the customer has separately chosen to hand you ' +
      'a dedicated integration credential; this skill will never create one itself.',
  );
}

/**
 * @param {string} runRoot
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.requireAuth=true]  pass false only for a script that
 *   does not touch the Table API and may run before any session exists --
 *   currently just bin/capture-session.mjs itself. Every other entry point
 *   needs a real `api`, so leave this true.
 */
/**
 * Since the crawl (bin/crawl.mjs, bin/frontend-review.mjs) now shares its
 * session with every Table API call, an interrupted or crashed persona crawl
 * that never reached its stop-impersonation cleanup -- or a phase run
 * concurrently with an active persona crawl -- would otherwise leave every
 * later Table API call silently scoped to the wrong user, with no error.
 * Guard against that here, once per process, rather than trusting every
 * caller to remember.
 *
 * No-ops until phase0.json exists (phase0 is what establishes the baseline;
 * it cannot check against one that doesn't exist yet), and no-ops if the
 * identity probe itself is inconclusive (a real permission gap should not be
 * escalated into a hard stop over an unrelated concern).
 */
async function verifyNotStaleImpersonation({ runFolder, api, log }) {
  const phase0 = await runFolder.readJson(path.join(runFolder.root, 'phase0.json'), null);
  const expected = phase0?.probes?.auditUser?.user_name;
  if (!expected) return;

  const res = await api.get('sys_user', { fields: ['user_name'], query: 'user_name=javascript:gs.getUserName()', limit: 1 });
  const actual = res.rows?.[0]?.user_name;
  if (res.error || !actual) {
    await log?.event('identity-check.inconclusive', { expected, status: res.status });
    return;
  }
  if (actual !== expected) {
    throw new Error(
      `This session is currently authenticated as "${actual}", but Phase 0 recorded the audit account as "${expected}". ` +
        'The shared session is most likely still impersonated from an interrupted crawl (bin/crawl.mjs / bin/frontend-review.mjs) ' +
        'that did not reach its stop-impersonation cleanup, or another phase is running concurrently with an active persona crawl. ' +
        'Every Table API call made in this state would be silently scoped to the wrong user. Stop and investigate -- do not re-run ' +
        'hoping it resolves itself.',
    );
  }
  await log?.event('identity-check.ok', { user: actual });
}

export async function openSession(runRoot, { env = process.env, requireAuth = true } = {}) {
  const config = loadConfig(env);
  const runFolder = await RunFolder.create(runRoot);
  const cache = new Cache(runFolder.cacheDir);
  const log = new RunLog(runFolder.logsDir);
  let api = null;
  // Kept in scope so they can be handed back below. Every existing caller
  // destructures the fields it wants by name, so adding two more is additive
  // and breaks nothing; both are null when requireAuth is false.
  let authHeader = null;
  let sessionAuth = null;
  if (requireAuth) {
    ({ authHeader, sessionAuth } = await resolveAuth({ runFolder, config, log }));
    api = new ReadOnlyTableApi({
      base: config.base,
      authHeader,
      sessionAuth,
      timeoutMs: config.timeoutMs,
      cache,
      log,
    });
    await verifyNotStaleImpersonation({ runFolder, api, log });
  }
  const metadata = await runFolder.metadata();
  const context = await runFolder.sharedContext();
  // authHeader / sessionAuth are exposed for exactly one caller,
  // bin/write-exception.mjs, which needs the run's already-resolved credential
  // to perform the operator-declared write exception. Nothing else in this
  // skill writes to the instance.
  return { config, runFolder, cache, log, api, metadata, context, authHeader, sessionAuth };
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

export function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
