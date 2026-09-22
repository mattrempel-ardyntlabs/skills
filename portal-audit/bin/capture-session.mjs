#!/usr/bin/env node
// Resolve browser authentication once, at Phase 0, not at Phase 5.
// See reference/13-data-access.md, Authentication.
//
//   node bin/capture-session.mjs --run <dir>
//
// Opens a headed browser at the instance login page. The auditor completes the
// login interactively, including SSO. The resulting session is saved so the
// headless crawl can reuse it, and so additional personas can be obtained by
// impersonating from within that same session rather than negotiating a second
// SSO login.
//
// This ONE login is also, by default, what authenticates every Table API call
// in every other phase (see lib/session.mjs, lib/session-auth.mjs). No
// separate service account, OAuth client, or dedicated credential is needed
// unless the customer has independently chosen to provision one -- this skill
// never creates a user or credential on the customer's instance to get one.
// Run this BEFORE bin/phase0.mjs, not after: phase0 already needs the Table
// API, which now depends on this session existing.
//
// The saved session is credential material. It is written to <run>/.auth/ and
// bin/finish-run.mjs deletes it at the end of the run. It is NOT covered by the
// keep-by-default retention rule that applies to cache/ and screenshots/.

import path from 'node:path';
import { openSession, parseArgs, die } from '../lib/session.mjs';
import { ReadOnlyBrowser } from '../lib/browser.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');

// requireAuth: false -- this script is what CREATES the session every other
// phase's openSession() call will require. It cannot itself demand one exist
// yet.
const { runFolder, config, metadata } = await openSession(args.run, { requireAuth: false });
if (!metadata?.authorization?.confirmed) die('No confirmed authorization in metadata.json. Run bin/init-run.mjs first.');

const storageStatePath = path.join(runFolder.root, '.auth', 'storage-state.json');

try {
  await ReadOnlyBrowser.captureSession({ instanceBase: config.base, storageStatePath });
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        storageStatePath,
        note:
          'Session captured. Phases 5 and 6 can now run headless against this login, and so can every other ' +
          'phase\'s Table API access -- this one login is the only credential this audit uses, unless the customer ' +
          'has separately provisioned a dedicated SN_TOKEN/SN_USER credential.',
      },
      null,
      2,
    ) + '\n',
  );
} catch (err) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        error: String(err),
        fallbackLadder: [
          'Preferred: interactive login once as admin, reused here. That is what just failed.',
          'Alternative: a local-login-capable service account exempted from SSO for the audit window.',
          'Fallback: the auditor drives the browser manually for a scripted checklist while the skill runs every platform-side phase. Degraded, but the audit still delivers.',
        ],
        consequence:
          'If no browser session can be established at all, Phases 5 and 6 do not run, and Phases 6, 8 and 9 degrade to their platform-only findings. That must be stated plainly in the report, not silently omitted.',
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(5);
}
