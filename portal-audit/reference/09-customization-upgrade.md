# Customization and Upgrade Risk

The highest-priority section of the audit report.

## The three buckets

Classify every portal-touching record into exactly one bucket. Never merge buckets 2 and 3. They have opposite remediation.

| Bucket | Definition | Upgrade behavior | Remediation |
|---|---|---|---|
| **1. Out-of-box, unmodified** | Base record with no customer update against it | Upgrades cleanly | None |
| **2. Custom** | Newly created record, including clones of out-of-box widgets | No upgrade conflict. Carries maintenance cost | Review. Check whether the source has moved on |
| **3. Customized out-of-box** | Base record with a `sys_update_xml` entry against its original sys_id | **Skipped at upgrade.** Silently diverges from base | Revert to base, re-implement as a clone |

**Flag every bucket 3 record prominently.** These are the records that stop receiving fixes and features.

## Detection

| Signal | Table | Meaning |
|---|---|---|
| Customer Update exists for record | `sys_update_xml` | Record has been customized |
| Version history | `sys_update_version` | What changed and when |
| Skipped disposition | `sys_upgrade_history_log` (`disposition`), parent `sys_upgrade_history`; surfaced in the UI as Upgrade History / Upgrade Monitor in the Upgrade Console | Base update was not applied |
| Clone relationship | `sp_rel_widget_clone` | Widget is a clone, and of what |

Mechanically: a cloned widget is a **new** `sp_widget` record with a new name and sys_id. The original stays pristine and continues receiving upgrades. A directly modified out-of-box widget keeps its original sys_id but gains a `sys_update_xml` entry. At upgrade the platform compares the customer version to the incoming base version, skips the base update, and records a Skipped disposition.

## Record types to classify

Every record type touched by this portal:

- `sp_widget`
- `sp_page`
- `sp_theme`
- `sp_rectangle_menu` and `sp_rectangle_menu_item`
- `sp_page_route_map`
- `sp_search_source`
- `sp_css`, `sp_js_include`, `sp_angular_provider`, `sp_ng_template`
- `sp_instance` and its extended tables (usually all custom by nature, but instance option overrides on out-of-box widgets still matter)
- Employee Center scoped records where applicable

## What to capture per bucket 3 record

- What changed, at the field level where practical.
- When, and by whom.
- Whether the base version has moved since the customization.
- How many releases of base improvements have been missed.
- Whether the customization is still needed, since platform features frequently overtake customizations. The Australia portal-level authentication feature is a live example: a customized Login widget from before Australia can often now be reverted.

## Specific documented cases

**Cloned or customized search widgets and AI Search.** Search widgets cloned or customized before an upgrade may not be compatible with AI Search. ServiceNow ships a fix script to reclassify search widget instances. Check for this on any portal with AI Search enabled.

**Update set capture gaps in Service Portal Designer.** The Designer often records only directly-edited records, so the `sp_page` to `sp_container` to `sp_row` to `sp_column` to `sp_instance` hierarchy can be incompletely captured. A broken `sp_container.sp_page` reference makes containers fail to render with no error. Look for containers with missing or dangling page references.

**Employee Center records created in global scope.** Quick links, connected content and external links can end up in the wrong scope or fail to capture. External Link records specifically do not auto-capture in update sets.

**Hardcoded portal paths in cloned widgets.** A widget cloned from `/sp` for use on `/esc` frequently retains hardcoded links to `/sp`. Grep cloned widget templates and scripts for hardcoded portal suffixes.

## Orphaned customizations

Cross-reference against the Phase 5 crawl output:

- Custom widgets not placed on any page reached in the crawl.
- Cloned widgets whose source widget has since been substantially updated.
- Custom pages with no inbound links from anywhere in the portal.
- Route maps pointing at pages that no longer exist.

These are pure maintenance cost with no user-facing benefit, and they are usually easy wins in a remediation plan.

**Unlike Phase 5's general reconciliation, publish these even when the crawl only ran under the admin persona; do not withhold them.** An orphan is a structural fact, whether anything at all links to this page or widget, not a role-gated access question, so it is far less sensitive to which persona did the crawling. Attach a caveat referencing the admin persona's captured effective role set (from Phase 0, see `00-methodology.md`) rather than withholding the finding, since the one real edge case is an unusual role hierarchy where a link exists that admin specifically cannot see.

## Blast radius beyond themes

Pages and widgets are just as global and shareable as themes, so a bucket 3 finding on a shared widget affects every portal placing it, not just this one. Unlike a theme, there is no direct field that names every portal using a given page or widget, so use two tiers and be honest about which one a finding used.

**Tier 1, exact, CONFIG evidence.** A page matching another `sp_portal`'s homepage, login page, or 404 page field directly. Cheap, certain, no crawling of other portals required. Populate `shared_with` with the real portal names.

**Tier 2, approximate, INFERRED evidence.** For a widget, an instance-wide count of pages placing it, via `sp_instance`, higher than what this portal's own crawl would produce. For a page, menu items or links pointing at it from outside this portal's own menu tree. Either signals likely sharing without confirming exactly which other portals. Set `portal_scope: shared`, leave `shared_with` empty or unconfirmed, and attach a caveat explaining why the other portals could not be named. Never present this tier with the same confidence as Tier 1.

## Tiered evidence for staleness (Phase 8)

Upgrade History data **is** reachable through the Table API with admin — confirmed 2026-09-11 against a live instance, see open question 4b in `14-open-questions.md`. The backing tables are **`sys_upgrade_history`** ("System Upgrades", one row per upgrade) and **`sys_upgrade_history_log`** ("Upgrade Details", one row per file, carrying the `disposition` field). The Table API call must carry the `X-UserToken` header, per the CSRF-token finding in `13-data-access.md`.

Tier A is therefore the expected path, not a hopeful one. Still keep the lower tiers: reachability was confirmed on one instance and one release, and an engagement may hit a locked-down instance or a missing table. Confirm with a `sys_db_object` lookup, then fall back only if Tier A actually fails.

- **Tier A, best, and normally available.** Read `sys_upgrade_history_log` directly, filtered on skipped dispositions and narrowed with `file_nameSTARTSWITH` for the artifacts in scope (for example `file_nameSTARTSWITHsp_^dispositionIN4,9,10,11,12`), for an authoritative skipped-disposition count.

  `disposition` is a choice field. The skipped values, read from `sys_choice` on the live instance, are `4` Skipped, `9` Skipped Error, `10` Skipped Manual Merge, `11` Skipped Apply Once, and `12` Not Latest. There is also a second-pass series (`101`–`107`, where `104` is Skipped (second pass)); decide per engagement whether to fold it in, and say which set you counted. Pull the choice list rather than assuming these codes hold on every release.
- **Tier B, fallback, always available with admin.** Use `sys_update_xml` (proves customization) plus `sys_update_version` timestamps, compared against the release family captured in Phase 0, to estimate staleness without an exact skip count.
- **Tier C, weakest, always available.** Confirm the record is customized and state plainly that staleness could not be determined from this instance; recommend a manual check in Upgrade Monitor.

State which tier a finding came from. A Tier A finding is a hard count. A Tier B finding is a close estimate. A Tier C finding is a flag with no number attached.

## Access requirement

Reading `sys_update_xml` requires admin-level access. If the audit credentials do not permit it, this phase degrades severely and that limitation must be stated in Phase 0, not discovered late.
