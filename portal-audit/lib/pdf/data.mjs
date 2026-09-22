// Shapes findings/*.json into the data the PDF templates render from.
//
// Reuses lib/report.mjs's SECTIONS, SEVERITY_ORDER and sortFindings so the
// PDF is sectioned identically to report.md. Nothing here re-derives which
// phase belongs to which section a second time; that logic has one home.
//
// The one thing this module cannot derive on its own is editorial judgment:
// the exec-summary headline and the "what to do next" synthesis are a
// judgment call, same as authoring a finding is (see SKILL.md, "Author the
// Phase 1 findings yourself from the observations"). Pass a narrative object
// to supply it. Without one, buildPdfData() produces a plain, honest,
// mechanically-generated fallback and says so in `narrative.generated`, so
// the gap is visible in the output rather than silently guessed at.

import { SECTIONS, SEVERITY_ORDER, sortFindings, triageFindings } from '../report.mjs';

const GALLERY_CAP = 8;

/**
 * @param {object} args
 * @param {object[]} args.findings  every findings/*.json, raw and untriaged
 * @param {object|null} [args.runFacts]  from readRunFacts() in lib/report.mjs,
 *   supplied by bin/report-pdf.mjs. Omitted, every fact is unknown and the
 *   contradiction guard simply never fires -- it can only hold a finding back
 *   on a fact the run actually established.
 */
export function buildPdfData({ context, metadata, findings, narrative, runFacts = null }) {
  // The PDF and report.md are the same deliverable in two formats, so they must
  // hold back the same findings. This used to filter the raw array on `status`
  // alone, which meant a finding lib/report.mjs had suppressed as superseded,
  // or as contradicted by the run's own artifacts, was still published by the
  // PDF. Same function, same facts, same result: the triage rules have one home
  // in lib/report.mjs and are not re-implemented here.
  const triage = triageFindings(findings, runFacts ?? {});
  const { published, withheld, live } = triage;

  const claimed = new Set();
  const sections = SECTIONS.map((section) => {
    const rows = published.filter((f) => !claimed.has(f) && section.match(f, f._file ?? ''));
    for (const r of rows) claimed.add(r);
    const sorted = sortFindings(rows);
    const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, sorted.filter((f) => f.severity === s).length]));
    return {
      key: section.key,
      title: section.title,
      lead: section.lead ?? null,
      count: sorted.length,
      bySeverity,
      highFindings: sorted.filter((f) => f.severity === 'Critical' || f.severity === 'High'),
      tableFindings: sorted.filter((f) => f.severity !== 'Critical' && f.severity !== 'High'),
    };
  }).filter((s) => s.count > 0);

  const highFindings = [];
  for (const s of sections) for (const f of s.highFindings) highFindings.push({ finding: f, sectionTitle: s.title });

  const severityCounts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, published.filter((f) => f.severity === s).length]));

  const galleryItems = sortFindings(published.filter((f) => f.evidence_type === 'RENDERED' && f.screenshot_ref))
    .filter((f, i, arr) => arr.findIndex((g) => g.screenshot_ref === f.screenshot_ref) === i)
    .slice(0, GALLERY_CAP)
    .map((f) => ({ screenshotRef: f.screenshot_ref, caption: `${f.title} (${f.id}).` }));

  const personas = (context.personaRegistry ?? []).map((p) => p.name);

  return {
    meta: {
      portalName: context.portalName ?? context.portalSuffix,
      portalSuffix: context.portalSuffix,
      instanceBase: context.instanceBase,
      environment: metadata?.environment ?? 'environment not recorded',
      runDate: (metadata?.startedAt ?? '').slice(0, 10) || 'date not recorded',
      personas: personas.length ? personas : ['admin'],
      releaseFamily: context.releaseFamily ?? 'not determined',
    },
    totals: {
      published: published.length,
      withheld: withheld.length,
      all: findings.length,
      // Accounted for rather than silently missing: published + withheld no
      // longer adds up to `all` once triage holds something back.
      heldBack: triage.heldBack.length,
      amended: triage.amended.length,
    },
    severityCounts,
    sections,
    highFindings,
    galleryItems,
    withheldFindings: withheld.map((f) => ({ title: f.title, description: f.description })),
    // Same accounting report.md carries in its Appendix G, so the PDF is not
    // quietly shorter than the Markdown with no explanation of why. `phase`
    // rides along so the PDF's own appendix (lib/pdf/html.mjs) can render the
    // same Finding/Phase/Reason table report.md's Appendix G does.
    heldBackFindings: triage.heldBack.map((h) => ({ id: h.finding.id, title: h.finding.title, phase: h.finding.phase, kind: h.kind, detail: h.detail })),
    amendedFindings: triage.amended.map((a) => ({ id: a.finding.id, title: a.finding.title, phase: a.finding.phase, kind: a.kind, detail: a.detail })),
    runParameters: buildRunParameters({ context, metadata, findings: live }),
    narrative: resolveNarrative({ narrative, context, published, sections }),
  };
}

function buildRunParameters({ context, metadata, findings }) {
  const rows = [];
  const personas = (context.personaRegistry ?? []).map((p) => p.name);
  rows.push({
    label: 'Persona',
    detail:
      personas.length > 1
        ? `${personas.join(', ')}. Findings gated on a role are confirmed for each persona listed.`
        : 'Admin only. Any finding that depends on a role check other than admin’s own is inferred from configuration, not observed, and is captioned as such.',
  });
  if (context.domainSeparationActive === true) {
    rows.push({ label: 'Domain separation', detail: 'Active on this instance. Findings in this report may be domain-scoped without saying so; treat Service Portal results as validated only within the domain the audit ran in.' });
  } else if (context.domainSeparationActive === false) {
    rows.push({ label: 'Domain separation', detail: 'Confirmed inactive on this instance.' });
  } else {
    rows.push({ label: 'Domain separation', detail: 'Could not be confirmed either way on this instance. Treated as an open scope limitation, not asserted.' });
  }
  const usageBacked = findings.some((f) => f.evidence_type === 'USAGE');
  rows.push({
    label: 'Usage telemetry',
    detail: usageBacked
      ? 'At least one finding in this report is backed by usage telemetry; it is tagged USAGE and named in the section it appears in.'
      : 'No finding in this report is usage-backed. Adoption and reachability claims rest on configuration and rendered evidence only.',
  });
  if (context.adminUpdateXmlAccess === false) {
    rows.push({ label: 'Update-set access', detail: 'The audit credential could not read sys_update_xml. The customized out-of-box inventory is degraded as a result.' });
  }
  if (context.crawlRan === false) {
    rows.push({ label: 'Crawl coverage', detail: 'The browser phases did not run. Front-end, customization and security findings that depend on the crawl are absent, not empty.' });
  }
  return rows;
}

function resolveNarrative({ narrative, context, published, sections }) {
  if (narrative?.headline) {
    return {
      headline: narrative.headline,
      scopeNote: narrative.scopeNote ?? defaultScopeNote(context),
      nextSteps: narrative.nextSteps?.length ? narrative.nextSteps : defaultNextSteps(published),
      generated: false,
    };
  }
  const top = sortFindings(published)[0];
  const sectionCount = sections.length;
  return {
    headline: top
      ? `${top.title}, plus ${published.length - 1} more finding${published.length - 1 === 1 ? '' : 's'} across ${sectionCount} area${sectionCount === 1 ? '' : 's'}.`
      : 'No published findings this run.',
    scopeNote: defaultScopeNote(context),
    nextSteps: defaultNextSteps(published),
    // Surfaced in the PDF's own Appendix A and in bin/report-pdf.mjs's stdout,
    // so a mechanically-assembled headline is never mistaken for an
    // authored one. Pass --narrative to replace it with something sharper.
    generated: true,
  };
}

function defaultScopeNote(context) {
  return `This audit covers the ${context.portalName ?? context.portalSuffix} portal (/${context.portalSuffix}) end to end, read-only, against ${context.instanceBase}.`;
}

function defaultNextSteps(published) {
  const top = sortFindings(published).slice(0, 4);
  return top.map((f, i) => ({ title: f.title, detail: f.remediation ?? f.description }));
}
