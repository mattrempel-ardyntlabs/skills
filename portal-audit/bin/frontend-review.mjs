#!/usr/bin/env node
// Phase 6: front-end and experience review, per unique page template.
//
//   node bin/frontend-review.mjs --run <dir> --persona admin [--langs es,de] [--limit N]
//
// Every unique template is reviewed by default. --limit is an explicit
// opt-in for a quick sample, never the default: reference/10-frontend-review.md
// asks for "a baseline screenshot for every unique template, at every width
// tested, for every persona used", and neither documented invocation
// (SKILL.md, agents/frontend-agent.md) passes --limit at all.
//
// Run per unique page template, not per rendered instance of a templated page.
// One kb_article template covers a thousand articles. Templates come from the
// Phase 5 page inventory, deduplicated on page ID.
//
// For each template, at mobile, tablet and desktop:
//   baseline screenshot, axe-core violations, horizontal overflow, heading and
//   landmark structure, request count and page weight.
// Per requested language: the rendered text is captured so the frontend-agent
// can measure translation coverage rather than reporting a binary.
//
// This produces observations. The frontend-agent turns them into findings.

import path from 'node:path';
import { openSession, parseArgs, die } from '../lib/session.mjs';
import { ReadOnlyBrowser, WIDTHS } from '../lib/browser.mjs';
import { buildPageUrl } from '../lib/portal-url.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');

const { runFolder, config, log, context } = await openSession(args.run);
if (!context) die('No shared-context.json. Run bin/phase1.mjs first.');

const persona = args.persona ?? 'admin';
const entry = context.personaRegistry.find((p) => p.name === persona);
if (!entry) die(`Persona "${persona}" is not in the run's persona registry.`);

const inventory = await runFolder.readJson(runFolder.inventoryPath, null);
if (!inventory?.pageInventory?.length) {
  die('No page inventory. Run bin/crawl.mjs first. Without a crawl, Phase 6 cannot run and the report must say so.');
}

// Unique templates: one entry per page ID, preferring a node that rendered.
const templates = new Map();
for (const node of inventory.pageInventory) {
  if (node.persona !== persona) continue;
  const id = node.actualPageId ?? node.pageId;
  if (!id) continue;
  const existing = templates.get(id);
  if (!existing || (existing.outcome !== 'ok' && node.outcome === 'ok')) templates.set(id, node);
}
// No artificial default. The old default of 40 silently reviewed 40 of the
// 148 admin templates on the esc-2026-09-11 run and said nothing at all about
// the other 108, so Phase 6 reported a clean bill of health for pages it had
// never loaded. Worse, the 40 were taken in map-insertion order rather than by
// usefulness: replaying that run's frontend-observations.admin.json shows 23
// of the 40 rendered "Not Found", leaving 17 genuinely reviewed templates --
// 11.5% real coverage. Reviewing every template is the documented contract
// (reference/10-frontend-review.md); --limit stays as an explicit, opt-in
// sample for a quick pass.
// parseArgs() turns a valueless `--limit` into boolean true, which Number()
// would quietly coerce to 1 and review a single template. Reject it instead.
let limit = Infinity;
if (args.limit !== undefined) {
  limit = Number(args.limit);
  if (args.limit === true || !Number.isFinite(limit) || limit < 1) {
    die(`--limit must be a positive number, got "${args.limit}". Omit --limit to review every template.`);
  }
}
const list = Number.isFinite(limit) ? [...templates.values()].slice(0, limit) : [...templates.values()];
const langs = args.langs ? String(args.langs).split(',').map((s) => s.trim()).filter(Boolean) : [];

const storageStatePath = path.join(runFolder.root, '.auth', 'storage-state.json');
const browser = await ReadOnlyBrowser.launch({
  instanceBase: config.base,
  storageStatePath,
  screenshotsDir: runFolder.screenshotsDir,
  log,
  headless: !args.headed,
});

// Ctrl-C or a kill signal bypasses the try/finally below. Without this, an
// interrupted persona review leaves the shared session impersonated for
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

const results = [];
const observationsPath = path.join(runFolder.root, `frontend-observations.${persona}.json`);
// Write once up front so the file exists even if `list` turns out empty (for
// example, running --persona employee straight after an admin-only crawl):
// stdout would otherwise report templatesReviewed: 0 with no observations
// file to explain why.
await runFolder.writeJson(observationsPath, { persona, templatesReviewed: 0, templatesTotal: list.length, widths: WIDTHS, languages: langs, results });

try {
  if (persona !== 'admin') {
    if (!entry.underlying_user) die(`Persona "${persona}" has no underlying_user to impersonate.`);
    await browser.startImpersonation(persona, entry.underlying_user);
  }
  const [tab] = await browser.openTabs(1);

  for (const node of list) {
    const pageId = node.actualPageId ?? node.pageId;
    const record = { pageId, title: node.title, widths: {}, languages: {}, persona };

    for (const [widthName, width] of Object.entries(WIDTHS)) {
      const url = buildPageUrl(config.base, context.portalSuffix, pageId, node.params ?? {});
      // Set the viewport BEFORE navigating, not after: load-time responsive
      // logic (widgets that check window width once, at initial digest) does
      // not re-run on a post-load resize.
      await tab.setViewport(width);
      const nav = await tab.navigate(url);
      const shot = await tab.screenshot(`${pageId}__${widthName}__${persona}`);
      const observed = await tab.observe({ accessibility: widthName === 'desktop', aria: false });
      const timing = await tab.timing();
      record.widths[widthName] = {
        url: nav.url,
        status: nav.status,
        screenshot: path.relative(runFolder.root, shot),
        horizontalOverflow: observed.horizontalOverflow,
        scrollWidth: observed.scrollWidth,
        clientWidth: observed.clientWidth,
        imagesWithoutAlt: observed.imagesWithoutAlt,
        headings: observed.headings.slice(0, 20),
        landmarks: observed.landmarks,
        formCount: observed.formCount,
        widgetIds: [...new Set(observed.widgets.map((w) => w.widgetId).filter(Boolean))],
        widgetSysIds: [...new Set(observed.widgets.map((w) => w.widgetSysId).filter(Boolean))],
        widgetCount: observed.widgets.length,
        // A template can be in the inventory with outcome "ok" from the crawl
        // and still render "Page not found" here. Record it, so coverage
        // counts reviewed templates that actually rendered rather than
        // templates that were merely visited: 23 of the 40 reviewed on the
        // esc-2026-09-11 run were Not Found and nothing in the output said so.
        pageNotFound: observed.pageNotFound,
        notAuthorizedMessage: observed.notAuthorizedMessage,
        timing,
        axe: widthName === 'desktop' ? observed.axe : undefined,
        baselineTextLength: observed.bodyTextLength,
        baselineTextSample: widthName === 'desktop' ? observed.bodyTextSample : undefined,
      };
    }

    // Translations. The lang parameter and the guest-language path segment are
    // the documented way to exercise translations without changing a profile.
    for (const lang of langs) {
      const url = buildPageUrl(config.base, context.portalSuffix, pageId, node.params ?? {}, { lang, guestLang: lang });
      await tab.navigate(url);
      const observed = await tab.observe();
      const shot = await tab.screenshot(`${pageId}__desktop__${persona}__${lang}`, { width: WIDTHS.desktop });
      record.languages[lang] = {
        url,
        htmlLang: observed.lang,
        textLength: observed.bodyTextLength,
        textSample: observed.bodyTextSample,
        horizontalOverflow: observed.horizontalOverflow,
        screenshot: path.relative(runFolder.root, shot),
      };
    }

    results.push(record);
    await runFolder.writeJson(observationsPath, {
      persona,
      templatesReviewed: results.length,
      templatesTotal: list.length,
      widths: WIDTHS,
      languages: langs,
      results,
    });
  }
} finally {
  await browser.close();
}

process.stdout.write(
  JSON.stringify(
    {
      persona,
      templatesReviewed: results.length,
      templatesAvailable: templates.size,
      limitApplied: Number.isFinite(limit) && templates.size > limit ? limit : null,
      templatesSkippedByLimit: Number.isFinite(limit) ? Math.max(0, templates.size - list.length) : 0,
      // Honest coverage: a template that rendered "Page not found" was
      // visited, not reviewed.
      templatesRendered: results.filter((r) => r.widths.desktop && !r.widths.desktop.pageNotFound).length,
      templatesNotFound: results.filter((r) => r.widths.desktop?.pageNotFound).length,
      widgetsObserved: results.reduce((a, r) => a + (r.widths.desktop?.widgetCount ?? 0), 0),
      languages: langs,
      axeAvailable: results.some((r) => r.widths.desktop?.axe && !r.widths.desktop.axe.error),
      file: observationsPath,
      manualChecksStillRequired: [
        'Keyboard navigation through each template, including custom widgets',
        'Visible focus indicators and focus order matching visual order',
        'Focus trapping in modals and focus return on close',
        'Skip links',
        'Screen reader announcement of dynamic content, which Angular widgets frequently get wrong',
        'Form error announcement and association with fields',
      ],
      note: 'Automated tooling catches roughly a third of real accessibility issues. The manual list above is not optional.',
    },
    null,
    2,
  ) + '\n',
);
