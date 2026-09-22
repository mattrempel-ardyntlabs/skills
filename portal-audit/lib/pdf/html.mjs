// HTML templates for the two PDF documents. See lib/pdf/render.mjs for why
// there are two (a fixed full-bleed cover plus a naturally flowing content
// document) and reference/17-pdf-report.md for the pagination rules this
// markup depends on: break-inside:avoid on every atomic unit below, no
// manual chunking, and a height cap on every embedded image. Skipping any
// of those three reintroduces the "starts on one page, ends on the next"
// bug this template was built to fix.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SEV_COLOR = {
  Critical: { bg: 'var(--c-terracotta-deep)', fg: '#fff' },
  High: { bg: 'var(--c-terracotta)', fg: '#fff' },
  Medium: { bg: 'var(--c-yellow)', fg: '#0C0B0A' },
  Low: { bg: 'var(--c-forest)', fg: '#fff' },
  Informational: { bg: '#EDE7E0', fg: '#0C0B0A' },
};
const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Informational'];

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fileUrl = (p) => `file://${p}`;

function pill(sev) {
  const c = SEV_COLOR[sev] ?? SEV_COLOR.Informational;
  return `<span class="pill" style="background:${c.bg};color:${c.fg}">${esc(sev)}</span>`;
}
function evidenceBadge(type) {
  return `<span class="ev-badge ev-badge--${String(type).toLowerCase()}">${esc(type)}</span>`;
}

export function renderCoverHtml(data, assets) {
  const themeHref = fileUrl(path.join(assets.themeDir, 'theme.css'));
  const logoSrc = fileUrl(path.join(assets.themeDir, 'logo', 'ardyntlabs-wide-light.svg'));
  const motifSrc = fileUrl(path.join(assets.themeDir, 'motif', 'weave.svg'));
  const { meta } = data;

  return `<!doctype html><html><head><meta charset="utf-8" />
<link rel="stylesheet" href="${themeHref}" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  .cover { width: 816px; height: 1056px; padding: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--c-forest); color: #fff; position: relative; }
  .cover__motif { position: absolute; top: 100px; right: -60px; width: 420px; opacity: 0.16; z-index: 0; pointer-events: none; }
  .cover__motif img { width: 100%; display: block; filter: sepia(1) saturate(2) hue-rotate(140deg) brightness(0.9); }
  .cover__bar, .cover__meta, .cover__rule, .cover__foot { position: relative; z-index: 1; }
  .cover__bar { display: flex; justify-content: space-between; align-items: center; padding: 48px 64px 0; }
  .cover__logo { height: 24px; width: auto; }
  .cover__doc { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.6); }
  .cover__spacer { flex: 1; min-height: 220px; }
  .cover__meta { padding: 0 64px; margin-top: auto; }
  .eyebrow { font-family: var(--font-sans); font-weight: 500; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg-muted); }
  .cover__eyebrow { color: var(--c-yellow); display: block; margin-bottom: 18px; }
  .cover__h1 { font-family: var(--font-display); font-weight: 700; font-size: 84px; line-height: 0.98; letter-spacing: -0.02em; margin: 0 0 44px; color: var(--c-yellow); max-width: 11ch; }
  .cover__under { display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 30px; flex-wrap: wrap; gap: 8px; }
  .cover__client { font-family: var(--font-sans); font-weight: 500; font-size: 15px; color: #fff; }
  .cover__date { font-family: var(--font-mono); font-size: 11px; color: rgba(255,255,255,0.62); letter-spacing: 0.08em; }
  .cover__rule { height: 1px; background: rgba(255,255,255,0.14); margin: 0 64px; }
  .cover__foot { padding: 22px 64px 44px; display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 10.5px; color: rgba(255,255,255,0.6); letter-spacing: 0.05em; }
</style>
</head><body>
<div class="cover">
  <div class="cover__motif"><img src="${motifSrc}" alt="" /></div>
  <div class="cover__bar">
    <img class="cover__logo" src="${logoSrc}" alt="Ardynt Labs" />
    <span class="cover__doc">Portal Audit &middot; Confidential</span>
  </div>
  <div class="cover__spacer"></div>
  <div class="cover__meta">
    <span class="eyebrow cover__eyebrow">ServiceNow Portal Audit</span>
    <h1 class="cover__h1">${esc(meta.portalName)}</h1>
    <div class="cover__under">
      <span class="cover__client">${esc(meta.instanceBase)} &middot; ${esc(meta.environment)}</span>
      <span class="cover__date">${esc(meta.runDate)}</span>
    </div>
  </div>
  <div class="cover__rule"></div>
  <div class="cover__foot">
    <span>Weave. Automate. Govern.</span>
    <span>Ardynt Labs &middot; ardyntlabs.com</span>
  </div>
</div>
</body></html>`;
}

export async function renderContentHtml(data, assets) {
  const themeHref = fileUrl(path.join(assets.themeDir, 'theme.css'));
  const css = await readFile(new URL('./report.css', import.meta.url), 'utf8');

  const sections = [
    execSummary(data),
    chartPage(data),
    highSection(data, assets),
    tableSections(data),
    galleryPage(data, assets),
    methodologyPage(data),
    heldBackAppendix(data),
    nextStepsPage(data),
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(data.meta.portalName)} Portal Audit</title>
<link rel="stylesheet" href="${themeHref}" />
<style>${css}</style>
</head>
<body>
${sections}
</body>
</html>`;
}

function execSummary(data) {
  const { meta, totals, severityCounts, narrative } = data;
  const scopeLimitations = [];
  const domainRow = data.runParameters.find((r) => r.label === 'Domain separation');
  if (domainRow && /open scope limitation|Active on this instance/.test(domainRow.detail)) {
    scopeLimitations.push(domainRow.detail);
  }

  return `
<section class="chapter chapter--first">
  <span class="eyebrow">Executive summary</span>
  <h2 class="h2">${esc(narrative.headline)}</h2>
  <p class="lede">${esc(narrative.scopeNote)} It was run read-only, as ${esc(meta.personas.join(', '))}, against a ${esc(meta.environment)} instance. ${totals.published} findings published, ${totals.withheld} withheld.</p>

  <div class="summary-grid">
    ${SEV_ORDER.map((s) => `<div><div class="summary-grid__n" style="color:${s === 'Critical' || s === 'High' ? 'var(--c-terracotta)' : '#0C0B0A'}">${severityCounts[s]}</div><div class="summary-grid__l">${esc(s)}</div></div>`).join('')}
  </div>

  <h3 class="h3">The three findings that matter most</h3>
  <div class="top3">
    ${topFindingsForSummary(data)
      .map(
        (f, i) => `<div class="top3__card top3__card--${['midnight', 'forest', 'terracotta'][i % 3]}">
      <span class="eyebrow" style="color:var(--c-yellow)">0${i + 1} &middot; ${esc(f.sectionTitle)}</span>
      <p class="top3__t">${esc(f.title)}</p>
      <p class="top3__sub">${esc(f.description)}</p>
    </div>`,
      )
      .join('')}
  </div>

  ${scopeLimitations.length ? `<div class="callout callout--warn"><strong>Scope limitation.</strong> ${esc(scopeLimitations[0])} See Methodology.</div>` : ''}
</section>`;
}

function topFindingsForSummary(data) {
  return data.highFindings.slice(0, 3).map(({ finding, sectionTitle }) => ({ title: finding.title, description: finding.description, sectionTitle }));
}

function chartPage(data) {
  if (data.sections.length < 2) return '';
  const maxCount = Math.max(...data.sections.map((s) => s.count));
  const barRows = data.sections
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((s) => {
      const segs = SEV_ORDER.filter((sev) => s.bySeverity[sev] > 0)
        .map((sev) => `<div class="bar__seg" style="width:${(s.bySeverity[sev] / maxCount) * 100}%;background:${SEV_COLOR[sev].bg}"></div>`)
        .join('');
      return `<div class="bar-row"><div class="bar-row__label">${esc(s.title)}</div><div class="bar-row__track">${segs}</div><div class="bar-row__n">${s.count}</div></div>`;
    })
    .join('');

  return `
<section class="chapter">
  <span class="eyebrow">Where the findings sit</span>
  <h2 class="h2">Findings by report section</h2>
  <p class="lede">Sections are ordered by client value in the pages that follow, not by this count.</p>
  <div class="bar-chart">${barRows}</div>
  <div class="legend">${SEV_ORDER.map((s) => `<span class="legend__item"><span class="legend__swatch" style="background:${SEV_COLOR[s].bg}"></span>${esc(s)}</span>`).join('')}</div>
</section>`;
}

function findingCard(f, sectionTitle) {
  return `
  <article class="finding-card">
    <div class="finding-card__head">
      ${pill(f.severity)}
      ${evidenceBadge(f.evidence_type)}
      <span class="finding-card__section">${esc(sectionTitle)}</span>
    </div>
    <h4 class="finding-card__title">${esc(f.title)}</h4>
    <p class="finding-card__desc">${esc(f.description)}</p>
    ${
      f.quantification
        ? `<div class="stat-inline"><span class="stat-inline__n">${esc(f.quantification.count)}${f.quantification.of_total != null ? ` <span class="stat-inline__of">of ${esc(f.quantification.of_total)}</span>` : ''}</span><span class="stat-inline__l">${esc(f.quantification.unit)}</span></div>`
        : ''
    }
    ${f._shotSrc ? `<img class="finding-card__shot" src="${f._shotSrc}" alt="Rendered evidence" />` : ''}
    <div class="finding-card__evidence"><span class="finding-card__k">Evidence.</span> ${esc(f.evidence_detail)}</div>
    ${f.remediation ? `<div class="finding-card__remediation"><span class="finding-card__k">Remediation.</span> ${esc(f.remediation)}</div>` : ''}
    ${f.caveat ? `<div class="finding-card__caveat"><span class="finding-card__k">Caveat.</span> ${esc(f.caveat)}</div>` : ''}
  </article>`;
}

function highSection(data, assets) {
  if (!data.highFindings.length) return '';
  return `
<section class="chapter">
  <span class="eyebrow">Spotlight &middot; ${data.highFindings.length} findings</span>
  <h2 class="h2">High severity, in full</h2>
  <div class="finding-stack">
    ${data.highFindings
      .map(({ finding, sectionTitle }) => {
        const shotSrc = finding.screenshot_ref ? fileUrl(path.join(assets.screenshotsDir, finding.screenshot_ref.replace(/^screenshots\//, ''))) : null;
        return findingCard({ ...finding, _shotSrc: shotSrc }, sectionTitle);
      })
      .join('\n')}
  </div>
</section>`;
}

function tableSections(data) {
  let out = '';
  for (const s of data.sections) {
    if (!s.tableFindings.length) continue;
    out += `
<section class="chapter">
  <span class="eyebrow">${esc(s.title)}</span>
  <h2 class="h2 h2--tight">${s.count} findings &middot; ${s.tableFindings.length} shown here, condensed</h2>
  <table class="findings-table">
    <thead><tr><th style="width:90px">Severity</th><th>Finding</th><th style="width:90px">Evidence</th></tr></thead>
    <tbody>
      ${s.tableFindings
        .map(
          (f) => `<tr>
        <td>${pill(f.severity)}</td>
        <td><strong>${esc(f.title)}</strong><div class="findings-table__desc">${esc(f.description.slice(0, 190))}${f.description.length > 190 ? '&hellip;' : ''}</div></td>
        <td>${evidenceBadge(f.evidence_type)}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>
</section>`;
  }
  return out;
}

function galleryPage(data, assets) {
  if (!data.galleryItems.length) return '';
  return `
<section class="chapter">
  <span class="eyebrow">Rendered evidence</span>
  <h2 class="h2 h2--tight">Selected screenshots</h2>
  <p class="lede">Persona and viewport are named in each finding this evidence backs. Full inventory lives in the run's screenshots folder.</p>
  <div class="gallery">
    ${data.galleryItems.map((g) => `<figure class="gallery__item"><img src="${fileUrl(path.join(assets.screenshotsDir, g.screenshotRef.replace(/^screenshots\//, '')))}" alt=""/><figcaption>${esc(g.caption)}</figcaption></figure>`).join('')}
  </div>
</section>`;
}

function methodologyPage(data) {
  const withheldPara = data.withheldFindings.length
    ? `${data.withheldFindings.length} finding${data.withheldFindings.length === 1 ? ' is' : 's are'} withheld this run, each a stated placeholder rather than an omission: ${data.withheldFindings.map((f) => f.title).join('; ')}.`
    : 'No findings are withheld this run.';

  return `
<section class="chapter">
  <span class="eyebrow">Appendix A</span>
  <h2 class="h2 h2--tight">Methodology and evidence typing</h2>

  <h3 class="h3">Evidence types</h3>
  <table class="findings-table findings-table--legend">
    <tbody>
      <tr><td>${evidenceBadge('CONFIG')}</td><td>Read directly from a platform record. Highest challenge resistance: the record can be shown.</td></tr>
      <tr><td>${evidenceBadge('RENDERED')}</td><td>Observed in a browser as a named persona. Reproducible if the persona is recorded.</td></tr>
      <tr><td>${evidenceBadge('USAGE')}</td><td>Derived from usage telemetry. Depends on telemetry being enabled.</td></tr>
      <tr><td>${evidenceBadge('INFERRED')}</td><td>Reasoned from the above. Lowest confidence; stated as such wherever it appears.</td></tr>
    </tbody>
  </table>

  <h3 class="h3">Run parameters</h3>
  <table class="findings-table findings-table--legend">
    <tbody>
      ${data.runParameters.map((r) => `<tr><td style="width:200px"><strong>${esc(r.label)}</strong></td><td>${esc(r.detail)}</td></tr>`).join('')}
    </tbody>
  </table>

  <h3 class="h3">Withheld findings</h3>
  <p class="p">${esc(withheldPara)}</p>
</section>`;
}

// Appendix B, the PDF's counterpart to report.md's Appendix G: findings the
// triage in lib/report.mjs kept out of the report body (superseded,
// contradicted by this run's own artifacts, or an unrecognized status), plus
// findings that were published with a stale caveat replaced. Nothing here is
// re-derived; both lists come straight off buildPdfData()'s triage pass, so
// the PDF is never quietly shorter than report.md with no explanation why.
function heldBackAppendix(data) {
  const { heldBackFindings, amendedFindings } = data;
  if (!heldBackFindings.length && !amendedFindings.length) return '';

  const row = (f) => `<tr><td style="width:220px"><strong>${esc(f.id)}</strong> ${esc(f.title)}<div class="findings-table__desc">Phase ${esc(f.phase)}</div></td><td>${esc(f.detail)}</td></tr>`;

  return `
<section class="chapter">
  <span class="eyebrow">Appendix B</span>
  <h2 class="h2 h2--tight">Findings held back or amended before assembly</h2>
  <p class="p">These were written during the run and then changed on the way into this report, the same triage report.md's Appendix G records. The original wording stays in findings/ either way; nothing there was edited.</p>

  ${
    heldBackFindings.length
      ? `<h3 class="h3">Kept out of this report (${heldBackFindings.length})</h3>
  <table class="findings-table findings-table--legend">
    <tbody>
      ${heldBackFindings.map(row).join('')}
    </tbody>
  </table>`
      : ''
  }

  ${
    amendedFindings.length
      ? `<h3 class="h3">Published, with a stale caveat replaced (${amendedFindings.length})</h3>
  <table class="findings-table findings-table--legend">
    <tbody>
      ${amendedFindings.map(row).join('')}
    </tbody>
  </table>`
      : ''
  }
</section>`;
}

function nextStepsPage(data) {
  if (!data.narrative.nextSteps.length) return '';
  return `
<section class="chapter">
  <span class="eyebrow">Where to start</span>
  <h2 class="h2">${data.narrative.nextSteps.length} move${data.narrative.nextSteps.length === 1 ? '' : 's'}, in order</h2>
  <div class="next-steps">
    ${data.narrative.nextSteps.map((s, i) => `<div><div class="next-steps__n">${i + 1}</div><div><strong>${esc(s.title)}</strong> ${esc(s.detail)}</div></div>`).join('')}
  </div>
  <div class="next-steps__sign">
    <div class="next-steps__line"><span>Ardynt Labs &middot; Portal Audit</span><span>${esc(data.meta.portalName)} &middot; ${esc(data.meta.instanceBase)}</span></div>
  </div>
</section>`;
}
