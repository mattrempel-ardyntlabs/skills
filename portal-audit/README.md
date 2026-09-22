# ServiceNow Portal Audit Knowledge Base

Reference material for a Claude Code skill that audits a single customer ServiceNow portal end to end. Target release: Australia. Behavior differences for Zurich and Yokohama are noted inline where known.

The skill itself lives alongside this file: `SKILL.md` is the entry point, `agents/` holds one dispatch prompt per sub-agent, `lib/` and `bin/` hold the read-only tooling, and `test/smoke.mjs` verifies the read-only guarantees without needing an instance.

## How to use this knowledge base

Do not read every file. Each audit phase names the files it needs. Load only those.

Sub-agents should be given the file list for their phase and nothing else. The whole knowledge base does not fit comfortably alongside a large data payload in one context window, which is the reason it is split.

## Routing table

| If you are doing this | Read these |
|---|---|
| Planning the audit, deciding sub-agent boundaries | `reference/00-methodology.md` |
| The findings schema every sub-agent must conform to | `reference/16-findings-schema.md` |
| Reading the portal record, resolving a URL suffix | `reference/01-portal-record.md`, `reference/13-data-access.md` |
| Walking pages, containers, widgets, dependencies | `reference/02-page-widget-model.md` |
| Working out what pages are reachable, crawling | `reference/03-routing-reachability.md` |
| Anything about who can see what in Service Portal | `reference/04-security-model.md` |
| Employee Center taxonomy, topics, topic access | `reference/05-ec-taxonomy.md` |
| EC versus EC Pro, feature usage matrix | `reference/06-ec-pro.md` |
| AI Search or Zing, search health | `reference/07-search.md` |
| Catalog and knowledge content bindings | `reference/08-catalog-knowledge.md` |
| Custom versus out-of-box, upgrade risk | `reference/09-customization-upgrade.md` |
| Accessibility, responsive, translations, UX | `reference/10-frontend-review.md` |
| Server and client performance, system properties | `reference/11-performance-properties.md` |
| Looking up a table name or writing a query | `reference/12-table-inventory.md` |
| Querying the instance, auth, pagination | `reference/13-data-access.md` |
| Something is unverified or missing | `reference/14-open-questions.md` |
| Writing the final report | `reference/15-report-model.md` |
| Building the branded PDF alongside report.md | `reference/17-pdf-report.md` |

## Non-negotiable rules for every agent

1. **Read only, by construction, not by instruction.** The Table API client only implements `get` and `count`. The browser wrapper only implements navigate, click-a-link, observe, screenshot, and start/stop impersonation. No write action exists to call. The one narrow exception is a write action the operator explicitly declares before the audit starts, scoped to one named target, always logged, never including delete. See `reference/13-data-access.md`.
2. **Never assume instance-wide defaults apply to this portal.** Almost every setting that matters is per-portal. Read the record.
3. **Distinguish evidence types.** Configuration record, rendered observation, and usage telemetry carry different confidence. Tag every finding with which one it came from.
4. **Persona matters.** Visibility findings are meaningless without recording which user the observation was made as.
5. **Verify table names on the instance.** Several Employee Center and AI Search table names in this knowledge base are inferred from documentation that describes forms rather than tables. See `reference/14-open-questions.md`.
