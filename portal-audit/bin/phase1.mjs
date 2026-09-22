#!/usr/bin/env node
// Phase 1: portal record and bindings, plus the shared context payload and the
// crawl seed frontier.
//
//   node bin/phase1.mjs --run <dir> [--personas personas.json] [--release Australia]
//
// Writes:
//   <run>/shared-context.json   the small payload every sub-agent receives
//   <run>/phase1-observations.json  the facts the orchestrator turns into findings
//   <run>/seeds.json            the crawl seed frontier for Phase 5
//
// The orchestrator authors the Phase 1 findings from the observations. This
// script does not invent findings; it establishes facts.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { openSession, parseArgs, die } from '../lib/session.mjs';
import { extractPageIds, extractParameterNames, findHardcodedPortalPaths } from '../lib/portal-url.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');

const { api, runFolder, config, metadata, log } = await openSession(args.run);
const phase0 = await runFolder.readJson(path.join(runFolder.root, 'phase0.json'), null);
if (!phase0?.probes?.portal?.resolved) die('Run bin/phase0.mjs first, and resolve any fatal scope issue it reports.');

const suffix = phase0.suffix;
// phase0.probes.portal is { row: {...} } when exactly one sp_portal matched
// the suffix, or { rows: [...] } (plural) when more than one did -- the
// platform does not enforce a unique url_suffix, and bin/phase0.mjs already
// warns when that happens rather than picking one silently. Handle both
// shapes explicitly instead of assuming .row exists.
const portalCandidates = phase0.probes.portal.rows ?? (phase0.probes.portal.row ? [phase0.probes.portal.row] : []);
if (portalCandidates.length !== 1) {
  die(
    `${portalCandidates.length} sp_portal record(s) share url_suffix "${suffix}" per phase0.json. Exactly one must ` +
      'match before Phase 1 can proceed. Resolve this with the operator (phase0.json already warned about it if there ' +
      'was more than one) rather than guessing which record is the real portal.',
  );
}
const portalRow = portalCandidates[0];
const portalSysId = value(portalRow.sys_id);

// ---------------------------------------------------------------------------
// The whole portal record, not selected fields. reference/01-portal-record.md.
// ---------------------------------------------------------------------------
const portalFull = await api.get('sp_portal', {
  fields: [
    // No 'main_menu': sp_portal has no such column. "Main menu" is the form
    // label for sp_rectangle_menu (reference/01-portal-record.md,
    // reference/03-routing-reachability.md). A bad field name is silently
    // dropped from a Table API response rather than erroring, so asking for it
    // looked like an unconfigured portal instead of a failed query.
    'sys_id', 'title', 'url_suffix', 'homepage', 'login_page', 'notfound_page', 'default_title', 'theme',
    'kb_knowledge_base', 'sc_catalog', 'notification', 'quick_start_config', 'css_variables',
    'logo', 'icon', 'inactive', 'alternate_portal', 'enable_ais', 'search_source', 'search_application', 'sp_rectangle_menu',
    'sys_created_on', 'sys_updated_on', 'sys_updated_by', 'sys_class_name',
  ],
  query: `sys_id=${portalSysId}`,
  limit: 1,
  displayValue: 'all',
});
const portal = portalFull.rows[0] ?? portalRow;

const observations = { portal: flatten(portal), checks: {}, counts: {}, gaps: [] };

// Record a readable, skip and continue (reference/13-data-access.md's error
// handling contract) rather than letting a 403 on one table quietly collapse
// into an empty array with no trace of why in this phase's own output.
function recordGap(res, label) {
  if (res.error) {
    observations.gaps.push({ label, status: res.status, error: String(res.error).slice(0, 300) });
  }
  return res;
}

// ---------------------------------------------------------------------------
// Homepage, login page and 404 page must resolve to existing, active pages.
// ---------------------------------------------------------------------------
const pageRefs = {
  homepage: value(portal.homepage),
  login_page: value(portal.login_page),
  notfound_page: value(portal.notfound_page),
};
const pageSysIds = Object.values(pageRefs).filter(Boolean);
const boundPages = pageSysIds.length
  ? await api.get('sp_page', {
      fields: ['sys_id', 'id', 'title', 'public', 'roles', 'draft', 'internal', 'sys_updated_on'],
      query: `sys_idIN${pageSysIds.join(',')}`,
      limit: 10,
    })
  : { rows: [] };
const byId = Object.fromEntries((boundPages.rows ?? []).map((r) => [value(r.sys_id), flatten(r)]));
observations.checks.boundPages = Object.fromEntries(
  Object.entries(pageRefs).map(([slot, sysId]) => [
    slot,
    sysId
      ? byId[sysId]
        ? { ok: true, ...byId[sysId] }
        : { ok: false, sys_id: sysId, problem: 'referenced page record does not resolve' }
      : { ok: false, problem: 'field is empty on the portal record' },
  ]),
);

// ---------------------------------------------------------------------------
// Search chain. Live engine is a per-portal fact read from the record.
// ---------------------------------------------------------------------------
const aiSearchOn = value(portal.enable_ais) === 'true';
// The portal record's own search_application field is the authoritative
// binding. Confirmed live and empirically: deriving this instead from a
// broader `sys_search_context_config` query (portal=X^ORportalISEMPTY,
// taking the first row) can silently pick up a DIFFERENT portal's search
// application when two portals each have their own. That happened on this
// instance: the derived value for "esc" was actually "sp"'s Search
// Application, and the resulting finding (an unpublished profile) belonged
// to sp alone, not esc. Read the direct field first; only fall back to the
// broader discovery query if the portal record leaves it empty.
const boundSearchAppSysId = value(portal.search_application);
let searchApplication = null;
if (aiSearchOn) {
  const sc = boundSearchAppSysId
    ? await api.get('sys_search_context_config', {
        fields: ['sys_id', 'name', 'search_profile', 'results_limit', 'suggestions_limit', 'active', 'portal'],
        query: `sys_id=${boundSearchAppSysId}`,
        limit: 1,
        displayValue: 'all',
      })
    : await api.get('sys_search_context_config', {
        fields: ['sys_id', 'name', 'search_profile', 'results_limit', 'suggestions_limit', 'active', 'portal'],
        query: `portal=${portalSysId}^ORportalISEMPTY`,
        limit: 20,
        displayValue: 'all',
      });
  searchApplication = sc.error ? { error: sc.error } : (sc.rows ?? []).map(flatten);
  if (!boundSearchAppSysId) {
    observations.gaps.push({
      label: 'sp_portal.search_application',
      note: 'Empty on the portal record. Falling back to a broader sys_search_context_config query (portal=X^ORportalISEMPTY), which is less reliable when more than one portal shares an instance -- confirm the resulting sys_id is actually this portal\'s before trusting downstream findings against it.',
    });
  }
}
const zingSources = aiSearchOn
  ? null
  : await api
      .get('sp_search_source', { fields: ['sys_id', 'id', 'name', 'data_source', 'active'], query: `portal=${portalSysId}`, limit: 100, all: true })
      .then((r) => (r.error ? { error: r.error } : r.rows.map(flatten)));
observations.checks.search = {
  mode: aiSearchOn ? 'ai_search' : 'zing',
  searchApplication,
  zingSources,
  allowList: phase0.probes.search?.allowListProperty ?? null,
  portalOnAllowList: phase0.probes.search?.portalOnAllowList ?? null,
};

// ---------------------------------------------------------------------------
// Seed frontier. Built from platform data, before a browser opens.
// ---------------------------------------------------------------------------
const seeds = [];
const seen = new Set();
const addSeed = (pageId, source, params = {}) => {
  if (!pageId) return;
  const key = `${pageId}|${JSON.stringify(params)}`;
  if (seen.has(key)) return;
  seen.add(key);
  seeds.push({ pageId, params, source });
};

// 1. Homepage, login page, 404 page.
for (const [slot, sysId] of Object.entries(pageRefs)) {
  const page = sysId ? byId[sysId] : null;
  if (page?.id) addSeed(page.id, `portal.${slot}`);
}

// 2. Menu item targets, from the main menu tree.
// sp_rectangle_menu is the column, read directly. The old
// `value(portal.main_menu) || value(portal.sp_rectangle_menu)` fallback only
// ever exercised its right-hand side, because main_menu is not a column on
// sp_portal and came back undefined on every row.
const mainMenuInstance = value(portal.sp_rectangle_menu);
let menuItems = [];
if (mainMenuInstance) {
  const instMenu = await api.get('sp_instance_menu', { fields: ['sys_id', 'sp_rectangle_menu'], query: `sys_id=${mainMenuInstance}`, limit: 5 });
  const menuSysId = value(instMenu.rows?.[0]?.sp_rectangle_menu) ?? mainMenuInstance;
  const items = await api.get('sp_rectangle_menu_item', {
    fields: ['sys_id', 'label', 'type', 'page', 'href', 'roles', 'condition', 'order', 'sp_rectangle_menu', 'parent'],
    query: `sp_rectangle_menu=${menuSysId}`,
    limit: 500,
    all: true,
    displayValue: 'all',
  });
  menuItems = (items.rows ?? []).map(flatten);

  // Resolve item.page (a sp_page sys_id) to the page's actual `id` field
  // rather than trusting item.page_display: sys_dictionary's chosen display
  // column for a reference field is instance-configurable and is not
  // guaranteed to be `id` (it could be `title`). Seeding the crawl with the
  // wrong string silently poisons the frontier with pages that will never
  // resolve. See reference/14-open-questions.md.
  const menuPageSysIds = [...new Set(menuItems.map((i) => i.page).filter(Boolean))];
  const menuPageIdBySysId = {};
  if (menuPageSysIds.length) {
    const menuPages = recordGap(
      await api.get('sp_page', { fields: ['sys_id', 'id'], query: `sys_idIN${menuPageSysIds.join(',')}`, limit: 500, all: true }),
      'sp_page (menu targets)',
    );
    for (const p of menuPages.rows ?? []) menuPageIdBySysId[value(p.sys_id)] = value(p.id);
  }

  for (const item of menuItems) {
    for (const id of extractPageIds(item.href)) addSeed(id, 'menu');
    if (item.page) {
      const resolvedId = menuPageIdBySysId[item.page];
      if (resolvedId) addSeed(resolvedId, 'menu');
      else observations.gaps.push({ label: 'menu item page reference', page_sys_id: item.page, error: 'did not resolve against sp_page' });
    }
  }
}
observations.checks.menu = { instance: mainMenuInstance, itemCount: menuItems.length, items: menuItems.slice(0, 200) };

// 3. sp_instance_link targets.
const links = recordGap(
  await api.get('sp_instance_link', { fields: ['sys_id', 'href', 'title', 'sp_column'], limit: 1000, all: true }),
  'sp_instance_link',
);
for (const l of links.rows ?? []) for (const id of extractPageIds(value(l.href))) addSeed(id, 'sp_instance_link');

// 4. Page IDs in widget templates, scripts and instance options.
const instances = recordGap(
  await api.get('sp_instance', {
    fields: ['sys_id', 'sp_widget', 'sp_column', 'title', 'options', 'sys_class_name'],
    limit: 1000,
    all: true,
    maxRows: Number(args['instance-limit'] ?? 20000),
  }),
  'sp_instance',
);
const widgetSysIds = [...new Set((instances.rows ?? []).map((r) => value(r.sp_widget)).filter(Boolean))];
for (const inst of instances.rows ?? []) for (const id of extractPageIds(value(inst.options))) addSeed(id, 'instance_options');

const widgetBodies = [];
const chunkSize = 50;
const widgetCap = Number(args['widget-limit'] ?? 1500);
for (let i = 0; i < Math.min(widgetSysIds.length, widgetCap); i += chunkSize) {
  const chunk = widgetSysIds.slice(i, i + chunkSize);
  const res = await api.get('sp_widget', {
    fields: ['sys_id', 'id', 'name', 'public', 'roles', 'template', 'client_script', 'script', 'link', 'option_schema', 'sys_created_on', 'sys_updated_on', 'sys_scope'],
    query: `sys_idIN${chunk.join(',')}`,
    limit: chunkSize,
  });
  if (res.error) {
    // Previously a silent `break`: one failed chunk truncated every chunk
    // after it with no trace of why, so bodiesFetched < instancedWidgetCount
    // was indistinguishable from "some sp_instance rows just reference
    // deleted widgets" (also possible, and not an error at all). Record
    // which chunk failed and why, and keep going rather than abandoning the
    // rest of the widget set over one bad chunk.
    observations.gaps.push({ label: 'sp_widget chunk', chunkStart: i, chunkSize: chunk.length, status: res.status, error: String(res.error).slice(0, 300) });
    continue;
  }
  widgetBodies.push(...res.rows.map(flatten));
}
const resolvedWidgetSysIds = new Set(widgetBodies.map((w) => w.sys_id));
const danglingWidgetSysIds = widgetSysIds.filter((id) => !resolvedWidgetSysIds.has(id));
if (danglingWidgetSysIds.length && !observations.gaps.some((g) => g.label === 'sp_widget chunk')) {
  // No fetch error, so this is real: some sp_instance rows reference a
  // sp_widget sys_id that no longer resolves to a record (widget deleted,
  // instance not cleaned up). Distinct from a fetch failure; worth recording
  // as its own fact rather than silently absorbing into "widgets fetched".
  observations.gaps.push({
    label: 'sp_instance references to a non-existent sp_widget',
    count: danglingWidgetSysIds.length,
    widgetSysIds: danglingWidgetSysIds,
    note: 'No chunk fetch failed; these sys_ids simply did not resolve to a sp_widget record.',
  });
}

// Composition hierarchy: sp_page -> sp_container -> sp_row -> sp_column -> sp_instance.
// Needed for three things: the configured page set, page-keyed parameter
// requirements, and the orphaned-container check (a broken sp_container.sp_page
// reference renders nothing, silently, with no error).
const containers = recordGap(
  await api.get('sp_container', { fields: ['sys_id', 'sp_page', 'order'], limit: 1000, all: true, maxRows: 50000 }),
  'sp_container',
);
const rows = recordGap(
  await api.get('sp_row', { fields: ['sys_id', 'sp_container', 'sp_column'], limit: 1000, all: true, maxRows: 50000 }),
  'sp_row',
);
const columns = recordGap(
  await api.get('sp_column', { fields: ['sys_id', 'sp_row', 'size', 'size_md', 'size_sm', 'size_xs'], limit: 1000, all: true, maxRows: 50000 }),
  'sp_column',
);
const allPages = recordGap(
  await api.get('sp_page', {
    fields: ['sys_id', 'id', 'title', 'public', 'roles', 'draft', 'sys_updated_on'],
    limit: 1000,
    all: true,
    maxRows: 50000,
  }),
  'sp_page',
);

const pageById = Object.fromEntries((allPages.rows ?? []).map((r) => [value(r.sys_id), flatten(r)]));
const containerToPage = Object.fromEntries((containers.rows ?? []).map((c) => [value(c.sys_id), value(c.sp_page)]));
const rowToContainer = Object.fromEntries((rows.rows ?? []).map((r) => [value(r.sys_id), value(r.sp_container)]));
const columnToRow = Object.fromEntries((columns.rows ?? []).map((c) => [value(c.sys_id), value(c.sp_row)]));

const orphanedContainers = (containers.rows ?? [])
  .filter((c) => {
    const p = value(c.sp_page);
    return !p || !pageById[p];
  })
  .map((c) => ({ sys_id: value(c.sys_id), sp_page: value(c.sp_page) }));

const widgetToPages = {};
const pageToWidgets = {};
// widget sys_id -> the sp_instance rows that place it. This is the join key the
// Phase 5 crawl needs: lib/crawl.mjs reads a widget's sys_id out of its
// `.v<sys_id>` wrapper class and looks it up here, instead of guessing
// placement from a DOM instance-id attribute that is usually absent.
// sp_instance.sp_widget is the reference to sp_widget (confirmed against the
// cached table__sp_instance__*.json reads in portal-audit-runs/*/cache).
const widgetInstanceIndex = {};
for (const inst of instances.rows ?? []) {
  const col = value(inst.sp_column);
  const pageSysId = containerToPage[rowToContainer[columnToRow[col]]];
  const page = pageSysId ? pageById[pageSysId] : null;
  const widget = value(inst.sp_widget);
  if (!widget) continue;
  (widgetToPages[widget] ??= new Set()).add(page?.id ?? null);
  if (page?.id) (pageToWidgets[page.id] ??= new Set()).add(widget);
  (widgetInstanceIndex[widget] ??= []).push({
    instanceSysId: value(inst.sys_id),
    // null when the sp_column does not chain back to a page: a theme header or
    // footer placement, or an orphaned container. Recorded as null rather than
    // dropped, so the crawl can tell "placed somewhere I cannot name" apart
    // from "not placed anywhere at all".
    pageId: page?.id ?? null,
    spColumn: col ?? null,
    title: value(inst.title) || null,
  });
}

const parameterHints = {};
const parameterizedPages = {};
const hardcodedPaths = [];
const getWidgetCalls = [];
const widgetIdBySysId = {};
for (const w of widgetBodies) {
  widgetIdBySysId[w.sys_id] = w.id;
  const blob = `${w.template ?? ''}\n${w.client_script ?? ''}\n${w.script ?? ''}\n${w.link ?? ''}\n${w.option_schema ?? ''}`;
  for (const id of extractPageIds(blob)) addSeed(id, `widget:${w.id}`);
  const params = extractParameterNames(w.script);
  if (params.length) {
    parameterHints[w.id] = params;
    for (const pageId of widgetToPages[w.sys_id] ?? []) {
      if (!pageId) continue;
      parameterizedPages[pageId] = [...new Set([...(parameterizedPages[pageId] ?? []), ...params])];
    }
  }
  const foreign = findHardcodedPortalPaths(blob, suffix);
  if (foreign.length) hardcodedPaths.push({ widget: w.id, sys_id: w.sys_id, suffixes: foreign });
  const embeds = [...String(blob).matchAll(/getWidget\(\s*['"]([A-Za-z0-9_.-]+)['"]/g)].map((m) => m[1]);
  if (embeds.length) getWidgetCalls.push({ widget: w.id, sys_id: w.sys_id, embeds: [...new Set(embeds)] });
}

// Route maps. Both portal-scoped and system-wide, because a system-wide map
// changes behavior on a portal whose own configuration never mentions it.
const routeMaps = recordGap(
  await api.get('sp_page_route_map', {
    fields: ['sys_id', 'sp_portal', 'route_from', 'route_to', 'active', 'order'],
    limit: 500,
    all: true,
    displayValue: 'all',
  }),
  'sp_page_route_map',
);
const allRouteMaps = (routeMaps.rows ?? []).map(flatten);
observations.checks.routeMaps = {
  total: allRouteMaps.length,
  portalScoped: allRouteMaps.filter((r) => r.sp_portal === portalSysId),
  systemWide: allRouteMaps.filter((r) => !r.sp_portal),
  loops: detectLoops(allRouteMaps),
};
for (const rm of allRouteMaps) {
  if (rm.sp_portal === portalSysId || !rm.sp_portal) addSeed(rm.route_to, 'route_map');
}

observations.checks.widgets = {
  instancedWidgetCount: widgetSysIds.length,
  bodiesFetched: widgetBodies.length,
  truncated: widgetSysIds.length > widgetCap,
  hardcodedForeignPortalPaths: hardcodedPaths,
  runtimeEmbedding: getWidgetCalls,
  publicWidgets: widgetBodies.filter((w) => w.public === 'true').map((w) => ({ id: w.id, sys_id: w.sys_id, roles: w.roles })),
};
observations.checks.composition = {
  pageCount: Object.keys(pageById).length,
  containerCount: (containers.rows ?? []).length,
  instanceCount: (instances.rows ?? []).length,
  orphanedContainers,
  parameterizedPages,
};
observations.counts.seeds = seeds.length;

// ---------------------------------------------------------------------------
// Theme.
// ---------------------------------------------------------------------------
const themeSysId = value(portal.theme);
let themeSharedWith = [];
if (themeSysId) {
  const sharing = recordGap(
    await api.get('sp_portal', { fields: ['sys_id', 'title', 'url_suffix'], query: `theme=${themeSysId}`, limit: 100, all: true }),
    'sp_portal (theme sharing)',
  );
  themeSharedWith = (sharing.rows ?? []).map(flatten).filter((p) => p.sys_id !== portalSysId);
}
observations.checks.theme = { sys_id: themeSysId, sharedWith: themeSharedWith };

// ---------------------------------------------------------------------------
// Shared context payload. Keep it under about a page; it goes to every agent.
// ---------------------------------------------------------------------------
let personas = [
  {
    name: 'admin',
    description: 'The audit credential itself, used directly',
    acquisition: 'direct',
    underlying_user: phase0.probes.auditUser?.user_name ?? config.username,
    effective_roles: phase0.probes.adminEffectiveRoles ?? [],
  },
];
if (args.personas) {
  const declared = JSON.parse(await readFile(args.personas, 'utf8'));
  personas = [personas[0], ...declared.filter((p) => p.name !== 'admin')];
}

const context = {
  instanceBase: config.base,
  releaseFamily: args.release ?? phase0.probes.releaseFamily?.inferred ?? null,
  releaseFamilyCaveat: phase0.probes.releaseFamily?.caveat,
  // Tri-state, passed through unchanged: true / false / the literal string
  // 'unknown'. bin/phase0.mjs records 'unknown' on purpose when the sys_domain
  // probe is inconclusive, and lib/report.mjs (domainSeparationNote) and
  // lib/pdf/data.mjs both branch on all three. Boolean() here collapsed
  // 'unknown' to true and made the report assert "domain separation appears
  // active" off a failed query. Never coerce this. '?? "unknown"' is the
  // fallback for a phase0.json written before the probe existed.
  domainSeparationActive: phase0.probes.domainSeparation?.likelyActive ?? 'unknown',
  adminUpdateXmlAccess: Boolean(phase0.probes.sys_update_xml?.readable),
  environment: metadata.environment,
  runFolder: runFolder.root,
  writeException: metadata.write_exception
    ? {
        name: metadata.write_exception.name,
        action: metadata.write_exception.action,
        target: metadata.write_exception.target,
        reason: metadata.write_exception.reason,
      }
    : null,
  portalSysId,
  portalSuffix: suffix,
  portalName: display(portal.title) ?? value(portal.default_title) ?? suffix,
  homepage: pageSlot('homepage'),
  loginPage: pageSlot('login_page'),
  notFoundPage: pageSlot('notfound_page'),
  themeSysId,
  mainMenuSysId: mainMenuInstance ?? null,
  defaultCatalogSysId: value(portal.sc_catalog) ?? null,
  defaultKnowledgeBaseSysId: value(portal.kb_knowledge_base) ?? null,
  searchMode: aiSearchOn ? 'ai_search' : 'zing',
  // Prefer the portal record's own field; it's the authoritative binding.
  // Only fall back to the discovery query's first row (less reliable when
  // more than one portal exists on the instance, see the gap logged above).
  searchApplicationSysId: boundSearchAppSysId ?? (Array.isArray(searchApplication) ? (searchApplication[0]?.sys_id ?? null) : null),
  employeeCenterPresent: phase0.probes.employeeCenterPresent,
  ecProPresent: phase0.probes.ecProPresent,
  inactive: value(portal.inactive) === 'true',
  alternatePortal: display(portal.alternate_portal) ?? null,
  personaRegistry: personas,
  adminOnlyRun: personas.length === 1,
};

await runFolder.writeJson(runFolder.contextPath, context);
await runFolder.writeJson(path.join(runFolder.root, 'phase1-observations.json'), observations);
await runFolder.writeJson(path.join(runFolder.root, 'seeds.json'), {
  seeds,
  parameterHintsByWidget: parameterHints,
  parameterizedPages,
  note:
    'parameterizedPages lists page IDs whose widgets call $sp.getParameter, with the parameter names they need. ' +
    'Write one representative record per page into parameter-samples.json (pageId -> [{param: value}]) before the crawl. Do not enumerate all records.',
});
await runFolder.writeJson(path.join(runFolder.root, 'page-composition.json'), {
  pageToWidgets: Object.fromEntries(Object.entries(pageToWidgets).map(([k, v]) => [k, [...v].map((s) => widgetIdBySysId[s] ?? s)])),
  widgetToPages: Object.fromEntries(Object.entries(widgetToPages).map(([k, v]) => [widgetIdBySysId[k] ?? k, [...v].filter(Boolean)])),
  orphanedContainers,
  // Keyed by widget SYS_ID, not by sp_widget.id, because the sys_id is what the
  // crawl can read out of the rendered DOM. bin/crawl.mjs hands this to
  // runCrawl() as widgetInstanceIndex.
  widgetInstanceIndex,
  // The sp_instance read above is capped (--instance-limit, default 20000). If
  // it truncated, a widget can be missing from the index while genuinely having
  // sp_instance rows, so the crawl must not read "absent" as "runtime embedded".
  widgetInstanceIndexComplete: !(instances.partial ?? instances.truncated ?? false) && !instances.error,
  widgetInstanceIndexNote: (instances.partial ?? instances.truncated ?? false) || instances.error
    ? 'INCOMPLETE: the sp_instance read was truncated or errored, so this index does not cover every placement. Widget placement classification is downgraded to "unknown" for anything it does not list.'
    : 'Complete: every sp_instance row this credential can read is represented.',
});
await log.event('phase1.complete', { seeds: seeds.length, widgets: widgetBodies.length });

process.stdout.write(
  JSON.stringify(
    {
      context,
      seedCount: seeds.length,
      widgetBodiesFetched: widgetBodies.length,
      routeMaps: observations.checks.routeMaps.total,
      brokenPageBindings: Object.entries(observations.checks.boundPages)
        .filter(([, v]) => !v.ok)
        .map(([k, v]) => ({ slot: k, problem: v.problem })),
      themeSharedWithCount: themeSharedWith.length,
      orphanedContainerCount: orphanedContainers.length,
      parameterizedPageCount: Object.keys(parameterizedPages).length,
      gaps: observations.gaps,
      files: {
        sharedContext: runFolder.contextPath,
        observations: path.join(runFolder.root, 'phase1-observations.json'),
        seeds: path.join(runFolder.root, 'seeds.json'),
        composition: path.join(runFolder.root, 'page-composition.json'),
      },
    },
    null,
    2,
  ) + '\n',
);

// ---------------------------------------------------------------------------

function pageSlot(slot) {
  const sysId = pageRefs[slot];
  const page = sysId ? byId[sysId] : null;
  return page ? { sys_id: sysId, id: page.id, title: page.title } : { sys_id: sysId ?? null, id: null, title: null };
}

function detectLoops(maps) {
  const edges = new Map();
  for (const m of maps) if (m.active !== 'false' && m.route_from && m.route_to) edges.set(m.route_from, m.route_to);
  const loops = [];
  for (const [from] of edges) {
    const path = [from];
    let cur = from;
    for (let i = 0; i < 10; i += 1) {
      const next = edges.get(cur);
      if (!next) break;
      if (path.includes(next)) {
        loops.push([...path, next]);
        break;
      }
      path.push(next);
      cur = next;
    }
  }
  return loops;
}

function value(v) {
  if (v && typeof v === 'object') return v.value ?? null;
  return v ?? null;
}
function display(v) {
  if (v && typeof v === 'object') return v.display_value ?? v.value ?? null;
  return v ?? null;
}
function flatten(row) {
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (v && typeof v === 'object') {
      out[k] = v.value ?? null;
      if (v.display_value !== undefined && v.display_value !== v.value) out[`${k}_display`] = v.display_value;
    } else {
      out[k] = v;
    }
  }
  return out;
}
