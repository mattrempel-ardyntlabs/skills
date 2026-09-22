// Instance connection config, read from the environment.
//
// No credential is required here, and none is ever written to the run
// folder. The default way this skill authenticates is by reusing the single
// interactive session captured by bin/capture-session.mjs (see
// lib/session.mjs, lib/session-auth.mjs, reference/13-data-access.md). That
// needs no environment variable at all beyond SN_INSTANCE.
//
// SN_TOKEN / SN_USER+SN_PASSWORD are an optional, secondary path: if a
// customer voluntarily provisions a dedicated service account or OAuth
// client for the engagement, lib/session.mjs prefers THIS credential over
// the captured session when both are present, since it does not depend on a
// session file staying valid for the length of a long run. Neither is ever
// required, and this skill never creates a user or credential on the
// customer's instance to get one.

export function loadConfig(env = process.env) {
  const raw = env.SN_INSTANCE;
  if (!raw) {
    throw new Error('SN_INSTANCE is not set. Set SN_INSTANCE to the instance host (acme.service-now.com) or full base URL.');
  }
  const base = normalizeInstance(raw);

  // Optional, secondary credential. null unless the operator's environment
  // provides one; see lib/session.mjs for how this is chosen against the
  // captured-session path.
  let authHeader = null;
  let username = null;
  if (env.SN_TOKEN) {
    authHeader = `Bearer ${env.SN_TOKEN}`;
    username = env.SN_USER || '(oauth token)';
  } else if (env.SN_USER && env.SN_PASSWORD) {
    authHeader = 'Basic ' + Buffer.from(`${env.SN_USER}:${env.SN_PASSWORD}`).toString('base64');
    username = env.SN_USER;
  }

  return {
    base,
    host: new URL(base).host,
    authHeader, // null unless a dedicated credential was provided; see above
    username,
    // Cap on concurrent in-flight API requests. Enforced at the single
    // chokepoint every read goes through, ReadOnlyTableApi's private
    // transport in lib/table-api.mjs, which reads the same value from the
    // environment by default so it holds however the client was constructed.
    // See reference/13-data-access.md, rate and load discipline.
    //
    // Honest about its limits: this is a per-process cap. It cannot bound
    // several sub-agents running as separate OS processes against one
    // instance -- nothing in a single Node process can -- so treat it as the
    // per-agent share, not a machine-wide guarantee.
    maxConcurrency: maxConcurrencyFromEnv(env),
    timeoutMs: Number(env.SN_TIMEOUT_MS || 60000),
  };
}

/**
 * The concurrent-request cap, from SN_MAX_CONCURRENCY.
 *
 * Exported separately from loadConfig() so lib/table-api.mjs can default to it
 * without requiring SN_INSTANCE, which loadConfig() insists on. That keeps one
 * definition of the knob: a client constructed directly, without a config
 * object threaded through it, still gets the cap.
 *
 * A non-numeric or non-positive value falls back to 4 rather than silently
 * disabling the cap (Number('') is 0, and `|| 4` alone would let
 * SN_MAX_CONCURRENCY=abc through as NaN).
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {number} a positive integer
 */
export function maxConcurrencyFromEnv(env = process.env) {
  const parsed = Number(env.SN_MAX_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed < 1) return 4;
  return Math.floor(parsed);
}

export function normalizeInstance(raw) {
  let value = String(raw).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`Refusing a non-https instance URL: ${value}`);
  }
  return `${url.protocol}//${url.host}`;
}
