# Findings Schema

Every sub-agent returns findings in this shape, and only this shape. Phase 10 assembles the report from these objects. A sub-agent that returns anything else, including raw records, has failed its job. See `00-methodology.md` for the sub-agent contract this schema supports.

## Shape

```json
{
  "id": "string, stable within a run (phase-slug plus sequence, e.g. p3-014)",
  "phase": 0,
  "title": "one line, client-readable",
  "description": "the finding itself",
  "status": "published | withheld",
  "evidence_type": "CONFIG | RENDERED | USAGE | INFERRED",
  "evidence_detail": "table plus query, or URL plus persona, or telemetry source, whatever backs evidence_type",
  "severity": "Critical | High | Medium | Low | Informational",
  "persona": "string or null. Must be a name key from this run's persona registry (see 03-routing-reachability.md). Required, non-null, for any reachability or visibility finding.",
  "portal_scope": "single | shared",
  "shared_with": ["other portal names, populated when portal_scope is shared and known"],
  "tier": "string or null. Carries ONLY the blast-radius scheme: '1' or '2' (09-customization-upgrade.md). Never the Phase 8 staleness scheme (A/B/C) -- that goes in evidence_detail instead, on any phase, not just Phase 8. Null when no tier applies.",
  "record_refs": [{"table": "sys_id"}],
  "url": "string or null. Direct link to the primary record or rendered page this finding is about. See conventions below.",
  "screenshot_ref": "string or null. Path to a cached screenshot backing this finding. See 10-frontend-review.md.",
  "write_exception_used": "string or null. Name of the declared write exception (see 13-data-access.md) whose action produced this finding's evidence. Null for every normal, read-only finding.",
  "caveat": "string or null. E.g. 'requires re-login to take effect', 'documented default, not a defect'.",
  "quantification": "object or null. {count, of_total, unit} when a number applies to the finding, null otherwise.",
  "remediation": "string or null",
  "supersedes": ["finding ids this finding invalidates and replaces. Empty array when it replaces nothing. See rule 7."]
}
```

`phase` is an integer, 0 to 10, not a range string.

`supersedes` is the one optional field: it may be omitted entirely, and an omitted `supersedes` reads as `[]`. Every other field must be present, even when its value is null. The exemption exists so findings written before this field was added still validate and their runs' reports can still be regenerated. New findings should write it explicitly.

## Validation rules

An orchestrator or synthesis step should reject or flag a finding that violates any of these, rather than let it into the report silently wrong.

1. **Persona is mandatory for access claims.** Any finding with `evidence_type: RENDERED`, or any finding asserting reachability or visibility, must have a non-null `persona`. A visibility finding without a persona is not a finding. This does not apply to a finding that is purely structural, such as a Phase 8 orphan finding (nothing links to this record, for anyone) — those still record `persona` for context, but the rule exists to catch access-dependent claims specifically.
2. **`persona` must resolve to a real registry entry.** Free text is not allowed. It must match a `name` in the run's persona registry, so the report can cross-reference exactly who or what was tested.
3. **Shared scope needs a reason.** `portal_scope: shared` is allowed with an empty `shared_with` only when `tier` is `2` and the caveat explains why the other portals could not be confirmed (see the two-tier blast-radius rule in `09-customization-upgrade.md`). At `tier: 1`, `shared_with` must be non-empty.
4. **`write_exception_used` must match a logged exception.** If set, it must correspond to an exception actually declared and logged per `13-data-access.md`. Never set by an agent on its own judgment mid-run.
5. **`url` follows the stated convention or is null.** For `CONFIG` and `INFERRED` findings backed by a platform record, use the Next Experience deep link: `https://<instance>/now/nav/ui/classic/params/target/<table>.do%3Fsys_id%3D<sys_id>`. For `RENDERED` findings, use the actual portal URL navigated to when the finding was observed. For `USAGE` findings, use a link into Usage Insights or `sp_log` if one exists, or null if there is no direct link for that telemetry view. Null when no single record or page applies (for example, a cross-cutting statistical finding).
6. **An admin-only run must not silently drop the Phase 5 reconciliation.** When the crawl only tested the admin persona, write a `status: withheld` placeholder for it in `findings/phase-5-*.json` rather than omitting it entirely, so the evidence trail shows the gap was noticed, not missed. See worked example 7.
7. **A correction supersedes what it corrects, by id.** When a later finding establishes that an earlier one is wrong, list the earlier one's `id` in the later one's `supersedes` array. Do not write a finding titled "Correction:" that only narrates the mistake in prose: prose cannot remove the struck statement from the report, and the report then publishes the correction next to the thing it says is wrong. Every id in `supersedes` must exist in the same run, a finding may not supersede itself, and two findings may not supersede each other. Phase 10 leaves every superseded finding out of the assembled report and names it in Appendix G, so nothing disappears without a trace.

## Consistency guard at assembly

Phase 10 also checks a finding's claims about the run itself against the run's own artifacts before publishing it. A finding whose evidence says "the screenshots directory is empty" is contradicted when the run folder holds screenshots; one saying "the Phase 5 crawl has not run" is contradicted when `crawl-state*.json` records visited nodes.

Where the contradiction sits decides what happens:

- in `title`, `description` or `evidence_detail`, the finding is about a gap that did not happen, so it is kept out of the report body entirely;
- in `caveat` alone, the finding still stands and only its qualifier went stale, so it is published with that caveat replaced by a note saying what was disproved.

Either way it is listed in Appendix G with the fact that contradicted it, and nothing in `findings/` is edited. This is a narrow self-consistency check, not a general fact-checker: it only covers claims a finding makes about this audit's own artifacts, which a sub-agent working with partial visibility can get wrong. If a finding is caught wrongly, fix the finding's wording rather than the guard: the wording is what a client would have read.

## Worked examples

**1. Critical, CONFIG, no persona needed** — the empty-criteria topic bug (Phase 3).

```json
{
  "id": "p3-014",
  "phase": 3,
  "title": "Topic 'Payroll' is invisible to all users",
  "description": "Enable user criteria check is on for the Payroll topic, but Available For and Not Available For are both empty. At the topic level this means visible to nobody, not everybody.",
  "status": "published",
  "evidence_type": "CONFIG",
  "evidence_detail": "topic sys_id abc123, Available For and Not Available For fields both blank",
  "severity": "Critical",
  "persona": null,
  "portal_scope": "single",
  "shared_with": [],
  "tier": null,
  "record_refs": [{"topic": "abc123"}],
  "url": "https://<instance>/now/nav/ui/classic/params/target/topic.do%3Fsys_id%3Dabc123",
  "screenshot_ref": null,
  "write_exception_used": null,
  "caveat": null,
  "quantification": {"count": 1, "of_total": 47, "unit": "topics affected"},
  "remediation": "Populate Available For, or disable the user criteria toggle to revert to content-level security."
}
```

This one **will** trip the validator's soft "wording reads as an access or visibility claim but persona is null" warning (the title contains "invisible"), and that is expected, not a mistake to fix. It is a warning, not an error, precisely for cases like this one: rule 1's carve-out for a purely structural finding applies here, since the misconfiguration makes the topic invisible to everyone regardless of which persona looked, so persona is structurally irrelevant rather than merely omitted. Do not silence the warning by rewording away from plain visibility language; do not add a persona just to quiet it either.

**2. High, CONFIG, shared blast radius, Tier 1 exact** — a bucket 3 customization (Phase 8).

```json
{
  "id": "p8-002",
  "phase": 8,
  "title": "Login widget directly modified, 4 base releases behind",
  "description": "The out-of-box Login widget carries a sys_update_xml entry from Utah. Base has since shipped 4 releases of Login widget updates, including the Australia portal-specific auth feature, which may make this customization obsolete.",
  "status": "published",
  "evidence_type": "CONFIG",
  "evidence_detail": "sys_update_xml against sp_widget sys_id def456, last customer update 2023-08. Staleness evidence tier B: sys_update_version timestamps compared against release family.",
  "severity": "High",
  "persona": null,
  "portal_scope": "shared",
  "shared_with": ["Employee Center (esc)", "IT Service Portal (itsp)"],
  "tier": "1",
  "record_refs": [{"sp_widget": "def456"}],
  "url": "https://<instance>/now/nav/ui/classic/params/target/sp_widget.do%3Fsys_id%3Ddef456",
  "screenshot_ref": null,
  "write_exception_used": null,
  "caveat": "Portal-specific authentication (Australia) may let this customization be reverted rather than maintained.",
  "quantification": {"count": 4, "of_total": null, "unit": "base releases missed"},
  "remediation": "Evaluate whether Australia's per-portal auth config replaces this customization; if so, revert to base and reconfigure declaratively."
}
```

Note the two different tiers in play here and how they are kept distinct: `tier: "1"` describes the blast-radius confidence (this widget's sharing with two named portals is confirmed exactly). The staleness confidence (how many base releases were missed) is a separate tiering scheme, A/B/C, stated in `evidence_detail` rather than in the `tier` field, since `tier` only carries the blast-radius scheme in this schema. Keep the two schemes from being conflated when writing a Phase 8 finding.

**3. Medium, RENDERED, persona mandatory** — a keyboard trap (Phase 6).

```json
{
  "id": "p6-031",
  "phase": 6,
  "title": "Keyboard trap in custom appointment-booking widget",
  "description": "Opening the appointment modal on the Schedule page traps keyboard focus; Escape and Tab do not return focus to the trigger element.",
  "status": "published",
  "evidence_type": "RENDERED",
  "evidence_detail": "Observed at https://instance/esc?id=schedule, modal opened via 'Book appointment' button",
  "severity": "Medium",
  "persona": "admin",
  "portal_scope": "single",
  "shared_with": [],
  "tier": null,
  "record_refs": [{"sp_widget": "ghi789"}],
  "url": "https://instance/esc?id=schedule",
  "screenshot_ref": "screenshots/schedule__desktop__admin.png",
  "write_exception_used": null,
  "caveat": null,
  "quantification": null,
  "remediation": "Add focus trap release on Escape and restore focus to trigger element on close."
}
```

**4. Informational, with a required caveat** — inactive AI Search on an upgraded instance (Phase 1, search health).

```json
{
  "id": "p1-007",
  "phase": 1,
  "title": "AI Search is inactive on this portal",
  "description": "Enable AI Search is false on the sp_portal record. The portal uses the legacy Zing search experience.",
  "status": "published",
  "evidence_type": "CONFIG",
  "evidence_detail": "sp_portal sys_id jkl012, Enable AI Search = false",
  "severity": "Informational",
  "persona": null,
  "portal_scope": "single",
  "shared_with": [],
  "tier": null,
  "record_refs": [{"sp_portal": "jkl012"}],
  "url": "https://<instance>/now/nav/ui/classic/params/target/sp_portal.do%3Fsys_id%3Djkl012",
  "screenshot_ref": null,
  "write_exception_used": null,
  "caveat": "This instance was upgraded into Australia. AI Search defaults to inactive on upgrade; this is the documented default, not a defect.",
  "quantification": null,
  "remediation": "Opportunity: enable AI Search and configure a Search Application to modernize search."
}
```

**5. Low, INFERRED, published with a caveat, not withheld** — a Phase 8 orphaned widget.

```json
{
  "id": "p8-019",
  "phase": 8,
  "title": "Custom widget 'esc_promo_banner' not reachable from any crawled page",
  "description": "This custom widget exists with an sp_instance placement on the 'legacy_promo' page, but that page was never reached in the Phase 5 crawl.",
  "status": "published",
  "evidence_type": "INFERRED",
  "evidence_detail": "sp_instance pqr678 places sp_widget mno345 on sp_page 'legacy_promo'; 'legacy_promo' is absent from the Phase 5 reachable set for the admin persona",
  "severity": "Low",
  "persona": "admin",
  "portal_scope": "single",
  "shared_with": [],
  "tier": null,
  "record_refs": [{"sp_widget": "mno345"}],
  "url": "https://<instance>/now/nav/ui/classic/params/target/sp_widget.do%3Fsys_id%3Dmno345",
  "screenshot_ref": null,
  "write_exception_used": null,
  "caveat": "Published rather than withheld per the Phase 8 orphan rule in 09-customization-upgrade.md: this is a structural fact (nothing links to the host page), not a role-gated access claim, so it holds regardless of which persona crawled. Admin's own effective role set for this run held no unusual restrictions, which supports treating this as a real orphan rather than a role-hidden link admin specifically could not see.",
  "quantification": null,
  "remediation": "Confirm intentional before removing; if orphaned, safe to retire."
}
```

**6. Low, INFERRED, Tier 2 approximate blast radius** — a widget likely shared, other portals unconfirmed (Phase 8).

```json
{
  "id": "p8-024",
  "phase": 8,
  "title": "Widget 'esc_feedback_card' likely used beyond this portal",
  "description": "This widget is placed on 6 pages instance-wide, but only 1 of those pages appeared in this portal's own Phase 5 crawl. The other 5 placements suggest use by other portals.",
  "status": "published",
  "evidence_type": "INFERRED",
  "evidence_detail": "sp_instance count for sp_widget stu901: 6 instance-wide, 1 within this portal's reachable set",
  "severity": "Low",
  "persona": null,
  "portal_scope": "shared",
  "shared_with": [],
  "tier": "2",
  "record_refs": [{"sp_widget": "stu901"}],
  "url": "https://<instance>/now/nav/ui/classic/params/target/sp_widget.do%3Fsys_id%3Dstu901",
  "screenshot_ref": null,
  "write_exception_used": null,
  "caveat": "Tier 2, approximate. Instance-wide placement count is higher than this portal's own crawl would produce, which signals likely sharing, but the specific other portals could not be confirmed without crawling them, which is out of scope for a single-portal audit.",
  "quantification": {"count": 6, "of_total": 1, "unit": "instance-wide placements versus placements within this portal's crawl"},
  "remediation": null
}
```

**7. Withheld placeholder** — the Phase 5 reconciliation, admin-only run.

```json
{
  "id": "p5-000",
  "phase": 5,
  "title": "Reachability reconciliation withheld: admin-only run",
  "description": "The Phase 5 reconciliation of configured-and-reachable, configured-but-unreachable, and reachable-but-not-configured page sets was not published for this run.",
  "status": "withheld",
  "evidence_type": "CONFIG",
  "evidence_detail": "Only the admin persona was crawled; no operator-declared persona was added at Phase 0",
  "severity": "Informational",
  "persona": "admin",
  "portal_scope": "single",
  "shared_with": [],
  "tier": null,
  "record_refs": [],
  "url": null,
  "screenshot_ref": null,
  "write_exception_used": null,
  "caveat": "This finding only means something relative to a real, non-admin view, per the persona-gating rule in 03-routing-reachability.md. Add a business-role persona at Phase 0 on a future run to unlock it.",
  "quantification": null,
  "remediation": "Re-run with at least one operator-declared persona to obtain this reconciliation."
}
```
