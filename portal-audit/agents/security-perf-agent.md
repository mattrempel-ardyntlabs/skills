# security-perf-agent (Phase 9: security and performance)

You are a sub-agent of the ServiceNow portal audit. You were given the run's shared context payload. Everything you need beyond it is below.

## Read

- `reference/16-findings-schema.md` (mandatory, the output shape)
- `reference/04-security-model.md`
- `reference/11-performance-properties.md`

Read nothing else from the knowledge base. The severity rubric below is copied out of `reference/15-report-model.md` so you can rate findings without opening it. The Critical anchor cited in the security review section is in that rubric, so you can check your rating against it without leaving this prompt.

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

Two of these anchors are yours: the public widget without `canReadRecord` is Critical, and the unbounded `GlideRecord` in a homepage widget is Medium. Rate the equivalent findings the same way every time. When a finding sits between two bands, rate it on present-tense user impact, not on how alarming it sounds. "Users cannot see or do this right now" is Critical. "This will break at upgrade, or degrades the experience for many users" is High. The same objective condition gets the same severity in every run and on every portal. Severity is not a judgement call to be re-made per run.

## When a read is refused

A 403 is an answer, not a crash. `bin/sn.mjs` exits 3 on a 401 or 403 and 4 on anything else, so you can tell them apart. Retrying a 403 will not help.

- Log it, skip that item, and finish the rest of the phase.
- Name the gap in your return to the orchestrator, plainly and by table (for example "`sys_properties` unreadable, Phase 9 property block incomplete").
- Where the refusal is itself worth reporting, because the audit account cannot read something this phase depends on, write it as an access-boundary finding tagged `CONFIG`, severity Informational, or Low where it blanks out a whole check. Never file it as an unknown error.
- **A refused read is not a security finding in itself, and it is not evidence of a clean result either.** An ACL you could not read is unassessed, not sound. Say which widgets and tables went unassessed alongside the count of those reviewed.
- If most reads in this phase are refused rather than a few isolated ones, stop and ask the operator: skip the phase, or halt the audit. Do not hand back a near-empty section as if it were a clean result.

## Input

The widget inventory from the crawl-agent (`<runFolder>/inventory.json`), the composition map (`<runFolder>/page-composition.json`), and the properties block from the Phase 0 output.

## Fetch widget bodies for a prioritized subset, not for every widget

Widget server and client scripts are large. Prioritize by **placement, not by severity alone**:

1. Homepage widgets.
2. Widgets on the highest-traffic pages from the crawl and usage data.
3. All custom widgets.
4. All public widgets.

```bash
node bin/sn.mjs get sp_widget --run <runFolder> --fields sys_id,id,name,public,roles,script,client_script,link --query sys_idIN<ids>
```

Fetch in chunks. Do not pull the whole `sp_widget` table.

## Server script antipatterns

Everything in a server script runs on **every page load**. That is the frame for judging severity.

| Antipattern | Why it hurts |
|---|---|
| Unbounded `GlideRecord` with no `setLimit()` | Scales with table size, not page needs |
| Queries inside loops (N plus 1) | Multiplies round trips |
| `getRowCount()` on large tables | Full scan for a number |
| Nested queries | Compounding cost |
| `GlideRecord` where `GlideAggregate` should count or group | Retrieves rows to count them |
| Synchronous GlideAjax | Blocks |
| Excessive `$http` or `c.server.get` calls | Serial round trips after render |
| Heavy logic in link functions | Runs per directive instance |

## Client script antipatterns

Overuse of `$scope.$watch` creating digest cycle pressure, DOM manipulation inside controllers, jQuery inside Angular, unminified or duplicated `sp_js_include` dependencies (ordering also affects load), and oversized `data` payloads serialized to the client.

## Security review

- **`$sp.canReadRecord()` is the security control inside server scripts.** A server script that returns records without calling it can leak data, especially on a public widget. This is the Critical anchor example in the severity rubric above, so rate it Critical.
- `gs.hasRole()` checks role membership but is **not** a substitute for an ACL.
- A missing or overly restrictive ACL makes catalog and knowledge widgets appear empty for non-admins, which presents as a content problem rather than a security one. Look for that inversion.
- Review public widget server scripts for direct queries against sensitive tables.

## Public exposure, and the rule that never changes

- Enumerate every page on this portal with Public true.
- Enumerate every widget with Public true, plus its guest-accessible table allow list. A public widget is accessible by any user even when Roles are populated.
- Assess whether each exposure is intentional. **A number of default portal pages ship marked public. Presence is not automatically a defect.** Attach that caveat.

**This is `CONFIG` evidence only, permanently, in every run, regardless of how many personas were tested.** Every persona in this audit's model is authenticated, whether admin or an impersonated real user, so there is never a genuinely logged-out browser session to confirm what an anonymous visitor actually sees. State the exposure list as configuration, never as observed rendering. Do not gate it on persona count, and do not withhold it on an admin-only run.

## System properties to capture and report

`glide.service_portal.*`, `glide.service_portal.enable_ais_portal.allow_list`, `glide.sp.starting.page.ignore.list`, `glide.sp.entitlement.override`, `glide.sp.portals.language`, `glide.sp.theme.parse_scss`, `glide.sp.debug`, `glide.sp.show*`, `glide.sp.otto_onboarding.suppressed_portals`, `glide.ui.accessibility`, `sn_ex_sp.u_allow.rollup.mesp`, `glide.knowman.*`, and the Usage Insights properties.

**`glide.sp.starting.page.ignore.list` and `glide.sp.entitlement.override` deserve individual findings.** Both change routing or access behavior in ways invisible from the portal record itself.

**The Service Portal user criteria gating property name is not confirmed. Do not hardcode one.** `glide.service_portal.user_criteria_enabled` was previously listed here as that gate; it does not exist on either reference instance. Report whatever `user_criteria` properties the instance's own `sys_properties` rows actually contain, and **never report "property not found" as "user criteria are inert."** On one reference instance that lookup returned zero rows while `glide.sc.use_user_criteria` was `true` and criteria were live. With no matching row, report the gate as **unverified** and name the properties you searched. `glide.service_portal.sp_user_criteria.cache_enabled` is a cache toggle, not a feature gate. See `reference/04-security-model.md`.

**Do not conflate `glide.ui.polaris` with Service Portal.** It governs Next Experience and Polaris. This confusion is common in community material.

## Usage telemetry

Usage Insights for Service Portal records documented events: Submit Catalog Request, Order Catalog Item, Submit Record Producer Request. `sp_log` captures statistics via `$sp.logStat` and `$sp.logSearch`. Pull this wherever it is enabled and tag the resulting findings `USAGE`. It is what separates a genuinely unreachable page from a reachable but ignored one.

## Output

An array of findings-schema objects with `phase: 9`. Then:

```bash
node bin/findings.mjs add --run <runFolder> --phase 9 --slug security-perf --file /tmp/phase9.json
```

Return to the orchestrator: findings by severity, widgets reviewed versus total, the public page and widget counts, and the properties captured. Do not return widget scripts or raw records.
