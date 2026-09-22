# Routing and Reachability

## Why a browser crawl is required

Three documented behaviors mean platform configuration and rendered reality diverge by design. An audit built only on table queries will be wrong in all three directions.

1. **Pages are global, not owned by a portal.** `sp_page` has no portal reference. Any page in the instance is addressable through any portal with `?id=`. The set of pages a portal can reach is a property of links, menus and route maps, not of the portal record.
2. **Links render for users who cannot open the target.** Per the Australia docs on page security: users without a listed role can still see links to the page if those links appear in the portal, and only get a "page not found" error on opening it. A rendered link is not proof of access.
3. **`$sp.getWidget()` embeds widgets at runtime** with no `sp_instance` record on the host page. Instance-derived widget inventories under-count.

## URL structure

```
https://<instance>/<portal suffix>/<guest language>/<keywords>?id=<page id>&lang=<language>&<page parameters>
```

| Element | Meaning |
|---|---|
| portal suffix | Suffix established for the portal, for example `/sp` |
| guest language | Language ID of the portal language, for example `es`. Page returns in that language if the language is active and the user is a guest |
| keywords | Human readable keywords improving SEO and click-through for public pages |
| id | Page ID to navigate to within the portal frame, for example `?id=index` |
| lang | Language ID, for example `lang=es`. Returns that language if active and the user is a guest or an authenticated user with no language preference set |
| page parameters | Additional parameters required by some pages to look up a record (table, sys_id) |

Example of a public knowledge page in Spanish: `https://<instance>/sp/es/faq/what-is-a-cookie?id=kb_article&sys_id=KB0000007`

Omitting required page parameters produces the error `You are either not authorized or record is not valid`. Treat that as a distinct crawl outcome from a genuine 404, because it means the page exists and is reachable but was called wrong.

**Article versioning**: with the Knowledge Management - Service Portal plugin (`com.snc.knowledge_serviceportal`) and article versioning enabled, the article version number must be in the URL: `?id=kb_article&sys_id=KB0000005%20V1.0` rather than `?id=kb_article&sys_id=KB0000005`.

## How widgets reference pages

Widgets and widget instance options reference pages by page ID. A typical link inside a widget HTML template:

```html
<div><a href="?id=sc_home">${Order something...}</a></div>
```

This means page IDs are discoverable by static analysis of widget templates and instance options, which is how you build the crawl seed frontier before opening a browser.

## Page route maps

`sp_page_route_map` intercepts routing within a portal, redirecting a "route from" page ID to a "route to" page ID. It exists so hardcoded out-of-box links can be redirected without cloning widgets.

- Route maps do **not** redirect across portals. Cross-portal redirection requires a JS Include or UI Script on the theme, or the `SPEntryPage` script include, or the Inactive plus Alternate portal mechanism on the portal record.
- **Scope varies.** Some route maps are portal-specific and some apply system-wide. The Knowledge Article View page route map is documented as active by default on new instances and applying to all portals in the system. The standard ticket page route map is another documented example.
- An audit must capture both portal-scoped and system-wide route maps, because a system-wide map changes behavior on a portal whose own configuration never mentions it.

Misconfiguration signatures: redirect loops (A to B to A), routes pointing at a non-existent page ID, and route maps applying more broadly than intended.

## Menus

`sp_rectangle_menu` is the menu container, referenced by `sp_instance_menu` and ultimately by the portal's own **`sp_portal.sp_rectangle_menu`** column. It holds `sp_rectangle_menu_item` records.

The portal's menu column is named `sp_rectangle_menu`. `sp_portal` has no `main_menu` column; "Main menu" is a form-level label, not a queryable field name. Requesting `main_menu` in a Table API `sysparm_fields` list is silently dropped from the response rather than erroring, so a bad field name looks like an unconfigured portal instead of a failed query. Verified against a live instance: a `sys_dictionary` read of `sp_portal` returns `sp_rectangle_menu` and no `main_menu`.

Each item resolves a target: a page ID, a URL, or a KB or catalog reference via `$sp.getMenuHREF()`. Items can be role-gated and can carry conditions. `$sp.getMenuItems(sys_id)` returns items for an instance.

Employee Center layers its own Menu Item and Footer Menus records on top, for the mega menu and footer.

Bad config: items pointing to pages the user cannot read (dead ends), and role or condition mismatches hiding navigation from users who should have it.

## Crawl methodology

This section is synthesis built on the documented behaviors above, not a ServiceNow-published procedure.

### Rules

- **Read only.** Never submit a form, order an item, or trigger a record producer.
- Extraction must happen **after Angular render**, not from raw HTML, because widgets build links client-side.
- Crawl breadth-first so depth-from-homepage is meaningful in the report. Breadth-first also means the budget below runs out on the long tail, not on menus and homepage.

### Budget

Cap the crawl at 500 distinct page nodes or 100 minutes of wall-clock time, whichever comes first, per persona. The 100 minutes is wall-clock, not summed across concurrent tabs, so 3 tabs running for 100 minutes is still one 100-minute budget, not 300 tab-minutes. On hitting either limit, stop immediately. State plainly how many nodes were reached and roughly how many remain queued, then ask the operator: raise the limit and continue from where it stopped, or finalize with a partial result. Never raise a limit and continue without asking again, including on a second or third hit. Each persona gets its own budget, so adding personas multiplies crawl time roughly by how many are added.

Persist the frontier queue and visited-node set to `crawl-state.json` in the run folder as the crawl progresses, separately from the raw-response `cache/` (which is keyed by table plus query, not by crawl position). This is what makes "continue from where it stopped" literal rather than aspirational, both for a budget-limit resume and for resuming an interrupted run in a later session.

### Parallelism within one persona

Once a persona's session (its saved login, whether direct or via impersonation) is captured, that same saved login can be loaded into more than one browser tab at once. Different tabs can then crawl different segments of the frontier concurrently. Cap this at 3 tabs, fixed, to avoid overloading the instance per the load discipline in `13-data-access.md`. This has not been confirmed to work with whatever browser tool ends up being used in the build; fall back to one tab, one frontier, in sequence, if it does not. Never run tabs for more than one persona at the same time, since impersonation is one identity per session.

### Seed frontier

Seed from platform data collected in Phases 1 and 2, before opening a browser:

1. Homepage, login page, 404 page from `sp_portal`.
2. Every menu item target from the main menu tree and, for EC, mega menu and footer menus.
3. Every `sp_instance_link` target.
4. Every page ID appearing in widget HTML templates and instance options (static grep for `id=`).

### Normalization and deduplication

Normalize to the documented URL structure. Deduplicate on **page ID plus material parameters** so that a thousand knowledge articles collapse into one `kb_article` page node with a sampled parameter set. Without this the crawl is unbounded on any real customer portal.

Treat `lang` and the guest-language path segment as non-material for structure dedup, but retain them for the translation review in Phase 6.

### Route map application

Record both the intended destination and the actual destination for every link. The divergence is itself a finding, and a link that appears broken may simply be route-mapped.

### Outputs

**Page inventory**: page ID, title, reached from, depth, status, Public, Roles, Draft, whether route-mapped, persona under which it was reached.

**Widget inventory**: widget, host page, instance sys_id if any, out-of-box or custom, and whether reached through an `sp_instance` record or embedded at runtime via `getWidget`.

### Reconciliation

Report three sets explicitly. Collapsing them loses the finding.

1. **Configured and reachable.** Normal.
2. **Configured but unreachable (orphans).** Pages with instances and containers that nothing links to. Often abandoned work, sometimes intentionally parameter-only.
3. **Reachable but not in the configured set.** Usually route-map effects, embedded widgets, or pages borrowed from another portal because pages are global.

### Parameterized pages

Pages requiring `sys_id` or `table` cannot be reached by link-following alone. Discover required parameters from `$sp.getParameter` calls in the server scripts of that page's widgets, then visit each with one representative record. Do not enumerate all records.

### Persona model

Because links render for users who cannot open the target, a single-persona crawl systematically overstates reachability. But most real portals require login for nearly everything, so there is no free guest/anonymous baseline to fall back on. The default floor is a single persona: `admin`, the audit's own credential, used directly.

At Phase 0, offer the operator the option to add more personas. Guide the offer using this specific portal's own security surface: read the roles actually referenced in its `sp_page.roles`, `sp_widget.roles`, and, for Employee Center, its topic criteria, and present that short list rather than asking the operator to guess blind. For each persona they want to add, collect a `name` (the registry key, used everywhere else in the KB and the findings schema to refer to this persona) and a real, active user's username or sys_id to impersonate. Impersonation requires the admin account to hold the `impersonator` role; if it does not, additional personas are not available through this mechanism, and the audit proceeds admin-only.

Impersonation is one identity per session, so personas are crawled sequentially, never in parallel with each other.

Capture the `admin` persona's own effective role set in Phase 0 (see `00-methodology.md`) rather than assuming it either bypasses or respects role gating. Whether it does either is instance-specific, depending on how the customer's role hierarchy is configured.

**Gating rule.** The Phase 5 reconciliation of configured-and-reachable, configured-but-unreachable, and reachable-but-not-configured sets only means something relative to a real, non-admin view. When the audit ran admin-only, withhold this specific finding rather than publish a misleading version of it, and state exactly why, in the place it would otherwise appear.

This does not extend to Phase 8's orphan detection, which reuses the same crawl output to ask a different, more persona-robust question (does anything link to this at all, for anyone), and is published with a caveat instead of withheld. See `09-customization-upgrade.md`.

Public exposure (Phase 9) is not gated by persona at all, in either direction. Every persona in this model is authenticated, whether admin or an impersonated real user, so there is never a truly logged-out view to render against. Public exposure is reported as CONFIG evidence only (the list of records flagged Public true), permanently, not as something an additional persona would unlock. See `04-security-model.md`.

Findings that do not depend on access, such as the raw page and widget inventory, accessibility and responsive checks, and script-level code review, are unaffected and run normally on admin alone.

Record persona against every reachability claim, using the `name` key from the persona registry, never free text.

### Usage cross-reference

Where Usage Insights and `sp_log` data are available, cross-reference to distinguish pages that are unreachable from pages that are reachable but unused. This converts "this widget looks unused" from speculation into an evidence-backed finding. See `11-performance-properties.md`.
