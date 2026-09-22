# Claude Code Build Prompt: ServiceNow Portal Audit Skill

Paste everything below into Claude Code, with the `portal-audit/` directory present in the working directory.

---

## Task

Build a Claude Code skill that performs an in-depth audit of a single customer ServiceNow portal (Service Portal, Employee Center, Employee Center Pro, or a custom portal built on Service Portal). Target release is Australia, with Zurich and Yokohama supported where behavior is noted as differing.

The research is already done. It lives in `portal-audit/`. Read `portal-audit/README.md` first. It contains a routing table telling you which reference file covers which concern. Do not read every reference file into context at once. That is the whole reason the knowledge base is split.

Do not re-research ServiceNow portal internals. If something is genuinely missing, check `portal-audit/reference/14-open-questions.md` first, since it may already be documented as a known gap.

## What the skill does

The user provides one thing: a portal URL suffix or full URL. The skill audits that one portal and produces a report.

The audit runs in eleven phases, 0 through 10, defined in `portal-audit/reference/00-methodology.md`. That file also defines the sub-agent decomposition, which phases can run in parallel, and what shared context each sub-agent receives. Every sub-agent's output must conform to `portal-audit/reference/16-findings-schema.md`. Read that file before writing any sub-agent.

Phases 1 through 4 and 7 through 9 read the platform through the Table API. Phases 5 and 6 require a real browser, because the findings are render-time facts that platform queries cannot produce. `portal-audit/reference/03-routing-reachability.md` explains why in three documented specifics.

## Hard requirements

**Read only, enforced by construction.** The Table API client must only implement `get` and `count`. Do not add a write method to it. The browser wrapper must only implement navigate, click-a-link, observe, screenshot, and start/stop impersonation. Do not add fill, type, or submit to it. The click-a-link action must apply the form-check and write-verb blocklist defined in `13-data-access.md` exactly, not a re-derived version of it. The point is that no write action exists to call, not that agents are told not to call one.

**One narrow, operator-declared exception.** If an engagement genuinely needs one specific write tested (for example, confirming a record producer submits correctly), the operator can declare it in Phase 0: the exact action, the exact target, and why. The orchestrator then builds one narrow write action scoped to that target only, never a general write capability. Every use is logged locally, and every finding produced from it carries `write_exception_used` set to the exception's name in the findings schema. Delete is never allowed, even under this exception, with no override.

**Start/Stop Impersonating is read-only in effect but not inert.** It changes session state on the instance and is logged there. Treat it as an allowed, named exception distinct from the write-exception mechanism above. Log every start and stop locally, and always call stop, even if the phase fails partway through.

**Sub-agents are mandatory, not optional.** A real customer portal produces far more data than one context window holds. The orchestrator runs Phase 0 and Phase 1 itself, then dispatches sub-agents per `00-methodology.md`. Each sub-agent receives: the small shared context payload (defined in that file, keep it under one page), the specific reference files for its phase, and nothing else.

**Sub-agents return structured findings, never raw records.** A sub-agent that returns two thousand `kb_knowledge` rows has failed. Implement the schema already defined in `portal-audit/reference/16-findings-schema.md` and make every sub-agent conform to it. Do not design a new one.

**Always set `sysparm_fields` and `sysparm_exclude_reference_link=true`** on Table API calls. A single `sp_widget` record with all fields carries the full template, client script, server script, CSS and option schema. See `portal-audit/reference/13-data-access.md`.

**Use the Aggregate API for counts and distributions.** Never retrieve rows in order to count them. This is what keeps the Phase 4 sampling strategy affordable.

**Cache raw responses to local disk**, keyed by table plus query. Sub-agents read from cache rather than re-querying. The cache doubles as the audit's evidence trail and makes report regeneration free.

## Resolve these in Phase 0, before anything else

These three are the most common ways this kind of tool fails late and wastes an entire run. Resolve them in this order, since the first gates everything else:

1. **Confirm the operator is authorized to run this, and against which environment.** Ask, before any query runs, before even resolving the portal: confirmation that the customer has given permission for a read-only audit of this environment, and whether it is production or a non-production clone. If production, add an explicit reminder that the browser crawl still generates real load and should not run during business hours without agreement. Record the answers in the run's metadata alongside the rest of the evidence trail. See `portal-audit/reference/13-data-access.md`.

2. **Authentication for the browser phase.** SSO is the likely blocker. `13-data-access.md` lays out the preferred path (interactive auth once as admin, then reuse the session or storage state, with additional personas obtained via impersonation from that same session), the alternative, and the degraded fallback. Detect and resolve this at the start.

3. **Whether the credential can read `sys_update_xml`.** This needs admin. Phase 8, the customized-out-of-box inventory, is both the highest-value section of the report and the one that needs elevated rights. If admin is not available, say so in Phase 0 output and set expectations, rather than producing a hollow Phase 8 at the end. Separately, whether Upgrade History is reachable at all through the Table API is not confirmed even with admin; Phase 8 uses a tiered fallback for this, see `09-customization-upgrade.md`.

Also in Phase 0: detect whether the URL suffix resolves to an `sp_portal` record at all. If it resolves to a `sys_ux_page_registry` entry, it is a UI Builder experience and out of scope. If it is a CMS site, that is a migration conversation. Stop and say so in both cases.

## Design decisions already made, do not relitigate

These were settled during research. Implement them as specified.

**Customization classification has three buckets, not two.** Out-of-box unmodified, custom (including clones), and customized out-of-box. Only the third gets flagged prominently. Clones upgrade cleanly and have completely different remediation from directly modified base records. Never merge buckets 2 and 3 into a single "customized" count. See `09-customization-upgrade.md`.

**User criteria analysis enumerates the small sets exhaustively and samples the large ones.** Service Portal page, widget, widget instance, announcement and search source criteria, plus Employee Center topic criteria, plus knowledge base, catalog and category level criteria, are all enumerated in full. Individual articles and catalog items are sampled, with distributions and outliers reported. Customers have thousands of each. See `04-security-model.md`.

**Reachability is determined by crawling, not by querying.** `sp_page` has no portal reference. Pages are global to the instance. The set of pages a portal reaches is a property of links, menus and route maps. See `03-routing-reachability.md`.

**Default persona is admin only. Additional personas are operator-declared, not automatic.** Guest/anonymous access is unusable on most real portals, since nearly everything requires login, so there is no free default beyond admin. At Phase 0, offer to add personas, guided by the roles this specific portal's pages, widgets and topics actually reference, and collect a name plus a real username or sys_id to impersonate for each, using ServiceNow's Start/Stop Impersonating rather than a second SSO login. The Phase 5 reachability reconciliation only means something relative to a non-admin view and must be withheld (`status: withheld` in the findings schema), not produced with misleading confidence, when only admin was tested. Phase 9's public exposure finding is different: it is CONFIG-only in every run, permanently, since no persona in this model is ever truly logged out, so it is never gated by persona count in the first place. See `03-routing-reachability.md`.

**Blast radius is not a theme-only concept.** Pages and widgets are just as global and shareable as themes. Use two tiers: an exact tier for a page matching another portal's homepage, login, or 404 field directly (cheap, certain), and an approximate tier for everything else, using instance-wide placement counts as a signal, not proof. Never present the approximate tier with the same confidence as the exact one. See `09-customization-upgrade.md`.

**The crawl has a stated budget: 500 distinct page nodes or 100 minutes per persona, whichever comes first.** On hitting either limit, stop, state clearly what was and was not reached, and ask the operator whether to raise the limit and continue or finalize with a partial result. Never raise a limit and continue without asking, including on a second or third hit. See `03-routing-reachability.md`.

**Within one persona, the frontier can be crawled with up to 3 concurrent browser tabs sharing that persona's saved login.** This has not been confirmed to work with whatever browser tool ends up being used; fall back to one tab in sequence if it does not. Never run more than one persona's tabs concurrently, since impersonation is one identity per session.

## Build order

1. Skill scaffold, implementing the findings schema from `16-findings-schema.md`, and the read-only enforcement layer.
2. Table API client with field selection, pagination, aggregates and disk caching.
3. Phase 0 and Phase 1 in the orchestrator, producing the shared context payload.
4. Platform-side sub-agents: theme, taxonomy, criteria, ecpro, customization, security-perf.
5. Browser layer and the crawl sub-agent. This is the hardest part. Build it after the platform side works end to end.
6. Front-end review sub-agent.
7. Report assembly per `portal-audit/reference/15-report-model.md`.

Get a full platform-side-only run working against a real instance before starting step 5. The audit is already useful without the browser phases, and having a working baseline makes the browser work debuggable.

## Report requirements

`portal-audit/reference/15-report-model.md` specifies ordering, the evidence typing scheme (`CONFIG`, `RENDERED`, `USAGE`, `INFERRED`), the severity model with anchor examples, and the findings that must carry caveats attached to the finding itself rather than buried in a general disclaimer.

Two things to enforce in code: every finding carries an evidence tag, and every reachability or visibility finding carries the persona it was observed as. A visibility finding without a persona is not a finding.

**Output artifacts.** One folder per run, named by portal suffix and date, holding `cache/`, `screenshots/`, `findings/` (one JSON file per phase, each an array of findings-schema objects), and the assembled `report.md`. Offer a branded PDF alongside the Markdown report via `bin/report-pdf.mjs` (see `reference/17-pdf-report.md`), which renders the Ardynt Labs Design System theme rather than a generic export. If a prior run folder exists for the same portal, offer a comparison section, inserted right after the executive summary, matching findings across runs by `record_refs` rather than by `id`.

**Data retention.** Keep `cache/` and `screenshots/` by default after the report is generated, since they can matter for a future re-audit comparison or for re-verifying a disputed finding. Offer to delete them, do not delete by default. Never commit the run folder to git; add it to `.gitignore`.

**Error handling.** Retry a transient failure (timeout, server error, rate limit) up to 3 times with increasing waits, then log it, skip that item, and continue the phase. Treat a permission error (403) the same way, without retrying, since retrying will not help. If a whole phase is failing broadly rather than on isolated items, stop and ask the operator whether to skip the phase or halt the audit to investigate, rather than silently producing a near-empty section.

## Style

No em dashes anywhere in generated documents, reports, or skill output.

## Ask before you start

Confirm your understanding of the phase model and sub-agent boundaries, and raise anything in the knowledge base that looks contradictory or underspecified, before writing code.
