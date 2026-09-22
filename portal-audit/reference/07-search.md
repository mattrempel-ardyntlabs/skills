# Search: AI Search versus Zing

Two engines coexist. Which one is live is a **per-portal** fact read from the portal record, never an instance-wide assumption.

## Detection

1. Read `sp_portal`. Is **Enable AI Search** true?
2. If true, capture **Search Application** and **Search Results Configuration**. The Search Sources related list is hidden on the portal record, and sources are defined in the AI Search application instead.
3. If false, the portal uses the legacy Zing search experience, and `sp_search_source` records on the portal are the relevant configuration.

The visibility of the Search Sources related list is itself a clean detection signal.

## Defaults, which differ by instance history

- AI Search is enabled in Service Portal for all **new and zBoot** customers by default.
- For customers **upgrading into Australia**, AI Search is **inactive by default** and is enabled by updating the portal record.
- If left inactive, the portal uses the legacy search experience.

Do not report inactive AI Search on an upgraded instance as a defect. It is the documented default. Report it as an opportunity.

## Portal eligibility

AI Search is only supported in Service Portal, Employee Center (ESC), Consumer Service Portal, Business Portal and Customer Service Portal. **Custom portals must be built off a baseline of one of these portals** to have AI Search capability. The `glide.service_portal.enable_ais_portal.allow_list` property contains the list of supported baseline portals.

A custom portal not derived from an allow-listed baseline **cannot use AI Search at all**. This converts a search recommendation into a re-platforming conversation and is a hard finding.

## AI Search architecture

```
Data
  └── Indexed Sources (ais_datasource)
        └── Search Sources
              └── Search Profile (ais_search_profile)
                    └── Search Application (sys_search_context_config)
                          └── bound to portal via Enable AI Search
```

| Object | Table (confidence) | Purpose |
|---|---|---|
| Search Application | `sys_search_context_config` (high) | Binds an app or portal to a Search Profile. Controls search engine, result counts, tabs, facets, sorting, suggestions limit |
| Search Profile | `ais_search_profile` (high) | The search experience bundle: included sources, dictionaries and synonyms, Genius Results |
| Indexed Source | `ais_datasource` (high) | Indexed copy of a table's data, its filter, retention, searchable and dot-walk fields |
| Search Source | verify on instance | Maps an indexed source into a profile |
| Genius Result config | verify on instance | Direct-answer results |
| Synonyms / dictionaries | verify on instance | Query expansion |

Configuration order in practice: Search Profile, then Indexed Source, then Search Source, then Search Application. Profiles start in draft and must be **published**.

Search Results Configuration is an EVAM definition controlling how results are displayed.

Roles: `ais_admin` (in Australia also gates Search Suggestions tables as a granular admin role), `search_application_admin`.

## Failure modes to check

| Symptom | Likely cause |
|---|---|
| New content not returned | Stale index. Reindex required. Topic renames explicitly require manual reindexing of the topic table |
| No results at all | Profile unpublished, or source not linked to profile |
| Results missing for some users only | ACL filtering at query time. Indexed content the user cannot read is filtered out |
| Low recall generally | Restrictive Indexed Source filters |
| Referenced field content not found | Dot-walk fields not enabled on the Indexed Source |
| Knowledge articles misbehaving | Associated search profile not linked to a knowledge bases search source |
| Search widgets broken after enabling AI Search | Cloned or customized search widgets predating AI Search. ServiceNow ships a fix script to reclassify search widget instances |
| No results in Internet Explorer | AI Search does not support IE |

The cloned-search-widget case is worth an explicit check on any portal with AI Search enabled, because it is documented, common, and has a supplied remedy.

## Australia additions

- **Hybrid search** (keyword plus semantic), requires Now Assist in AI Search 15.0 or later. Explicitly targets reducing zero-result searches.
- **Multimodal captioning** of indexed attachments (Patch 3).
- **Multi-source synthesized responses** (Patch 4).
- **Enhanced Search Preview** with Summary, Genius Results, Details and Profile admin tools, plus keyword versus hybrid mode selection.

Now Assist Multi-Content Response Genius Results can override other Genius Result configurations in global and workspace search.

## Zing, the legacy engine

Classic keyword text-index engine using text indexes (`ts_index_*`, text-index events, the `ts_query` and `ts_index` family). Reliable for exact matches such as ticket numbers, weak on typos and intent.

The Knowledge Management Service Portal and the deprecating Knowledge v3 homepage historically support only Zing.

Legacy for portals, but not formally deprecated.

## Search health signals

| Signal | Source | Meaning |
|---|---|---|
| Zero-result rate | Search event data | Content gaps or index problems. Australia hybrid search targets this directly |
| Click-through rate | Search event data | Result relevance |
| Deflection | Usage Insights, catalog and incident volume | Whether search is reducing ticket creation |
| Index freshness | Indexed Source last run | Whether recent content is findable |

Compare against the site's own baseline, not an absolute threshold.
