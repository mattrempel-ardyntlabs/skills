# Handoff: servicenow-docs-compact skill

## Context

This is Anthropic Skill used by ArdyntLabs consultants (Matt) to search ServiceNow's
official documentation (the public `ServiceNow/ServiceNowDocs` GitHub repo) across
three tracked release branches (australia, zurich, yokohama) and ground Build Agent
prompts in release-accurate technical detail. Full design rationale is in
`servicenow-docs-compact/references/architecture.md`. Day-to-day usage and maintenance
commands are in `servicenow-docs-compact/SKILL.md`, read that first.

**No git repo exists yet.** This skill currently only lives as an installed plugin
copy (mounted at `/mnt/skills/plugins/servicenow-docs-compact` in the prior session).
Matt's stated goal: once this reaches a good working state, deploy it to git as the
source of truth. That hasn't happened yet, this package is the "good working state."

## What happened this session, in order

1. **Ran 5 varied test scenarios** against `search_pages.py`: a standard release-scoped
   query, an acronym-expansion query (MACD), a cross-release delta/changelog query,
   an unsupported-release edge case (rejected cleanly, correct), and a misspelled
   publication name (did_you_mean worked for close typos, less useful for far-off
   names). Also ran `selftest.py`, 31/31 passed at that point.

2. **Diagnosed a real issue from Test 1**: searching for GlideRecord syntax in
   `application-development` returned 0 matches on the first try because that
   publication's catalog description was still the extractive default and had
   nothing to do with its actual scope. Root cause: at the time, only 3 of ~55
   publications per release (`order-management`, `source-to-pay-operations`,
   `customer-service-management`) had hand-curated descriptions. The other ~48-49
   per release were still on auto-generated, sometimes actively misleading, blurbs.

3. **Curated all remaining publications**, in 4 batches, across all three releases:
   - Batch 1 (10 largest): employee-service-management, it-operations-management,
     security-management, governance-risk-compliance, integrate-applications,
     it-business-management, it-asset-management, now-intelligence,
     field-service-management, intelligent-experiences
   - Batch 2 (10): platform-user-interface, conversational-interfaces,
     application-portfolio-management, financial-services-operations, build-workflows,
     mobile, healthcare-life-sciences, operational-technology, impact,
     government-industry
   - Batch 3 (13): release-notes, telecom-network-inventory,
     environmental-social-governance, telecom-media-technology, manufacturing,
     service-management-for-the-enterprise, industrial-connected-workforce,
     acct-lifecycle-events, retail-industry, telecom-service-ops, service-exchange,
     service-bridge, core-business-suite
   - Batch 4 (12, mostly 1-page landing publications): proactive-service-exp-workflows,
     customer-relationship-management, roles-by-product, better-together, technology,
     cloud-governance-suite, cloud-observability, glossary, hyperautomation-low-code,
     industry-products, now-platform, zurich-prbsummary-release-notes

   Method used for every description: `manifest_io.load_publication()` to pull a
   real random sample of that publication's actual page titles (not the extractive
   default), then hand-write a description grounded in that sample, matching the
   style of the 3 originally-curated publications. `needs_description` cleared to
   `false` on every one. Verified this is durable: `update_catalog_entry` and
   `full_reconcile` in `sync_release.py` both skip regenerating a description once
   `needs_description: false`, confirmed by reading the code, not just trusting docs.

   Result: **0 publications per release now need descriptions** (was ~48-49).
   Confirmed with `selftest.py --full`, 38/38 passing throughout.

4. **Did a deeper review pass** beyond the description work. Findings:
   - **Real issue, unresolved**: `manifests/_state/*.json` shows `last_synced:
     2026-07-12`, about 8 weeks stale as of this session (2026-09-03). SKILL.md
     says routine refresh should run "a few times a week via the scheduled task."
     Confirmed via `git ls-remote --heads` that all three branches still exist
     upstream (not a branch-deletion problem), so this is either a scheduled-task
     problem or this packaged copy just hasn't been refreshed. **Recommend running
     `sync_release.py` for all three releases once this lands in its real
     environment**, and confirming whatever scheduled task is supposed to run it
     is actually configured there.
   - **Real issue, unresolved, proposed but not applied**: `service-exchange` and
     `service-bridge` are two disjoint publications (68 pages each, zero path
     overlap) covering the same underlying feature, files inside `service-exchange`
     are literally named things like `service-bridge-v2-error-log.md`. Anyone
     asking about Service Exchange / Service Bridge needs both publications
     checked. Proposed adding a one-line cross-reference in each description; Matt
     hadn't confirmed this yet when the session ended.
   - **Fixed**: my own batch-description edits had written the 3 catalog JSON files
     with `indent=2`, inconsistent with `sync_release.py`'s own `save_json()` which
     writes compact (`separators=(",", ":")`, no indent). Rewrote all three to
     match, saved ~2KB/file, avoids a noisy diff on the next real sync.
   - **Minor/cosmetic, not fixed**: SKILL.md states "20 files," actual is 19 (the
     20th in `sync_release.py --check-size` output is a `__pycache__` artifact from
     running the scripts locally, not a real package file). Trivial wording fix
     whenever SKILL.md is next touched.
   - **Checked, no issue found**: acronym/synonym coverage (spot-checked ITOM, CAB,
     SAM, TRM, PPM, CSDM, none needed synonym entries, ServiceNow's docs use these
     acronyms verbatim in titles), cross-release delta publication completeness (all
     3 pairwise combos among tracked releases present), curated-description
     protection logic (read the actual code, matches what selftest verifies),
     packaging caps (5.8MB / 20 files vs 30MB / 200-file limits, comfortable).

## Current state of the package in this zip

- `servicenow-docs-compact/` is the full skill directory as it stood at end of
  session: SKILL.md, manifests (base.enc.json, overrides, catalog, synonyms,
  supported-releases, state), scripts, references/architecture.md.
- All `__pycache__` and `.checkouts` directories stripped before packaging.
- Last verified state: `selftest.py --full` → 38 passed, 0 failed. Package size
  5.8MB across 20 files (19 real files on disk; the 20th only appears when a script
  is actually run, see minor finding above).
- **Nothing has been pushed to git.** This zip IS the source of truth to commit.

## Suggested next steps (Matt's stated goal + open items above)

1. Set up the git repo and commit this skill directory as-is, that's Matt's own
   next step, not something done yet.
2. Run `python3 scripts/sync_release.py <release>` for australia, zurich, and
   yokohama to refresh the ~8-week-stale index, then `--check-size` and
   `selftest.py --full` again before committing.
3. Decide on the service-exchange/service-bridge cross-reference note (proposed,
   not applied), Matt hadn't confirmed this when the session ended.
4. Optional cosmetic fix: SKILL.md's "20 files" → "19 files" (or drop the exact
   number and describe it qualitatively, so it doesn't drift again).
5. Whatever scheduled-task mechanism is meant to run routine syncs "a few times a
   week" per SKILL.md should be verified as actually configured in the real
   deployment environment, this session's testing couldn't confirm that either way.

## Suggested skills for the next agent

- None of Claude's built-in document/data skills (docx, pptx, xlsx, pdf) apply here,
  this is pure Python/JSON/git work.
- If further skill-authoring or restructuring of `servicenow-docs-compact` itself is
  needed (e.g. splitting it, changing its packaging), the `skill-creator` skill
  (available at `/mnt/skills/examples/skill-creator/SKILL.md` in this environment,
  may be named differently in Claude Code) is relevant for validating changes against
  Skills API constraints.
- Otherwise, standard bash/git tooling in Claude Code covers everything described
  above, no other skill is needed to continue this work.
