# Open Questions and Verification Requirements

Things this knowledge base does not settle. Each needs verification on the target instance or further research.

## Verify on the target instance before depending on it

1. **Employee Center table names.** The Australia docs describe taxonomy, topic, connected content, quick link and the rest as *forms*, without consistently naming tables. Resolve real names by filtering `sys_db_object` for the `sn_ex_sp`, `sn_ect`, `sn_ex_emp_fd` and `sn_hr_sp` scopes. Scoped table names also drift across Store versions, so do this per engagement rather than hardcoding.

   **Tested 2026-09-11, fresh Australia PDI — and re-tested, corrected 2026-09-11 on a second, longer-lived instance.** The first test concluded "`sn_ect` is not a real scope prefix," which conflated two different questions: it correctly found no *tables* prefixed `sn_ect_`, then wrongly generalized that to "the scope doesn't exist." A later real audit run found `sn_ect` ("Employee experience taxonomy," v28.2.5) present, active, and installed in `sys_scope` and `sys_store_app` on an instance where taxonomy had actually been configured. **Corrected finding: `sn_ect` is a real, installable scope. It just owns none of its own database tables** — taxonomy/topic content lives on unscoped global tables regardless of whether `sn_ect` is installed: `taxonomy`, `topic`, `taxonomy_content_configuration`, `m2m_connected_content`, `m2m_sp_portal_taxonomy`. Do not filter `sys_db_object` for a `sn_ect_` table prefix (it will find nothing), but do include `sn_ect` in any `sys_scope`/`sys_store_app` inventory query — omitting it (as a fixed, enumerated scope list is prone to do) will misreport the app chain. Other confirmed real EC-scoped table prefixes: `sn_ex_sp_*` (portal config — footer, quick links, static content, action groups, portal notifications), `sn_hr_sp_*` (ESC — to-do config, pre-chat survey), `sn_ex_emp_fd_*` (portal performance stats), `sn_ex_sp_gd_help_*` (Guided Self-Service, item 7 below). Also seen installed and worth including in any EC scope inventory: `sn_ex_sp_notifs` ("Notifications for EC").

2. **AI Search object tables beyond the three confirmed.** `sys_search_context_config`, `ais_search_profile` and `ais_datasource` are high confidence. Search Source, Genius Result configuration, synonym and dictionary objects, and search event or analytics tables are not confirmed from a primary data-dictionary page. Filter `sys_db_object` for the `ais_` prefix.

   **Confirmed 2026-09-11.** The `ais_` scope holds 50+ tables well beyond the original three, including `ais_search_source`, `ais_genius_result_configuration`, `ais_dictionary`, `ais_datasource_stats`, `ais_query_statistics`, `ais_publish_history`. High confidence, filtering `sys_db_object` for `ais_` is a reliable way to enumerate the full set per engagement.

3. **Search event and analytics tables.** Named nowhere in this knowledge base with confidence. Search health signals in `07-search.md` depend on locating them.

   **Confirmed 2026-09-11.** They exist and are Table-API reachable: `sys_search_event`, `sys_search_signal_result_event`, `sys_search_result_clicked`, `sys_search_autocomplete_query_event`, `sys_search_suggestion`, `ts_search_stats`, `sys_search_source_event`. `07-search.md` can cite these directly.

## Genuine research gaps

4. **Domain separation and Service Portal.** No Australia documentation confirmed. On a domain-separated instance, taxonomy Domain, user criteria evaluation and content visibility may all be domain-scoped. Currently out of validated scope. Worth dedicated research before running this skill at a domain-separated customer. No confirmed detection method exists either: candidates are `glide.sys.domain.enabled` in `sys_properties` and counting active `sys_domain` records beyond global, but neither is verified. Resolve this per engagement before trusting the `domain separation active` flag in the shared context payload (`00-methodology.md`).

   **Tested 2026-09-11, fresh non-domain-separated Australia PDI — still open.** `sys_domain` returned `400` via the Table API on every query shape tried (bare, filtered, via `/api/now/stats`), not the `401`/`403` a permission problem would give. `glide.sys.domain.enabled` also does not exist as a `sys_properties` row on this instance. Neither candidate detection method was confirmed working or non-working, since this instance has no domain separation to detect — the `400` might just mean "unreachable this way regardless," which would sink both candidates. Genuinely needs a domain-separated instance to test. Not yet re-tested with the plugin now being installed (see item 7 note) — that instance won't have domain separation either, so this stays open.

4a. **Release family detection.** Mapping `sys_properties` `glide.buildname` to Australia, Zurich, or Yokohama needs a lookup table that will need updating as new releases ship. Verify per engagement rather than treating any hardcoded mapping as permanent.

   **Tested 2026-09-11 — the underlying assumption was wrong.** `glide.buildname` is **not** a `sys_properties` row; querying for it (and for anything `nameLIKEglide.build`) returned zero records. The build name is not persisted to the database table this KB assumed. It is available on `/stats.do`, which renders plainly as `Build name: Australia` (also `Build date`, `Build tag`, `Instance name`) with no auth token games — a normal authenticated page load and a text scrape resolves it. Rewrite this item's method to parse `/stats.do` instead of querying `sys_properties`. The lookup-table-drifts-across-releases caveat still applies once the value is captured.

4b. **Whether Upgrade History or Upgrade Monitor data is Table-API reachable at all, even with admin.** **RESOLVED — reachable.** `09-customization-upgrade.md`'s tiered evidence approach for Phase 8 staleness findings depends on this, and Tier A is available. Still worth searching `sys_db_object` per engagement to confirm the tables exist on that instance and release.

   **Confirmed 2026-09-11.** `GET sys_upgrade_history` returned real records (`200`, not blocked) once the Table API call carried the `X-UserToken` header — see the CSRF-token finding in `13-data-access.md`. Tier A is available, at least on this instance and this release. `sys_node_upgrade_history` and `sys_upgrade_history_log` also exist as candidates if `sys_upgrade_history` alone is too coarse.

   The reference run exercised both. `sys_upgrade_history` (label "System Upgrades") returned 8 rows with `from_version`, `to_version`, `state`, `upgrade_start` and `upgrade_end`. `sys_upgrade_history_log` (label "Upgrade Details") is the row-level detail table and carries the `disposition` field the skipped-count depends on; filtered reads such as `disposition=4` and `file_nameSTARTSWITHsp_^dispositionIN4,9,10,11,12` both returned `200` with real rows. A `sys_db_object` search for `nameLIKEupgrade` registered 31 tables, including both of these.

4c. **Whether the browser tool used in the eventual build supports multiple independent, concurrently scriptable browser contexts loaded from the same saved login.** Needed for the 3-tab parallelism described in `03-routing-reachability.md`. Confirm before build; fall back to single-tab sequential crawling if not supported.

   **Confirmed 2026-09-11**, for the Claude Browser pane tool specifically. Opened a second tab against the same portal URL: it inherited the existing authenticated session with no re-login, and both tabs remained independently addressable and navigable by `tabId` without interfering with each other. The 3-tab parallelism design in `03-routing-reachability.md` is supported by this tooling. Re-verify if the eventual build ends up using a different browser-automation layer than this one.

4d. **Whether axe-core can be injected into a rendered page using whichever browser tool the build ends up using.** Needed for the automated accessibility checks in `10-frontend-review.md`. Confirm before build.

   **Confirmed 2026-09-11**, for the Claude Browser pane tool. Injected axe-core 4.9.1 via a `<script src>` tag pointed at a CDN, into the live default Service Portal home page. It loaded and ran a real scan (1159 nodes checked, 44 passes, 0 violations, 1 incomplete) — not an empty/no-op result. Accessibility checks in `10-frontend-review.md` are viable with this tooling. Re-verify if the eventual build's browser tool has a different injection surface or a stricter CSP on the target instance.

   **Re-verified for the actual build, with a different mechanism.** The built skill (`lib/browser.mjs`) uses Playwright, not the Claude Browser pane, and vendors axe-core locally (`bin/setup.mjs` pins **4.10.2**, not the 4.9.1 tested above) rather than loading it from a CDN via a `<script src>` tag. It injects by evaluating the vendored source directly in the page's main world (`page.evaluate`), which sidesteps the CDN-script-tag CSP question this item originally asked, rather than answering it under the same conditions. `test/smoke.mjs` exercises this exact path against a mock page serving a strict `script-src 'self'` CSP and confirms it works. Bottom line unchanged: axe-core injection is viable for Phase 6, just via evaluate-of-vendored-source, not a CDN tag.

5. **Portal-specific Instance Scan checks.** None confirmed in Australia documentation. If out-of-box portal scan checks exist, they would provide free corroborating findings. Worth a direct check on an instance.

   **Confirmed 2026-09-11.** They exist. Of 362 total `scan_check` records on a fresh instance, at least six are Service Portal specific: "Role definition for Service portal pages," "Enable Cross Scope Privilege Checks on Service Portal Form," "Review Public Service Portal Pages," "All Portal pages with Public Access," "Configure Service Portal Widgets Allow List," "Configure Service Portal Widgets Table Allow List." There's also "Securing Record Producers" (relevant to item 10 below), with its check script fully readable via `scan_table_check`. Pull `scan_result` for these `sys_id`s as free corroborating findings, as hoped.

6. **Announcements.** User criteria applies to announcements per the Service Portal user criteria documentation, but the announcement table and its portal binding were not researched. Announcements are user-visible content and belong in the audit.

   **Confirmed 2026-09-11.** Tables exist: `announcement` (base record), `m2m_announcement_portal` (the portal binding), `announcement_consumer_type`, `announcement_style`, `m2m_dismissed_announcement`. There's also a separate, newer `sys_ux_banner_announcement*` set — worth checking which one a given portal actually uses before assuming the classic tables are authoritative.

7. **Guided Self-Service.** Appears in the EC reference list and interacts with topics (cloning or moving a topic clones or moves its Guided Self-Service). Its structure, tables and audit surface were not researched in depth.

   **Resolved 2026-09-11**, after installing the Guided Self-Service plugin on the test instance. It's its own scoped app: `sn_ex_sp_gd_help` ("Guided Self-Service in Employee Center"), confirmed via `sys_scope`. The earlier `gsw_*` / `sys_playbook_*` leads were both dead ends — this plugin's tables use their own prefix instead. Real tables:
   - `sn_ex_sp_gd_help_process` (Guided Self-Service Process) — the main record. Its `process` field is a **Reference to `sys_pd_process_definition`** (confirmed via `sys_dictionary`), meaning Guided Self-Service is built on **Process Designer** (Process Automation Designer), not Decision Tree or a plain Flow Designer flow. Audit method: pull the referenced `sys_pd_process_definition` record to see the actual flow logic a process runs.
   - `sn_ex_sp_gd_help_m2m_process_topic` — links `guided_help_process` to `topic`. This is the mechanism behind the KB's original note that cloning/moving a topic clones/moves its Guided Self-Service: it's an m2m row, so cloning a topic without also cloning/repointing this mapping would silently drop the Guided Self-Service association — worth a specific check in Phase 3 or wherever topic cloning is audited.
   - `sn_ex_sp_gd_help_process_user_criteria_mtom` / `_no_mtom` — same "Available For / Not Available For" user-criteria pattern as every other EC content type, so it slots into the existing visibility-findings approach without a special case.
   - `sn_ex_sp_gd_help_execution` — process execution/usage records, a usage-telemetry source for this content type (Phase 7 territory).

8. **Virtual Agent and Now Assist embedding in the portal.** Known to exist and to interact with AI Search Genius Results. The configuration surface, how a VA is bound to a specific portal, and what to audit were not researched.

   **Partially confirmed 2026-09-11.** Relevant tables exist: `sys_cb_topic` / `sys_cb_design_topic` / `sys_cb_topic_category` (Conversation Builder topics), `sys_cs_virtual_agent_context`, `sys_cs_available_virtual_agent_topics`. How a VA is *bound to a specific portal* — the actual audit surface this item is asking about — is not yet confirmed; this only confirms the topic-authoring tables exist.

9. **The newer catalog experience.** Referenced in passing. Whether the portal uses classic catalog widgets or a newer experience changes what Phase 5 sees and what Phase 8 classifies.

   **Mostly resolved 2026-09-11.** The `sn_sc` prefix guess was wrong (confirmed empty), but the feature has a name once you look at `sys_scope` directly: **"Service Catalog Builder"** (plus a separate "AES Catalog Builder" variant tied to App Engine Studio). Confirmed via `sys_ux_page_registry` (fixed the earlier field-name mistake — real fields are `title`/`path`/`parent_app`, not `name`): it registers two distinct authoring UI Builder pages, `build/catalog` (Catalog Builder) and `aes/catalogbuilder` (AES Catalog Builder). There's also a `catalog_draft_entities` table (staging/drafts before publish) and `catalog_builder_analytics`. The `glide.sc.builder.*` properties already surfaced under item 12/general search (`preview_portal_id`, `template_access`, `allow_create_from_scratch`, `content_url`) are this feature's configuration surface.

   **Still open:** everything above is the *authoring* side (how an admin builds a catalog item with the newer tool). What the KB item actually asked — whether a given **rendered, end-user-facing** catalog page uses classic Angular catalog widgets or a newer UI-Builder-driven runtime — is not yet confirmed. That needs navigating an actual portal's catalog page and inspecting what component tree renders it, not a table search.

10. **Record producers in Employee Center.** Producers are a large share of real EC content and have their own variable, UI policy and client script surface. Not covered beyond the table names.

    **Confirmed 2026-09-11.** `sc_cat_item_producer` exists and is Table-API reachable. There's also an out-of-box Instance Scan check, "Securing Record Producers" (see item 5), which checks whether a producer has `user_criteria` attached via `sc_cat_item_user_criteria_mtom` — a ready-made, OOB-validated check for exactly the kind of misconfiguration this item was worried about (unauthorized direct-URL access).

11. **EC and EC Pro Australia release notes.** `employee-center-rn` and `ec-pro-rn` in the ServiceNowDocs `australia` branch were not fetched verbatim. Australia-specific EC additions cited from community sources (Simplified Side Navigation, Navigation Analytics, Approval Assistance Agent) should be confirmed there.

12. **Notification-to-portal link configuration.** Known to be a common misconfiguration (routing non-ITIL users to the wrong portal). The specific properties and notification configuration were not researched.

    **Investigated further 2026-09-11 — confirmed it's not a hardcoded-string problem.** Pulled all 389 stock `sysevent_email_action` records (Table-API reachable, no ACL block) and searched `message` for `$sp?id=`, `esc?id=`, `sp_portal`, `getMyPortal`, `portal_id`: zero hits across the board. Real link construction, where it exists at all, uses a `<mail_script>` block with embedded JavaScript — e.g. the stock "Indicator Notifications" template calls `gs.getProperty('glide.servlet.uri')`, appends `nav_to.do?uri=...`, and builds the href at send time. Only 1 of 389 stock notifications does this kind of URL-building at all; most either have no link or use a different mechanism not yet identified (possibly a related list / reference field the email layout renders automatically, outside the `message` field).

    Revised audit method: this is a **customization risk, not a global-property check** — look for `<mail_script>` blocks in `message` bodies that construct a URL, and within those, flag any that hardcode a portal name/suffix instead of deriving it (e.g., from the record's `sys_class_name` or a per-user default portal) the way the stock example does. A clean stock instance gives no positive hits to compare against, so this specific check may only be testable meaningfully against a customer instance with customized notifications.

    **General finding surfaced by this dig, filed under `13-data-access.md`:** `glide.servlet.uri` is actively read via `gs.getProperty()` in live platform script, yet does not exist as a `sys_properties` row on this instance — same pattern as `glide.buildname` (item 4a). A property's absence from `sys_properties` does not mean it's unset or false; it may just mean nobody has overridden the platform default. Any phase that checks a property by querying `sys_properties` (this one included) needs to account for that.

## Known-uncertain claims carried in this knowledge base

- Some `sp_*` table names beyond the core set (`sp_rectangle`, `m2m_sp_dependency_js_include`) are drawn from community sources rather than official documentation.
- The undocumented `$sp` methods (`saveRecord`, `getInstanceRecord`, `getVariablesArray`, `buildThemeVariableModel`) are community-reported. They are useful for recognizing what a customization is doing, but should not be relied on as stable.
- The crawl methodology, the three-bucket customization model and the Phase 4 sampling strategy are synthesis built on documented platform behavior, not ServiceNow-published procedures. The behaviors they rest on are documented and cited in the relevant files.

## Deliberate scope exclusions

Recorded so they are not mistaken for oversights:

- **CMS sites.** `com.glide.cms` can no longer be activated and deprecates in the C release. If a customer's "portal" is a CMS site, that is a migration conversation, not an audit.
- **UI Builder experiences.** Different technology, different audit. If the URL suffix resolves to a `sys_ux_page_registry` entry rather than an `sp_portal` record, stop and say so.
- **Workspace experiences.** Out of scope entirely.
- **Now Mobile app configuration** beyond the MESP content rollup difference.
