---
name: servicenow-docs-compact
description: Search ServiceNow's official AI Platform documentation (the public ServiceNow/ServiceNowDocs GitHub repo, indexed here in a compressed 5.8MB manifest) across the Australia, Zurich, and Yokohama release branches to pull accurate, release-specific technical context, then draft a ready-to-use prompt for ServiceNow Build Agent or other ServiceNow AI Platform / configuration work. Use this any time the user asks a ServiceNow product question, wants help writing or improving a Build Agent prompt, mentions a ServiceNow release name (Australia, Zurich, Yokohama), needs release-specific ServiceNow guidance, or wants technical grounding pulled from ServiceNow's docs before drafting any ServiceNow-related prompt, even if they don't say "Build Agent" explicitly. Also use this to run or schedule the manifest refresh, or to check whether the indexed data is up to date.
---

# ServiceNow Docs Assistant (compact build)

Helps ArdyntLabs consultants find accurate, release-specific ServiceNow documentation and turn it into a usable Build Agent (or general ServiceNow AI Platform) prompt, without ever reading the full 250MB+ per-release doc corpus into context.

All commands below use `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes with this plugin's actual installed path wherever it appears in this file, so these commands work regardless of exact mount location or working directory. The scripts themselves resolve their own data directory from `__file__`.

## Why this exists / how it's shaped (read this before changing anything)

The underlying corpus is ServiceNow's own `ServiceNowDocs` repo: ~49,000 markdown pages per release branch, ~250MB of real content per release. Three constraints shaped everything below:

1. **Never read more than what's relevant to one question.** A full-repo read is what broke the original attempt at this (hit usage limits every time). Retrieval always goes catalog to publication to specific pages, narrowing at each step, never a bulk read.
2. **The whole Skill package (this file + scripts + manifest data) must stay under the Skills API's 30MB size cap.** This build stores each publication gzipped and base64-encoded inside ordinary `.json` files, which brought the package from 24.9MB to **5.8MB** and made per-publication reads about 17 times faster, since search now decodes one publication instead of parsing 19MB to use 1% of it. The history below explains what the uncompressed design cost and why compression was not the first answer. A flat manifest with every field for every page, times three releases, measured at ~95-98MB, over the cap by a lot. What actually fit: dropping `breadcrumb`/`canonical_url`/`last_updated`/`product` (kept `title`, `description`, `topic_type`), and splitting the manifest into a **shared base** (content identical across whichever releases share it, ~88% of pages once breadcrumb noise was removed from the comparison) plus **small per-release override files** for genuine differences. Measured total: **24.9MB**.
3. **SEPARATELY, the Skills API also caps a package at 200 files total, regardless of byte size.** The first version of this skill organized base/overrides as one file per publication per tier (`base/<publication>.json`, `overrides/<release>/<publication>.json`), comfortably under 30MB, but 63 publications across 4 tiers produced 252 manifest files (263 including support files) and failed upload on file count alone, even though size was never the problem. Fixed by consolidating each tier into a single file. Same bytes, same dedup logic, 17 files instead of 263. **If you're ever tempted to split these back into per-publication files for readability, re-check both caps first. They're independent, and passing one doesn't mean you've passed the other.**

Directory layout:
```
manifests/
  _supported_releases.json         canonical list of tracked releases + chronological order, check before trusting any release name
  _synonyms.json                   ServiceNow acronym/shorthand groups (MACD, S2P, POM, PONR, ESC, SP, etc.), auto-applied by search_pages.py
  catalog/<release>.json           ~50-60 publications, one-line description + counts each, always safe to read in full
  base.enc.json                    ALL publications, one file (~4MB), {"format":..,"version":..,"publications":{"<publication>":"<base64 of gzipped JSON>"}}
  overrides/<release>.enc.json     ALL publications for that release, one file (~0.5MB each), same shape
scripts/
  sync_release.py                  refresh logic (incremental + full-reconcile modes)
  search_pages.py                  keyword search within one publication, with automatic acronym expansion, use this instead of reading base.json directly
  manifest_io.py                   the only code that knows how manifests are stored, read and write both layouts
  migrate_manifests.py             convert between the compressed and plain layouts in either direction
  selftest.py                      regression suite, run it after touching any script or manifest
references/
  architecture.md                  full derivation of the base+override design, every measurement, and every tradeoff, read before redesigning anything
```

`.checkouts/` may also appear at the skill root. That's git working copies left by a sync, roughly 400MB per release. It is deliberately excluded from the size report and must never be included when packaging the skill for upload.

## Step 1 - Determine which release the user means

Getting this wrong is worse than usual: a prompt built from the wrong release's docs can reference syntax or features that don't exist on the customer's actual instance. Don't guess.

1. Check `manifests/_supported_releases.json` for the current list (currently australia, zurich, yokohama, but check, don't hardcode this).
2. If the message already states or clearly implies the release ("our Zurich customer...", "targeting Yokohama"), use it.
3. If not stated, ask once, before doing any retrieval: "Which release is this for, Australia, Zurich, or Yokohama?"
4. Once established, treat it as the working release for the rest of the session, don't re-ask on every message.
5. If the user names a release that isn't in the supported list, say so plainly. Do not silently substitute the nearest available release's docs. That's the one place a quiet fallback would actively mislead someone. `search_pages.py` also rejects unknown release names outright rather than returning an empty result that looks like "no docs on this topic".

## Step 2 - Retrieve relevant docs (narrow at every step)

1. **Read `manifests/catalog/<release>.json` in full** (small, ~14KB). Use the publication descriptions to pick the 1-3 most relevant publications for the question. If a description is thin or missing (`needs_description: true`), don't skip that publication just because its blurb is weak, check its title and page count too.
2. **For each candidate publication, run the search helper rather than reading files directly:**
   ```bash
   python3 ${CLAUDE_PLUGIN_ROOT}/scripts/search_pages.py <release> <publication> <keyword1> [<keyword2> ...] --limit 10
   ```
   This merges base + this release's overrides in a subprocess and returns only matching entries (path/title/description/topic_type). It never puts the full `base.json` (~19MB, all publications) into context.

   **`search_pages.py` automatically expands known ServiceNow shorthand** (MACD, S2P, POM, PONR, CPQ, L2C, ESC, SP, SLA, UIB, and others, see `manifests/_synonyms.json`) against the actual product/feature terminology used in doc titles, since the acronym itself usually never appears in the docs verbatim. Check the `expansions_applied` field in the output to see when this fired. You don't need to manually spell out an acronym before searching, pass it as given.

   **If results still come back thin or clearly off-target, retry in this order, don't just give up after one try:**
   1. Confirm the acronym actually expanded (check `expansions_applied`). If it's a shorthand term not yet in `_synonyms.json`, that's likely why.
   2. Rephrase using plain, descriptive English that mirrors how ServiceNow actually titles its docs ("Managing X", "Configure Y", "Exploring Z") rather than internal jargon or codenames. This is what reliably works when the first attempt doesn't.
   3. Watch for compound API names. Keyword matching is word-boundary based, so a multi-word phrase must appear as written: "glide record" and "GlideRecord" are different strings. Common cases are handled by `_synonyms.json`; for anything else, try the closed-up form too.
   4. Only after that, consider a different publication, or ask the user for a different angle on the question.

   An unknown publication name returns a `did_you_mean` list of near matches rather than a bare error, so a typo or a guessed name is cheap to correct.
3. **Pick the 2-5 most relevant page paths** from the results.
4. **Fetch the actual content for just those pages:**
   - If `.checkouts/<release>/<path>` exists on disk (left over from a recent sync), read it directly, fastest option.
   - Otherwise, fetch it directly from the public repo, no auth needed:
     ```bash
     curl -s https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/<release>/<path>
     ```
   Only fetch the handful of files you've already identified as relevant, never the whole publication or repo.
5. Synthesize an answer grounded in what you actually retrieved. If the docs don't clearly cover what's being asked, say that directly rather than filling the gap from general ServiceNow knowledge. The whole point of this skill is release-accurate grounding.

## Cross-release questions ("what changed between X and Y")

Don't decline these, the data is already indexed. ServiceNow ships consolidated per-product changelogs as their own publication, named `delta-<older-release>-<newer-release>`, stored under the *newer* release's data.

1. **Recognize the pattern:** "what changed/what's new between X and Y", "upgrade impact from X to Y", "differences between X and Y" for any two releases.
2. **Determine which named release is older** using `chronological_order` in `manifests/_supported_releases.json` (higher number = newer). Among the three currently tracked: yokohama (oldest), then zurich, then australia (newest).
3. **Construct the publication name** `delta-<older>-<newer>` and search it exactly like any other publication, using the *newer* release as the `<release>` argument (that's where the data lives):
   ```bash
   python3 ${CLAUDE_PLUGIN_ROOT}/scripts/search_pages.py <newer-release> delta-<older>-<newer> <topic keywords> --limit 10
   ```
   Example: "what changed in Order Management between Yokohama and Zurich" becomes `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/search_pages.py zurich delta-yokohama-zurich "order management" --limit 10`
4. If the user names two releases where one isn't in `_supported_releases.json`, say so, don't guess at an unindexed release's delta content.
5. Delta publications persist even for source releases no longer separately tracked (e.g. `delta-washingtondc-australia` exists even though washingtondc no longer has a live branch). The changelog page doesn't depend on the source branch still existing.

## Step 3 - Offer to draft a prompt

After presenting the relevant technical info, offer to turn it into a ready-to-use Build Agent (or general ServiceNow AI Platform) prompt that incorporates the retrieved details, don't wait to be asked twice. Keep the retrieved facts (exact field names, table names, API behaviors, version-specific caveats) intact in the drafted prompt rather than paraphrasing them loosely. Precision here is the entire value of this skill over just asking Build Agent directly.

## Maintenance - refreshing the manifest

**Dependency:** `sync_release.py` (only this script, nothing else here) needs `pyyaml` to parse page frontmatter, which is not in Python's standard library. Check it's importable before running a sync:
```bash
python3 -c "import yaml" || python3 -m pip install pyyaml
```
On a Homebrew-managed Python (externally-managed-environment error from plain `pip install`), use a venv instead: `python3 -m venv .venv && .venv/bin/pip install pyyaml && .venv/bin/python3 scripts/sync_release.py <release>`.

**Routine refresh (run per release, a few times a week via the scheduled task):**
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/sync_release.py <release>
```
Pulls just that branch, reprocesses only publications with upstream changes, reconciles against the existing base file. Cheap, safe, doesn't need other releases checked out. Publications deleted upstream are purged from base, overrides and catalog in the same pass, so search never returns pages that would 404 on fetch.

**Periodic full reconcile (recommended monthly, or whenever size creeps up):**
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/sync_release.py --full-reconcile australia zurich yokohama
```
Rebuilds base+overrides from scratch across all three. Incremental syncs alone can drift slightly out of optimal dedup over time (a page that becomes identical across releases won't be detected as shared until this runs), and this is what re-optimizes it. Hand-curated catalog descriptions are snapshotted before the rebuild and restored after, so this no longer destroys them.

**After any refresh, check size:**
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/sync_release.py --check-size
```
If this reports getting close to 30MB *or* 200 files, flag it to the user directly rather than letting the next Skills API upload silently fail. Both are real, independent constraints, not formalities. (File count is the one that actually bit this skill once already, see the architecture note above.) Run `--check-size` for the current measured state rather than trusting a number here, it drifts with every sync; as of this writing it's a handful of MB and well under 20 files, comfortable headroom under both caps. The uncompressed build of this skill sat at 24.9MB with about 5MB of headroom, which is what motivated the compressed manifests.

**Working with the compressed manifests:**
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/migrate_manifests.py --status
```
Reports which layout is on disk and the size of each tier. To go back to plain uncompressed JSON, for instance to diff the data by hand or to rule the compression out as the cause of a problem:
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/migrate_manifests.py --decode --prune
```
`--encode --prune` converts back. Both directions verify every publication round-trips before deleting anything, and every script reads either layout, so nothing else needs to change when you switch. Without `--prune` both layouts are left on disk, which doubles the manifest bytes counted against the 30MB cap; `selftest.py` fails if that state is left behind.

Do not store the manifests as `.zip` archives, however tempting the extra compression looks. The Skills API rejects any package containing a nested zip file, and a skill is itself uploaded as a zip. That is why the payload is base64 text inside `.json` rather than a binary archive. See `references/architecture.md`.

**Before packaging for upload, and after touching any script or manifest:**
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/selftest.py --full
```
38 checks covering manifest integrity, search behavior, the encoded format and its round-trip, sync behavior against a synthetic git repo, and both packaging caps. Every check corresponds to a bug that actually shipped once. Without `--full` it skips the sync tests and runs in a couple of seconds. Also delete any `__pycache__` directories before packaging, since they count against the 200-file cap:
```bash
find ${CLAUDE_PLUGIN_ROOT} -name __pycache__ -type d -not -path "*/.checkouts/*" | xargs rm -rf
```

**If a sync fails with a branch-not-found error:** this is very likely ServiceNow's branch retention policy. Their `llms.txt` describes keeping only the most recent release branches and deleting older ones on each new GA, though the exact number retained has varied in practice (as of 2026-09-03 the repo still carried australia, zurich, yokohama and xanadu, alongside `main`). Yokohama, being the oldest tracked release here, is at the highest risk. Tell the user plainly rather than retrying silently. They may want to archive what's already indexed for that release, since re-fetching won't be possible once the branch is gone. Verify current branches with `git ls-remote --heads https://github.com/ServiceNow/ServiceNowDocs.git` rather than assuming.

## Adding a new release later

1. Add an entry to `manifests/_supported_releases.json`.
2. Run `sync_release.py --full-reconcile` including the new release alongside the existing ones.
3. Run `--check-size` immediately after. With compressed manifests a fourth release costs roughly 0.5MB of overrides plus whatever new base entries it introduces, so this is comfortable now rather than tight, but check rather than assume.
4. Run `selftest.py --full` to confirm nothing regressed.

## Improving catalog descriptions

Every catalog entry starts with an extractive draft (shortest "overview"-flavored page description found) and is flagged `needs_description: true`. These are starting points, not final answers. The extractive heuristic can pick a genuinely misleading page (e.g. one narrow integration standing in for an entire 1,000+ page publication). `order-management`, `source-to-pay-operations`, and `customer-service-management` have been rewritten by hand (across all three releases) as a first pass and are a good reference for the bar to hit: grounded in actually reading each publication's real scope, not just picking the shortest available blurb.

Most other publications are still on the extractive default and still flagged. When you're actually working with one and notice its description is thin, generic, or actively misleading, take a moment to rewrite it properly and clear `needs_description`. This compounds in retrieval quality over time, and a bad catalog description is worse than a merely thin one, since publication selection is the very first filtering step everything else depends on.

Clearing the flag is what marks a description as curated, and curated descriptions are now protected: neither an incremental sync nor a full reconcile will overwrite them. (Until this was fixed, both did, which meant hand-written descriptions were silently reverted to the extractive draft within days. If you find a curated description has reverted, that's a bug, not expected behavior.)
