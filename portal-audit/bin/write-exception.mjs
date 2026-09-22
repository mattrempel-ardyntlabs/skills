#!/usr/bin/env node
// The only script in this skill that writes to the instance.
//
//   node bin/write-exception.mjs --run <dir> --payload <file.json> [--confirm]
//
// Everything else here is read-only. This one exists because
// reference/13-data-access.md allows a single narrow, operator-declared write
// exception, and lib/write-exception.mjs's perform() had no caller: the gate
// was wired at Phase 0 by bin/init-run.mjs, but nothing could actually execute
// the approved action.
//
// The rules are not re-implemented here. buildWriteException() in
// lib/write-exception.mjs is the only copy of them: it refuses a declaration
// that is not approved, that names a delete, that uses an action other than
// update or insert, or that updates without naming an exact sys_id. This
// script's own job is the human-facing half:
//
//   1. Resolve the SAME credential every read in the run used, via
//      openSession(), rather than deriving a second auth path for the one
//      request that changes data.
//   2. Print exactly what is about to happen -- instance, method, URL, table,
//      sys_id, and the full payload -- before anything is sent.
//   3. Refuse to send it at all without an explicit --confirm.
//
// Without --confirm this is a dry run. It prints the plan, exits 3, and makes
// no network request of any kind. There is no default that writes, no
// environment variable that implies consent, and no --yes alias.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { openSession, parseArgs, die } from '../lib/session.mjs';
import { buildWriteException } from '../lib/write-exception.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');
if (!args.payload || args.payload === true) {
  die(
    '--payload <file.json> is required. The body of the write is never assembled from command-line flags or ' +
      'defaulted to an empty object: it is read from a file the operator wrote and can re-read.',
  );
}

// requireAuth is left at its default (true). This script needs a real
// credential, and openSession()'s stale-impersonation check matters more here
// than anywhere else in the skill: performing a write while the shared session
// is still impersonated from an interrupted crawl would write as the wrong
// user.
const { runFolder, config, metadata, log, authHeader, sessionAuth } = await openSession(args.run);

if (!metadata?.authorization?.confirmed) {
  die(
    'No confirmed authorization in metadata.json for this run. Nothing is written to a customer instance outside an ' +
      'authorized audit. Run bin/init-run.mjs first.',
  );
}

const declaration = metadata.write_exception ?? null;
if (!declaration) {
  die(
    `This run declares no write exception, so there is nothing to perform. A write exception is declared by the ` +
      'operator at Phase 0 (bin/init-run.mjs --write-exception <file.json>), before the audit starts, never mid-run. ' +
      'Re-running init-run to add one after the fact is not the same thing and is not what this script is for.',
  );
}

// Same gate bin/init-run.mjs ran at Phase 0, run again here against whatever is
// actually in metadata.json now. Re-validating rather than trusting the earlier
// pass means a metadata.json that was hand-edited after the run started is
// caught before the request, not after it.
let action;
try {
  action = buildWriteException(declaration, { base: config.base, authHeader, sessionAuth, log });
} catch (err) {
  die(`Refusing to perform this write exception. The declaration in metadata.json does not pass the gate: ${err.message}`);
}
if (!action) die('buildWriteException() returned null for a non-null declaration. Refusing to proceed.');

const payloadRaw = await readFile(args.payload, 'utf8');
let payload;
try {
  payload = JSON.parse(payloadRaw);
} catch (err) {
  die(`--payload ${args.payload} is not valid JSON: ${err.message}`);
}
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  die(`--payload ${args.payload} must contain a JSON object of field name to value. Got ${Array.isArray(payload) ? 'an array' : typeof payload}.`);
}
if (Object.keys(payload).length === 0) {
  die(`--payload ${args.payload} is an empty object. Refusing to send a write with no fields; say what is being written.`);
}

const method = declaration.action === 'update' ? 'PATCH' : 'POST';
const url =
  declaration.action === 'update'
    ? `${config.base}/api/now/table/${declaration.target.table}/${declaration.target.sys_id}`
    : `${config.base}/api/now/table/${declaration.target.table}`;

const plan = {
  run: runFolder.root,
  environment: metadata.environment,
  instance: config.base,
  authMode: authHeader ? 'dedicated credential (SN_TOKEN/SN_USER)' : 'the interactive session captured for this run',
  exception: action.name,
  authorizedScope: action.describe(),
  reason: declaration.reason,
  request: { method, url, table: declaration.target.table, sys_id: declaration.target.sys_id ?? null },
  payloadFile: path.resolve(args.payload),
  payloadFields: Object.keys(payload),
  payload,
};

process.stdout.write('About to perform the declared write exception:\n');
process.stdout.write(JSON.stringify(plan, null, 2) + '\n');

// The gate. Strictly `true`, which parseArgs() produces only for a bare
// --confirm. `--confirm=false`, `--confirm no` and `--confirm 0` all arrive as
// strings and are all refused, because a flag whose value argues against
// itself is not consent.
if (args.confirm !== true) {
  process.stderr.write(
    '\nDRY RUN. Nothing was sent and no network request was made.\n' +
      (args.confirm === undefined
        ? 'Re-run with --confirm to perform exactly the request above.\n'
        : `--confirm was given the value ${JSON.stringify(args.confirm)}. Only a bare --confirm authorizes the write.\n`),
  );
  await log.writeExceptionUse(action.name, {
    phase: 'dry-run',
    action: declaration.action,
    table: declaration.target.table,
    sys_id: declaration.target.sys_id ?? null,
    payloadKeys: Object.keys(payload),
    confirmed: false,
  });
  process.exit(3);
}

process.stdout.write('\n--confirm given. Performing the write now.\n');

let result;
try {
  // perform() logs its own attempt and result to logs/write-exception.jsonl.
  result = await action.perform(payload);
} catch (err) {
  await log.error('write-exception', { exception: action.name, message: String(err) });
  die(`The write exception failed: ${err.message}. logs/write-exception.jsonl records the attempt.`, 4);
}

await log.event('write-exception.performed', {
  exception: action.name,
  table: declaration.target.table,
  sys_id: declaration.target.sys_id ?? result?.sys_id ?? null,
  payloadKeys: Object.keys(payload),
});

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      exception: action.name,
      request: plan.request,
      wrote: Object.keys(payload),
      resultSysId: result?.sys_id ?? null,
      auditLog: path.join(runFolder.logsDir, 'write-exception.jsonl'),
      note:
        'Any finding produced from this action must set write_exception_used to the exception name above, per ' +
        'reference/13-data-access.md.',
    },
    null,
    2,
  ) + '\n',
);
