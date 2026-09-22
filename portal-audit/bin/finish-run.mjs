#!/usr/bin/env node
// End of run housekeeping.
//
//   node bin/finish-run.mjs --run <dir> [--delete-cache] [--delete-screenshots]
//
// Retention, per reference/13-data-access.md:
//   cache/ and screenshots/ are KEPT by default. They matter for a future
//   re-audit comparison and for re-verifying a disputed finding. Offer to
//   delete them; never delete by default.
//   findings/ is always kept. It is already summarized rather than raw.
//   .auth/ is always deleted. It holds live session credential material and is
//   not covered by the keep-by-default rule.

import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { openSession, parseArgs, die } from '../lib/session.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');

// requireAuth: false -- this script only deletes .auth/, it never queries the
// instance. Requiring auth here would mean it could never run a second time
// (it would have just deleted the only captured session), and would block
// bin/report.mjs regenerations after a finished run for the same reason.
const { runFolder, log } = await openSession(args.run, { requireAuth: false });
const actions = [];

const authDir = path.join(runFolder.root, '.auth');
if (await exists(authDir)) {
  await rm(authDir, { recursive: true, force: true });
  actions.push('deleted .auth/ (session credential material, always deleted)');
}

if (args['delete-cache']) {
  await rm(runFolder.cacheDir, { recursive: true, force: true });
  actions.push('deleted cache/ at the operator\'s request');
  await log.event('retention.cache-deleted', {});
} else {
  actions.push('kept cache/ (default). Offer deletion to the operator; do not delete unasked.');
}

if (args['delete-screenshots']) {
  await rm(runFolder.screenshotsDir, { recursive: true, force: true });
  actions.push('deleted screenshots/ at the operator\'s request. Image links in an already-generated report.md will now be broken.');
  await log.event('retention.screenshots-deleted', {});
} else {
  actions.push('kept screenshots/ (default). Screenshots taken while logged in as a real user can show real customer data.');
}

process.stdout.write(
  JSON.stringify(
    {
      runFolder: runFolder.root,
      actions,
      reminders: [
        'The run folder is never committed to git. portal-audit-runs/ is in .gitignore.',
        'If a PDF is wanted: node bin/report-pdf.mjs --run <run> [--narrative <file.json>]. See reference/17-pdf-report.md.',
      ],
    },
    null,
    2,
  ) + '\n',
);

async function exists(p) {
  return Boolean(await stat(p).catch(() => null));
}
