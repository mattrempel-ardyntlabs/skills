# PDF Report

`report.md` stays the source of truth (`15-report-model.md`). `report.pdf` is a branded, presentation layer on top of the exact same `findings/*.json`, built by `bin/report-pdf.mjs` and `lib/pdf/`. It exists because a real client deliverable benefits from a designed exec summary, a severity chart, spotlighted High findings and a screenshot gallery, none of which belong in the plain-Markdown source of truth.

## Running it

```bash
node bin/report-pdf.mjs --run <run> [--narrative narrative.json]
```

Reads `findings/*.json` and `shared-context.json` the same way `bin/report.mjs` does, and never touches the instance. Writes `<run>/report.pdf`.

## Narrative input

Two things in the PDF cannot be derived mechanically from findings without flattening into something bland: the exec-summary headline, and the "what to do next" synthesis. Both are a judgment call, the same way authoring a finding is (`SKILL.md`: "Author the Phase 1 findings yourself from the observations"). Supply them with `--narrative`:

```json
{
  "headline": "One sentence, client-readable, the way you'd open the conversation.",
  "scopeNote": "One sentence on what was audited (optional, otherwise built from context).",
  "nextSteps": [
    { "title": "Short imperative.", "detail": "Why, or what it unblocks." }
  ]
}
```

Without `--narrative`, the PDF still renders. The headline becomes the single top finding's own title, `nextSteps` becomes the top four findings' own remediation text, and the command's JSON output sets `narrativeGenerated: true` with a note, so a plain fallback is never mistaken for an authored exec summary. Author one before handing the PDF to a client.

Everything else in the PDF, the severity grid, the findings-by-section chart, the High-severity cards, the condensed tables, the screenshot gallery, is assembled directly from `findings/*.json` via the same `SECTIONS` list `lib/report.mjs` uses for `report.md` (`lib/pdf/data.mjs` imports it rather than re-deriving section membership a second time).

## Assets

`assets/pdf-theme/` vendors the pieces of the Ardynt Labs Design System the templates use: `theme.css` (color and type tokens), `fonts/` (Recoleta Alt Bold for headings, four Poppins weights for everything else), `logo/` and `motif/` (the cover's wordmark and weave pattern). Vendored rather than referenced from the design system's own folder, so the skill renders identically regardless of whose machine it runs on. If the design system's tokens or assets change, re-copy the same files here; nothing in `lib/pdf/` needs to change to pick them up.

## The pagination rules these templates depend on

The PDF used to ship with a real bug: content that started on one physical page and spilled onto the next mid-sentence, mid-row, or mid-image, jarring to read and disqualifying for a client deliverable. Both root causes are worth restating so a future template change does not reintroduce them.

**Never chunk content into fixed-size pages by hand.** An earlier version of this pipeline rendered one `.page` div per intended physical page, sized by guesswork (2 finding cards per page, 12 table rows per page). Chromium's `page.pdf()` paginates the whole document as one continuous flow at a fixed pixel height; a `.page` div whose real rendered content exceeded that height spilled onto a second physical page mid-content, and the div's own forced page-break then landed right after, producing an odd near-empty page. The fix: `content.html` has no manual chunking. Content flows naturally inside `.chapter` sections (`break-before: page` only at real chapter boundaries), and `break-inside: avoid` on every atomic unit, a finding card, a table row, a gallery item, a next-steps line, is what actually keeps one of those units from splitting. This only works because nothing forces a fixed count per page; the browser measures real heights and decides for itself.

**Cap every embedded image's height.** A portrait screenshot (390 by 900, a mobile capture) stretched to `width: 100%` inside a ~600px-wide card renders at roughly 1,380px tall, taller than a full physical page. No `break-inside: avoid` can save a block that is, by itself, taller than one page; Chromium is forced to cut it, and it cut mid-image. `.finding-card__shot` is capped at `max-height: 380px` with `object-fit: contain`; `.gallery__item img` is fixed at `height: 210px` with `object-fit: cover`. Any new place that embeds a screenshot needs the same treatment, since the crawl captures both desktop (1440 by 900) and mobile (390 by 900) viewports and the two have very different aspect ratios.

**QA the actual rendered PDF pages, not the HTML.** Screenshotting an HTML `.page` div (or any single element) cannot reveal either bug above, since an element screenshot renders it in isolation and ignores how the browser's print engine actually paginates the surrounding flow. Verify with the real output instead:

```bash
pdftoppm -png -r 110 <run>/report.pdf /tmp/pdf-qa/pg
```

Then look at the PNGs, specifically the boundary pages between chapters and any page carrying a card with a screenshot. This is the only way that actually would have caught the bug described above; it was found this way, not by review.

## Two documents, not one

`render.mjs` produces `cover.pdf` (zero margin, full-bleed, dark background) and `content.pdf` (real margins, Chromium's native header/footer template for the running "Ardynt Labs &middot; \<portal\> Portal Audit" and page-number footer) separately, then merges them with `pdf-lib`. A full-bleed dark cover and a flowing, margined content document are two different page models; mixing them in one Playwright print pass does not work cleanly. Nothing about this model is specific to this one report; reuse it for any future PDF with a distinct cover.
