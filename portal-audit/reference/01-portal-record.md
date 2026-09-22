# The Portal Record: Audit Entry Point

`sp_portal` is the root of the traversal graph. One record, resolved from the URL suffix the auditor supplies, unlocks every other branch.

## Resolving the portal

The user supplies a URL suffix (`sp`, `esc`) or a full URL. Query `sp_portal` by URL suffix. Exactly one record should match. If zero match, the suffix may belong to a UI Builder experience or a legacy CMS site rather than a Service Portal, which is itself a finding.

## Fields and what each one unlocks

| Field | Effect | Downstream branch |
|---|---|---|
| URL suffix | Path segment mapping a URL to this portal | Crawl base URL |
| Homepage | `sp_page` shown when no `id` parameter is given | Crawl seed, page tree root |
| Login page | Page used for authentication | Crawl seed, auth review |
| 404 page | Page shown for an unresolved `id` | Crawl seed, error-state review |
| Default title | Browser title | Branding |
| Theme | `sp_theme` reference: header widget, footer widget, branding, SCSS | Phase 2 |
| Main menu (column: **`sp_rectangle_menu`**) | Reference to an `sp_instance_menu`. The column is named `sp_rectangle_menu`, not `main_menu` — query it by that name | Menu tree, crawl seeds |
| KB / Knowledge Base | Default `kb_knowledge_base` used by `$sp.getKBRecord()` and KB widgets | Content bindings |
| Catalog / SC Catalog | Default `sc_catalog` used by catalog widgets and `$sp.getSCRecord()` | Content bindings |
| Notification | Notification configuration | Email-to-portal links |
| Quick Start config | Quick start guidance | Low priority |
| CSS variables | SCSS variable overrides, populated by the Branding Editor | Theming review |
| Logo, Icon | Image fields | Branding |
| Inactive | Deactivates the portal | See below |
| Alternate portal | Redirect target when Inactive | See below |
| Enable AI Search | Turns on AI Search for this portal | Phase 1, see `07-search.md` |
| Search Application | `sys_search_context_config` binding: engine, results limit, suggestions limit | Search chain |
| Search Results Configuration | EVAM definition controlling result display | Search chain |
| Search Sources (related list) | `sp_search_source` records, **hidden when AI Search is enabled** | Zing chain |

## Portal deactivation

`sp_portal` has an **Inactive** option and an **Alternate portal** field. Confirmed in the Australia docs, correcting a common assumption that portals cannot be deactivated.

- When Inactive with an Alternate portal set, users are redirected by replacing the URL suffix of the inactive portal with the suffix of the alternate portal.
- Temporary HTTP 302 redirects are used, so search engines do not deindex public pages of a portal that may be reactivated.
- With no Alternate portal set, users get a message that the portal has been deactivated. These messages are customizable from `sys_ui_message`.
- You cannot deactivate: the default portal on an instance, any portal configured as an alternate portal for an inactive portal, or the Mobile Employee Service Portal (`/mesp`).
- Reactivation is clearing the Inactive option.

Audit implications: if different pages are used on each portal, page route maps are required to map pages from the inactive portal to the alternate portal. Existing `SPEntryPage` customizations or other redirect customizations can conflict with deactivation and must be tested or removed. Verify that resources such as knowledge base articles and catalog items are actually available on the alternate portal, since redirection does not carry entitlement with it.

## Portal-specific authentication (Australia)

Australia allows tailoring the login experience per Service Portal, with different identity providers, local login, or both, configured on the portal rather than by customizing the Login widget. When not enabled, the portal falls back to instance-wide authentication.

Audit checks: whether per-portal auth is configured, whether a customized Login widget still exists from before this feature (a bucket 3 customization that can now be reverted, see `09-customization-upgrade.md`), and whether `SPEntryPage` customizations conflict.

## Theme

`sp_theme`, referenced by `sp_portal.theme`, holds header widget, footer widget, base styles, CSS variables (SCSS), plus related `sp_css` stylesheet includes and `sp_js_include` JS includes.

Precedence: SCSS variables on the portal record and theme compile through `sp_bootstrap.scss` (requested with a `portal_id` parameter), then per-widget and per-instance SCSS is injected as `<style>` elements in `<head>`.

Key audit behaviors:
- One theme can serve multiple portals. Always cross-reference which other portals share this theme and state the blast radius of any theme finding. Pages and widgets carry the same blast-radius risk, using a two-tier confidence model since they lack a direct field to check against. See `09-customization-upgrade.md`.
- Prefer SCSS variables over raw CSS selectors. Element, class and id selectors change between releases. Variables such as `$brand-primary` and `$sp-tagline-color` are stable. Raw selector overrides are upgrade-fragile and should be flagged.
- Australia adds a Coral dark theme and the ability to create theme variants.

## Structure visualization widgets

Two out-of-box widgets expose portal structure and are useful for cross-checking your own traversal:
- **SP Portal Map widget**: displays the portal in a tree structure.
- **SP Page Map widget**: works in the Page Editor to display any Service Portal page in a tree structure.

Both live on the Service Portal Configuration page.
