// Phase 5 crawl engine. See reference/03-routing-reachability.md.
//
// Breadth first, so depth from the homepage is meaningful and the budget runs
// out on the long tail rather than on menus. Read only: every node is reached
// with navigate() (a GET). clickLink() is used only for controls with no
// resolvable href, and always through the blocklist gate.
//
// Budget: 500 distinct page nodes or 100 minutes wall clock, per persona. On
// hitting either limit the crawl stops immediately and returns
// status "budget_exceeded". The caller must ask the operator before continuing,
// every time, including the second and third time.

import { nodeKey, parsePortalUrl, buildPageUrl } from './portal-url.mjs';

export const DEFAULT_BUDGET = { maxNodes: 500, maxMinutes: 100 };
export const MAX_TABS = 3;

export function emptyState(persona) {
  return {
    persona,
    startedAt: null,
    elapsedMsBefore: 0,
    frontier: [],
    visited: {},
    pageInventory: [],
    widgetInventory: [],
    skippedClicks: [],
    externalLinks: [],
    otherPortalLinks: [],
    status: 'not_started',
  };
}

/**
 * @param {object} args
 * @param {import('./browser.mjs').ReadOnlyTab[]} args.tabs   1 to 3 tabs sharing one persona's login
 * @param {object} args.portal   {instanceBase, suffix}
 * @param {object[]} args.seeds  [{pageId, params, source}]
 * @param {string} args.persona  registry name key
 * @param {object} args.state    resumable state (emptyState() or a loaded crawl-state.json)
 * @param {object} [args.budget]
 * @param {object} [args.parameterHints]  pageId -> [{param: value}] representative records
 * @param {object|null} [args.widgetInstanceIndex]  widget SYS_ID -> [{instanceSysId, pageId, spColumn, title}],
 *   written by bin/phase1.mjs into page-composition.json from sp_instance.sp_widget.
 *   Pass null (the default) when it is unavailable; placement then reports
 *   'unknown' rather than being guessed at.
 * @param {boolean} [args.widgetInstanceIndexComplete]  false when the sp_instance
 *   read that produced the index was truncated or errored. A widget missing from
 *   an incomplete index proves nothing, so placement stays 'unknown'.
 * @param {(state: object) => Promise<void>} args.persist
 * @param {object} [args.log]
 */
export async function runCrawl({
  tabs,
  portal,
  seeds,
  persona,
  state,
  budget = DEFAULT_BUDGET,
  parameterHints = {},
  widgetInstanceIndex = null,
  widgetInstanceIndexComplete = false,
  persist,
  log,
}) {
  if (tabs.length > MAX_TABS) throw new Error(`Crawl parallelism is capped at ${MAX_TABS} tabs.`);
  if (state.persona && state.persona !== persona) {
    throw new Error(`crawl state belongs to persona "${state.persona}", not "${persona}".`);
  }
  state.persona = persona;
  const runStart = Date.now();
  if (!state.startedAt) state.startedAt = new Date().toISOString();

  // Seed the frontier on a fresh run.
  if (state.status === 'not_started') {
    for (const seed of seeds) {
      enqueue(state, { ...seed, depth: 0 });
    }
    state.status = 'running';
  }

  const elapsedMs = () => state.elapsedMsBefore + (Date.now() - runStart);
  const budgetHit = () => {
    if (Object.keys(state.visited).length >= budget.maxNodes) return 'maxNodes';
    if (elapsedMs() >= budget.maxMinutes * 60000) return 'maxMinutes';
    return null;
  };

  while (state.frontier.length > 0) {
    const hit = budgetHit();
    if (hit) {
      state.status = 'budget_exceeded';
      state.budgetLimitHit = hit;
      state.elapsedMsBefore = elapsedMs();
      await persist(state);
      return summarize(state, budget);
    }

    // One wave per tab, so the tabs work different frontier segments at once.
    const wave = [];
    while (wave.length < tabs.length && state.frontier.length > 0) {
      const next = state.frontier.shift();
      if (state.visited[next.key]) continue;
      wave.push(next);
    }
    if (wave.length === 0) break;

    await Promise.all(
      wave.map(async (node, i) => {
        const tab = tabs[i % tabs.length];
        try {
          await visit({ tab, node, state, portal, persona, parameterHints, widgetInstanceIndex, widgetInstanceIndexComplete, log });
        } catch (err) {
          state.visited[node.key] = { ...node, status: 'error', error: String(err), persona };
          await log?.error('crawl-node', { key: node.key, error: String(err) });
        }
      }),
    );

    // Do NOT bake elapsedMs() back into state.elapsedMsBefore here. It is
    // the fixed baseline from before this call started (0 on a fresh crawl,
    // or the total from a prior --resume); reassigning it on every wave adds
    // the whole run-so-far again each time, since elapsedMs() already adds
    // (Date.now() - runStart) to it. That compounded quadratically: the
    // 100-minute budget was firing after roughly 4 real minutes. Persist the
    // state as-is for crash recovery; elapsedMsBefore is only baked in once,
    // at each real exit point (above, and below), where that is correct
    // because runStart is about to go stale.
    await persist(state);
  }

  state.status = 'complete';
  state.elapsedMsBefore = elapsedMs();
  await persist(state);
  return summarize(state, budget);
}

async function visit({ tab, node, state, portal, persona, parameterHints, widgetInstanceIndex, widgetInstanceIndexComplete, log }) {
  const params = { ...(node.params ?? {}) };
  let usedRepresentative = false;
  const hints = parameterHints[node.pageId];
  if (hints?.length) {
    for (const [k, v] of Object.entries(hints[0])) {
      if (!(k in params)) {
        params[k] = v;
        usedRepresentative = true;
      }
    }
  }

  const target = buildPageUrl(portal.instanceBase, portal.suffix, node.pageId, params);
  const nav = await tab.navigate(target);
  const snapshot = await tab.observe();

  const actual = parsePortalUrl(snapshot.url, portal);
  const actualPageId = actual && !actual.external ? actual.pageId : null;
  const routeMapped = actualPageId !== null && node.pageId !== null && actualPageId !== node.pageId;

  const outcome = classifyOutcome(nav, snapshot);

  state.visited[node.key] = {
    key: node.key,
    pageId: node.pageId,
    params,
    requestedUrl: target,
    finalUrl: snapshot.url,
    title: snapshot.title,
    depth: node.depth,
    reachedFrom: node.reachedFrom ?? node.source ?? 'seed',
    httpStatus: nav.status,
    outcome,
    routeMapped,
    intendedPageId: node.pageId,
    actualPageId,
    usedRepresentativeRecord: usedRepresentative,
    persona,
    widgetCount: snapshot.widgets.length,
    visitedAt: new Date().toISOString(),
  };
  state.pageInventory.push(state.visited[node.key]);

  const hostPageId = actualPageId ?? node.pageId;
  for (const w of snapshot.widgets) {
    const placement = classifyPlacement({
      widgetSysId: w.widgetSysId ?? null,
      hostPageId,
      index: widgetInstanceIndex,
      indexComplete: widgetInstanceIndexComplete,
    });
    state.widgetInventory.push({
      widgetId: w.widgetId,
      widgetSysId: w.widgetSysId ?? null,
      // Kept as a raw observation only. It is absent on almost every widget in
      // a real portal, which is why it is no longer what placement is decided
      // on. See classifyPlacement().
      domInstanceId: w.instanceId ?? null,
      instanceId: w.instanceId,
      cssId: w.cssId,
      hostPageId,
      placement: placement.placement,
      placementBasis: placement.basis,
      instanceSysIds: placement.instanceSysIds,
      persona,
    });
  }

  if (outcome !== 'ok') return;

  // Enqueue discovered links.
  for (const a of snapshot.anchors) {
    if (!a.resolved) continue;
    const parsed = parsePortalUrl(a.resolved, portal);
    if (!parsed) continue;
    if (parsed.external) {
      state.externalLinks.push({ from: node.pageId, href: parsed.href, text: a.text });
      continue;
    }
    if (parsed.otherPortalOrPlatform) {
      state.otherPortalLinks.push({ from: node.pageId, href: parsed.href, text: a.text, firstSegment: parsed.firstSegment });
      continue;
    }
    enqueue(state, {
      pageId: parsed.pageId,
      params: parsed.params,
      depth: node.depth + 1,
      reachedFrom: node.pageId ?? '(default)',
      source: 'link',
      linkText: a.text,
    });
  }

  // Hrefless, client-side navigation controls that carry a resolvable
  // data-page-id: reached the same way as a link, by constructing the target
  // URL and navigating to it directly, never by actually clicking the DOM
  // element. This is deliberately simpler and no less read-only (still a
  // plain GET either way), but it only covers controls that expose their
  // destination as a `data-page-id` attribute.
  //
  // A `[ng-click]` or `[role="link"]` control with no such attribute
  // (common for widgets that navigate via an Angular service call rather
  // than a declared attribute) is NOT reached at all: neither enqueued nor
  // actually clicked. lib/blocklist.mjs and ReadOnlyTab.clickLink() exist and
  // are fully tested (test/smoke.mjs), but nothing in this file calls
  // clickLink() -- that would mean resolving a DOM selector, invoking the
  // click, and capturing wherever it lands, which is a materially different
  // and untested code path from "navigate to an already-known URL". Recorded
  // here as a genuine gap rather than clicked speculatively: every such
  // control is logged into skippedClicks so the crawl's own summary is
  // honest about what it did not reach, instead of reporting 0 always.
  for (const c of snapshot.clickables) {
    if (c.pageId) {
      enqueue(state, {
        pageId: c.pageId,
        params: {},
        depth: node.depth + 1,
        reachedFrom: node.pageId ?? '(default)',
        source: 'data-page-id',
        linkText: c.text,
      });
    } else {
      state.skippedClicks.push({
        from: node.pageId ?? '(default)',
        tag: c.tag,
        text: c.text,
        reason: 'no data-page-id attribute; would need an actual click to discover the destination, which this crawler does not do',
      });
    }
  }
}

export const WIDGET_PLACEMENTS = ['sp_instance', 'sp_instance_elsewhere', 'runtime_getWidget', 'unknown'];

/**
 * Decide how a rendered widget got onto the page, by joining the widget sys_id
 * the DOM exposes (lib/browser.mjs reads it off the `.v<sys_id>` wrapper class)
 * against sp_instance.sp_widget.
 *
 * The old rule was `w.instanceId ? 'sp_instance' : 'runtime_getWidget'`. The
 * DOM instance-id attribute is absent on effectively every widget a real portal
 * renders, so that rule reported the entire page as runtime-embedded via
 * $sp.getWidget. That is a strong claim -- it says the widget has no
 * sp_instance record at all -- and it was being made from the absence of an
 * attribute nobody had confirmed was ever present.
 *
 * Four outcomes, and only one of them asserts a runtime embed:
 *   sp_instance            an sp_instance row for this widget sits on this page.
 *   sp_instance_elsewhere  rows exist for this widget, but none resolve to this
 *                          page. Either a theme header/footer placement (whose
 *                          sp_column does not chain back to an sp_page) or a
 *                          runtime embed. Not enough to say which.
 *   runtime_getWidget      the widget has no sp_instance row anywhere on this
 *                          instance, so something placed it at runtime.
 *   unknown                no index, an incomplete index, or no sys_id in the
 *                          DOM. The question was not answered.
 *
 * @returns {{placement: string, basis: string, instanceSysIds: string[]}}
 */
export function classifyPlacement({ widgetSysId, hostPageId, index, indexComplete }) {
  if (!index || typeof index !== 'object') {
    return { placement: 'unknown', basis: 'no sp_instance index was supplied to the crawl', instanceSysIds: [] };
  }
  if (!widgetSysId) {
    return { placement: 'unknown', basis: 'the rendered element carried no widget sys_id to join on', instanceSysIds: [] };
  }
  const entries = index[widgetSysId] ?? [];
  if (entries.length === 0) {
    if (!indexComplete) {
      return {
        placement: 'unknown',
        basis: 'the sp_instance index is incomplete (truncated or failed read), so this widget being absent from it proves nothing',
        instanceSysIds: [],
      };
    }
    return {
      placement: 'runtime_getWidget',
      basis: `no sp_instance row references widget ${widgetSysId} anywhere on this instance`,
      instanceSysIds: [],
    };
  }
  const onThisPage = entries.filter((e) => e.pageId && hostPageId && e.pageId === hostPageId);
  if (onThisPage.length) {
    return {
      placement: 'sp_instance',
      basis: `sp_instance.sp_widget=${widgetSysId} placed on page "${hostPageId}"`,
      instanceSysIds: onThisPage.map((e) => e.instanceSysId).filter(Boolean),
    };
  }
  const unresolved = entries.filter((e) => !e.pageId).length;
  return {
    placement: 'sp_instance_elsewhere',
    basis:
      `${entries.length} sp_instance row(s) reference widget ${widgetSysId}, none resolving to page "${hostPageId ?? '(unknown)'}"` +
      (unresolved ? `; ${unresolved} of them have no page (theme header/footer or orphaned container)` : ''),
    instanceSysIds: entries.map((e) => e.instanceSysId).filter(Boolean),
  };
}

function classifyOutcome(nav, snapshot) {
  if (nav.timedOut) return 'timeout';
  // A page called without its required parameters is a distinct outcome from a
  // genuine 404: the page exists and is reachable, it was called wrong.
  if (snapshot.notAuthorizedMessage) return 'missing_parameters_or_unauthorized';
  if (snapshot.pageNotFound) return 'page_not_found';
  if (nav.status && nav.status >= 400) return `http_${nav.status}`;
  return 'ok';
}

function enqueue(state, node) {
  const key = nodeKey(node.pageId, node.params ?? {});
  if (state.visited[key]) return false;
  if (state.frontier.some((f) => f.key === key)) return false;
  state.frontier.push({ ...node, key, params: node.params ?? {} });
  return true;
}

function summarize(state, budget) {
  const visited = Object.values(state.visited);
  return {
    status: state.status,
    budgetLimitHit: state.budgetLimitHit ?? null,
    persona: state.persona,
    nodesVisited: visited.length,
    nodesQueued: state.frontier.length,
    elapsedMinutes: Math.round(state.elapsedMsBefore / 60000),
    budget,
    outcomes: tally(visited.map((v) => v.outcome)),
    routeMappedCount: visited.filter((v) => v.routeMapped).length,
    widgetPlacements: state.widgetInventory.length,
    runtimeEmbeddedWidgets: state.widgetInventory.filter((w) => w.placement === 'runtime_getWidget').length,
    // Reported next to the count above so a run whose placement join never had
    // an index cannot be read as "nothing was runtime embedded".
    widgetPlacementBreakdown: tally(state.widgetInventory.map((w) => w.placement ?? 'unknown')),
    skippedClicks: state.skippedClicks.length,
  };
}

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/**
 * Reconcile the three sets. Withheld, not published, on an admin-only run.
 * See the persona-gating rule in reference/03-routing-reachability.md.
 */
export function reconcile({ crawlState, configuredPageIds }) {
  const reached = new Set(Object.values(crawlState.visited).map((v) => v.actualPageId ?? v.pageId).filter(Boolean));
  const configured = new Set(configuredPageIds);
  return {
    configuredAndReachable: [...configured].filter((p) => reached.has(p)).sort(),
    configuredButUnreachable: [...configured].filter((p) => !reached.has(p)).sort(),
    reachableButNotConfigured: [...reached].filter((p) => !configured.has(p)).sort(),
  };
}
