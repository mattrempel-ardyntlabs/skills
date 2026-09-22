#!/usr/bin/env node
// Creates the run folder and records the Phase 0 authorization answers.
//
// This runs BEFORE any query. reference/13-data-access.md: "At the very start of
// Phase 0, before any query: confirm the operator has the customer's permission
// to run a read-only audit of this environment, and confirm whether it is
// production or a non-production clone."
//
// bin/phase0.mjs refuses to run until this file exists with authorized=true, so
// the gate is enforced by the tooling rather than by remembering to ask.
//
//   node bin/init-run.mjs --suffix esc --authorized yes \
//     --environment production --production-ack yes \
//     [--note "approved by J. Smith, ticket CHG0012345"] \
//     [--write-exception ./exception.json]

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { RunFolder, runFolderName, RUNS_ROOT, findPriorRun } from '../lib/run-folder.mjs';
import { loadConfig } from '../lib/config.mjs';
import { parseArgs, die } from '../lib/session.mjs';
import { buildWriteException } from '../lib/write-exception.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.suffix) die('--suffix <portal url suffix> is required.');

const authorized = /^(y|yes|true)$/i.test(String(args.authorized ?? ''));
if (!authorized) {
  die(
    'Refusing to create a run. The customer must have authorized a read-only audit of this environment. ' +
      'Ask the operator, then pass --authorized yes.',
  );
}

const environment = String(args.environment ?? '').toLowerCase();
if (!['production', 'non-production'].includes(environment)) {
  die('--environment must be "production" or "non-production".');
}
if (environment === 'production' && !/^(y|yes|true)$/i.test(String(args['production-ack'] ?? ''))) {
  die(
    'This is production. The browser crawl generates real load and should not run during business hours ' +
      'without agreement. Restate that to the operator and pass --production-ack yes to proceed.',
  );
}

const config = loadConfig();
const root = path.join(args['runs-root'] ?? RUNS_ROOT, runFolderName(args.suffix));
const runFolder = await RunFolder.create(root);

let writeException = null;
let writeExceptionSummary = null;
if (args['write-exception']) {
  writeException = JSON.parse(await readFile(args['write-exception'], 'utf8'));
  // The one gate, run here. reference/13-data-access.md puts the declaration at
  // Phase 0, "before the audit starts, never mid-run", so the declaration is
  // checked here, before it is trusted enough to be written to metadata.json
  // and inherited by every later phase.
  //
  // This calls the same buildWriteException() a run would use to perform the
  // action, rather than a separate narrower pre-screen. A second copy of the
  // rules here would drift: the previous version of this block only tested the
  // delete blocklist, so a declaration with approved missing, an action of
  // "upsert", or an update naming no sys_id was recorded as authorized and only
  // rejected later, if at all.
  //
  // No network happens: buildWriteException() builds and validates the action
  // object, and only its perform() ever issues a request. log is null because
  // the run's log is only meaningful once the action is actually used.
  try {
    const gated = buildWriteException(writeException, { base: config.base, log: null });
    writeExceptionSummary = gated.describe();
  } catch (err) {
    die(`Refusing to record this write exception. ${err.message}`);
  }
}

const prior = await findPriorRun(args.suffix, root, args['runs-root'] ?? RUNS_ROOT);

await runFolder.writeJson(runFolder.metadataPath, {
  portalSuffixRequested: args.suffix,
  instanceHost: config.host,
  // null unless a dedicated SN_TOKEN/SN_USER credential is configured. The
  // default path (the interactive session, captured next) resolves the real
  // audit user later; see phase0.json's auditUser probe.
  auditUser: config.username,
  environment,
  authorization: {
    confirmed: true,
    environment,
    productionLoadAcknowledged: environment === 'production',
    note: args.note ?? null,
    recordedAt: new Date().toISOString(),
  },
  // Recorded only after buildWriteException() accepted it above, alongside the
  // one-line description of exactly what was authorized, so the operator and
  // the report can both see the scope that was approved rather than re-deriving
  // it from the raw declaration.
  write_exception: writeException ? { ...writeException, describe: writeExceptionSummary, validatedAt: new Date().toISOString() } : null,
  priorRun: prior,
  startedAt: new Date().toISOString(),
});

process.stdout.write(
  JSON.stringify(
    {
      runFolder: runFolder.root,
      environment,
      instanceHost: config.host,
      auditUser: config.username,
      priorRun: prior,
      writeExceptionDeclared: writeException?.name ?? null,
      writeExceptionScope: writeExceptionSummary,
      next: config.username
        ? 'node bin/phase0.mjs --run ' + runFolder.root
        : 'node bin/capture-session.mjs --run ' + runFolder.root + '  (no dedicated credential configured; this captures the login that phase0 and every later phase will use)',
    },
    null,
    2,
  ) + '\n',
);
