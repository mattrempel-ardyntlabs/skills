#!/usr/bin/env node
// Write and validate findings. Every sub-agent's output goes through here.
//
//   node bin/findings.mjs add      --run <dir> --phase 3 --file my-findings.json [--slug taxonomy]
//   node bin/findings.mjs validate --run <dir> [--phase 3]
//
// "add" validates against reference/16-findings-schema.md and refuses to write
// anything that fails. A sub-agent cannot get an invalid finding into the run.
// Findings land in <run>/findings/phase-<n>-<slug>.json as a JSON array.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { openSession, parseArgs, die } from '../lib/session.mjs';
import { validateFindings } from '../lib/findings.mjs';

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!args.run) die('--run <run folder> is required.');

// requireAuth: false -- this only validates and writes findings JSON that a
// sub-agent already produced; it never queries the instance itself.
const { runFolder, context, metadata, config } = await openSession(args.run, { requireAuth: false });
const ctxBase = {
  personas: (context?.personaRegistry ?? [{ name: 'admin' }]).map((p) => p.name),
  writeExceptions: metadata?.write_exception?.name ? [metadata.write_exception.name] : [],
  instanceHost: config.host,
  portalBase: context ? `${context.instanceBase}/${context.portalSuffix}` : undefined,
  adminOnlyRun: context?.adminOnlyRun ?? true,
};

if (command === 'add') {
  if (!args.file) die('--file <findings json array> is required.');
  const phase = Number(args.phase);
  if (!Number.isInteger(phase)) die('--phase <0-10> is required.');
  const findings = JSON.parse(await readFile(args.file, 'utf8'));
  const result = validateFindings(findings, { ...ctxBase, phase });

  if (!result.ok) {
    process.stdout.write(JSON.stringify({ accepted: false, ...report(result) }, null, 2) + '\n');
    process.stderr.write('\nFindings rejected. Fix them and re-run. Nothing was written.\n');
    process.exit(7);
  }
  const slug = args.slug ? String(args.slug).replace(/[^\w-]/g, '-') : 'findings';
  const target = path.join(runFolder.findingsDir, `phase-${phase}-${slug}.json`);
  await runFolder.writeJson(target, findings);
  process.stdout.write(
    JSON.stringify({ accepted: true, written: target, count: findings.length, warnings: report(result).warnings }, null, 2) + '\n',
  );
} else if (command === 'validate') {
  const files = await runFolder.findingsFiles();
  const summary = [];
  let ok = true;
  for (const file of files) {
    const m = /^phase-(\d+)-/.exec(file);
    const phase = m ? Number(m[1]) : undefined;
    const findings = await runFolder.readJson(path.join(runFolder.findingsDir, file), []);
    const result = validateFindings(findings, { ...ctxBase, phase });
    if (!result.ok) ok = false;
    summary.push({ file, count: findings.length, ...report(result) });
  }
  process.stdout.write(JSON.stringify({ ok, files: summary }, null, 2) + '\n');
  if (!ok) process.exit(7);
} else {
  die('usage: findings.mjs <add|validate> --run <dir> [...]');
}

function report(result) {
  return {
    fileErrors: result.fileErrors,
    errors: result.results.filter((r) => r.errors.length).map((r) => ({ id: r.id, errors: r.errors })),
    warnings: result.results.filter((r) => r.warnings.length).map((r) => ({ id: r.id, warnings: r.warnings })),
  };
}
