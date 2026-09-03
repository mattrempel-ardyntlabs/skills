# Architecture derivation

Full record of how this skill's manifest structure was arrived at, for whoever maintains this next (including a future instance of Claude).

## The constraint

Claude Skills uploaded via the Skills API are capped at 30MB total (all files combined). The underlying corpus, ServiceNow's `ServiceNowDocs` repo, is far larger than that per release:

- One release branch (`australia`): 428MB total repo size, 247.6MB of actual page content across 48,934 markdown files (excluding navigation-only `index.md` files).
- Three tracked releases (australia, zurich, yokohama) together: roughly 750MB of raw source content.

None of that raw content is meant to live in the skill package, only a lightweight index (the "manifest") that helps narrow a question down to a handful of specific pages, which then get fetched on demand from the public repo or a local git checkout. The question this document answers: how lightweight does that index need to be, and how did we get there.

## Attempt 1: flat manifest, one file per release, all metadata fields

Initial schema per page: `path, title, description, product, topic_type, breadcrumb, last_updated, canonical_url`.

Measured (australia only, pretty-printed JSON): 38.5MB, already over the entire 30MB cap for a single release.

## Attempt 2: compact JSON (no pretty-printing)

Same fields, `json.dumps(..., separators=(',', ':'))` instead of `indent=2`.

Measured (australia only): 32.6MB. An ~18% reduction, free (no data loss), but still over the cap for one release alone, let alone three.

## Attempt 3: field trimming

Dropped `canonical_url` (never needed, we fetch actual content by path, not by displaying URLs to end users), `last_updated` (only useful for the sync script's own change-detection, which uses git commit diffing instead, not a per-page timestamp), and `product` (frequently empty or redundant with title/breadcrumb).

This alone wasn't measured in isolation, it was combined with the deduplication attempt below, since both were needed together to fit.

## Attempt 4: cross-release deduplication, including breadcrumb in the equality check

Idea: most documentation pages don't actually change between releases, group identical pages into one shared "base" file, and only store per-release "override" entries for pages that are genuinely unique to a release or have actually changed.

First pass compared `title + description + breadcrumb + topic_type` for equality across releases. Result:
- Of 38,547 page paths present in all three tracked releases, only 33,996 (88.2%) were byte-identical, but that 88.2% figure was measured on `title+description` only, informally, before the stricter 4-field comparison below.
- Running the actual base+override split with the 4-field equality check (including breadcrumb): **26,586 base entries**, with **26,647 / 28,421 / 26,604** override entries for australia/zurich/yokohama respectively. Total: **53.6MB**. A real ~45% reduction from the ~98MB three-release baseline, but still over the 30MB cap.

## Attempt 5: drop breadcrumb from the equality check (and from storage)

Diagnosis: breadcrumb (the navigation path shown in ServiceNow's docs UI, e.g. "Triggers > Playbook building blocks > Workflow Studio") changes far more often across releases than the actual page content does, ServiceNow reorganizes navigation more often than it rewrites descriptions. Including it in the equality check made pages look "different across releases" even when nothing meaningful had changed, defeating most of the possible deduplication.

Dropping breadcrumb entirely (both from the comparison and from what gets stored) and re-running:
- **49,487 base entries** (vs. 26,586 before), the overwhelming majority of pages now correctly recognized as identical wherever they appear.
- Override entries collapsed to **5,198 (australia) / 5,549 (zurich) / 4,945 (yokohama)**.
- **Total: 24.8MB**, measured directly against the real repo across all three releases, all three publication-organized directories, full corpus, nothing left out.

This is the shipped design. Base (18.9MB) + overrides (1.9 + 2.1 + 1.9MB) = 24.8MB, leaving ~5MB of headroom under the 30MB cap once SKILL.md and the scripts are added (they total well under 200KB).

## Known tradeoffs of the shipped design

1. **Breadcrumb / navigation context is gone from the page-level manifest.** Title, description, and topic_type remain for every page, nothing becomes unsearchable, but a consultant won't see "where this sits in ServiceNow's docs navigation" from the manifest alone. Not considered a significant loss for prompt-drafting purposes, but worth knowing if retrieval quality ever feels off in a way that seems navigation-related.
2. **~5MB of headroom is not a lot.** Adding a 4th tracked release, or substantial corpus growth from ServiceNow, could push this back over 30MB. `sync_release.py --check-size` warns at 25MB specifically so this doesn't get discovered only at upload time.
3. **Incremental syncs can drift slightly out of optimal deduplication between full reconciles.** If release A gets a page that happens to now match what's already in base (because some other release's content changed to match it), an incremental sync of A alone won't detect and fold it in, it'll sit as an unnecessary override until the next `--full-reconcile` run. This doesn't cause incorrect answers, just slightly suboptimal size, and self-corrects on the next full reconcile.
4. **ServiceNow's branch retention policy is an external risk, not something this architecture solves.** ServiceNow's own `llms.txt` states they keep only the 3 most-recent release branches plus `latest`, deleting the oldest on every new GA. Yokohama (oldest of the three currently tracked) is at highest risk. If it disappears upstream, `sync_release.py` will fail clearly with a message pointing at this, rather than silently succeeding with stale data, but there's no automatic mitigation beyond that; archiving already-indexed content for a release you expect to lose access to is a manual decision for whoever maintains this.

## A second, independent cap: 200 files (discovered after initial deployment)

The 30MB size analysis above was thorough, but incomplete, it verified byte size exhaustively and never checked file *count* against the Skills API's separate 200-file-total limit. The first packaged version of this skill organized `base`/`overrides` as one file per publication per tier:

```
manifests/base/<publication>.json                    (63 files)
manifests/overrides/australia/<publication>.json      (63 files)
manifests/overrides/zurich/<publication>.json         (63 files)
manifests/overrides/yokohama/<publication>.json       (63 files)
```

63 publications x 4 tiers = 252 manifest files, plus catalog/state/support files = **263 total**. This passed local validation (`package_skill.py` doesn't check file count) and only surfaced as an error when the user actually tried to upload it via the Skills API: "too many files, max 200."

**Fix:** consolidate each tier into a single file, `manifests/base.json` (all publications keyed by name) and `manifests/overrides/<release>.json` (same, per release), instead of one file per publication. This changes nothing about the underlying dedup logic or total byte size (same ~24.8MB), only how it's packaged. Final count: **15 files** (17 today, after `references/architecture.md` and `scripts/selftest.py` were added), with `sync_release.py` and `search_pages.py` updated to read/write the consolidated structure.

**Lesson for next time:** the 30MB size cap and the 200-file cap are independent constraints. Passing one says nothing about the other. Any future redesign of this manifest's file layout should check both explicitly (`sync_release.py --check-size` now reports both) rather than assuming size headroom implies file-count headroom, or vice versa.

## Third round: retrieval-quality fixes from real usage testing

After the file-count fix above, real testing against demo prompts surfaced four gaps, none related to the size/count caps, but worth recording here since one of them (acronym expansion) touches the size budget and another (word-boundary matching) is a correctness fix to logic documented above.

1. **Acronym/shorthand queries failed silently.** Searching "MACD move add change disconnect" returned unrelated generic task docs instead of "Customer Life Cycle Management Workflows", the actual MACD page, because the acronym itself never appears in that page's title or description, only in ServiceNow's internal terminology. Fixed with `manifests/_synonyms.json` (1.6KB, negligible against the ~5MB headroom), a small set of synonym groups mapping shorthand to the *actual terms used in doc titles*, not literal letter-by-letter expansions (which was tried first and doesn't work: "move add change disconnect" is exactly what failed originally). `search_pages.py` applies this automatically before scoring.

2. **Expansion-derived terms needed higher scoring weight than literal keywords.** Even with the synonym group in place, the exact originally-failing query (acronym + generic literal words together) still didn't surface the right page, because generic bare words like "add" and "disconnect" coincidentally matched many unrelated docs at equal weight. Fixed by weighting expansion-derived matches roughly double literal-keyword matches, so the specific expanded term dominates ranking even when noisy literal words are also present.

3. **That weighting change then exposed a substring-matching bug that predates this round.** With "orm" (real ServiceNow shorthand for Order Management, `com.sn_ind_tmt_orm`) weighted higher, it started outranking genuine matches by false-positive substring-matching inside unrelated words: "perf**orm**ance", "n**orm**al", "unif**orm**". Fixed by switching from raw substring matching to word-boundary regex matching (`\bterm\b`) for all keyword matching, not just expansion terms, a general correctness fix, since any short literal keyword could have hit the same bug even without synonym expansion involved.

4. **Catalog descriptions were actively misleading, not just thin.** All ~55 publications per release were still on their extractive-default description, and several were badly mismatched, e.g. `order-management` (1,040+ pages, the entire Sales CRM suite) described only as "APIs available in ServiceNow CPQ to manage configurations", because the extractive heuristic happened to grab an unrepresentative page. Since catalog lookup is the first filtering step, a bad description here silently misdirects a query before `search_pages.py` ever runs. Rewrote `order-management`, `source-to-pay-operations`, and `customer-service-management` by hand across all three releases, grounded in actually reading each publication's real index/scope rather than trusting the extractive pick. Also retemplated the `delta-*` cross-release publications' descriptions (previously a generic, typo'd default: "Find consoldiated release notes information by product.") since they became load-bearing for cross-release routing (below). Most other publications remain on the extractive default, this was a first pass, not a complete one.

5. **Cross-release "what changed" questions were indexed but never routed to.** ServiceNow ships consolidated per-product changelogs as `delta-<older-release>-<newer-release>` publications (confirmed naming/structure: stored under the *newer* release's own data, e.g. `delta-yokohama-zurich` lives in zurich's base/overrides). SKILL.md previously had no step recognizing this question pattern, so it would decline rather than search already-available data. Added explicit routing logic plus `chronological_order` fields in `_supported_releases.json` so "which release is older" has one authoritative source rather than being inferred inline.

Net effect on size/count: `_synonyms.json` added ~1.6KB (16 files total now, still far under the 200-file cap; 24.9MB, unchanged to one decimal place). None of this round's fixes touched the base+override dedup logic itself.

## If this needs revisiting later

Realistic levers, roughly in order of how much they'd help without further sacrificing coverage:
- Truncate `description` to a fixed character cap (median measured length: 141 chars; p90: 289 chars), meaningful for the ~10% of pages with long descriptions, marginal for the rest.
- Drop `topic_type` from the equality check the same way breadcrumb was dropped, if it turns out to still be causing avoidable override splits (not measured, worth checking against real data before assuming it'll help as much as breadcrumb did).
- Reduce the tracked release count (accepting a real capability loss) if ArdyntLabs's active customer base shrinks to fewer release trains.
- Revisit the companion-repository approach (SKILL.md + scripts uploaded via Skills API, manifest data pulled from a separate git repo you own at runtime) if the corpus outgrows what any amount of trimming can fit. This was the original fallback plan before this base+override design was found to fit, still valid as a next step, not a dead end.

## Fourth round: code review and regression testing (2026-09-03)

A full review of both scripts plus the shipped manifest data, with fixes. Recorded here because three of these were silent failures: nothing logged an error, the output just got quietly worse.

1. **Search crashed on null manifest fields.** ServiceNow ships pages whose YAML frontmatter has an empty `title:` or `description:` key. PyYAML returns `None` for those, `sync_release.py` stored them as JSON `null`, and `search_pages.py` called `.lower()` on them. Result: `AttributeError` and a dead search for any publication containing one. That was 50 entries across the shipped manifests, and it took out `servicenow-platform`, `it-service-management`, `employee-service-management` and `integrate-applications`, four of the largest and most-used publications. Four of eight realistic test queries failed this way. Fixed at both ends (coercion at write time in `parse_publication_pages`, defensive reads in `search_pages.py`) and the 50 already-indexed nulls were repaired in place.

2. **Curated catalog descriptions were destroyed by routine sync.** `update_catalog_entry` regenerated the description whenever `page_count` changed, and `full_reconcile` deleted the entire catalog directory before rebuilding. Both were reproduced against a synthetic repo: a hand-written description was replaced by the extractive draft on the next sync. Given the scheduled refresh runs several times a week, curation had a lifespan measured in days, while SKILL.md actively asks people to invest in it. Now a description with `needs_description: false` is treated as curated and never regenerated, and `full_reconcile` snapshots curated descriptions before the wipe and restores them after.

3. **Publications deleted upstream were never purged.** `to_process` intersects changed publications with the ones present in the checkout, so a publication removed wholesale was skipped entirely and its pages stayed in base, overrides and catalog indefinitely. Search kept returning paths that would 404 on fetch, which is precisely the release-accuracy failure this skill exists to prevent. Incremental sync now diffs tracked publications against the checkout and purges the difference.

4. **Input handling in `search_pages.py`.** An unknown release produced an error blaming the publication name instead. Unknown publications gave no suggestions. `--limit 0` silently returned nothing and `--limit -3` silently dropped the last three results. Empty-string keywords compiled to `\b\b` and matched every page in the publication. Keywords with punctuation at the edge, like `(CPQ)`, compiled to a regex that could never match, because the `\b` added unconditionally in round three assumed a word character at both ends. All fixed; the boundary is now applied only where the keyword's own edge is alphanumeric.

5. **Cosmetic: markdown escaping leaked into ~1,400 titles** (`Now Assist for Configure, Price, Quote \(CPQ\)`). Stripped for display in search output only, leaving stored data untouched. As a side effect, a literal `(cpq)` search now matches those titles, which it previously could not.

6. **Six synonym groups added** after testing found real gaps: `glide record`/`gliderecord`, `esc`, `sp`, `sla`, `uib`, and their expansions. Each was verified to move a query from useless to correct-in-top-3. A seventh candidate (`ui action`/`form button`) was dropped after checking that `form button` has zero targets in the corpus, since a synonym pointing at nothing is dead weight.

7. **`scripts/selftest.py` added.** 32 checks: manifest integrity (null fields, catalog/manifest count agreement, orphaned catalog entries), search behavior including every previously-crashing publication, sync behavior against a synthetic git repo built on the fly, and both packaging caps. Every check exists because the matching bug actually shipped. Run `--full` before packaging.

**Standing risk noted, not fixed:** total package size is now 24.9MB against `SKILL_SIZE_WARN_BYTES` of 25MB. The ~5MB of headroom described earlier in this document is effectively spent. The next meaningful upstream growth will start printing size warnings, and a fourth tracked release is no longer a comfortable addition. The levers listed under "If this needs revisiting later" are the ones to reach for.

## A third packaging constraint: no nested zip files (2026-09-03)

Discovered while testing whether the manifests could be shipped compressed. The Skills API upload dialog rejects a package outright with **"Zip cannot contain nested zip files"**. Since a skill is uploaded as a zip, any `.zip` stored inside it is a nested zip, so the "one zip archive per manifest tier, one member per publication" design is not available, regardless of its merits.

That is now three independent packaging constraints, each discovered separately and none implied by the others:

1. 30MB total package size.
2. 200 files total, regardless of size.
3. No nested zip files inside the package.

Assume there are more. Test packaging changes with a throwaway one-file skill before rewriting anything real.

**What replaced it.** Per-publication compression is still achievable without any binary file: gzip each publication's JSON, base64 the result, and store the lot as a normal `.json` file mapping publication name to encoded blob. Pure ASCII, same file types the skill already ships, so no new upload capability is required and no test upload is needed.

Measured across all four tiers:

| | Current | Nested zip (blocked) | base64 of gzip in .json |
|---|---|---|---|
| base | 18.93 MB | 3.03 MB | 4.03 MB |
| overrides (3) | 5.89 MB | 1.24 MB | 1.65 MB |
| package total | 24.94 MB | 4.40 MB | **5.80 MB** |
| headroom under 30MB | 5.1 MB | 25.6 MB | **24.2 MB** |
| read one publication | 192 ms | 3 ms | **11 ms** |

The base64 encoding costs about 33% over raw deflate, which is why this lands at 5.80 MB rather than 4.40 MB. Irrelevant against a 30MB cap once headroom goes from 5 MB to 24 MB.

Note the read time. `search_pages.py` currently parses all 18.93 MB of `base.json` to use roughly 1% of it. Decoding one publication's blob is about 17 times faster, so compression makes retrieval faster here, not slower. This also retires most of the size levers listed under "If this needs revisiting later": once the data is compressed, truncating descriptions or dropping `topic_type` recovers very little, because deflate was already exploiting exactly that redundancy.

A plain `.gz` binary asset would reach 4.40 MB and might well be accepted, since the rejection message names zip specifically. Not pursued: it saves 1.4 MB out of 24 MB of headroom and would need its own upload test to confirm.

## Shipped: compressed manifests (servicenow-docs-compact)

This skill is the compressed build. The uncompressed original remains as `servicenow-docs`, unchanged, so reverting is a matter of uploading the other package.

Layout: each publication's page metadata is gzipped, base64-encoded, and stored as a value in an ordinary `.json` file.

```
manifests/base.enc.json
{"format":"gzip+base64","version":1,"publications":{"<publication>":"<base64 of gzipped JSON>"}}
```

Measured against the real corpus:

| | Uncompressed | This build |
|---|---|---|
| base | 18.93 MB | 4.03 MB |
| overrides (3 releases) | 5.89 MB | 1.65 MB |
| package total | 24.94 MB | **5.80 MB** |
| headroom under 30MB | 5.1 MB | **24.2 MB** |
| files | 17 | 20 |
| end-to-end search, one publication | 234 ms | **79 ms** |

Result parity was verified across ten queries spanning nine publications and all three releases: identical match counts and identical result ordering in every case.

Three design points worth keeping:

1. **`manifest_io.py` is the only module that knows the storage format.** `search_pages.py`, `sync_release.py` and `selftest.py` all go through it, and every read falls back to the plain `.json` file when the encoded one is absent. That fallback is what makes the format reversible without touching call sites.
2. **Search decodes exactly one publication.** `load_publication()` pulls a single blob rather than materialising all 61. This is why compression made retrieval about three times faster end to end, and roughly seventeen times faster on the data-loading portion alone.
3. **`migrate_manifests.py` converts in both directions and verifies before deleting.** Every publication is read back through the same code path the scripts use and compared against the source; the conversion aborts if anything fails to round-trip, and source files are only removed on `--prune`.

Leaving both layouts on disk is a real hazard, since it doubles the manifest bytes counted against the cap while everything still appears to work. `selftest.py` fails if plain manifests are found alongside encoded ones.

Compression also retires most of the levers listed under "If this needs revisiting later". Truncating descriptions and dropping `topic_type` recover very little once deflate has already exploited that redundancy, and both cost real data.
