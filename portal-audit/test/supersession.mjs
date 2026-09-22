#!/usr/bin/env node
// Offline test for the report's staleness and supersession handling.
// Run from the skill directory:  node test/supersession.mjs
//
// No ServiceNow instance and no network. Synthetic findings plus a synthetic
// run folder on disk, so the consistency guard reads real artifacts rather
// than a stubbed fact object.
//
// Covers:
//   - a finding listed in another finding's `supersedes` is excluded from the
//     assembled report, and named in Appendix G instead of vanishing;
//   - a finding whose own evidence contradicts the run's artifacts (an empty
//     screenshots directory, a crawl that never ran) is held back;
//   - the three-way domain separation renderer, especially that the
//     undetermined case never says "active";
//   - the schema side: supersedes must resolve, may not self-reference, and an
//     older finding written without the field still validates.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { makeFinding, validateFinding, validateFindings, resolveSupersessions } from '../lib/findings.mjs';
import { assembleReport, readRunFacts, triageFindings, domainSeparationNote, contradictionFor } from '../lib/report.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  }
}

const INSTANCE = 'https://dev000000.service-now.com';

function finding(over = {}) {
  return makeFinding({
    id: 'p1-001',
    phase: 1,
    title: 'A finding',
    description: 'Something was observed.',
    status: 'published',
    evidence_type: 'CONFIG',
    evidence_detail: 'sp_portal sys_id abc123',
    severity: 'Medium',
    ...over,
  });
}

const tmp = await mkdtemp(path.join(tmpdir(), 'portal-audit-supersession-'));
try {
  // -------------------------------------------------------------------
  // 1. A synthetic run folder that HAS run: 3 screenshots, a complete crawl.
  // -------------------------------------------------------------------
  await mkdir(path.join(tmp, 'screenshots'), { recursive: true });
  for (const n of ['home__desktop__admin.png', 'home__mobile__admin.png', 'kb__desktop__admin.png']) {
    await writeFile(path.join(tmp, 'screenshots', n), 'not really a png', 'utf8');
  }
  await writeFile(
    path.join(tmp, 'crawl-state.admin.json'),
    JSON.stringify({ status: 'complete', frontier: [], visited: { a: 1, b: 1, c: 1, d: 1 } }),
    'utf8',
  );

  const facts = await readRunFacts({ root: tmp });
  check('run facts count the screenshots on disk', facts.screenshotCount === 3, JSON.stringify(facts));
  check('run facts see a completed crawl', facts.crawlRan === true && facts.crawlVisited === 4, JSON.stringify(facts));

  // -------------------------------------------------------------------
  // 2. Supersession excludes the superseded finding from assembly.
  // -------------------------------------------------------------------
  const stale = finding({
    id: 'p1-s02-target',
    title: "Employee Center's Search Profile is unpublished",
    description: 'The portal points at a Search Application whose profile was never published.',
  });
  const correction = finding({
    id: 'p1-s02',
    title: 'Correction: Employee Center uses its own Search Application and its Search Profile is published',
    description: 'Read directly from the portal record, the profile is Published. The earlier statement is wrong.',
    supersedes: ['p1-s02-target'],
  });
  const untouched = finding({ id: 'p1-003', title: 'An unrelated finding that must survive' });

  const resolved = resolveSupersessions([stale, correction, untouched]);
  check('the superseded id resolves to its superseder', resolved.supersededBy.get('p1-s02-target')?.[0] === 'p1-s02');
  check('nothing dangles when the target exists', resolved.dangling.length === 0);

  const context = {
    instanceBase: INSTANCE,
    portalSuffix: 'esc',
    portalName: 'Employee Center',
    portalSysId: 'abc',
    personaRegistry: [{ name: 'admin', description: 'audit credential', acquisition: 'direct', underlying_user: 'auditor', effective_roles: ['admin'] }],
    adminOnlyRun: true,
  };
  const metadata = { startedAt: '2026-09-11', environment: 'non-production', authorization: { confirmed: true } };

  const markdown = await assembleReport({
    runFolder: { root: tmp },
    metadata,
    context,
    findings: [
      { ...stale, _file: 'phase-1-search.json' },
      { ...correction, _file: 'phase-1-search.json' },
      { ...untouched, _file: 'phase-1-config.json' },
    ],
  });

  // Appendix G deliberately names a held-back finding, so "excluded" means
  // excluded from the report body, not erased from the document.
  const body = (md) => md.slice(0, md.indexOf('## Appendices'));
  check('the superseded finding is not rendered in the report body', !body(markdown).includes(stale.title));
  check('the correction itself is still rendered', markdown.includes(correction.title));
  check('the unrelated finding is untouched', markdown.includes(untouched.title));
  check('the superseded finding is accounted for in Appendix G', markdown.includes('### G. Findings held back or amended before assembly'));
  check('Appendix G names the superseder', /superseded by `?p1-s02`?/.test(markdown) || markdown.includes('superseded by p1-s02'));
  check('the assembled report still has no em dashes', !/[—–]/.test(markdown));

  // -------------------------------------------------------------------
  // 3. The consistency guard catches a finding contradicted by the run.
  // -------------------------------------------------------------------
  const p7013 = finding({
    id: 'p7-013',
    phase: 7,
    title: 'Rendered-presence evidence withheld: the Phase 5 crawl has not run',
    description: 'Presence on rendered pages produced no evidence because the crawl has not run in this audit.',
    status: 'withheld',
    evidence_detail: 'No Phase 5 crawl inventory exists in this run folder; the screenshots directory is empty.',
    severity: 'Informational',
    persona: 'admin',
    caveat: 'Recorded as a withheld placeholder rather than omitted.',
    remediation: 'Run the Phase 5 crawl and re-derive the configured-versus-surfaced split.',
  });

  const clash = contradictionFor(p7013, facts);
  check('the guard flags the contradicted finding', clash !== null, JSON.stringify(clash));
  check('the guard names the artifact that disproves it', /screenshot|visited/.test(clash?.fact ?? ''), clash?.fact);

  const guarded = await assembleReport({
    runFolder: { root: tmp },
    metadata,
    context,
    findings: [{ ...p7013, _file: 'phase-7-ecpro.json' }, { ...untouched, _file: 'phase-1-config.json' }],
  });
  check('the contradicted finding is kept out of the report body', !body(guarded).includes(p7013.title));
  check('the contradicted finding is named in Appendix G', guarded.includes('`p7-013`'));

  // A stale claim in the caveat alone amends the caveat, it does not discard
  // the finding: the substance (no reportee data) is independent of the crawl.
  const staleCaveatOnly = finding({
    id: 'p7-010',
    phase: 7,
    title: 'Organization chart page is configured with no reportee data behind it',
    description: 'The org chart widget is placed but the backing table is empty.',
    evidence_detail: 'sp_instance places the widget; the reportee table holds zero rows.',
    caveat: 'Crawl-presence evidence is not available: the Phase 5 browser crawl has not run in this audit.',
  });
  const amendedTriage = triageFindings([staleCaveatOnly], facts);
  check('a stale caveat does not discard the finding', amendedTriage.live.length === 1 && amendedTriage.heldBack.length === 0);
  check('the stale caveat is recorded as amended', amendedTriage.amended.length === 1);
  check('the stale caveat text is replaced', !amendedTriage.live[0].caveat.includes('has not run'));
  check('the replacement names the contradicting fact', /screenshot|visited/.test(amendedTriage.live[0].caveat));
  check('the source finding object is not mutated', staleCaveatOnly.caveat.includes('has not run'));

  const amendedReport = await assembleReport({
    runFolder: { root: tmp },
    metadata,
    context,
    findings: [{ ...staleCaveatOnly, _file: 'phase-7-ecpro.json' }],
  });
  check('the amended finding is still published in the body', body(amendedReport).includes(staleCaveatOnly.title));
  check('the report body never carries the disproved claim', !body(amendedReport).includes('the Phase 5 browser crawl has not run'));

  // A remediation that says "run the Phase 5 crawl" must not trip the guard.
  const fineFinding = finding({
    id: 'p8-019',
    phase: 8,
    title: "Custom widget 'promo_banner' not reachable from any crawled page",
    description: "This widget sits on a page that was never reached in the Phase 5 crawl.",
    remediation: 'Run the Phase 5 crawl again after fixing the menu link.',
  });
  check('a normal crawl-referencing finding is not flagged', contradictionFor(fineFinding, facts) === null);

  // -------------------------------------------------------------------
  // 4. On a run where the crawl really did not run, the guard stays quiet.
  // -------------------------------------------------------------------
  const emptyRun = await mkdtemp(path.join(tmpdir(), 'portal-audit-empty-'));
  await mkdir(path.join(emptyRun, 'screenshots'), { recursive: true });
  const emptyFacts = await readRunFacts({ root: emptyRun });
  check('an empty run reports zero screenshots and no crawl', emptyFacts.screenshotCount === 0 && emptyFacts.crawlRan === null);
  check('the same finding passes on a run that really did not crawl', contradictionFor(p7013, emptyFacts) === null);
  await rm(emptyRun, { recursive: true, force: true });

  // -------------------------------------------------------------------
  // 5. Every finding is accounted for, including an unrecognized status.
  // -------------------------------------------------------------------
  const oddStatus = { ...finding({ id: 'p2-001', phase: 2 }), status: 'draft' };
  const triage = triageFindings([stale, correction, untouched, oddStatus], facts);
  check('triage keeps the live findings only', triage.live.length === 2);
  check('triage accounts for every finding', triage.live.length + triage.heldBack.length === 4);
  check(
    'an unrecognized status is held back by name, not silently dropped',
    triage.heldBack.some((h) => h.finding.id === 'p2-001' && h.kind === 'unrecognized-status'),
  );

  // Mutual supersession cancels out rather than deleting both sides.
  const a = finding({ id: 'm-a', supersedes: ['m-b'] });
  const b = finding({ id: 'm-b', supersedes: ['m-a'] });
  const mutual = resolveSupersessions([a, b]);
  check('mutual supersession is reported as a conflict', mutual.conflicts.length === 1);
  check('neither side of a mutual supersession is dropped', triageFindings([a, b], facts).live.length === 2);

  // -------------------------------------------------------------------
  // 6. Domain separation renders three distinct states (Bug 2).
  // -------------------------------------------------------------------
  const yes = domainSeparationNote(true);
  const no = domainSeparationNote(false);
  const unknown = domainSeparationNote('unknown');
  check('true says domain separation appears active', /appears active/.test(yes));
  check('false says it is inactive', /inactive/.test(no));
  check('the three states render differently', yes !== no && no !== unknown && yes !== unknown);
  check('unknown never claims active or not active', !/active/i.test(unknown), unknown);
  check('unknown says it could not be determined', /could not be determined/.test(unknown));
  check('undefined is treated as undetermined, never as active', domainSeparationNote(undefined) === unknown);
  check('null is treated as undetermined', domainSeparationNote(null) === unknown);

  const unknownReport = await assembleReport({
    runFolder: { root: tmp },
    metadata,
    context: { ...context, domainSeparationActive: 'unknown' },
    findings: [{ ...untouched, _file: 'phase-1-config.json' }],
  });
  check('the assembled report carries the undetermined wording', unknownReport.includes('could not be determined'));
  check('the assembled report does not assert domain separation', !unknownReport.includes('domain separation appears active'));

  // -------------------------------------------------------------------
  // 7. Schema validation of supersedes (rule 7).
  // -------------------------------------------------------------------
  const ctx = { personas: ['admin'], portalBase: `${INSTANCE}/esc` };
  check('a finding with a resolvable supersedes passes', validateFindings([stale, correction], ctx).ok);

  const selfRef = finding({ id: 'p1-009', supersedes: ['p1-009'] });
  check(
    'a finding cannot supersede itself',
    validateFinding(selfRef, { ...ctx, knownFindingIds: ['p1-009'], knownFindingIdsComplete: true }).errors.some((e) =>
      e.includes('cannot supersede itself'),
    ),
  );

  const dangling = finding({ id: 'p1-010', supersedes: ['p9-999'] });
  const strict = validateFinding(dangling, { ...ctx, knownFindingIds: ['p1-010'], knownFindingIdsComplete: true });
  check('a supersedes pointing at no finding in the run is rejected', strict.errors.some((e) => e.includes('does not match any finding id')));

  const loose = validateFindings([dangling], ctx);
  check('with only one phase file in scope it is a warning, not a hard error', loose.ok && loose.results[0].warnings.length === 1);

  const notArray = { ...finding({ id: 'p1-011' }), supersedes: 'p1-001' };
  check('supersedes must be an array', validateFinding(notArray, ctx).errors.some((e) => e.includes('must be an array of finding ids')));

  // Backwards compatibility: findings written before the field existed.
  const legacy = finding({ id: 'p1-012' });
  delete legacy.supersedes;
  check('a finding written without supersedes still validates', validateFinding(legacy, ctx).errors.length === 0, JSON.stringify(validateFinding(legacy, ctx).errors));

  // -------------------------------------------------------------------
  // 8. ctx.instanceHost is actually read now (Bug 4).
  // -------------------------------------------------------------------
  const foreign = finding({
    id: 'p1-013',
    record_refs: [{ sp_portal: 'abc123' }],
    url: 'https://someone-elses-instance.service-now.com/now/nav/ui/classic/params/target/sp_portal.do%3Fsys_id%3Dabc123',
  });
  check(
    'a url pointing at another instance is rejected',
    validateFinding(foreign, { personas: ['admin'], instanceHost: 'dev000000.service-now.com' }).errors.some((e) =>
      e.includes("is not this run's instance"),
    ),
  );
  const ours = { ...foreign, url: `${INSTANCE}/now/nav/ui/classic/params/target/sp_portal.do%3Fsys_id%3Dabc123` };
  check('a url on this run\'s instance passes', validateFinding(ours, { personas: ['admin'], instanceHost: 'dev000000.service-now.com' }).errors.length === 0);
  check(
    'the host check also works from portalBase alone',
    validateFinding(foreign, ctx).errors.some((e) => e.includes("is not this run's instance")),
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write('\nFailures:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.exit(failed === 0 ? 0 : 1);
