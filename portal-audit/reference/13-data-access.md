# Reading the Instance

This file covers how the skill actually gets data. It is the load-bearing operational detail that the rest of the knowledge base assumes.

## Read-only contract

Every agent operates read-only, enforced by what the tooling can do, not by what it is told not to do.

**Table API client.** Implement exactly two methods: `get` and `count`. Do not implement a write method. There is nothing to call, so nothing can be called.

**Browser wrapper.** Implement exactly five actions: navigate, click-a-link, observe/snapshot, screenshot, and start/stop impersonation. Do not implement fill, type, or submit. Before any click, check two things: the element is not inside a `<form>`, and its visible text does not match a blocklist of write verbs (order, submit, save, book, approve, comment, react, apply, request, add to cart, checkout, post, delete, remove). If either check fails, skip the click and log it as "skipped: looked like a mutating control."

**Start/Stop Impersonating is a named, deliberate exception**, not a loophole. It changes session state on the instance and is logged there, even though it does not change customer data. Log every start and stop locally too, and always call stop before the browser phase ends, even if something fails partway through.

**The one narrow write exception.** If an engagement genuinely needs one specific write tested, for example confirming a record producer submits correctly, the operator declares it explicitly in Phase 0, before the audit starts, never mid-run: the exact action, the exact target, and why. The orchestrator then builds one narrow write action scoped to that target only, never a general write capability. Log every use locally. Every finding produced from it carries `write_exception_used` set to the exception's name (see `16-findings-schema.md`). Delete is never allowed under this exception, with no override.

State this contract to the customer before the audit: the tool cannot write, because it has no write action to call, except for any specific exception the operator has separately named and logged.

## Confirm authorization before anything runs

At the very start of Phase 0, before any query: confirm the operator has the customer's permission to run a read-only audit of this environment, and confirm whether it is production or a non-production clone. If production, restate the load-discipline reminder below and get explicit confirmation to proceed there rather than against a clone. Record both answers in the run's metadata, alongside the rest of the evidence trail.

## Access methods, in order of preference

### 1. Table API (primary)

```
GET /api/now/table/{tableName}
```

Useful parameters:

| Parameter | Purpose |
|---|---|
| `sysparm_query` | Encoded query. Use the same syntax as a list filter |
| `sysparm_fields` | Comma separated field list. **Always set this.** Default returns every field and blows up context |
| `sysparm_limit` | Page size |
| `sysparm_offset` | Pagination offset |
| `sysparm_display_value` | `true`, `false`, or `all`. `all` returns both value and display value |
| `sysparm_exclude_reference_link` | Set `true` to drop reference link objects and reduce payload substantially |
| `sysparm_query_no_domain` | Where permitted, avoids domain filtering surprises |

Pagination: use `sysparm_limit` plus `sysparm_offset`, and check the `Link` response header for next-page hints. Never request an unbounded set.

**Context discipline**: always set `sysparm_fields` and `sysparm_exclude_reference_link=true`. A single `sp_widget` record with all fields includes the full template, client script, server script, CSS and option schema, which can be tens of kilobytes. Fetch widget bodies deliberately and only for the prioritized subset.

**A `sys_properties` row missing does not mean the property is unset, off, or false.** Confirmed twice (2026-09-11): `glide.buildname` and `glide.servlet.uri` are both actively read by live platform script via `gs.getProperty()` — `glide.servlet.uri` is used inside a stock notification's `<mail_script>` to build a link — yet neither exists as a row in `sys_properties` on this instance. Properties left at their platform default apparently never get persisted as a record; only properties someone has explicitly set appear as rows. Any phase that checks a property's value or presence by querying `sys_properties` (release detection in `14-open-questions.md` item 4a, domain separation in item 4, notification link construction in item 12, and any similar check elsewhere in this KB) must treat a missing row as "unknown / possibly-default," never as a confirmed negative. Where the value matters and no row exists, look for a rendered page that surfaces it instead — `/stats.do` for build name, for example — rather than concluding the feature is off.

### 2. Aggregate API (for counts)

```
GET /api/now/stats/{tableName}?sysparm_count=true&sysparm_group_by=...
```

Use this everywhere the audit needs a count or a distribution rather than records. This is how Phase 4 sampling stays cheap: group by criteria record, group by category, group by active state. Never retrieve rows to count them.

### 3. Browser session (Phases 5 and 6)

Required, because the findings are render-time facts. See `03-routing-reachability.md` and `10-frontend-review.md`.

## Authentication

**Default, and normally the only thing this skill uses: one interactive login, reused for everything.** The operator authenticates once — including through SSO — in `bin/capture-session.mjs`, at Phase 0. That single session then authenticates:

- The browser crawl, Phases 5 and 6 (Playwright reuses the saved storage state directly).
- **Every Table API call, in every other phase.** `lib/session-auth.mjs` replays the captured session's cookies plus a CSRF token (`X-UserToken`, read from `window.g_ck`) against the Table API. No separate service account, OAuth application registry entry, or dedicated credential is required, and **this skill never creates a user or credential on the customer's instance to get one** — that would itself be a write action, which contradicts the read-only contract this whole file exists to enforce.

This resolves what used to be two separate authentication problems (one for the browser, one for the API) into one: whatever access the operator's own login gives them is what the whole audit runs as. It also means SSO, previously framed as "the usual blocker for the browser phase," is now the one thing to resolve for the *entire* audit, not just Phases 5 and 6.

**How the replay actually works** (confirmed empirically, 2026-09-11, fresh Australia PDI, no SSO involved): an authenticated session cookie alone does not satisfy the Table API — a plain `GET`, even from a tab actively logged into the instance's UI, returns `401 User is not authenticated`. The request succeeds once an `X-UserToken` header carrying the page's CSRF token is attached alongside the session cookie. That token is not something you need a live browser tab to fetch: it appears as literal text in the HTML of any classic-UI page load —

```
window.g_ck = '2c7d6e89c3938350175f1d0ed401317dce6ea0aa5a6202a228e6a6cf69df12e693a67bac';
```

— so `lib/session-auth.mjs` gets it with one plain `GET` to `/navpage.do` and a regex, no script evaluation and no browser process required. It refreshes that token (one more plain `GET`) automatically the first time a call comes back `401` mid-run, on the assumption the token went stale rather than that access was denied outright; `lib/table-api.mjs` retries exactly once on that basis before treating a further `401` as a real permission problem. If the session itself has expired (not just the token), that refresh fails with an explicit error naming `bin/capture-session.mjs` as the fix — never a silent empty result.

**A heavier alternative exists, and is deliberately not built.** Instead of extracting and replaying cookies, every Table API call could be routed through a live Playwright page already open in Phase 5/6's browser (e.g. `page.evaluate(() => fetch(...))`), so the request always rides an actual, currently-open browser tab rather than a cached credential. Reach for this only if the lightweight replay above turns out to be blocked or fingerprinted by an instance's security controls, which has not been observed. It costs more than it's worth otherwise:

- It requires a browser process to stay alive and healthy for the *entire* run, not just the crawl phases. Today, Phases 0, 1, 3, 4, 7, 8 and 9 are each a separate short-lived `node bin/*.mjs` process (see `SKILL.md`); tying Table API access to one live browser context would mean standing up a small persistent server those processes talk to, instead of each just reading a session file.
- It doesn't parallelize as cheaply. Several sub-agents can each hold a plain HTTP client and the same replayed cookie/token pair; sharing one live browser context across several concurrent processes is real, extra engineering.
- It's more fragile: a crashed browser process or a closed tab takes down Table API access along with the crawl, instead of failing independently.

**Optional, secondary path: a dedicated credential.** If a customer independently chooses to provision a service account (Basic Auth) or register an OAuth application, `lib/config.mjs` and `lib/session.mjs` will use it (`SN_USER`+`SN_PASSWORD` or `SN_TOKEN`) in preference to the captured session, since it doesn't depend on a session file staying valid for a long run. This is never something to ask for as a precondition, and this skill has no code path that creates such a credential itself — only a path that uses one if handed one.

| Method | When it's used |
|---|---|
| Captured interactive session (default) | Always, unless a dedicated credential is configured. Covers both the browser phases and the Table API. |
| Basic auth / OAuth 2.0 (optional) | Only if the customer has separately provisioned `SN_USER`+`SN_PASSWORD` or `SN_TOKEN` for this engagement. |
| SSO / SAML | Handled once, interactively, by the operator in `bin/capture-session.mjs`. Programmatic login is not attempted. |

**This single login is also what makes additional personas cheap.** Once the session is established, extra personas (see `03-routing-reachability.md`) are obtained by impersonating a real named user from within that same session, not by negotiating a second SSO login. If the account does not hold the `impersonator` role, additional personas are not available and the audit proceeds admin-only.

Resolve this in Phase 0, before `bin/phase0.mjs` runs — it needs the Table API too now. Discovering an auth problem in Phase 5 wastes the whole run.

## Required access levels

| Phase | Minimum access |
|---|---|
| 1, 2 | `sp_admin` or read access to `sp_*` tables |
| 3 | `taxonomy_admin` or read on EC scoped tables |
| 4 | Read on `user_criteria` and the join tables |
| 5, 6 | Admin browser session by default; `impersonator` role additionally required if the operator adds personas |
| 7 | Read on `sys_store_app`, `sys_plugins`, EC Pro tables |
| 8 | **`admin`**, for `sys_update_xml` and `sys_update_version`. Upgrade History **is** Table-API reachable with admin (`sys_upgrade_history`, `sys_upgrade_history_log`), confirmed 2026-09-11, provided the call carries `X-UserToken`. Keep the tiered evidence approach in `09-customization-upgrade.md` as a fallback |
| 9 | Read on widget scripts, `sys_properties`, `sys_security_acl` |

Phase 8 is the one that needs elevated rights and is also the highest-value section of the report. If admin is not available, say so in Phase 0 and set expectations.

## Environment choice

Prefer a **non-production clone** for anything heavy. It removes performance risk and usually loosens the credential conversation. The tradeoffs to state explicitly:

- A clone may have stale or scrubbed data, which distorts content counts and user criteria evaluation.
- Usage telemetry may not have been cloned, which weakens Phase 7 and the unused-content findings.
- User records may be scrubbed, which breaks persona-based visibility testing, since impersonating an extra persona (`03-routing-reachability.md`) requires a real, active named user to exist on the instance being tested.

If usage data matters to the engagement, plan to read telemetry from production even if everything else runs against a clone.

## Rate and load discipline

- Batch with `sysparm_fields` and aggregates rather than many small calls.
- Cap concurrency across sub-agents. Several parallel crawlers plus several parallel API agents can measurably load a shared non-production instance.
- Throttle the browser crawl. It is the heaviest phase.
- Never run the crawl against production during business hours without agreement.

## Error handling

Three failure types, three responses:

- **Permission errors (403).** Retrying will not help. Log it, skip that item, state the gap plainly in that phase's output (for example, "kb_knowledge unreadable, excluded from Phase 4 sampling"), and continue.
- **Transient errors (timeout, server error, rate limit).** Retry up to 3 times with increasing waits, then treat as a permission error above: log, skip, continue. On a rate limit specifically, also reduce concurrency, not just wait longer.
- **A whole phase failing broadly**, not just isolated items. Stop and ask the operator: skip the phase and continue the audit, or halt to investigate. Do not silently produce a near-empty section.

## Caching

Cache raw responses to local disk keyed by table plus query. Sub-agents should read from that cache rather than re-querying, and the cache becomes the audit's evidence trail. It also makes re-runs and report regeneration cheap without touching the instance again.

**Retention.** Keep the cache and any screenshots by default after the report is generated, since they matter for a future re-audit comparison (`15-report-model.md`) and for re-verifying a disputed finding. Offer to delete them; do not delete by default. Never commit the run folder to git; add it to `.gitignore`. The structured findings themselves (`findings/*.json`) are lower sensitivity, already summarized rather than raw, and are always worth keeping.

## Domain separation

The taxonomy record has a Domain field, and domain separation changes visibility across the platform. No Service Portal specific domain separation documentation was confirmed for Australia. Treat domain-separated instances as out of validated scope: detect whether domain separation is active, and if it is, state the limitation in the report rather than producing findings that may be domain-scoped without acknowledging it. See `14-open-questions.md`.

**Confirmed empirically (2026-09-11, fresh non-domain-separated Australia PDI):** `sys_domain` is not readable through the Table API on this instance — every query shape (bare, filtered, via `/api/now/stats`) returned `400`, not the `401`/`403` a permission problem would produce. `glide.sys.domain.enabled` also does not exist as a `sys_properties` row here. Neither result confirms the detection method works when domain separation actually is active — this still needs a real domain-separated instance to test — but it does mean the client must not treat a `400` from `sys_domain` as "definitely not domain-separated"; it may just mean the table is unreachable this way on any instance, separated or not.
