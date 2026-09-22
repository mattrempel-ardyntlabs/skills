#!/usr/bin/env node
// Phase 10: render report.pdf alongside report.md, from the same
// findings/*.json report.mjs already reads. Never touches the instance.
//
//   node bin/report-pdf.mjs --run <dir> [--narrative <file.json>]
//
// --narrative supplies the one thing this script cannot derive on its own:
// the exec-summary headline and the "what to do next" synthesis, which are
// a judgment call the same way authoring a finding is (SKILL.md: "Author
// the Phase 1 findings yourself from the observations"). Shape:
//
//   {
//     "headline": "one sentence, client-readable",
//     "scopeNote": "one sentence describing what was audited (optional)",
//     "nextSteps": [{"title": "...", "detail": "..."}, ...]  (optional)
//   }
//
// Without --narrative, the PDF still renders, with a plain, mechanically
// assembled headline and next-steps list built from the top findings, and
// this script says so on stdout so the gap doesn't go unnoticed.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { openSession, parseArgs, die } from '../lib/session.mjs';
import { loadAllFindings, readRunFacts } from '../lib/report.mjs';
import { buildPdfData } from '../lib/pdf/data.mjs';
import { renderPdf } from '../lib/pdf/render.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const THEME_DIR = path.join(HERE, '..', 'assets', 'pdf-theme');

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');

// requireAuth: false, same reasoning as bin/report.mjs: this only reads
// findings/*.json and screenshots/ off disk, so it must keep working after
// bin/finish-run.mjs has deleted .auth/.
const { runFolder, context, metadata, log } = await openSession(args.run, { requireAuth: false });
if (!context) die('No shared-context.json. Run bin/phase1.mjs first.');

const findings = await loadAllFindings(runFolder);
if (!findings.length) die('No findings in <run>/findings/. Nothing to render.');

let narrative = null;
if (args.narrative) {
  narrative = JSON.parse(await readFile(args.narrative, 'utf8'));
}

// The same facts bin/report.mjs checks findings against, read off this run's
// own artifacts. Without them the PDF would publish a finding report.md holds
// back, and the two deliverables would disagree.
const runFacts = await readRunFacts(runFolder);

const data = buildPdfData({ context, metadata, findings, narrative, runFacts });

// Same rule bin/report.mjs enforces on report.md: no em or en dash in
// generated output. Checking the whole data object, not just the narrative,
// catches one carried in a finding's own title or description too.
if (/[—–]/.test(JSON.stringify(data))) {
  die('Assembled PDF data contains an em or en dash. Skill output uses none. Fix the source finding or narrative and re-run.');
}

const outPath = path.join(runFolder.root, 'report.pdf');
const assets = { themeDir: THEME_DIR, screenshotsDir: runFolder.screenshotsDir };

const stats = await renderPdf({ data, assets, outPath });
await log.event('report_pdf.rendered', {
  pages: stats.totalPages,
  narrativeGenerated: data.narrative.generated,
  heldBack: data.totals.heldBack,
  amended: data.totals.amended,
});

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      pdf: outPath,
      pages: stats.totalPages,
      narrativeGenerated: data.narrative.generated,
      // Same triage bin/report.mjs applies to report.md. Printed so a PDF that
      // is shorter than the findings folder says why on stdout.
      findingsHeldBack: data.heldBackFindings,
      findingsAmended: data.amendedFindings,
      note: data.narrative.generated
        ? 'No --narrative supplied. The headline and next-steps were assembled mechanically from the top findings. Pass --narrative for an authored exec summary.'
        : null,
    },
    null,
    2,
  ) + '\n',
);
