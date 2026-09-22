# Front-End and Experience Review

Browser only. Run per **unique page template**, not per rendered instance of a templated page. One `kb_article` template covers a thousand articles.

## Screenshots

Capture a baseline screenshot for every unique template, at every width tested (mobile, tablet, desktop), for every persona used. Cheap, and it proves coverage even where nothing is wrong. When a specific RENDERED finding gets flagged, capture one more screenshot at the exact moment the issue was observed.

Store screenshots in the run's `screenshots/` folder (see `15-report-model.md`), named by template, width, and persona. In the findings schema, reference the file by path in `screenshot_ref`, never embed the image itself in a finding passed between sub-agents.

Screenshots taken while logged in as a real user can show real customer data on screen. Handle them under the same retention rule as the rest of the cache, in `13-data-access.md`.

## Accessibility

Automated first, then manual. Automated tooling catches roughly a third of real issues.

**Automated per template**: run axe-core, injected into the rendered page. Checks color contrast, missing alt text, missing form labels, ARIA misuse, heading structure, landmark regions, duplicate IDs. Confirm axe-core can actually be injected via whichever browser tool the build ends up using.

**Manual per template**:
- Keyboard navigation through the whole page, including any custom widget.
- Visible focus indicators, and focus order matching visual order.
- Focus trapping in modals, and focus return on close.
- Skip links.
- Screen reader announcement of dynamic content, which Angular widgets frequently get wrong because they update the DOM without ARIA live regions.
- Form error announcement and association with fields.

**Platform context**:
- `glide.ui.accessibility` is the platform accessibility property.
- Australia adds semantic tags in Service Portal Designer that improve screen reader navigation. These benefit pages built or rebuilt with them. A heavily customized portal may not inherit them, so check rather than assume.
- The Coral dark theme changes contrast characteristics. Test whichever themes are actually in use.
- ServiceNow publishes accessibility conformance documentation for base components. Out-of-box widget failures are worth reporting to the customer but are not their defect to fix. Custom widget failures are.

Separate custom widget findings from out-of-box widget findings. The remediation owner is different.

## Responsive rendering

Capture each unique template at mobile, tablet and desktop widths.

Bootstrap 3 grid classes on `sp_column` records declare the **intended** breakpoints, so compare intent against actual rendering. A column set to `col-md-6` with content that overflows at that width is a design problem, not a configuration one.

Check for:
- Horizontal overflow and forced horizontal scrolling.
- Tap target size and spacing.
- Navigation that becomes unreachable or unusable at narrow widths, especially custom mega menus.
- Content that disappears entirely rather than reflowing.
- Tables and data lists, which are the most common responsive failure in Service Portal.
- Images without responsive sizing, especially EC banner images, which have documented recommended dimensions (1440x400px home page, 1258x300px topic page).

**Mobile portal versus MESP**: distinguish the responsive desktop portal from the Mobile Employee Service Portal. They are different experiences with different content. Remember the documented rollup difference: a topic rolls up connected content from child topics on desktop but not on mobile unless `sn_ex_sp.u_allow.rollup.mesp` is true.

## Translations

The `lang` URL parameter and the guest-language path segment are the documented mechanisms for exercising translations without changing a user profile. Use them.

```
https://<instance>/<suffix>/<guest language>/?id=<page>&lang=<language>
```

The language must be active. `lang` applies for guest users and for authenticated users with no language preference set.

Check per active language:
- Untranslated strings in the rendered page.
- Hardcoded English in widget templates, meaning strings not wrapped in `${...}` message syntax. This is a code defect and is the most common cause.
- Untranslated topic names, quick link labels and menu items.
- Untranslated catalog item names, descriptions and variable labels.
- Untranslated knowledge articles, and whether the portal falls back gracefully or shows nothing.
- Layout breakage under longer translated strings, particularly German and Finnish in navigation.
- Right-to-left rendering if any RTL language is active.
- `glide.sp.portals.language` property configuration.

Report translation coverage as a percentage per language per template, not as a binary.

## Usability review

Qualitative, but structure it so findings are defensible:

- **Task depth**: clicks from homepage to the top handful of tasks. Compare against the taxonomy structure from Phase 3.
- **Search prominence and quality**: is search discoverable, and do representative real queries return useful results. Use actual customer terminology, not generic terms.
- **Terminology consistency** between menu labels, taxonomy topic names, and catalog category names. Divergence between these three is extremely common and confuses users badly.
- **Error states**: what a user sees on a 404, on an unauthorized page, and on a page called without required parameters. All three are reachable and all three are frequently unstyled.
- **Dead ends**: pages with no forward path, identified from the Phase 5 crawl.
- **Empty states**: what a category, topic or list looks like with no content for that persona. Frequently a blank region rather than a message.
- **Login and first-run experience**, including the Otto onboarding pop-up in Australia, suppressible per portal via `glide.sp.otto_onboarding.suppressed_portals`.

## Observed performance

Captured in the browser, complementing the static analysis in `11-performance-properties.md`:

- Page weight and request count per template.
- Time to first meaningful render.
- Duplicated or unminified JS traceable to `sp_js_include` records.
- Blocking requests, particularly the `sp_bootstrap.scss` compilation.
- Widgets that trigger many `c.server.get` round trips after initial render.
