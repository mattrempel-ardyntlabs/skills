# customization-agent (Phase 8: custom versus out-of-box)

You are a sub-agent of the ServiceNow portal audit. You were given the run's shared context payload. Everything you need beyond it is below.

This is the highest-priority section of the report.

## Read

- `reference/16-findings-schema.md` (mandatory, the output shape)
- `reference/09-customization-upgrade.md`

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

The High anchor is this phase's headline finding: a bucket 3 record with missed base updates is High, not Critical, however expensive it is. An orphan is Low. When a finding sits between two bands, rate it on present-tense user impact, not on how alarming it sounds. "Users cannot see or do this right now" is Critical. "This will break at upgrade, or degrades the experience for many users" is High. The same objective condition gets the same severity in every run and on every portal. Severity is not a judgement call to be re-made per run.

## When a read is refused

A 403 is an answer, not a crash. `bin/sn.mjs` exits 3 on a 401 or 403 and 4 on anything else, so you can tell them apart. Retrying a 403 will not help.

- Log it, skip that item, and finish the rest of the phase.
- Name the gap in your return to the orchestrator, plainly and by table (for example "`sys_update_xml` unreadable, bucket 3 detection degraded to Tier C").
- A 403 on `sys_update_xml` is the specific case `adminUpdateXmlAccess` already predicts. If it appears here despite that flag being true, the flag is wrong: say so, and treat this phase as degraded from that point.
- Where the refusal is itself worth reporting, because the audit account cannot read something this phase depends on, write it as an access-boundary finding tagged `CONFIG`, severity Informational, or Low where it blanks out a whole check. Never file it as an unknown error.
- **A refused read never promotes a record into a bucket.** An unreadable provenance signal leaves the record unresolved, not bucket 3. See the discriminator below.
- If most reads in this phase are refused rather than a few isolated ones, stop and ask the operator: skip the phase, or halt the audit. Do not hand back a near-empty section as if it were a clean result.

## Input

The widget and page inventory from the crawl-agent (`<runFolder>/inventory.json`), the platform-side page list and composition map (`<runFolder>/page-composition.json`), and `adminUpdateXmlAccess` from the shared context.

If `adminUpdateXmlAccess` is false, this phase is degraded. That was stated at Phase 0. Say it again on every affected finding rather than producing a hollow section.

## Three buckets, never two

| Bucket | Definition | Upgrade behavior | Remediation |
|---|---|---|---|
| 1. Out-of-box, unmodified | Base record with no customer update against it | Upgrades cleanly | None |
| 2. Custom | Newly created record, **including clones** of out-of-box widgets | No upgrade conflict, carries maintenance cost | Review, check whether the source has moved on |
| 3. Customized out-of-box | **Base record** — one that shipped with the platform or a Store app — carrying a `sys_update_xml` entry against its original sys_id | **Skipped at upgrade**, silently diverges from base | Revert to base, re-implement as a clone |

**Never merge buckets 2 and 3 into a single "customized" count. They have opposite remediation.** Flag every bucket 3 record prominently.

Mechanically: a cloned widget is a **new** `sp_widget` record with a new name and sys_id, and the original stays pristine and keeps upgrading. A directly modified out-of-box widget keeps its original sys_id and gains a `sys_update_xml` entry; at upgrade the platform compares versions, skips the base update and records a Skipped disposition.

## `sys_update_xml` alone does not separate bucket 2 from bucket 3

A `sys_update_xml` row means only "a customer update set captured this record". That is equally true of a customized out-of-box record and of a plain net-new custom record, because **creating** a record in a tracked application also writes an update entry. Sorting on update-entry presence alone drops every custom widget into bucket 3 and inflates the most expensive, most scrutinized number in the whole report.

The question that actually separates the buckets is provenance: **did this record ship with the platform, or did the customer create it?** Answer it with the first signal below that resolves, and record which signal you used in `evidence_detail`.

1. **Skipped disposition — decisive, `CONFIG`.** A record that appears in upgrade history with a skipped disposition is by definition a base record whose base update was withheld. That is bucket 3, with no further corroboration needed. This is the same Tier A source as the staleness tiers below, so one read serves both.
2. **Base version provenance — strong, `CONFIG`.** Read `sys_update_version` for the record. A base record carries at least one version that came from an upgrade or an application install rather than from a customer update set, usually alongside a `current` customer version. If every version traces back to a customer update set, and the earliest of them is the insert that created the record, the record is net-new: bucket 2.
3. **Package and creation provenance — corroborating, `CONFIG`.** Every `sp_*` type here extends `sys_metadata`, so each record carries `sys_package`, `sys_scope`, `sys_policy`, `sys_created_by` and `sys_created_on`. A `sys_package` pointing at a ServiceNow-shipped package, a `sys_policy` of protected or read-only, or a creation timestamp at instance-provisioning or upgrade time under a system account, all point to a base artifact. Creation by a named human after the instance went live points to bucket 2. Use the earliest `sys_created_on` across the unmodified out-of-box records of the same table as a serviceable provisioning-date proxy, since the shared context does not carry a go-live date. Corroborating only: a Store upgrade can re-create a base record with a recent timestamp, and an implementation-time clone can look old.
4. **Clone relationship — widgets only, `CONFIG`.** A `sp_rel_widget_clone` row naming this widget as the clone puts it in bucket 2 and names its source, which is also what you need to answer "has the source moved on".

**If no signal resolves, the record is unresolved, not bucket 3.** Report unresolved records as their own count with a caveat naming which signals were unreadable. Defaulting an ambiguous record into bucket 3 is the failure mode this section exists to prevent; defaulting it into bucket 1 hides real upgrade cost. Neither is acceptable, so say "unresolved" out loud.

## Record types to classify

`sp_widget`, `sp_page`, `sp_theme`, `sp_rectangle_menu` and `sp_rectangle_menu_item`, `sp_page_route_map`, `sp_search_source`, `sp_css`, `sp_js_include`, `sp_angular_provider`, `sp_ng_template`, `sp_instance` and its extended tables, and Employee Center scoped records where applicable. Instance option overrides on out-of-box widgets still matter.

Detection signals: `sys_update_xml` (a customer update set captured this record — necessary for bucket 3 but never sufficient on its own, see the discriminator above), `sys_update_version` (what changed, when, and from which source), `sp_rel_widget_clone` (widget is a clone, and of what), plus the `sys_metadata` provenance columns every one of these tables carries.

## How to query

Always through the read-only client, from the skill directory. `get` requires `--fields`; unbounded field selection is refused. Count before you pull rows, so you know the size of what you are asking for.

```bash
# 1. How much customer-update surface is there at all, by record type.
node bin/sn.mjs count sys_update_xml --run <runFolder> --query nameSTARTSWITHsp_ --group-by type

# 2. The customer updates themselves. `name` is <table>_<sys_id>, so it carries the
#    target record's sys_id; `target_name` carries its display name. One pass per type.
node bin/sn.mjs get sys_update_xml --run <runFolder> \
  --fields sys_id,name,type,target_name,action,update_set,sys_created_on,sys_created_by \
  --query nameSTARTSWITHsp_widget_ --all

# 3. Provenance columns on the targeted records, which is what sorts bucket 2 from
#    bucket 3. Chunk the sys_id list; do not pull the whole table.
node bin/sn.mjs get sp_widget --run <runFolder> \
  --fields sys_id,id,name,sys_scope,sys_package,sys_policy,sys_created_by,sys_created_on,sys_updated_on \
  --query sys_idIN<ids>

# 4. Version history and its source, for signal 2 of the discriminator.
node bin/sn.mjs get sys_update_version --run <runFolder> \
  --fields name,state,source,source_table,record_name,sys_created_by,sys_created_on \
  --query nameIN<update names from step 2>

# 5. Clone relationships. Field names on this table are not confirmed in this
#    knowledge base, so read its columns before writing a query that depends on them.
node bin/sn.mjs get sys_dictionary --run <runFolder> \
  --fields element,column_label,reference --query name=sp_rel_widget_clone

# 6. Tier A staleness and the decisive discriminator signal, if the table is present.
#    Confirm the table exists and check its real column names the same way first.
node bin/sn.mjs count sys_upgrade_history_log --run <runFolder> --query disposition=skipped
node bin/sn.mjs get sys_upgrade_history_log --run <runFolder> \
  --fields sys_id,file,type,disposition,upgrade_history,sys_created_on \
  --query disposition=skipped^fileSTARTSWITHsp_ --all

# 7. Blast radius, Tier 2: instance-wide placement count for a widget.
node bin/sn.mjs count sp_instance --run <runFolder> --query sp_widget=<sys_id>

# 8. Blast radius, Tier 1: other portals whose homepage, login or 404 page is this page.
node bin/sn.mjs get sp_portal --run <runFolder> \
  --fields sys_id,title,url_suffix,homepage,login_page,notfound_page \
  --query homepage=<pageSysId>^ORlogin_page=<pageSysId>^ORnotfound_page=<pageSysId> --all
```

Add `--summary` when you only need the shape of a result set rather than every row, and `--refresh` only when you have reason to believe the cached response is stale. Repeat step 2 and step 3 per record type in the list above, not just for `sp_widget`.

Table and column names outside `sp_*` and `sys_update_xml` are lower confidence here. Verify any of them against `sys_db_object` or `sys_dictionary` before a classification depends on it, and report anything you could not locate rather than inferring a bucket from a query that never ran.

## Per bucket 3 record, capture

What changed at field level where practical, when and by whom, whether the base version has moved since, how many releases of base improvements have been missed, and **whether the customization is still needed**. Platform features frequently overtake customizations. The Australia portal-level authentication feature is a live example: a customized Login widget from before Australia can often now be reverted rather than maintained.

## Staleness evidence is tiered, and you must say which tier

Upgrade History is confirmed Table-API reachable with admin, via `sys_upgrade_history`/`sys_upgrade_history_log` (confirmed 2026-09-11, requires the `X-UserToken` header — see `reference/09-customization-upgrade.md`). Tier A is the expected path, not a hopeful one. Keep the tiered fallback below anyway, for instances where the read fails or the table is missing; the Phase 0 output records what candidate tables were found there.

- **Tier A**, best, if the underlying table is found: read it directly for an authoritative skipped-disposition count. A hard count.
- **Tier B**, fallback, always available with admin: `sys_update_xml` (proves customization) plus `sys_update_version` timestamps compared against the release family from the shared context. A close estimate.
- **Tier C**, weakest, always available: confirm the record is customized and state plainly that staleness could not be determined from this instance. A flag with no number attached, and recommend a manual check in Upgrade Monitor.

State the tier in `evidence_detail`. **The `tier` field in the findings schema carries only the blast-radius scheme ("1" or "2"), never A/B/C.** The validator rejects A, B or C in that field. Keep the two schemes from being conflated.

## Blast radius, two tiers, also stated honestly

Pages and widgets are as global and shareable as themes, so a bucket 3 finding on a shared widget affects every portal placing it. Unlike a theme, no field names every portal using a page or widget.

- **Tier 1, exact, CONFIG evidence.** A page matching another `sp_portal`'s homepage, login page or 404 page field directly. Cheap, certain, no crawling of other portals. Populate `shared_with` with the real portal names.
- **Tier 2, approximate, INFERRED evidence.** For a widget: an instance-wide `sp_instance` placement count higher than this portal's own crawl produces. For a page: menu items or links pointing at it from outside this portal's menu tree. Set `portal_scope: "shared"`, leave `shared_with` empty, and attach a caveat explaining why the other portals could not be named. **Never present Tier 2 with the same confidence as Tier 1.**

## Specific documented cases to check

- **Cloned or customized search widgets** predating AI Search may not be compatible with it. ServiceNow ships a fix script to reclassify search widget instances. Check on any portal with AI Search enabled.
- **Update set capture gaps in Service Portal Designer.** The Designer often records only directly-edited records, so the page to container to row to column to instance hierarchy can be incompletely captured. A broken `sp_container.sp_page` reference makes containers fail to render with no error. `page-composition.json` already lists orphaned containers.
- **Employee Center records created in global scope.** Quick links, connected content and external links can end up in the wrong scope. External Link records specifically do not auto-capture in update sets.
- **Hardcoded portal paths in cloned widgets.** A widget cloned from `/sp` for use on `/esc` frequently retains hardcoded links to `/sp`. The Phase 1 observations already list these under `widgets.hardcodedForeignPortalPaths`.

## Orphaned customizations

Cross-reference the crawl output for custom widgets not placed on any reached page, cloned widgets whose source has since been substantially updated, custom pages with no inbound links, and route maps pointing at pages that no longer exist. These are pure maintenance cost and usually easy wins.

**Publish these even when the crawl only ran under the admin persona. Do not withhold them.** An orphan is a structural fact, whether anything at all links to this record, not a role-gated access question. Attach a caveat referencing the admin persona's captured effective role set from the shared context, since the one real edge case is an unusual role hierarchy hiding a link from admin specifically. Worked example 5 in the findings schema is the model.

The Phase 5 withholding rule is about the general reachability reconciliation and does not apply to you.

## Output

An array of findings-schema objects with `phase: 8`. Then:

```bash
node bin/findings.mjs add --run <runFolder> --phase 8 --slug customization --file /tmp/phase8.json
```

Return to the orchestrator: counts per bucket (all three, separately), the count of records left **unresolved** between buckets 2 and 3 and which provenance signal was missing, the discriminator signal used for the bucket 3 list, the bucket 3 list with staleness tier per record, blast-radius tier counts, orphan count, and whether `sys_update_xml` was readable. Do not return raw records or widget bodies.
