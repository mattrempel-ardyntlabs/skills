#!/usr/bin/env node
// One-time setup for the browser phases.
//
//   node bin/setup.mjs [--skip-install]
//
// Three things:
//   1. Make Playwright resolvable (installs it locally if it is not already).
//   2. Vendor axe-core into vendor/axe.min.js, so the accessibility checks work
//      offline and at a pinned version.
//   3. Install pdf-lib, needed only by bin/report-pdf.mjs.
//
// The platform-side phases (0 to 4, 7 to 9) need none of this except pdf-lib,
// and only then if a PDF is requested. Run setup fully when the browser
// phases are in scope; --skip-install still leaves report.mjs (Markdown)
// working with nothing installed.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/session.mjs';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const AXE_VERSION = '4.10.2';
const AXE_URL = `https://cdnjs.cloudflare.com/ajax/libs/axe-core/${AXE_VERSION}/axe.min.js`;

const args = parseArgs(process.argv.slice(2));
const report = { playwright: null, axe: null };

// 1. Playwright.
try {
  const { loadPlaywright } = await import('../lib/browser.mjs');
  await loadPlaywright();
  report.playwright = { ok: true, source: 'already resolvable' };
} catch {
  if (args['skip-install']) {
    report.playwright = { ok: false, note: 'not installed, and --skip-install was passed' };
  } else {
    try {
      await exec('npm', ['install', '--no-audit', '--no-fund', 'playwright'], { cwd: ROOT, timeout: 600000 });
      await exec('npx', ['playwright', 'install', 'chromium'], { cwd: ROOT, timeout: 900000 });
      report.playwright = { ok: true, source: 'installed locally' };
    } catch (err) {
      report.playwright = {
        ok: false,
        error: String(err).slice(0, 400),
        note:
          'Phases 5 and 6 cannot run without a browser. The audit is still useful without them: run every platform-side phase ' +
          'and state plainly in the report that the crawl-dependent parts of Phases 6, 8 and 9 are absent.',
      };
    }
  }
}

// 2. axe-core.
const axePath = path.join(ROOT, 'vendor', 'axe.min.js');
const existing = await stat(axePath).catch(() => null);
if (existing && existing.size > 100000) {
  report.axe = { ok: true, source: 'already vendored', path: axePath, bytes: existing.size };
} else {
  try {
    const res = await fetch(AXE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const source = await res.text();
    await mkdir(path.dirname(axePath), { recursive: true });
    await writeFile(axePath, source, 'utf8');
    report.axe = { ok: true, source: AXE_URL, version: AXE_VERSION, path: axePath, bytes: source.length };
  } catch (err) {
    report.axe = {
      ok: false,
      error: String(err),
      note: `Download ${AXE_URL} manually to vendor/axe.min.js. Without it, Phase 6 accessibility checks are manual only.`,
    };
  }
}

// 3. pdf-lib, for bin/report-pdf.mjs.
try {
  await import('pdf-lib');
  report.pdfLib = { ok: true, source: 'already resolvable' };
} catch {
  if (args['skip-install']) {
    report.pdfLib = { ok: false, note: 'not installed, and --skip-install was passed' };
  } else {
    try {
      await exec('npm', ['install', '--no-audit', '--no-fund', 'pdf-lib'], { cwd: ROOT, timeout: 120000 });
      report.pdfLib = { ok: true, source: 'installed locally' };
    } catch (err) {
      report.pdfLib = { ok: false, error: String(err).slice(0, 400), note: 'bin/report-pdf.mjs cannot run without it. report.mjs (Markdown) is unaffected.' };
    }
  }
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exit(report.playwright?.ok && report.axe?.ok && report.pdfLib?.ok ? 0 : 1);
