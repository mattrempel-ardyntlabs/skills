# Report Model

## Output artifacts

One folder per audit run, named by portal suffix and date:

```
portal-audit-runs/<portal-suffix>-<date>/
  cache/            raw API responses, keyed by table plus query
  screenshots/       from 10-frontend-review.md
  crawl-state.json   frontier queue and visited nodes, for resuming a crawl, see 03-routing-reachability.md
  findings/          one JSON file per phase, each an array of 16-findings-schema.md objects
  logs/              impersonation start/stop and write-exception use, see 13-data-access.md
  metadata.json       authorization confirmation, production or non-production, run timestamps
  report.md          the assembled report, in the order below
  report.pdf         only if requested
```

`report.md` is the source of truth. Offer a PDF copy alongside it using `bin/report-pdf.mjs` (see `17-pdf-report.md`), and ask the operator at the end of the run whether they want one, rather than leaving it purely on-request.

Because `findings/*.json` already holds structured, evidence-tagged findings, regenerating `report.md` never requires touching the instance again.

## Ordering

Order by client value, not audit sequence. The audit runs 0 to 10. The report does not.

1. **Executive summary.** What was audited, as whom, against which release and instance, and the three findings that matter most.
2. **Progress since last audit**, only when a prior run for this portal exists and the operator asked for a comparison. Three buckets: resolved (was there last time, gone now), new (wasn't there, is now), and still open (present both times, worth noting how long). Match findings across runs by `record_refs`, never by `id`, since `id` is only a sequence number within one run. A finding with empty `record_refs` (a cross-cutting statistical finding with no single backing record) cannot be matched this way; report it under a fourth bucket, **not comparable**, rather than defaulting it into "new." Two findings can share the same `record_refs` (two distinct problems on one record); match by grouping, not by overwriting one key with the other.
3. **Customized out-of-box records.** The bucket 3 list from Phase 8. Highest priority, because it is concrete, quantifiable and directly tied to upgrade cost.
4. **Content visibility and taxonomy governance.** Phases 3 and 4. Critical findings first, notably topics with user criteria enabled and both criteria fields empty.
5. **Search health.** Phase 1 of the audit sequence, `07-search.md` in the doc set.
6. **Experience and accessibility.** Phase 6.
7. **Performance and security.** Phase 9.
8. **Feature adoption.** Phase 7, EC versus EC Pro used-versus-unused. Frames the commercial conversation.
9. **Portal configuration, theme and reachability.** Phases 0, 1 and 2 configuration context, plus the Phase 5 crawl findings. Last of the named sections deliberately: it is the catch-all for every phase-1 finding that section 5 above did not already claim, so it has to run after search, not before, or it would render some Phase 1 findings twice.
10. **Other findings.** Anything that did not match any of the named sections above. Should normally be empty; a finding landing here is worth a second look at whether it needs its own section rule.
11. **Appendices.** A: personas used, with acquisition method and effective roles. B: the evidence-typing table above. C: page inventory, one row per crawled node (first 500). D: widget inventory, deduplicated by widget ID, distinguishing runtime-embedded (`getWidget`) placements. E: run artifacts, what lives in the run folder and the retention policy. F: gaps and failures during the run, when `metadata.errorSummary` is present.

Sections 3 through 9 are matched against findings' `phase` (and, for search, the finding file's name) in that exact order, and matching is exclusive: whichever section a finding hits first claims it, so a later, broader rule (section 9's phase-1 catch-all) does not re-render something an earlier, narrower rule (section 5's phase-1-plus-search-filename rule) already claimed.

## Evidence typing

Tag every finding with the evidence behind it. The three types carry different confidence and the customer will challenge the softer ones.

| Tag | Meaning | Challenge resistance |
|---|---|---|
| `CONFIG` | Read from a platform record | High. Show the record |
| `RENDERED` | Observed in a browser as a named persona | Medium. Reproducible if persona is recorded |
| `USAGE` | Derived from Usage Insights or `sp_log` | Medium. Depends on telemetry being enabled |
| `INFERRED` | Reasoned from the above | Low. Say so, and say what would confirm it |

Never present an `INFERRED` finding in the same visual weight as a `CONFIG` one.

A `RENDERED` finding backed by a `screenshot_ref` (see `16-findings-schema.md`) carries more challenge resistance than one without. Link the actual image into `report.md` by its relative path within `screenshots/`. This makes the report self-contained only as long as the run folder stays intact; since retention (`13-data-access.md`) keeps `screenshots/` by default, this holds in the common case, but if the operator deletes it later, image links in an already-generated report will break. `bin/report-pdf.mjs` references screenshots by absolute path at render time, so the resulting `report.pdf` is a flattened snapshot: it stays correct even after `screenshots/` is later deleted, unlike `report.md`.

## Severity model

| Severity | Definition |
|---|---|
| **Critical** | Content or function is broken or invisible to users right now, or data is exposed to users who should not see it |
| **High** | Will break at upgrade, or materially degrades the experience for a significant population |
| **Medium** | Maintenance burden, performance cost, or accessibility failure on a custom component |
| **Low** | Inconsistency, dead configuration, or unrealized feature value |
| **Informational** | Inventory and context |

Anchor examples:
- Critical: topic with user criteria enabled and both criteria fields empty. Public widget returning records without `canReadRecord`.
- High: directly modified out-of-box widget with several releases of missed base updates. Custom portal not on an allow-listed baseline where the customer expects AI Search.
- Medium: unbounded `GlideRecord` in a homepage widget. Keyboard trap in a custom widget.
- Low: custom widget not placed on any reachable page. Criteria record with zero usages.

## Findings that need caveats attached

Some findings are frequently wrong without context. Attach the caveat in the finding itself, not in a general disclaimer nobody reads.

- **User criteria discrepancies**: changes require re-login before taking effect. An observed-versus-configured mismatch may just be session state.
- **Inactive AI Search on an upgraded instance**: the documented default, not a defect.
- **Public pages**: a number of default portal pages ship marked public. Presence is not automatically a defect.
- **Out-of-box widget accessibility failures**: real, but not the customer's defect to fix. Separate from custom widget failures.
- **Theme findings**: never single-portal. State which other portals share the theme.
- **Missing Australia features on Zurich or Yokohama**: not misconfiguration.
- **Reachability claims**: meaningless without the persona. Links render for users who cannot open the target.

## Quantification

Wherever possible, attach a number the customer can act on:

- Count of bucket 3 records, and how many base releases each has missed.
- Count of topics invisible due to empty criteria, and how many users each affects.
- Percentage translation coverage per language.
- Count of pages reachable but never visited in the telemetry window.
- Count of EC Pro features installed but unused.

A remediation plan built from counts gets funded. One built from adjectives does not.
