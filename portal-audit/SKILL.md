---
name: portal-audit
description: Use when auditing a customer ServiceNow portal end to end (Service Portal, Employee Center, Employee Center Pro, or a custom portal built on Service Portal), or when asked to review a portal's upgrade risk and customized out-of-box records, topic and user criteria visibility, search health, reachability, accessibility, or portal performance and security. The user supplies a portal URL suffix or full URL.
---

# ServiceNow Portal Audit

Audits one named portal and produces an evidence-tagged report. Target release is Australia, with Zurich and Yokohama supported where behavior is noted as differing.

The research is already done and lives in `reference/`. Do not re-research ServiceNow portal internals, and do not read every reference file at once. `README.md` in this directory holds the routing table.

## The contract, before anything else

**Read only, by construction.** The Table API client (`lib/table-api.mjs`) implements exactly `get` and `count`. The browser wrapper (`lib/browser.mjs`) implements exactly navigate, click-a-link, observe, screenshot, and start/stop impersonation. No write action exists to call. Every click passes the form check and the write-verb blocklist in `lib/blocklist.mjs` first. State this to the customer before the audit starts.

Two named exceptions, both logged locally:

- **Start/Stop Impersonating** changes session state on the instance. Always call stop, even when a phase fails partway through.
- **One operator-declared write**, declared at Phase 0 with the exact action, exact target and reason, scoped to that one target. Findings produced from it set `write_exception_used`. Delete is never allowed, with no override.

**No em dashes** in any report, finding or generated document.

## Setup

```bash
export SN_INSTANCE=acme.service-now.com
node bin/setup.mjs                     # installs Playwright, vendors axe-core, installs pdf-lib
node test/smoke.mjs                    # verifies the read-only guarantees hold
```

No `SN_USER`, `SN_PASSWORD` or `SN_TOKEN` is needed by default. This skill authenticates the Table API the same way it authenticates the browser crawl: **one interactive login, including SSO, captured once in Phase 0 below and reused for everything that follows.** It never creates a user or credential on the customer's instance to get one; see reference/13-data-access.md, Authentication.

Only set `SN_USER`+`SN_PASSWORD` (Basic Auth) or `SN_TOKEN` (OAuth Bearer) if the customer has independently chosen to provision a dedicated integration credential for this engagement. That is optional, never something to ask for as a precondition, and it is preferred over the captured session only because it does not depend on a session file staying valid for the length of a long run.

All commands run from this skill's directory. Run folders land in `portal-audit-runs/`, which is gitignored and never committed.

## Phase 0, in this order. Skipping any of these wastes the whole run.

1. **Authorization, before any query.** Ask the operator: has the customer authorized a read-only audit of this environment, and is it production or a non-production clone? If production, restate that the browser crawl generates real load and should not run during business hours without agreement, and get explicit confirmation. Then:

   ```bash
   node bin/init-run.mjs --suffix esc --authorized yes --environment production \
     --production-ack yes --note "approved by ..., CHG0012345"
   ```

   `bin/phase0.mjs` refuses to run until this exists. The gate is enforced by the tooling, not by remembering.

2. **Authentication, resolved now rather than discovered mid-run.** Every later phase, not just the browser crawl, depends on this:

   ```bash
   node bin/capture-session.mjs --run <run>
   ```

   Opens a real browser at the login page; the operator completes it interactively, including SSO. State plainly to the operator before this runs: **the resulting session is the only credential this audit will use.** No separate service account or OAuth registration is being requested, and none will be created. (If the customer has independently offered a dedicated `SN_TOKEN`/`SN_USER` credential, this step can be skipped for the Table API; `lib/session.mjs` prefers that dedicated credential over the captured session when both exist, since it does not depend on a session file staying valid for the length of a long run. The browser phases still need this step regardless.)

   SSO is the likely blocker. On failure the script prints the fallback ladder. If no browser session is possible at all, run every platform-side phase and state plainly in the report that Phases 5 and 6 did not run and that the crawl-dependent parts of Phases 6, 8 and 9 are absent, not empty. In that case Phases 1, 3, 4, 7, 8 and 9 cannot run either, since they now share this same session — say so.

3. **Scope and identity probes.**

   ```bash
   node bin/phase0.mjs --run portal-audit-runs/esc-<date>
   ```

   Stop and say so if the suffix resolves to a `sys_ux_page_registry` entry (a UI Builder experience, different technology, different audit) or to a CMS site (a migration conversation). The script exits 2 and names which.

   Then read its output and talk to the operator about:
   - **`sys_update_xml` access.** If unreadable, say now that Phase 8 will be degraded. Do not discover it at the end.
   - **Release family.** The `glide.buildname` mapping is not authoritative. Confirm it.
   - **Personas.** Default is `admin` only. Offer to add more, guided by `rolesReferencedByPortalSurface` in the phase 0 output rather than asking the operator to guess. For each persona collect a `name` (the registry key used everywhere afterwards) and a real, active username or sys_id. Impersonation needs the `impersonator` role; without it the run is admin-only. **Admin-only costs more than just the withheld Phase 5 reconciliation.** Admin bypasses every role check, so any finding that depends on one, not just reachability, gets caveated as inferred from configuration rather than observed: role-gated pages and widgets (Phase 1), topic and criteria visibility (Phases 3 and 4), and any accessibility check tied to a specific view. A run with a second, low-privilege persona converts several of these from CONFIG-inferred to RENDERED-confirmed. Push for one when the engagement allows it, rather than treating admin-only as the default to settle for.
   - **Domain separation.** If it reads as active, say the audit's Service Portal findings may be domain-scoped, and that this is outside validated scope.
   - **A write exception**, only if the engagement genuinely needs one.

## Phase 1, run by the orchestrator

```bash
node bin/phase1.mjs --run <run> [--personas personas.json] [--release Australia]
```

Writes `shared-context.json` (the payload every sub-agent gets, kept under a page), `phase1-observations.json`, `seeds.json` and `page-composition.json`.

Then, before the crawl: read `seeds.json`'s `parameterizedPages`, pick **one** representative record per page (never enumerate), and write `parameter-samples.json` as `{"kb_article": [{"sys_id": "..."}]}`.

Author the Phase 1 findings yourself from the observations. The scripts establish facts; findings are a judgment call.

## Dispatching sub-agents

Sub-agents are mandatory. A real customer portal produces far more data than one context window holds.

Give each sub-agent exactly three things: the contents of `shared-context.json`, the agent file from `agents/`, and nothing else. The agent file names the reference files it reads.

| Agent | Phase | Dispatch after |
|---|---|---|
| `agents/theme-agent.md` | 2 | Phase 1 |
| `agents/search-agent.md` | 1 | Phase 1 |
| `agents/taxonomy-agent.md` | 3 | Phase 1, only when Employee Center scoped apps are present |
| `agents/criteria-agent.md` | 4 | Phase 3, or Phase 1 on a non-EC portal |
| `agents/crawl-agent.md` | 5 | Phase 1 plus a browser session |
| `agents/frontend-agent.md` | 6 | Phase 5 |
| `agents/ecpro-agent.md` | 7 | Phase 1, only for Employee Center portals |
| `agents/customization-agent.md` | 8 | Phase 5 |
| `agents/security-perf-agent.md` | 9 | Phase 5 |

Theme, search, taxonomy and ecpro run in parallel. Criteria follows taxonomy. Customization, security-perf and frontend follow the crawl. Get the platform side working end to end before attempting the browser phases.

Non-Employee Center portals skip Phases 3 and 7 and weight 5, 8 and 9 more heavily.

## Findings

`reference/16-findings-schema.md` is the one and only findings shape. Do not invent another.

Every sub-agent writes an array of findings to a file, then:

```bash
node bin/findings.mjs add --run <run> --phase 4 --slug criteria --file /tmp/p4.json
```

Invalid findings are rejected and nothing is written. The validator enforces persona on access claims, persona resolution against the registry, the shared-scope tier rule, write-exception matching, the URL convention, integer phases, withheld findings carrying a reason, the admin-only Phase 5 placeholder, and the no-em-dash rule.

Sub-agents return **structured findings, never raw records**. A sub-agent that returns two thousand `kb_knowledge` rows has failed.

## Phases 5 and 6

```bash
node bin/crawl.mjs --run <run> --persona admin --tabs 3
node bin/frontend-review.mjs --run <run> --persona admin --langs de,es
```

Personas are crawled sequentially, never concurrently, because impersonation is one identity per session. Within one persona, up to 3 tabs share that persona's saved login.

**The crawl budget is 500 page nodes or 100 minutes wall clock per persona.** On hitting either, `bin/crawl.mjs` exits 6 and states what was and was not reached. Ask the operator every single time, including the second and third time: raise the limit and resume (`--resume --raise-budget N`), or finalize with a partial result. Never raise a limit on your own.

## Phase 10, the report

```bash
node bin/report.mjs --run <run> [--compare]
node bin/finish-run.mjs --run <run>
```

`bin/report.mjs` validates every finding before assembling, so a schema violation stops the report rather than appearing in it. Ordering, evidence typing and severity come from `reference/15-report-model.md`.

Then: offer a branded PDF alongside the Markdown.

```bash
node bin/report-pdf.mjs --run <run> [--narrative narrative.json]
```

This is a dedicated pipeline (`lib/pdf/`), not the generic `make-pdf` skill, because it renders the Ardynt Labs Design System theme, the severity chart, the high-severity spotlight cards and the screenshot gallery `make-pdf` has no concept of. `--narrative` supplies the one thing the script cannot derive on its own: the exec-summary headline and the "what to do next" synthesis, a judgment call the same way authoring a finding is. Without it, the PDF still renders with a plain, mechanically assembled headline, and says so. See `reference/17-pdf-report.md` for the shape and the pagination rules the templates depend on.

Offer to delete `cache/` and `screenshots/`; never delete by default. `bin/finish-run.mjs` always deletes `.auth/`, which holds live session credentials.

## Rules that are easy to get wrong

- **Never assume instance-wide defaults apply to this portal.** Almost every setting that matters is per-portal. Read the record.
- **Pages are global.** `sp_page` has no portal reference. Reachability is a property of links, menus and route maps, which is why the crawl exists.
- **A rendered link is not proof of access.** Links render for users who cannot open the target.
- **Three customization buckets, never two.** Out-of-box unmodified, custom (including clones), customized out-of-box. Only the third is flagged prominently. Clones upgrade cleanly.
- **The Phase 5 reconciliation is withheld on an admin-only run**, with a `status: withheld` placeholder written into `findings/phase-5-*.json`, not omitted. Phase 8's orphan detection is published anyway, with a caveat. Phase 9's public exposure is CONFIG-only in every run, permanently.
- **Use the Aggregate API for counts.** Never retrieve rows to count them.
- **Enumerate the small sets, sample the large ones.** `reference/04-security-model.md` says which is which.
- **Do not flag missing Australia features on Zurich or Yokohama**, and do not flag inactive AI Search on an upgraded instance as a defect. It is the documented default.

## Error handling

Transient failures retry 3 times with increasing waits, then log, skip and continue. A 403 is not retried. If a whole phase is failing broadly rather than on isolated items, stop and ask the operator whether to skip the phase or halt the audit, rather than producing a near-empty section.

## Files

```
SKILL.md              this file
reference/            the knowledge base, routed by README.md
agents/               one dispatch prompt per sub-agent
lib/                  table-api, browser, blocklist, crawl, findings, report
lib/pdf/              report.pdf's data shaping, HTML templates and render/merge (bin/report-pdf.mjs)
bin/                  the commands above
test/smoke.mjs        proves the read-only guarantees, no instance needed
vendor/axe.min.js     pinned axe-core, injected into rendered pages
assets/pdf-theme/     vendored Ardynt Labs Design System tokens, fonts, logo and motif for report.pdf
```
