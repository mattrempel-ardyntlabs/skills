# Audit Methodology and Sub-Agent Decomposition

Eleven phases, 0 through 10, for a single named portal. Phases 1 to 4 and 7 to 9 are platform-side. Phases 5 and 6 require a real browser. Every sub-agent's output must conform to `reference/16-findings-schema.md`.

## Phase list

| Phase | Name | Needs browser | Parallelizable |
|---|---|---|---|
| 0 | Scope and identity | No | No, blocks everything |
| 1 | Portal record and bindings | No | No, blocks everything |
| 2 | Theme and branding | No | Yes |
| 3 | Taxonomy and topic governance (EC only) | No | Yes |
| 4 | User criteria diagnostics, generalized | No | Yes, after 3 |
| 5 | Browser reachability crawl | Yes | Partially, by frontier partition |
| 6 | Front-end and experience review | Yes | Yes, after 5 |
| 7 | EC versus EC Pro feature usage | No | Yes |
| 8 | Custom versus out-of-box inventory | No | Yes, after 5 |
| 9 | Security and performance review | No | Yes, after 5 |
| 10 | Synthesis and report | No | No |

## Sub-agent boundaries

The orchestrator runs Phase 0 and Phase 1 itself, because everything downstream depends on the resolved `sp_portal` record and the small set of facts it yields. Those facts are the shared context passed to every sub-agent:

- instance base URL (needed to construct the `url` field in every finding)
- release family: Australia, Zurich, or Yokohama (needed so a sub-agent does not flag the absence of a release-gated feature as a defect)
- domain separation active (bool, see `reference/14-open-questions.md` for detection method status)
- admin / `sys_update_xml` access confirmed (bool, from a Phase 0 probe: `GET sys_update_xml?sysparm_limit=1`, 200 means true, 403 means false)
- production or non-production clone (from the Phase 0 authorization confirmation)
- run folder root path (the `portal-audit-runs/<portal-suffix>-<date>/` path for this run; `cache/`, `screenshots/`, `findings/`, `logs/` and `metadata.json` all live under it, see `reference/15-report-model.md`)
- the declared write exception, if any: `{name, action, target, reason}` (see `reference/13-data-access.md`), so any sub-agent that ends up using it can set `write_exception_used` correctly
- portal sys_id, URL suffix, name
- homepage, login page, 404 page sys_ids and page IDs
- theme sys_id
- main menu sys_id
- default catalog sys_id, default knowledge base sys_id
- search mode (ai_search or zing) and the bound Search Application sys_id if any
- whether Employee Center scoped apps are present, and whether EC Pro is present
- Inactive flag and Alternate portal
- the persona registry: `admin` by default, plus any operator-declared personas, each an entry of `{name, description, acquisition, underlying_user, effective_roles}`. See `reference/03-routing-reachability.md` for how additional personas are elicited and how `admin`'s own effective role set is captured.

Keep that payload under roughly one page of text. It is passed to every sub-agent, so it must stay small.

### Recommended sub-agents

Every sub-agent below reads `reference/16-findings-schema.md` in addition to the files listed for it. That line is not repeated per entry.

1. **theme-agent** (Phase 2). Input: theme sys_id. Reads `reference/01-portal-record.md` and `reference/11-performance-properties.md`. Returns theme inventory plus shared-portal cross-reference.
2. **search-agent** (Phase 1, search health). Input: search mode and Search Application sys_id from the shared context payload. Reads `reference/07-search.md` and, for the cloned-search-widget-versus-AI-Search check, `reference/09-customization-upgrade.md`. Runs in parallel with Phase 2 and 3 sub-agents, even though its findings are reported as part of Phase 1 in `reference/15-report-model.md`. Returns search health findings and the AI Search eligibility check.
3. **taxonomy-agent** (Phase 3). Input: portal sys_id. Reads `reference/05-ec-taxonomy.md`. Returns the full topic tree with governance and access attributes. This one produces the largest structured payload of the platform-side phases, so it should return a compacted tree, not raw records. Only dispatched when Employee Center scoped apps are present; skipped otherwise, per Phase 3's own scope.
4. **criteria-agent** (Phase 4). Input: catalog and KB sys_ids always; taxonomy-agent output only when Employee Center is present, since Phase 3 is skipped for non-EC portals. Reads `reference/04-security-model.md`, `reference/08-catalog-knowledge.md`. Returns criteria usage distribution and the exhaustively enumerated small sets.
5. **crawl-agent** (Phase 5). Input: seed frontier from Phases 1 and 2. Reads `reference/03-routing-reachability.md`, `reference/13-data-access.md`. Returns page inventory and widget inventory. Highest context pressure of any phase. Partition by frontier segment if the portal is large, and have each partition return only normalized inventory rows, never raw HTML. If the browser phase cannot run at all, even manually (see the auth fallback ladder in `reference/13-data-access.md`), Phases 6, 8 and 9 degrade to their platform-only findings and must state this plainly rather than silently omit crawl-dependent sections.
6. **frontend-agent** (Phase 6). Input: deduplicated page template list from crawl-agent. Reads `reference/10-frontend-review.md`. Returns per-template findings.
7. **ecpro-agent** (Phase 7). Input: app inventory. Reads `reference/06-ec-pro.md`. Returns used-versus-unused matrix.
8. **customization-agent** (Phase 8). Input: widget and page inventory from crawl-agent plus platform-side page list. Reads `reference/09-customization-upgrade.md`. Returns the three-bucket classification.
9. **security-perf-agent** (Phase 9). Input: widget inventory. Reads `reference/04-security-model.md`, `reference/11-performance-properties.md`. Returns server and client script findings plus public exposure list. Public exposure is CONFIG evidence only; see `reference/04-security-model.md`.

### Context discipline for sub-agents

- Every sub-agent returns structured findings, never raw record dumps. A sub-agent that returns two thousand `kb_knowledge` records has failed at its job.
- Sub-agents that enumerate large sets must summarize: counts, distributions, outliers, and a bounded sample. `reference/04-security-model.md` explains where exhaustive enumeration is correct and where sampling is correct.
- Widget server and client scripts are large. The security-perf agent should fetch scripts for a prioritized subset (homepage widgets, high-traffic page widgets, all custom widgets, all public widgets) rather than every widget on the instance.

## Phase detail

### Phase 0. Scope and identity

Input required from the user: the portal URL suffix or full URL, and completing an interactive login (`bin/capture-session.mjs`, including SSO). Nothing else is mandatory — no separate credential is requested by default. See `reference/13-data-access.md`, Authentication.

Order matters here and is easy to get backwards: authorization (`bin/init-run.mjs`) first, since nothing should query the instance before it; then session capture (`bin/capture-session.mjs`); then the scope and identity probes (`bin/phase0.mjs`). The probes now depend on the Table API, which in turn depends on the captured session — running `phase0.mjs` before `capture-session.mjs` fails outright.

Establish and record: the resolved portal, the release, whether the instance is new or upgraded (changes AI Search defaults, see `reference/07-search.md`), the personas available, and whether credentials permit reading `sys_update_xml` (admin-level). If they do not, Phase 8 degrades and that must be stated up front rather than discovered late.

Before any query runs, confirm with the operator that the customer has authorized a read-only audit of this environment, and whether it is production or a non-production clone. If production, restate the load-discipline reminder from `reference/13-data-access.md` and get explicit confirmation to proceed. Record the answers in the run's metadata.

Capture the admin account's own effective role set (`sys_user_has_role`, including inherited roles where queryable) and store it against the `admin` entry in the persona registry. This is cheap and gives honest context later for why content did or did not appear reachable under the admin persona.

Record whether the portal is Inactive and whether an Alternate portal is set. An inactive portal changes the meaning of every finding downstream.

### Phase 1. Portal record and bindings

See `reference/01-portal-record.md`. Read the whole record, not selected fields. Confirm homepage, login page and 404 page resolve to existing active pages. Determine the live search engine from the record. Capture catalog and KB bindings. For custom portals, check derivation against the AI Search baseline allow list.

Search health is reported under Phase 1 (see `reference/15-report-model.md`), though it can be produced by the search-agent running in parallel rather than by the orchestrator itself. See `reference/07-search.md`.

### Phase 2. Theme and branding

See `reference/01-portal-record.md` theme section. List every other portal sharing the theme and flag the sharing explicitly, because theme findings are never single-portal findings.

### Phase 3. Taxonomy and topic governance

Employee Center portals only. See `reference/05-ec-taxonomy.md`. Produces a standalone report section. The critical finding to hunt for is a topic with user criteria enabled and both criteria fields empty, which makes the topic invisible to everyone.

### Phase 4. User criteria diagnostics, generalized not exhaustive

See `reference/04-security-model.md`. Enumerate exhaustively only the small high-leverage sets. Sample the large sets and report distributions.

### Phase 5. Browser reachability crawl

See `reference/03-routing-reachability.md`. Read-only. Produces page inventory and widget inventory, and reconciles three sets: configured and reachable, configured but unreachable, reachable but not configured. The reconciliation itself is withheld, not published, when the crawl only ran under the admin persona. See the persona-gating rule in `03-routing-reachability.md`. This does not apply to Phase 8's orphan detection, which uses the same crawl output but is published regardless of persona, with a caveat; see `09-customization-upgrade.md`. The crawl runs against a stated budget (500 page nodes or 100 minutes wall-clock per persona) and checks back with the operator before exceeding it.

### Phase 6. Front-end and experience review

See `reference/10-frontend-review.md`. Run per unique page template, not per rendered instance of a templated page.

### Phase 7. EC versus EC Pro feature usage

See `reference/06-ec-pro.md`. Determine usage from evidence (record counts, presence in crawl, usage telemetry), not from installation state.

### Phase 8. Custom versus out-of-box

See `reference/09-customization-upgrade.md`. Three buckets. Customized out-of-box is the flagged bucket and is the highest priority section of the final report. Staleness evidence (how many base releases a bucket 3 record has missed) normally comes from Upgrade History, which **is** Table-API reachable with admin (`sys_upgrade_history`, `sys_upgrade_history_log`), confirmed 2026-09-11. A tiered fallback is retained for instances where that read fails. See the tiered evidence section in `09-customization-upgrade.md`. Blast radius for shared pages and widgets, not just themes, is captured here too.

### Phase 9. Security and performance

See `reference/04-security-model.md` and `reference/11-performance-properties.md`. Public exposure is CONFIG evidence only. There is no rendered, logged-out verification of it under this audit's persona model, since every persona is authenticated; state the exposure list as configuration, not as observed behavior.

### Phase 10. Synthesis

See `reference/15-report-model.md`. Order by client value, not audit sequence. If a prior run exists for this portal, offer a comparison section here, matched by `record_refs` rather than by finding `id`. Assemble the output artifacts (report folder, findings JSON per phase, optional PDF) per the layout in `15-report-model.md`.

## Validating the tooling itself

A code review of `lib/` and `bin/`, plus a passing `test/smoke.mjs`, is not evidence this skill works. Every one of the following was invisible to both and was found only by actually running the skill against a real instance:

- The captured-session readiness poll called the Table API to check login, which needs a CSRF token it had no way to attach before a page had loaded, so it always failed and spun for the full timeout even after a correct login.
- An allow-list check compared a portal's URL suffix string against a list of sys_ids. Always false, silently, regardless of real allow-list membership.
- A chunked record-fetch loop treated the first failed chunk as fatal and silently abandoned every chunk after it, with no trace in the output.
- A cross-table lookup used a broad discovery query that could return a different portal's record when more than one matched, producing a plausible-looking but wrong result.
- Table API pagination treated a page shorter than the requested limit as end-of-data. On an ACL-filtered table this is wrong, sometimes badly (one real query returned 99 of 197 rows on the first page and stopped there).

None of these are exotic. Each one produces output that looks complete and reasonable, which is exactly why review and mocks did not catch them: a mock table returns what the mock author expected, and a static read of the code sees a plausible-looking check. Only a real instance's real data exercises the actual edge (an ACL that legitimately shortens a page, a suffix that legitimately is not a sys_id, a login flow that legitimately has not finished when the poll starts).

Before treating a change to this skill's tooling as done, run it against a real, disposable non-production instance through at least Phase 0 and Phase 1, not just `test/smoke.mjs`. A passing smoke suite means the guarantees you already thought to test for still hold; it says nothing about the ones you have not thought of yet.

## Benchmarks that change the plan

- Pre-Australia instances lack portal-specific authentication, the Coral dark theme and theme variants, the Approval Assistance agent, hybrid AI Search and Otto branding. Do not flag their absence. Topic-based access control exists from Yokohama, so it applies on all three tracked releases.
- Instances upgraded into Australia have AI Search off by default. Inactive AI Search on an upgraded instance is a default, not a defect, though still worth raising as an opportunity.
- Non-Employee Center portals skip Phases 3 and 7 and weight Phases 5, 8 and 9 more heavily.
- Custom portals not derived from an allow-listed baseline cannot use AI Search at all, which turns a search recommendation into a re-platforming conversation.
