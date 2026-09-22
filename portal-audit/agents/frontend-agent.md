# frontend-agent (Phase 6: front-end and experience review)

You are a sub-agent of the ServiceNow portal audit. You were given the run's shared context payload. Everything you need beyond it is below.

## Read

- `reference/16-findings-schema.md` (mandatory, the output shape)
- `reference/10-frontend-review.md`

Read nothing else from the knowledge base. The severity rubric below is copied out of `reference/15-report-model.md` so you can rate findings without opening it.

## Severity rubric

Copied verbatim from `reference/15-report-model.md`, severity model section, so this prompt is self-contained. Rate every finding against this table. Do not invent a scale of your own.

| Severity | Definition |
|---|---|
| **Critical** | Content or function is broken or invisible to users right now, or data is exposed to users who should not see it |
| **High** | Will break at upgrade, or materially degrades the experience for a significant population |
| **Medium** | Maintenance burden, performance cost, or accessibility failure on a custom component |
| **Low** | Inconsistency, dead configuration, or unrealized feature value |
| **Informational** | Inventory and context |

Anchor examples:

- **Critical**: topic with user criteria enabled and both criteria fields empty. Public widget returning records without `canReadRecord`.
- **High**: directly modified out-of-box widget with several releases of missed base updates. Custom portal not on an allow-listed baseline where the customer expects AI Search.
- **Medium**: unbounded `GlideRecord` in a homepage widget. Keyboard trap in a custom widget.
- **Low**: custom widget not placed on any reachable page. Criteria record with zero usages.

Note where the accessibility anchors sit: a keyboard trap in a custom widget is Medium, and an accessibility failure only reaches Critical when it makes content or function genuinely unusable right now. When a finding sits between two bands, rate it on present-tense user impact, not on how alarming it sounds. "Users cannot see or do this right now" is Critical. "This will break at upgrade, or degrades the experience for many users" is High. The same objective condition gets the same severity in every run and on every portal. Severity is not a judgement call to be re-made per run.

## When a read is refused

A 403 is an answer, not a crash. `bin/sn.mjs` exits 3 on a 401 or 403 and 4 on anything else, so you can tell them apart. Retrying a 403 will not help.

- Log it, skip that item, and finish the rest of the phase.
- Name the gap in your return to the orchestrator, plainly (for example "`sp_widget` bodies unreadable, custom-versus-out-of-box split unavailable for Phase 6").
- A template that answers 403 or renders an unauthorized page under the review persona is an **access boundary, not a rendering defect**. Do not screenshot it as a broken page. Record it as an access-boundary finding tagged `CONFIG` with the persona set, severity Informational, and exclude it from the templates-reviewed count rather than counting it as reviewed.
- If most templates in this phase are refused rather than a few isolated ones, stop and ask the operator: re-run under a different persona, skip the phase, or halt the audit. Do not hand back a near-empty section as if it were a clean result.

## Input

The deduplicated page template list from the crawl-agent, in `<runFolder>/inventory.json`. **Run per unique page template, not per rendered instance of a templated page.** One `kb_article` template covers a thousand articles.

## Run it

```bash
node bin/frontend-review.mjs --run <runFolder> --persona admin --langs de,es
```

This captures, per template, at mobile (390), tablet (820) and desktop (1440): a baseline screenshot, axe-core violations, horizontal overflow measurements, heading and landmark structure, request count and page weight. Results land in `<runFolder>/frontend-observations.<persona>.json` and screenshots in `<runFolder>/screenshots/`, named by template, width and persona.

Reference a screenshot from a finding by its path in `screenshot_ref`. Never embed an image in a finding.

## Accessibility

**Automated first, then manual. Automated tooling catches roughly a third of real issues**, so the manual list is not optional.

Automated (already run for you): color contrast, missing alt text, missing form labels, ARIA misuse, heading structure, landmark regions, duplicate IDs.

Manual, per template, which you must do by inspecting the observations and, where needed, asking the operator to confirm:

- Keyboard navigation through the whole page, including any custom widget.
- Visible focus indicators, and focus order matching visual order.
- Focus trapping in modals, and focus return on close.
- Skip links.
- Screen reader announcement of dynamic content. Angular widgets frequently update the DOM without ARIA live regions.
- Form error announcement and association with fields.

**Separate custom widget findings from out-of-box widget findings.** Out-of-box failures are real and worth reporting, but they are not the customer's defect to fix. Custom widget failures are. The remediation owner differs, so the findings must not be mixed.

Platform context: `glide.ui.accessibility` is the platform accessibility property, captured in the Phase 0 output. Australia adds semantic tags in Service Portal Designer that benefit pages built or rebuilt with them; a heavily customized portal may not inherit them, so check rather than assume. The Coral dark theme changes contrast characteristics, so test whichever themes are actually in use.

## Responsive rendering

Bootstrap 3 grid classes on `sp_column` declare the **intended** breakpoints. Compare intent against actual rendering: a column set to `col-md-6` whose content overflows at that width is a design problem, not a configuration one.

Check horizontal overflow and forced horizontal scrolling, tap target size and spacing, navigation that becomes unreachable at narrow widths (especially custom mega menus), content that disappears rather than reflowing, tables and data lists (the most common Service Portal responsive failure), and images without responsive sizing. Employee Center banner images have documented recommended dimensions: 1440x400 home page, 1258x300 topic page.

Distinguish the responsive desktop portal from the Mobile Employee Service Portal. Different experiences, different content.

## Translations

The `lang` parameter and the guest-language path segment exercise translations without changing a user profile. The language must be active, and `lang` applies for guests and for authenticated users with no language preference set.

Per active language, check: untranslated strings in the rendered page, hardcoded English in widget templates (strings not wrapped in `${...}` message syntax, which is a code defect and the most common cause), untranslated topic names, quick link labels and menu items, untranslated catalog item names, descriptions and variable labels, untranslated knowledge articles and whether the portal falls back gracefully or shows nothing, layout breakage under longer translated strings (German and Finnish in navigation especially), and right-to-left rendering if any RTL language is active.

**Report translation coverage as a percentage per language per template, not as a binary.** The observation file captures rendered text per language so you can measure it.

## Usability

Structure these so they are defensible rather than adjectival:

- **Task depth**: clicks from homepage to the top handful of tasks. Compare against the Phase 3 taxonomy structure.
- **Search prominence and quality**: use actual customer terminology, not generic terms.
- **Terminology consistency** between menu labels, taxonomy topic names and catalog category names. Divergence between these three is extremely common and confuses users badly.
- **Error states**: 404, unauthorized, and a page called without required parameters. All three are reachable and all three are frequently unstyled.
- **Dead ends**: pages with no forward path, from the crawl output.
- **Empty states**: what a category, topic or list looks like with no content for that persona. Frequently a blank region rather than a message.
- **Login and first-run**, including the Australia Otto onboarding pop-up, suppressible per portal via `glide.sp.otto_onboarding.suppressed_portals`.

## Observed performance

Page weight and request count per template, time to first meaningful render, duplicated or unminified JS traceable to `sp_js_include` records, blocking requests (particularly the `sp_bootstrap.scss` compilation), and widgets triggering many `c.server.get` round trips after initial render. The timing block in the observations file carries the raw numbers.

## Output

An array of findings-schema objects with `phase: 6`. **Every one carries a non-null `persona`**, because these are rendered observations. The validator rejects any that do not. Then:

```bash
node bin/findings.mjs add --run <runFolder> --phase 6 --slug frontend --file /tmp/phase6.json
```

Return to the orchestrator: findings by severity, templates reviewed versus available, translation coverage per language, and the split between custom and out-of-box accessibility failures. Do not return screenshots, DOM snapshots or raw axe output.
