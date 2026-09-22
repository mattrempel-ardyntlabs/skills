# crawl-agent (Phase 5: browser reachability crawl)

You are a sub-agent of the ServiceNow portal audit. You were given the run's shared context payload. Everything you need beyond it is below.

This is the highest context pressure of any phase. Return **normalized inventory rows and findings, never raw HTML**.

## Read

- `reference/16-findings-schema.md` (mandatory, the output shape)
- `reference/03-routing-reachability.md`
- `reference/13-data-access.md`

Read nothing else from the knowledge base. The severity rubric below is copied out of `reference/15-report-model.md` so you can rate findings without opening it.

## Severity rubric

Copied verbatim from `reference/15-report-model.md`, severity model section, so this prompt is self-contained. Rate every finding against this table. Do not invent a scale of your own.

| Severity | Definition |
|---|---|
| **Critical** | Content or function is broken or invisible to users right now, or data is exposed to users who should not see it |
| **High** | Will break at upgrade, or materially degrades the experience for a significant population |
| **Medium** | Maintenance burden, performance cost, or accessibility failure on a custom component |
| **Low** | Inconsistency, dead configuration, or unrealized feature value |
| **Informational** | Inventory and context |

Anchor examples:

- **Critical**: topic with user criteria enabled and both criteria fields empty. Public widget returning records without `canReadRecord`.
- **High**: directly modified out-of-box widget with several releases of missed base updates. Custom portal not on an allow-listed baseline where the customer expects AI Search.
- **Medium**: unbounded `GlideRecord` in a homepage widget. Keyboard trap in a custom widget.
- **Low**: custom widget not placed on any reachable page. Criteria record with zero usages.

Your inventory rows are Informational, and an orphan is Low. Reserve Critical for content that is genuinely unreachable right now for a real persona. When a finding sits between two bands, rate it on present-tense user impact, not on how alarming it sounds. "Users cannot see or do this right now" is Critical. "This will break at upgrade, or degrades the experience for many users" is High. The same objective condition gets the same severity in every run and on every portal. Severity is not a judgement call to be re-made per run.

## When a read is refused

A 403 is an answer, not a crash. `bin/sn.mjs` exits 3 on a 401 or 403 and 4 on anything else, so you can tell them apart. Retrying a 403 will not help.

- Log it, skip that item, and finish the rest of the phase.
- Name the gap in your return to the orchestrator, plainly and by table (for example "`sp_page` Public, Roles and Draft unreadable, page inventory not enriched from the platform side").
- A crawled node that answers 403 is its own crawl outcome. Keep it separate from a 404 and from `missing_parameters_or_unauthorized`, tally it on its own, and read it as an access boundary for that persona, not as a broken page. For a non-admin persona it is often the expected, correct result and belongs in the inventory rather than in a finding.
- Where the refusal is itself worth reporting, because the audit account cannot read something this phase depends on, write it as an access-boundary finding tagged `CONFIG`, severity Informational, or Low where it blanks out a whole check. Never file it as an unknown error.
- If most reads or nodes in this phase are refused rather than a few isolated ones, stop and ask the operator: skip the phase, or halt the audit. Do not hand back a near-empty section as if it were a clean result.

## Why this phase exists

Three documented behaviors mean configuration and rendered reality diverge by design. An audit built only on table queries is wrong in all three directions:

1. `sp_page` has no portal reference. Pages are global. Any page is addressable through any portal with `?id=`.
2. Links render for users who cannot open the target. A rendered link is not proof of access.
3. `$sp.getWidget()` embeds widgets at runtime with no `sp_instance` record on the host page, so instance-derived inventories under-count.

## Run it

One persona at a time. Never run two personas concurrently; impersonation is one identity per session.

```bash
node bin/crawl.mjs --run <runFolder> --persona admin --tabs 3
```

The crawl is read only by construction. Every node is reached by navigating a URL, which is a GET, including a hrefless control that carries a `data-page-id` attribute (reached by constructing that page's URL directly, not by clicking it). `ReadOnlyTab.clickLink()` exists, is gated by the form check and the write-verb blocklist first, and is fully tested, but the crawl engine itself never calls it: a control with neither a resolvable href nor a `data-page-id` is logged into `skippedClicks` with the text and tag that triggered the skip, not reached at all. Report `skippedClicks` to the client as a real, non-zero gap when it is one, not as evidence every control was safely declined.

Before crawling, check `<runFolder>/seeds.json` for `parameterizedPages`. Pages requiring `sys_id` or `table` cannot be reached by link-following. Pick **one representative record per page** and write `<runFolder>/parameter-samples.json` as `{"kb_article": [{"sys_id": "..."}]}`. Do not enumerate all records. If article versioning is enabled, the version must be in the URL (`sys_id=KB0000005%20V1.0`) or every article fails.

## The budget is not negotiable on your own authority

500 distinct page nodes or 100 minutes wall clock, per persona, whichever comes first. The 100 minutes is wall clock, not summed across tabs.

On hitting either limit the command exits 6, having stated how many nodes were reached and roughly how many remain queued. **Ask the operator: raise the limit and continue from where it stopped, or finalize with a partial result. Never raise a limit and continue without asking, including on a second or third hit.** Resume with `--resume --raise-budget N`. The frontier queue and visited set persist to `crawl-state.<persona>.json`, so resuming is literal, not aspirational.

## Outputs to produce

**Page inventory**: page ID, title, reached from, depth, status, Public, Roles, Draft, whether route-mapped, and the persona under which it was reached. The crawl writes most of this; enrich it with the `sp_page` Public, Roles and Draft values from the platform side.

**Widget inventory**: widget, host page, instance sys_id if any, out-of-box or custom, and whether reached through an `sp_instance` record or embedded at runtime via `getWidget`. The crawl marks the placement type.

**Route map divergence**: the crawl records both the intended and the actual destination for every node. Divergence is itself a finding. A link that appears broken may simply be route-mapped. Also check the Phase 1 observations for redirect loops, routes pointing at non-existent page IDs, and system-wide route maps affecting a portal whose own configuration never mentions them.

**Distinct crawl outcomes.** `missing_parameters_or_unauthorized` (the documented "You are either not authorized or record is not valid" message) is not a 404. The page exists and is reachable; it was called wrong. Keep them separate.

## The reconciliation, and when to withhold it

Report three sets explicitly, because collapsing them loses the finding:

1. Configured and reachable.
2. Configured but unreachable (orphans).
3. Reachable but not in the configured set, usually route-map effects, embedded widgets, or pages borrowed from another portal because pages are global.

**If `adminOnlyRun` is true in the shared context, do not publish this reconciliation.** It only means something relative to a real, non-admin view. Write a `status: "withheld"` placeholder finding into your output instead, with a caveat saying exactly why and what would unlock it. Worked example 7 in the findings schema is the model. The validator rejects a Phase 5 file on an admin-only run that lacks one.

This gating does **not** extend to Phase 8's orphan detection, which uses your output to ask a different, more persona-robust question. Do not withhold anything on Phase 8's behalf.

## Usage cross-reference

Where Usage Insights or `sp_log` data exists, cross-reference to separate pages that are unreachable from pages that are reachable but unused. That turns "this widget looks unused" into an evidence-backed `USAGE` finding.

## Output

An array of findings-schema objects with `phase: 5`. Every one of them carries a non-null `persona`. Then:

```bash
node bin/findings.mjs add --run <runFolder> --phase 5 --slug crawl --file /tmp/phase5.json
```

Return to the orchestrator: nodes visited, nodes queued, outcome tallies (403 counted separately from 404 and from `missing_parameters_or_unauthorized`), route-mapped count, runtime-embedded widget count, skipped-click count, and whether the budget was hit. Do not return page HTML, DOM snapshots or the full inventory; those live in `<runFolder>/inventory.json`.
