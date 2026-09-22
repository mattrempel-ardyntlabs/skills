# Performance, Caching and System Properties

## Request lifecycle

```
URL
  └── sp_portal resolution by URL suffix
        └── sp_page_route_map interception (portal-scoped or system-wide)
              └── sp_page (homepage or 404 fallback)
                    └── sp_container / sp_row / sp_column
                          └── sp_instance widget instances
                                └── widget server scripts populate data
                                      └── payload plus compiled SCSS returned
                                            └── AngularJS renders each widget controller
                                                  └── client c.server.get / c.server.update round trips
```

A separate request for `sp_bootstrap.scss`, carrying `portal_id`, compiles the theme SCSS.

Everything in a server script runs on **every page load**. That is the frame for judging severity.

## Server script antipatterns

| Antipattern | Why it hurts |
|---|---|
| Unbounded `GlideRecord` query with no `setLimit()` | Scales with table size, not page needs |
| Queries inside loops (N plus 1) | Multiplies round trips |
| `getRowCount()` on large tables | Full scan for a number |
| Nested queries | Compounding cost |
| `GlideRecord` where `GlideAggregate` should count or group | Retrieves rows to count them |
| Synchronous GlideAjax | Blocks |
| Excessive `$http` or `c.server.get` calls | Serial round trips after render |
| Heavy logic in link functions | Runs per directive instance |

Prioritize by placement, not by severity alone: homepage widgets first, then widgets on the highest-traffic pages from the crawl and usage data, then all custom widgets, then all public widgets.

## Client script antipatterns

- Overuse of `$scope.$watch`, creating digest cycle pressure.
- DOM manipulation inside controllers.
- jQuery used inside Angular.
- Unminified or duplicated `sp_js_include` dependencies.
- Oversized `data` payloads serialized to the client.

## Caching and bundling

- Widget data caching.
- Browser caching.
- JS and CSS bundling controlled by Service Portal properties.
- `sp_js_include` **ordering** affects load.
- Theme SCSS compilation cost, governed in part by `glide.sp.theme.parse_scss`.

**Do not conflate `glide.ui.polaris` with Service Portal.** It governs Next Experience and Polaris. This confusion is common in community material.

## System properties to capture

| Property | Effect |
|---|---|
| `glide.service_portal.*` | Service Portal behavior and bundling |
| `glide.service_portal.sp_user_criteria.cache_enabled` | A **cache** toggle for Service Portal user criteria. Not a feature gate |
| `glide.service_portal.enable_ais_portal.allow_list` | Which baseline portals may use AI Search |
| `glide.sp.starting.page.ignore.list` | Changes landing behavior invisibly from the portal record |
| `glide.sp.entitlement.override` | Overrides entitlement behavior |
| `glide.sp.portals.language` | Portal language configuration |
| `glide.sp.theme.parse_scss` | Theme parsing behavior |
| `glide.sp.debug` | Debug output |
| `glide.sp.show*` | Various display toggles |
| `glide.sp.otto_onboarding.suppressed_portals` | Australia. Suppresses the Otto onboarding pop-up per portal. Accepts one portal sys_id or a comma separated list |
| `glide.ui.accessibility` | Platform accessibility |
| `sn_ex_sp.u_allow.rollup.mesp` | EC mobile content rollup from child topics |
| `glide.knowman.*` | Knowledge behavior |
| Usage Insights properties for Service Portal | Analytics collection |

`glide.sp.starting.page.ignore.list` and `glide.sp.entitlement.override` deserve individual attention because both change routing or access behavior in ways invisible from the portal record itself.

> **The Service Portal user criteria gating property name is not confirmed. Do not hardcode one.**
> `glide.service_portal.user_criteria_enabled` was previously listed in the table above as that gate. It does not exist on either reference instance. Read the target instance's own `sys_properties` rows before relying on any name, and **never treat "property not found" as proof the feature is inert** — on one reference instance the lookup returned no rows while `glide.sc.use_user_criteria` was `true` and criteria were live. If no matching row is found, report the gate as **unverified** and say which names you searched. See `04-security-model.md` for the full confusable-property table.

## Usage telemetry

**Usage Insights for Service Portal** automatically detects gestures and actions of portal users and records events viewable in the Usage Insights application.

Documented events:

| Event | Captured detail |
|---|---|
| Submit Catalog Request | Request ID, number of items in the request |
| Order Catalog Item | Item name and ID, associated request ID |
| Submit Record Producer Request | Producer submission |

`sp_log` captures Service Portal statistics via `$sp.logStat` and `$sp.logSearch`.

This data is what turns "this widget looks unused" into an evidence-backed finding, and it is what separates a genuinely unreachable page from a reachable but ignored one. Pull it wherever it is enabled.

## Instance-level diagnostics

Instance Scan is available and can interrogate configuration for health issues. No portal-specific out-of-box scan checks were confirmed in the Australia documentation, so treat Instance Scan as a general-purpose tool here rather than a portal audit shortcut. See `14-open-questions.md`.

Upgrade Monitor in the Upgrade Console is the tool for skipped changes. See `09-customization-upgrade.md`.
