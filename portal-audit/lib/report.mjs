// Report assembly. See reference/15-report-model.md.
//
// Ordered by client value, not by audit sequence. The audit runs 0 to 10; the
// report does not. Regenerating report.md never touches the instance, because
// findings/*.json already holds structured, evidence-tagged findings.
//
// Style: no em dashes anywhere in generated output.

import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { STATUSES, resolveSupersessions } from './findings.mjs';

export const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Informational'];
export const EVIDENCE_WEIGHT = { CONFIG: 0, RENDERED: 1, USAGE: 2, INFERRED: 3 };

// Exported so bin/report-pdf.mjs (lib/pdf/data.mjs) sections the PDF exactly
// the way report.md is sectioned, instead of re-deriving the same phase and
// filename rules a second time and risking the two drifting apart.
export const SECTIONS = [
  {
    key: 'customization',
    title: 'Customized out-of-box records',
    lead:
      'The bucket 3 list from Phase 8. Highest priority, because it is concrete, quantifiable and directly tied to upgrade cost. ' +
      'Bucket 2 (custom records, including clones) is reported separately and is not the same problem.',
    match: (f) => f.phase === 8,
  },
  {
    key: 'visibility',
    title: 'Content visibility and taxonomy governance',
    lead: 'Phases 3 and 4. Critical findings first, notably topics with user criteria enabled and both criteria fields empty.',
    match: (f) => f.phase === 3 || f.phase === 4,
  },
  {
    key: 'search',
    title: 'Search health',
    lead: 'Reported under Phase 1 of the audit sequence.',
    match: (f, file) => f.phase === 1 && /search/i.test(file),
  },
  {
    key: 'experience',
    title: 'Experience and accessibility',
    lead: 'Phase 6, per unique page template. Out-of-box widget failures are separated from custom widget failures, because the remediation owner differs.',
    match: (f) => f.phase === 6,
  },
  {
    key: 'security',
    title: 'Performance and security',
    lead: 'Phase 9. Public exposure is configuration evidence only, in every run; there is no logged-out persona in this audit model.',
    match: (f) => f.phase === 9,
  },
  {
    key: 'adoption',
    title: 'Feature adoption',
    lead: 'Phase 7. Employee Center versus Employee Center Pro, used versus unused, determined from evidence rather than installation state.',
    match: (f) => f.phase === 7,
  },
  {
    key: 'configuration',
    title: 'Portal configuration, theme and reachability',
    lead: 'Phases 0, 1 and 2 configuration context, plus the Phase 5 crawl findings.',
    match: (f) => [0, 1, 2, 5].includes(f.phase),
  },
];

export async function loadAllFindings(runFolder) {
  const files = await runFolder.findingsFiles();
  const all = [];
  for (const file of files) {
    const rows = await runFolder.readJson(path.join(runFolder.findingsDir, file), []);
    for (const f of rows ?? []) all.push({ ...f, _file: file });
  }
  return all;
}

export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (s !== 0) return s;
    const e = (EVIDENCE_WEIGHT[a.evidence_type] ?? 9) - (EVIDENCE_WEIGHT[b.evidence_type] ?? 9);
    if (e !== 0) return e;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Match findings across runs by record_refs, never by id.
 *
 * Keyed by an array-valued Map, not a single finding per key: two distinct
 * findings can legitimately share the same record_refs (two different
 * problems on the same widget, say). A plain `Map.set` here would let the
 * second silently overwrite the first, dropping it from the comparison
 * entirely rather than reporting it as resolved, added or still open.
 */
export function compareRuns(current, prior) {
  const keyOf = (f) =>
    (f.record_refs ?? [])
      .map((r) => Object.entries(r)[0])
      .filter(Boolean)
      .map(([t, s]) => `${t}:${s}`)
      .sort()
      .join('+');

  function group(findings) {
    const map = new Map();
    const notComparable = [];
    for (const f of findings) {
      const k = keyOf(f);
      if (!k) {
        notComparable.push(f);
        continue;
      }
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(f);
    }
    return { map, notComparable };
  }

  const { map: curKeyed, notComparable } = group(current);
  const { map: priorKeyed } = group(prior);

  const resolved = [];
  const added = [];
  const stillOpen = [];
  for (const [k, priorList] of priorKeyed) {
    if (!curKeyed.has(k)) resolved.push(...priorList);
  }
  for (const [k, curList] of curKeyed) {
    const priorList = priorKeyed.get(k);
    if (!priorList) {
      added.push(...curList);
      continue;
    }
    // Same key on both sides: pair up positionally rather than assuming
    // exactly one finding per side. Extras past the shorter list's length
    // fall back to added / resolved rather than being dropped.
    const n = Math.min(curList.length, priorList.length);
    for (let i = 0; i < n; i += 1) stillOpen.push({ current: curList[i], prior: priorList[i] });
    for (let i = n; i < curList.length; i += 1) added.push(curList[i]);
    for (let i = n; i < priorList.length; i += 1) resolved.push(priorList[i]);
  }
  return { resolved, added, stillOpen, notComparable };
}

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/**
 * Read the few facts about the run that the assembler can check a finding's own
 * claims against, straight off disk. Cheap: a directory listing and at most a
 * couple of small JSON reads, all of which already exist by Phase 10.
 *
 * Every field is null when it could not be established, and null never
 * contradicts anything. The guard only ever fires on a fact we actually have.
 *
 * @param {{root?: string, screenshotsDir?: string, crawlStatePath?: string}} runFolder
 */
export async function readRunFacts(runFolder) {
  const root = runFolder?.root ?? null;
  const facts = { screenshotCount: null, crawlRan: null, crawlStatus: null, crawlVisited: null };
  if (!root) return facts;

  const screenshotsDir = runFolder.screenshotsDir ?? path.join(root, 'screenshots');
  try {
    const names = await readdir(screenshotsDir);
    facts.screenshotCount = names.filter((n) => IMAGE_FILE.test(n)).length;
  } catch {
    facts.screenshotCount = null;
  }

  // Per-persona crawl state lives in crawl-state.<persona>.json alongside the
  // combined crawl-state.json, so take every one of them, not just the default.
  let stateFiles = [];
  try {
    stateFiles = (await readdir(root)).filter((n) => /^crawl-state(\.[\w-]+)?\.json$/.test(n));
  } catch {
    stateFiles = [];
  }
  // The largest single state file, not the sum: the combined crawl-state.json
  // and the per-persona crawl-state.<persona>.json record the same crawl, so
  // adding them would report a node count no crawl ever produced.
  let visited = 0;
  let sawState = false;
  const statuses = [];
  for (const name of stateFiles) {
    let state;
    try {
      state = JSON.parse(await readFile(path.join(root, name), 'utf8'));
    } catch {
      continue;
    }
    sawState = true;
    if (state?.status) statuses.push(String(state.status));
    const v = state?.visited;
    let count = 0;
    if (Array.isArray(v)) count = v.length;
    else if (v && typeof v === 'object') count = Object.keys(v).length;
    else if (Array.isArray(state?.pageInventory)) count = state.pageInventory.length;
    visited = Math.max(visited, count);
  }
  if (sawState) {
    facts.crawlVisited = visited;
    facts.crawlStatus = statuses.length ? [...new Set(statuses)].join(', ') : null;
    facts.crawlRan = visited > 0 || statuses.some((s) => /complete|running|resum/i.test(s));
  }
  return facts;
}

/**
 * Claims a finding can make about the run itself that the run's own artifacts
 * can immediately falsify.
 *
 * This is deliberately not a general fact-checker. It is a short list of
 * self-referential claims ("the crawl has not run", "the screenshots directory
 * is empty") that a sub-agent working with partial visibility has actually
 * written into a delivered report while the artifacts sat on disk saying
 * otherwise. `remediation` is not scanned, because a perfectly good remediation
 * reads "run the Phase 5 crawl".
 */
export const CONTRADICTION_CHECKS = [
  {
    key: 'screenshots-empty',
    claim: /\bscreenshots?\s+(directory|folder|dir)\s+is\s+empty\b|\bno\s+screenshots?\s+(were\s+|have\s+been\s+)?(taken|captured|exist|were\s+saved)\b/i,
    contradicted: (facts) => typeof facts.screenshotCount === 'number' && facts.screenshotCount > 0,
    explain: (facts) => `the run folder holds ${facts.screenshotCount} screenshot files`,
  },
  {
    key: 'crawl-not-run',
    claim:
      /\bcrawl\s+(has\s+not|did\s+not|was\s+not|never)\s+(yet\s+)?(run|ran|execute[d]?|happen(ed)?)\b|\bno\s+(phase\s*5\s+)?crawl\s+(inventory|data|state|results?|output)\s+exists\b|\bthe\s+(browser\s+)?crawl\s+has\s+not\s+run\b/i,
    contradicted: (facts) => facts.crawlRan === true,
    explain: (facts) =>
      `crawl state records ${facts.crawlVisited} visited nodes${facts.crawlStatus ? `, status "${facts.crawlStatus}"` : ''}`,
  },
];

// Order matters. A contradiction in one of the first three fields is the
// finding itself being false. A contradiction in `caveat` alone means the
// finding may still stand and only its qualifier went stale, so the two are
// handled differently below.
const SUBSTANTIVE_FIELDS = ['title', 'description', 'evidence_detail'];
const CLAIM_FIELDS = [...SUBSTANTIVE_FIELDS, 'caveat'];

/**
 * @returns {null | {key: string, field: string, fact: string, substantive: boolean}}
 */
export function contradictionFor(finding, facts) {
  for (const field of CLAIM_FIELDS) {
    const value = finding?.[field];
    if (typeof value !== 'string') continue;
    for (const check of CONTRADICTION_CHECKS) {
      if (!check.contradicted(facts)) continue;
      if (!check.claim.test(value)) continue;
      return { key: check.key, field, fact: check.explain(facts), substantive: SUBSTANTIVE_FIELDS.includes(field) };
    }
  }
  return null;
}

/**
 * Split every finding into what the report body may carry and what it may not,
 * accounting for all of them. Nothing is dropped without a recorded reason.
 *
 * Three things get held back:
 *   - a finding another finding lists in its `supersedes` array, because the
 *     correction and the thing it corrects cannot both be true;
 *   - a finding whose own title, description or evidence is contradicted by
 *     this run's artifacts, because the finding is then about a gap that did
 *     not happen;
 *   - a finding whose `status` is neither published nor withheld. Filtering on
 *     `status` alone used to make such a finding vanish from the report with no
 *     trace that it existed.
 *
 * A finding whose `caveat` alone is contradicted is a separate, lighter case:
 * the finding stands and only its qualifier went stale, so it is published with
 * the stale caveat replaced rather than dropped wholesale. The original text
 * stays in findings/*.json either way; nothing is edited at source.
 */
export function triageFindings(findings, facts) {
  const { supersededBy, dangling, conflicts } = resolveSupersessions(findings);
  const live = [];
  const heldBack = [];
  const amended = [];

  for (const f of findings) {
    const supersedes = supersededBy.get(f.id);
    if (supersedes?.length) {
      heldBack.push({ finding: f, kind: 'superseded', detail: `superseded by ${supersedes.join(', ')}` });
      continue;
    }
    if (!STATUSES.includes(f.status)) {
      heldBack.push({ finding: f, kind: 'unrecognized-status', detail: `status "${f.status}" is not published or withheld` });
      continue;
    }
    const clash = contradictionFor(f, facts);
    if (clash?.substantive) {
      heldBack.push({
        finding: f,
        kind: 'contradicted',
        detail: `its ${clash.field} claims something this run's own artifacts disprove (${clash.fact})`,
      });
      continue;
    }
    if (clash) {
      const replacement =
        'The caveat written with this finding described a gap in this run that the run itself disproves ' +
        `(${clash.fact}). It was replaced at assembly rather than published. The original wording is in ` +
        'findings/, and the substance of the finding above is unaffected. See Appendix G.';
      amended.push({ finding: f, kind: 'stale-caveat', detail: `its caveat was replaced (${clash.fact})` });
      live.push({ ...f, caveat: replacement });
      continue;
    }
    live.push(f);
  }

  return {
    live,
    heldBack,
    amended,
    dangling,
    conflicts,
    published: live.filter((f) => f.status === 'published'),
    withheld: live.filter((f) => f.status === 'withheld'),
  };
}

/**
 * Three distinct states, never collapsed into two. `true` and `false` are
 * answers; anything else, including the literal 'unknown' that bin/phase0.mjs
 * records when the sys_domain probe fails, means the question was not answered
 * and must not be asserted in either direction. Reporting an unanswered probe
 * as "appears active" was a scope limitation invented out of a failed query.
 */
export function domainSeparationNote(value) {
  if (value === true) {
    return (
      '- **Scope limitation**: domain separation appears active on this instance. Service Portal behavior under domain ' +
      "separation is outside this audit's validated scope; findings may be domain-scoped without saying so."
    );
  }
  if (value === false) {
    return '- **Domain separation**: confirmed inactive on this instance, so no finding here is domain-scoped.';
  }
  return (
    '- **Scope limitation**: the domain-separation status of this instance could not be determined during this run, ' +
    'because the probe behind it did not return an answer. It is neither confirmed nor ruled out, and nothing in this ' +
    'report should be read as a statement either way. Confirm it directly before relying on the scope of any finding.'
  );
}

export async function assembleReport({ runFolder, metadata, context, findings, comparison = null, inventory = null, runFacts = null }) {
  const facts = runFacts ?? (await readRunFacts(runFolder));
  const triage = triageFindings(findings, facts);
  const { published, withheld, live } = triage;
  const out = [];

  out.push(`# Service Portal audit: ${context.portalName ?? context.portalSuffix}`);
  out.push('');
  out.push(execSummary({ metadata, context, published, withheld, findings, triage }));

  if (comparison) out.push(comparisonSection(comparison));

  // Matching is exclusive, in SECTIONS array order: whichever section a
  // finding hits FIRST claims it. Without this, a phase-1 finding whose
  // filename contains "search" (agents/search-agent.md's own --slug
  // convention) matched both the "search" section's narrower rule and
  // "configuration"'s broader `[0,1,2,5].includes(phase)` catch-all, and got
  // rendered in full, twice. "search" is listed before "configuration" for
  // exactly this reason: claim the narrower match first.
  const claimed = new Set();
  for (const section of SECTIONS) {
    const rows = published.filter((f) => !claimed.has(f) && section.match(f, f._file ?? ''));
    for (const r of rows) claimed.add(r);
    const heldRows = withheld.filter((f) => !claimed.has(f) && section.match(f, f._file ?? ''));
    for (const r of heldRows) claimed.add(r);
    if (rows.length === 0 && heldRows.length === 0) continue;
    out.push(renderSection(section, rows, heldRows));
  }

  // Orphans are drawn from `live`, not from every finding: a superseded or
  // contradicted finding must not reappear here through the catch-all after
  // being held back from the sections above.
  const orphaned = live.filter((f) => !claimed.has(f));
  if (orphaned.length) {
    out.push(
      renderSection(
        { title: 'Other findings', lead: 'Findings that did not map to a named report section.' },
        orphaned.filter((f) => f.status === 'published'),
        orphaned.filter((f) => f.status === 'withheld'),
      ),
    );
  }

  out.push(appendices({ context, metadata, findings, inventory, triage, facts }));
  return out.join('\n');
}

function execSummary({ metadata, context, published, withheld, findings, triage }) {
  const top = sortFindings(published).slice(0, 3);
  const personas = (context.personaRegistry ?? []).map((p) => p.name);
  const counts = SEVERITY_ORDER.map((s) => `${s}: ${published.filter((f) => f.severity === s).length}`).join(', ');

  const lines = [];
  lines.push('## Executive summary');
  lines.push('');
  lines.push(`- **Portal**: ${context.portalName ?? '(unnamed)'} (\`/${context.portalSuffix}\`), sys_id \`${context.portalSysId}\``);
  lines.push(`- **Instance**: ${context.instanceBase} (${metadata?.environment ?? 'environment not recorded'})`);
  lines.push(`- **Release family**: ${context.releaseFamily ?? 'not determined'}`);
  lines.push(`- **Audited as**: ${personas.length ? personas.join(', ') : 'admin'}`);
  lines.push(`- **Run date**: ${metadata?.startedAt ?? 'unknown'}`);
  lines.push(`- **Authorization**: ${metadata?.authorization?.confirmed ? 'confirmed by the operator' : 'NOT CONFIRMED'}${metadata?.authorization?.note ? ` (${metadata.authorization.note})` : ''}`);
  const heldBack = triage?.heldBack ?? [];
  const amended = triage?.amended ?? [];
  const guardNote = [
    heldBack.length ? `${heldBack.length} held back` : null,
    amended.length ? `${amended.length} amended` : null,
  ].filter(Boolean);
  lines.push(
    `- **Findings**: ${published.length} published, ${withheld.length} withheld` +
      `${guardNote.length ? `, ${guardNote.join(' and ')} before assembly (see Appendix G)` : ''}. ${counts}`,
  );
  if (context.adminUpdateXmlAccess === false) {
    lines.push(
      '- **Access limitation**: the audit credential could not read `sys_update_xml`. Phase 8, the customized out-of-box inventory, is degraded. This was known at Phase 0, not discovered at the end.',
    );
  }
  lines.push(domainSeparationNote(context.domainSeparationActive));
  if (context.crawlRan === false) {
    lines.push(
      '- **Scope limitation**: the browser phases (5 and 6) did not run. Phases 6, 8 and 9 are reported from platform data only, and their crawl-dependent parts are absent rather than empty.',
    );
  }
  lines.push('');
  lines.push('### The three findings that matter most');
  lines.push('');
  if (top.length === 0) lines.push('No published findings.');
  for (const f of top) {
    lines.push(`1. **${f.title}** (${f.severity}, ${f.evidence_type}). ${f.description}`);
  }
  lines.push('');
  return lines.join('\n');
}

function comparisonSection({ resolved, added, stillOpen, notComparable }) {
  const lines = ['## Progress since last audit', ''];
  lines.push('Findings are matched across runs by `record_refs`, never by `id`, since `id` is only a sequence number within one run.');
  lines.push('');
  lines.push(`### Resolved (${resolved.length})`);
  lines.push('');
  for (const f of sortFindings(resolved)) lines.push(`- ${f.title} (was ${f.severity})`);
  if (!resolved.length) lines.push('None.');
  lines.push('');
  lines.push(`### New (${added.length})`);
  lines.push('');
  for (const f of sortFindings(added)) lines.push(`- ${f.title} (${f.severity})`);
  if (!added.length) lines.push('None.');
  lines.push('');
  lines.push(`### Still open (${stillOpen.length})`);
  lines.push('');
  for (const pair of stillOpen) lines.push(`- ${pair.current.title} (${pair.current.severity}; was ${pair.prior.severity} last run)`);
  if (!stillOpen.length) lines.push('None.');
  lines.push('');
  lines.push(`### Not comparable (${notComparable.length})`);
  lines.push('');
  lines.push('Cross-cutting findings with no backing record, which cannot be matched across runs. Not defaulted into "new".');
  lines.push('');
  for (const f of sortFindings(notComparable)) lines.push(`- ${f.title} (${f.severity})`);
  if (!notComparable.length) lines.push('None.');
  lines.push('');
  return lines.join('\n');
}

function renderSection(section, rows, heldRows = []) {
  const lines = [`## ${section.title}`, ''];
  if (section.lead) {
    lines.push(section.lead);
    lines.push('');
  }
  for (const f of sortFindings(rows)) lines.push(renderFinding(f));
  if (heldRows.length) {
    lines.push('### Withheld');
    lines.push('');
    for (const f of heldRows) lines.push(renderFinding(f));
  }
  return lines.join('\n');
}

function renderFinding(f) {
  const lines = [];
  const tags = [f.severity, f.evidence_type];
  if (f.persona) tags.push(`as ${f.persona}`);
  if (f.portal_scope === 'shared') tags.push(f.shared_with?.length ? `shared with ${f.shared_with.join(', ')}` : 'shared, portals unconfirmed');
  if (f.tier) tags.push(`blast radius tier ${f.tier}`);
  if (f.status === 'withheld') tags.push('WITHHELD');
  if (f.write_exception_used) tags.push(`write exception: ${f.write_exception_used}`);

  lines.push(`### ${f.title}`);
  lines.push('');
  lines.push(`\`${f.id}\` | ${tags.join(' | ')}`);
  lines.push('');
  lines.push(f.description);
  lines.push('');
  if (f.quantification) {
    const q = f.quantification;
    lines.push(`**Quantification**: ${q.count}${q.of_total !== null && q.of_total !== undefined ? ` of ${q.of_total}` : ''} ${q.unit}`);
    lines.push('');
  }
  lines.push(`**Evidence**: ${f.evidence_detail}`);
  if (f.url) lines.push(`  \n**Record**: ${f.url}`);
  lines.push('');
  if (f.screenshot_ref) {
    lines.push(`![${f.title}](${f.screenshot_ref})`);
    lines.push('');
  }
  if (f.caveat) {
    lines.push(`**Caveat**: ${f.caveat}`);
    lines.push('');
  }
  if (f.remediation) {
    lines.push(`**Remediation**: ${f.remediation}`);
    lines.push('');
  }
  return lines.join('\n');
}

function appendices({ context, metadata, findings, inventory, triage = null, facts = null }) {
  const lines = ['## Appendices', ''];

  lines.push('### A. Personas used');
  lines.push('');
  lines.push('| Name | Description | Acquisition | Underlying user | Effective roles |');
  lines.push('|---|---|---|---|---|');
  for (const p of context.personaRegistry ?? []) {
    lines.push(
      `| ${p.name} | ${p.description ?? ''} | ${p.acquisition ?? ''} | ${p.underlying_user ?? ''} | ${(p.effective_roles ?? []).slice(0, 12).join(', ')}${(p.effective_roles ?? []).length > 12 ? ', ...' : ''} |`,
    );
  }
  lines.push('');

  lines.push('### B. Evidence typing');
  lines.push('');
  lines.push('| Tag | Meaning | Challenge resistance |');
  lines.push('|---|---|---|');
  lines.push('| CONFIG | Read from a platform record | High. Show the record |');
  lines.push('| RENDERED | Observed in a browser as a named persona | Medium. Reproducible if persona is recorded |');
  lines.push('| USAGE | Derived from Usage Insights or sp_log | Medium. Depends on telemetry being enabled |');
  lines.push('| INFERRED | Reasoned from the above | Low. Say so, and say what would confirm it |');
  lines.push('');

  if (inventory?.pageInventory?.length) {
    lines.push(`### C. Page inventory (${inventory.pageInventory.length} nodes)`);
    lines.push('');
    lines.push('| Page ID | Title | Depth | Reached from | Outcome | Route mapped | Persona |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const p of inventory.pageInventory.slice(0, 500)) {
      lines.push(
        `| ${p.pageId ?? '(default)'} | ${(p.title ?? '').replace(/\|/g, '/')} | ${p.depth} | ${p.reachedFrom} | ${p.outcome} | ${p.routeMapped ? `yes, to ${p.actualPageId}` : 'no'} | ${p.persona} |`,
      );
    }
    lines.push('');
  }

  if (inventory?.widgetInventory?.length) {
    const byWidget = new Map();
    for (const w of inventory.widgetInventory) {
      const k = w.widgetId ?? w.cssId ?? 'unknown';
      if (!byWidget.has(k)) byWidget.set(k, { widgetId: k, pages: new Set(), placements: 0, runtime: 0 });
      const e = byWidget.get(k);
      e.pages.add(w.hostPageId);
      e.placements += 1;
      if (w.placement === 'runtime_getWidget') e.runtime += 1;
    }
    lines.push(`### D. Widget inventory (${byWidget.size} distinct widgets)`);
    lines.push('');
    lines.push('| Widget | Pages | Placements | Runtime embedded via getWidget |');
    lines.push('|---|---|---|---|');
    for (const e of [...byWidget.values()].sort((a, b) => b.placements - a.placements)) {
      lines.push(`| ${e.widgetId} | ${e.pages.size} | ${e.placements} | ${e.runtime} |`);
    }
    lines.push('');
  }

  lines.push('### E. Run artifacts');
  lines.push('');
  lines.push('- `cache/` raw API responses, keyed by table plus query. The evidence trail.');
  lines.push('- `screenshots/` per template, width and persona.');
  lines.push('- `findings/` one JSON file per phase, in the findings schema.');
  lines.push('- `logs/` impersonation start and stop, write-exception use, errors and skipped items.');
  lines.push('- `crawl-state.json` frontier queue and visited nodes, for resuming.');
  lines.push('- `metadata.json` authorization confirmation, environment, timestamps.');
  lines.push('');
  lines.push(
    'Retention: cache and screenshots are kept by default, because they matter for a future re-audit comparison and for re-verifying a disputed finding. Ask before deleting them. The run folder is never committed to git.',
  );
  lines.push('');

  const errors = metadata?.errorSummary;
  if (errors) {
    lines.push('### F. Gaps and failures during this run');
    lines.push('');
    for (const [kind, count] of Object.entries(errors)) lines.push(`- ${kind}: ${count}`);
    lines.push('');
  }

  const heldBack = triage?.heldBack ?? [];
  const amended = triage?.amended ?? [];
  const dangling = triage?.dangling ?? [];
  const conflicts = triage?.conflicts ?? [];
  if (heldBack.length || amended.length || dangling.length || conflicts.length) {
    lines.push('### G. Findings held back or amended before assembly');
    lines.push('');
    lines.push(
      'These were written during the run and then changed on the way into the report. They are named here rather than ' +
        'deleted, so the evidence trail shows what was set aside and why. Nothing in findings/ was edited.',
    );
    lines.push('');
    if (heldBack.length) {
      lines.push('Kept out of the report body:');
      lines.push('');
      lines.push('| Finding | Phase | Reason |');
      lines.push('|---|---|---|');
      for (const h of heldBack) {
        lines.push(`| \`${h.finding.id}\` ${String(h.finding.title ?? '').replace(/\|/g, '/')} | ${h.finding.phase} | ${h.detail} |`);
      }
      lines.push('');
    }
    if (amended.length) {
      lines.push('Published, with a stale caveat replaced:');
      lines.push('');
      lines.push('| Finding | Phase | Reason |');
      lines.push('|---|---|---|');
      for (const h of amended) {
        lines.push(`| \`${h.finding.id}\` ${String(h.finding.title ?? '').replace(/\|/g, '/')} | ${h.finding.phase} | ${h.detail} |`);
      }
      lines.push('');
    }
    if (dangling.length) {
      lines.push('Supersessions that could not be resolved, so the finding each one claims to strike stays in the report:');
      lines.push('');
      for (const d of dangling) lines.push(`- \`${d.id}\` supersedes \`${d.missing}\`, which is not a finding in this run.`);
      lines.push('');
    }
    if (conflicts.length) {
      lines.push('Findings that each claim to supersede the other. Neither was dropped; resolve the disagreement at source:');
      lines.push('');
      for (const c of conflicts) lines.push(`- \`${c.a}\` and \`${c.b}\`.`);
      lines.push('');
    }
    if (facts) {
      lines.push(
        `Run artifacts the consistency guard checked against: ${facts.screenshotCount ?? 'unknown'} screenshots, ` +
          `crawl ${facts.crawlRan === null ? 'state not found' : facts.crawlRan ? `ran (${facts.crawlVisited} nodes visited)` : 'did not run'}.`,
      );
      lines.push('');
    }
    lines.push(
      `Total findings written this run: ${findings.length}. Carried into the report body: ${findings.length - heldBack.length}.`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

export async function readTextIfExists(p) {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}
