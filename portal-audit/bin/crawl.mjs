#!/usr/bin/env node
// Phase 5: browser reachability crawl, one persona at a time.
//
//   node bin/crawl.mjs --run <dir> --persona admin [--tabs 3] [--resume] [--raise-budget 250]
//
// Budget: 500 page nodes or 100 minutes wall clock per persona. On hitting
// either limit this exits with code 6 and a clear statement of what was and was
// not reached. The operator decides whether to raise the limit and continue or
// to finalize with a partial result. Never raise a limit without asking, on the
// second and third hit as much as the first.
//
// Personas are crawled sequentially, never in parallel with each other, because
// impersonation is one identity per session.

import path from 'node:path';
import { openSession, parseArgs, die } from '../lib/session.mjs';
import { ReadOnlyBrowser } from '../lib/browser.mjs';
import { runCrawl, emptyState, DEFAULT_BUDGET, MAX_TABS, reconcile } from '../lib/crawl.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');

const { runFolder, config, log, context } = await openSession(args.run);
if (!context) die('No shared-context.json. Run bin/phase1.mjs first.');

const persona = args.persona ?? 'admin';
const entry = context.personaRegistry.find((p) => p.name === persona);
if (!entry) die(`Persona "${persona}" is not in the run's persona registry: ${context.personaRegistry.map((p) => p.name).join(', ')}`);

const tabCount = Math.min(Number(args.tabs ?? 3), MAX_TABS);
const seedsFile = await runFolder.readJson(path.join(runFolder.root, 'seeds.json'), { seeds: [], parameterHints: {} });
// Written by bin/phase1.mjs from sp_instance.sp_widget. The crawl joins each
// rendered widget's sys_id against it to decide placement, instead of inferring
// it from a DOM instance-id attribute that is almost never present.
const composition = await runFolder.readJson(path.join(runFolder.root, 'page-composition.json'), null);
const statePath = path.join(runFolder.root, `crawl-state.${persona}.json`);

let state = args.resume ? await runFolder.readJson(statePath, null) : null;
if (!state) state = emptyState(persona);

const budget = {
  maxNodes: DEFAULT_BUDGET.maxNodes + Number(args['raise-budget'] ?? 0),
  maxMinutes: DEFAULT_BUDGET.maxMinutes + Number(args['raise-minutes'] ?? 0),
};
if (args['raise-budget'] || args['raise-minutes']) {
  await log.event('crawl.budget-raised', { persona, budget, note: 'Operator approved. Never raise without asking.' });
}

const storageStatePath = path.join(runFolder.root, '.auth', 'storage-state.json');
const browser = await ReadOnlyBrowser.launch({
  instanceBase: config.base,
  storageStatePath,
  screenshotsDir: runFolder.screenshotsDir,
  log,
  headless: !args.headed,
});

// Ctrl-C or a kill signal bypasses the try/finally below. Without this, an
// interrupted persona crawl leaves the shared session impersonated for
// every later phase, silently. browser.close() already stops impersonation.
let cleaningUp = false;
async function onSignal(signal) {
  if (cleaningUp) return;
  cleaningUp = true;
  process.stderr.write(`\nReceived ${signal}. Stopping impersonation and closing the browser before exit...\n`);
  await browser.close().catch(() => {});
  process.exit(130);
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

let summary;
try {
  if (persona !== 'admin') {
    if (!entry.underlying_user) die(`Persona "${persona}" has no underlying_user to impersonate.`);
    await browser.startImpersonation(persona, entry.underlying_user);
  }

  const tabs = await browser.openTabs(tabCount);
  summary = await runCrawl({
    tabs,
    portal: { instanceBase: config.base, suffix: context.portalSuffix },
    seeds: seedsFile.seeds,
    persona,
    state,
    budget,
    parameterHints: await loadParameterSamples(),
    widgetInstanceIndex: composition?.widgetInstanceIndex ?? null,
    widgetInstanceIndexComplete: composition?.widgetInstanceIndexComplete === true,
    persist: (s) => runFolder.writeJson(statePath, s),
    log,
  });
} finally {
  // Always stop impersonation, even if the phase failed partway through.
  await browser.close();
}

// Merge this persona's inventory into the run-wide inventory.
const inventory = (await runFolder.readJson(runFolder.inventoryPath, { pageInventory: [], widgetInventory: [], byPersona: {} })) ?? {
  pageInventory: [],
  widgetInventory: [],
  byPersona: {},
};
inventory.pageInventory = [...inventory.pageInventory.filter((p) => p.persona !== persona), ...state.pageInventory];
inventory.widgetInventory = [...inventory.widgetInventory.filter((w) => w.persona !== persona), ...state.widgetInventory];
inventory.byPersona[persona] = summary;
await runFolder.writeJson(runFolder.inventoryPath, inventory);
await runFolder.writeJson(runFolder.crawlStatePath, { ...state, note: `Per-persona state lives in crawl-state.<persona>.json` });

// Reconciliation. Configured set comes from the seed frontier, which is the
// platform-side view of what this portal is supposed to reach.
const configuredPageIds = [...new Set(seedsFile.seeds.map((s) => s.pageId).filter(Boolean))];
const reconciliation = reconcile({ crawlState: state, configuredPageIds });

const result = {
  persona,
  tabs: tabCount,
  ...summary,
  reconciliation: context.adminOnlyRun
    ? {
        status: 'withheld',
        reason:
          'Only the admin persona was crawled. This reconciliation only means something relative to a real, non-admin view. Write the withheld placeholder finding into findings/phase-5-*.json rather than omitting it.',
      }
    : reconciliation,
  reconciliationData: reconciliation,
  statePath,
};
await runFolder.writeJson(path.join(runFolder.root, `crawl-summary.${persona}.json`), result);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');

if (summary.status === 'budget_exceeded') {
  process.stderr.write(
    `\nCrawl budget reached (${summary.budgetLimitHit}) for persona "${persona}".\n` +
      `Reached ${summary.nodesVisited} page nodes in ${summary.elapsedMinutes} minutes. ${summary.nodesQueued} nodes remain queued.\n` +
      'Ask the operator: raise the limit and continue from where it stopped (--resume --raise-budget N), or finalize with a partial result.\n',
  );
  process.exit(6);
}

async function loadParameterSamples() {
  // Pages requiring sys_id or table cannot be reached by link-following alone.
  // seeds.json lists which pages need which parameters, discovered from
  // $sp.getParameter calls in their widgets' server scripts. The orchestrator
  // writes one representative record per page into parameter-samples.json
  // (pageId -> [{param: value}]). Do not enumerate all records.
  //
  // Without samples, parameterized pages are visited bare and land in the
  // "missing_parameters_or_unauthorized" outcome bucket, which is the honest
  // result rather than a silent gap.
  const samples = await runFolder.readJson(path.join(runFolder.root, 'parameter-samples.json'), null);
  return samples ?? {};
}
