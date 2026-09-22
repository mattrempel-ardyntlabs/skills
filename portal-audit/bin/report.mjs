#!/usr/bin/env node
// Phase 10: assemble report.md from findings/*.json.
//
//   node bin/report.mjs --run <dir> [--compare] [--no-validate]
//
// Regenerating the report never touches the instance. Every finding is
// validated before it reaches the report, so a schema violation stops the
// report rather than appearing in it, silently wrong.

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { openSession, parseArgs, die } from '../lib/session.mjs';
import { RunFolder } from '../lib/run-folder.mjs';
import { validateFindings } from '../lib/findings.mjs';
import { assembleReport, loadAllFindings, compareRuns } from '../lib/report.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');

// requireAuth: false -- assembling the report reads findings/*.json off disk
// and never queries the instance (see the header comment above). Requiring
// auth here would mean report.md could never be regenerated after
// bin/finish-run.mjs has deleted .auth/, which is exactly when a correction
// or a --compare re-run is most likely to be needed.
const { runFolder, context, metadata, log } = await openSession(args.run, { requireAuth: false });
if (!context) die('No shared-context.json. Run bin/phase1.mjs first.');

const findings = await loadAllFindings(runFolder);
if (!findings.length) die('No findings in <run>/findings/. Nothing to assemble.');

if (!args['no-validate']) {
  const ctx = {
    personas: context.personaRegistry.map((p) => p.name),
    writeExceptions: metadata?.write_exception?.name ? [metadata.write_exception.name] : [],
    portalBase: `${context.instanceBase}/${context.portalSuffix}`,
  };
  const byPhase = new Map();
  for (const f of findings) {
    // _file is bookkeeping added by loadAllFindings, not part of the schema.
    const { _file, ...schemaShape } = f;
    if (!byPhase.has(f.phase)) byPhase.set(f.phase, []);
    byPhase.get(f.phase).push(schemaShape);
  }
  const problems = [];
  for (const [phase, rows] of byPhase) {
    const res = validateFindings(rows, { ...ctx, phase, adminOnlyRun: context.adminOnlyRun });
    if (!res.ok) {
      problems.push({
        phase,
        fileErrors: res.fileErrors,
        errors: res.results.filter((r) => r.errors.length).map((r) => ({ id: r.id, errors: r.errors })),
      });
    }
  }
  if (problems.length) {
    process.stdout.write(JSON.stringify({ ok: false, problems }, null, 2) + '\n');
    process.stderr.write('\nReport not assembled. Fix the findings above, or pass --no-validate to see the draft anyway.\n');
    process.exit(7);
  }
}

let comparison = null;
if (args.compare && metadata?.priorRun) {
  const prior = new RunFolder(metadata.priorRun);
  const priorFindings = await loadAllFindings(prior);
  if (priorFindings.length) comparison = compareRuns(findings, priorFindings);
}

const inventory = await runFolder.readJson(runFolder.inventoryPath, null);
const meta = { ...metadata, errorSummary: await summarizeErrors(runFolder) };

const markdown = await assembleReport({ runFolder, metadata: meta, context, findings, comparison, inventory });

if (/[—–]/.test(markdown)) {
  die('Assembled report contains an em or en dash. Skill output uses none. Fix the source finding and re-run.');
}

await writeFile(runFolder.reportPath, markdown, 'utf8');
await log.event('report.assembled', { findings: findings.length, compared: Boolean(comparison) });

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      report: runFolder.reportPath,
      findings: findings.length,
      published: findings.filter((f) => f.status === 'published').length,
      withheld: findings.filter((f) => f.status === 'withheld').length,
      compared: Boolean(comparison),
      priorRun: metadata?.priorRun ?? null,
      next: [
        'Offer the operator a PDF alongside the Markdown: node bin/report-pdf.mjs --run <run> [--narrative <file.json>]. See reference/17-pdf-report.md.',
        'Offer to delete cache/ and screenshots/. Do not delete by default.',
        'Delete <run>/.auth/, which holds session credential material.',
      ],
    },
    null,
    2,
  ) + '\n',
);

async function summarizeErrors(rf) {
  const { RunLog } = await import('../lib/run-log.mjs');
  const rl = new RunLog(rf.logsDir);
  const rows = await rl.read('errors.jsonl');
  if (!rows.length) return null;
  const out = {};
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}
