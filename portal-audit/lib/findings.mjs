// The one and only findings shape. Implements reference/16-findings-schema.md.
//
// Nothing else in this skill may invent a different findings shape. Every
// sub-agent writes findings that pass validateFindings() before they are
// accepted into <run>/findings/.

export const EVIDENCE_TYPES = ['CONFIG', 'RENDERED', 'USAGE', 'INFERRED'];
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational'];
export const STATUSES = ['published', 'withheld'];
export const PORTAL_SCOPES = ['single', 'shared'];
export const BLAST_RADIUS_TIERS = ['1', '2'];

export const FIELDS = [
  'id',
  'phase',
  'title',
  'description',
  'status',
  'evidence_type',
  'evidence_detail',
  'severity',
  'persona',
  'portal_scope',
  'shared_with',
  'tier',
  'record_refs',
  'url',
  'screenshot_ref',
  'write_exception_used',
  'caveat',
  'quantification',
  'remediation',
  'supersedes',
];

// Fields added to the schema after runs already existed on disk. They are part
// of FIELDS (so they are not rejected as unknown) but are not required to be
// present, so an older run's findings/*.json still validates and its report can
// still be regenerated. An absent optional field reads as its documented
// default: `supersedes` absent means "supersedes nothing".
const OPTIONAL_FIELDS = new Set(['supersedes']);

const STRING_FIELDS = [
  'id',
  'title',
  'description',
  'evidence_detail',
  'persona',
  'tier',
  'url',
  'screenshot_ref',
  'write_exception_used',
  'caveat',
  'remediation',
];

// Phases whose findings are access claims by nature.
const ACCESS_CLAIM_PHASES = new Set([5, 6]);

// Wording that signals an access claim in a phase that is not inherently one.
const ACCESS_CLAIM_WORDS =
  /\b(reachab|unreachable|visib|invisible|hidden from|not shown to|can see|cannot see|accessible to|inaccessible|rendered for)/i;

/**
 * Build a finding with every field present, so no sub-agent can omit one by
 * forgetting it. Unknown keys are rejected.
 */
export function makeFinding(input) {
  const unknown = Object.keys(input).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new Error(`Unknown finding field(s): ${unknown.join(', ')}`);
  return {
    id: input.id,
    phase: input.phase,
    title: input.title,
    description: input.description,
    status: input.status ?? 'published',
    evidence_type: input.evidence_type,
    evidence_detail: input.evidence_detail,
    severity: input.severity,
    persona: input.persona ?? null,
    portal_scope: input.portal_scope ?? 'single',
    shared_with: input.shared_with ?? [],
    tier: input.tier ?? null,
    record_refs: input.record_refs ?? [],
    url: input.url ?? null,
    screenshot_ref: input.screenshot_ref ?? null,
    write_exception_used: input.write_exception_used ?? null,
    caveat: input.caveat ?? null,
    quantification: input.quantification ?? null,
    remediation: input.remediation ?? null,
    supersedes: input.supersedes ?? [],
  };
}

/** Host of a URL-ish string, lowercased, or null if it does not parse. */
function hostOf(value) {
  if (!value) return null;
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch {
    return null;
  }
}

function toIdSet(value) {
  if (!value) return null;
  return value instanceof Set ? value : new Set(value);
}

/**
 * Validate one finding.
 *
 * @param {object} f
 * @param {object} ctx
 * @param {string[]} ctx.personas          name keys from the run persona registry
 * @param {string[]} [ctx.writeExceptions] declared exception names
 * @param {string} [ctx.instanceHost]      host of the instance under audit, e.g.
 *   acme.service-now.com. When given (or derivable from ctx.portalBase) a
 *   finding's `url` must point at this host, so a link copied from another run
 *   or another instance cannot reach the client's report (schema rule 5).
 * @param {string} [ctx.portalBase]        e.g. https://host/esc, for RENDERED urls
 * @param {Iterable<string>} [ctx.knownFindingIds] every finding id in the run,
 *   for resolving `supersedes` (schema rule 7)
 * @param {boolean} [ctx.knownFindingIdsComplete] true when knownFindingIds
 *   covers the whole run rather than one phase file. An unresolvable
 *   `supersedes` is an error when it is complete, a warning when it is not.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateFinding(f, ctx = {}) {
  const errors = [];
  const warnings = [];
  const personas = ctx.personas ?? ['admin'];
  const exceptions = ctx.writeExceptions ?? [];
  const knownIds = toIdSet(ctx.knownFindingIds);

  if (!f || typeof f !== 'object') return { errors: ['finding is not an object'], warnings };

  const unknown = Object.keys(f).filter((k) => !FIELDS.includes(k));
  if (unknown.length) errors.push(`unknown field(s): ${unknown.join(', ')}`);
  for (const field of FIELDS) {
    if (!(field in f) && !OPTIONAL_FIELDS.has(field)) errors.push(`missing field: ${field}`);
  }

  if (typeof f.id !== 'string' || !f.id.trim()) errors.push('id must be a non-empty string');
  if (!Number.isInteger(f.phase) || f.phase < 0 || f.phase > 10) {
    errors.push('phase must be an integer 0 to 10, not a range string');
  }
  if (typeof f.title !== 'string' || !f.title.trim()) errors.push('title must be a non-empty string');
  if (typeof f.title === 'string' && f.title.includes('\n')) errors.push('title must be one line');
  if (typeof f.description !== 'string' || !f.description.trim()) errors.push('description must be a non-empty string');
  if (!STATUSES.includes(f.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);
  if (!EVIDENCE_TYPES.includes(f.evidence_type)) errors.push(`evidence_type must be one of ${EVIDENCE_TYPES.join(', ')}`);
  if (typeof f.evidence_detail !== 'string' || !f.evidence_detail.trim()) {
    errors.push('evidence_detail must be a non-empty string');
  }
  if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!PORTAL_SCOPES.includes(f.portal_scope)) errors.push(`portal_scope must be one of ${PORTAL_SCOPES.join(', ')}`);
  if (!Array.isArray(f.shared_with)) errors.push('shared_with must be an array');
  if (!Array.isArray(f.record_refs)) errors.push('record_refs must be an array');
  else {
    for (const ref of f.record_refs) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 1) {
        errors.push('each record_ref must be a single {table: sys_id} pair');
      }
    }
  }
  for (const field of STRING_FIELDS) {
    const v = f[field];
    if (v !== null && v !== undefined && typeof v !== 'string') errors.push(`${field} must be a string or null`);
  }
  if (f.supersedes !== null && f.supersedes !== undefined) {
    if (!Array.isArray(f.supersedes)) {
      errors.push('supersedes must be an array of finding ids (schema rule 7)');
    } else {
      for (const target of f.supersedes) {
        if (typeof target !== 'string' || !target.trim()) {
          errors.push('each supersedes entry must be a non-empty finding id string (schema rule 7)');
          continue;
        }
        if (target === f.id) {
          errors.push('a finding cannot supersede itself (schema rule 7)');
          continue;
        }
        if (!knownIds) continue;
        if (knownIds.has(target)) continue;
        const msg =
          `supersedes "${target}" does not match any finding id in this run. ` +
          'A supersession must name a finding that exists, or the statement it claims to strike stays in the report (schema rule 7)';
        if (ctx.knownFindingIdsComplete) errors.push(msg);
        else warnings.push(`${msg}. Only this phase file's ids were in scope here; Phase 10 checks it run-wide`);
      }
    }
  }
  if (f.quantification !== null && f.quantification !== undefined) {
    const q = f.quantification;
    if (typeof q !== 'object' || Array.isArray(q)) errors.push('quantification must be an object or null');
    else if (!('count' in q) || !('of_total' in q) || !('unit' in q)) {
      errors.push('quantification must carry count, of_total and unit');
    }
  }

  // Rule 1 and 2: persona is mandatory for access claims and must resolve.
  const isAccessClaim =
    f.evidence_type === 'RENDERED' ||
    ACCESS_CLAIM_PHASES.has(f.phase) ||
    ACCESS_CLAIM_WORDS.test(`${f.title ?? ''} ${f.description ?? ''}`);
  if (isAccessClaim && (f.persona === null || f.persona === undefined || f.persona === '')) {
    if (f.evidence_type === 'RENDERED' || ACCESS_CLAIM_PHASES.has(f.phase)) {
      errors.push('persona is mandatory for a RENDERED or phase 5/6 finding (schema rule 1)');
    } else {
      warnings.push(
        'wording reads as an access or visibility claim but persona is null. Set persona, or reword as a purely structural finding (schema rule 1)',
      );
    }
  }
  if (f.persona !== null && f.persona !== undefined && !personas.includes(f.persona)) {
    errors.push(
      `persona "${f.persona}" is not in this run's persona registry (${personas.join(', ')}). Free text is not allowed (schema rule 2)`,
    );
  }

  // Rule 3: shared scope needs a reason.
  if (f.portal_scope === 'shared') {
    const named = Array.isArray(f.shared_with) && f.shared_with.length > 0;
    if (!named) {
      if (f.tier !== '2') {
        errors.push('portal_scope shared with an empty shared_with is only allowed at tier "2" (schema rule 3)');
      }
      if (!f.caveat || !String(f.caveat).trim()) {
        errors.push('tier 2 shared finding must carry a caveat explaining why the other portals are unconfirmed (schema rule 3)');
      }
    }
  }
  // `tier` only ever carries the blast-radius scheme, on any phase, not just
  // Phase 8. Staleness tiers (A/B/C) belong in evidence_detail instead
  // (schema example 2). Previously this only checked f.phase === 8, so e.g.
  // a phase-2 finding with tier: "Q" passed silently.
  if (f.tier !== null && f.tier !== undefined && !BLAST_RADIUS_TIERS.includes(f.tier)) {
    errors.push(
      'tier carries only the blast-radius scheme ("1" or "2"), on any phase. Phase 8 staleness tiers A/B/C belong in evidence_detail (schema example 2)',
    );
  }

  // Rule 4: write_exception_used must match a logged exception.
  if (f.write_exception_used) {
    if (!exceptions.includes(f.write_exception_used)) {
      errors.push(
        `write_exception_used "${f.write_exception_used}" does not match a declared exception (${exceptions.join(', ') || 'none declared'}) (schema rule 4)`,
      );
    }
  }

  // Rule 5: url convention.
  if (f.url) {
    if (f.evidence_type === 'CONFIG' || f.evidence_type === 'INFERRED') {
      const deepLink = /\/now\/nav\/ui\/classic\/params\/target\/[\w$.]+\.do%3Fsys_id%3D[\w<>]+/;
      if (f.record_refs?.length && !deepLink.test(f.url)) {
        errors.push(
          'a CONFIG or INFERRED finding backed by a record must use the Next Experience deep link form ' +
            'https://<instance>/now/nav/ui/classic/params/target/<table>.do%3Fsys_id%3D<sys_id> (schema rule 5)',
        );
      }
    }
    if (f.evidence_type === 'RENDERED' && ctx.portalBase && !String(f.url).startsWith(ctx.portalBase)) {
      warnings.push(`RENDERED url should be the portal URL actually navigated to (expected a ${ctx.portalBase} prefix)`);
    }
    // ctx.instanceHost is the run's own instance. Falls back to the host of
    // ctx.portalBase so the check also fires for callers that only pass that
    // one (bin/report.mjs does). Previously instanceHost was documented and
    // passed by bin/findings.mjs but read by nothing, so a url carried over
    // from a different run or a different instance reached the client's report
    // unchallenged, pointing at a record the reader cannot open.
    const expectedHost = hostOf(ctx.instanceHost ? `https://${String(ctx.instanceHost).replace(/^\w+:\/\//, '')}` : ctx.portalBase);
    const actualHost = hostOf(f.url);
    if (expectedHost && actualHost && actualHost !== expectedHost) {
      errors.push(
        `url host "${actualHost}" is not this run's instance ("${expectedHost}"). ` +
          'A finding must link to the instance it was observed on (schema rule 5)',
      );
    }
  }

  // Style rule from the build prompt: no em dashes in skill output.
  for (const field of STRING_FIELDS) {
    if (typeof f[field] === 'string' && /[—–]/.test(f[field])) {
      errors.push(`${field} contains an em or en dash. Skill output uses none.`);
    }
  }

  // Withheld findings must say why.
  if (f.status === 'withheld' && !f.caveat) {
    errors.push('a withheld finding must carry a caveat saying why it was withheld');
  }

  return { errors, warnings };
}

/**
 * Validate a whole phase file.
 *
 * @param {object[]} findings
 * @param {object} ctx  as validateFinding, plus:
 * @param {number} [ctx.phase]        expected phase for every finding in the file
 * @param {boolean} [ctx.adminOnlyRun] enables schema rule 6
 * @param {Iterable<string>} [ctx.knownFindingIds] every id in the run. Pass it
 *   to make `supersedes` resolution strict. Without it only this file's own ids
 *   are in scope, so a cross-file supersession downgrades to a warning here and
 *   is caught run-wide at assembly time instead (lib/report.mjs).
 */
export function validateFindings(findings, ctx = {}) {
  const results = [];
  if (!Array.isArray(findings)) {
    return { ok: false, fileErrors: ['findings file must be a JSON array'], results };
  }
  const seen = new Set();
  const fileErrors = [];

  // Resolve supersedes against the widest id set the caller gave us, plus this
  // file's own ids. Validation of finding #1 must be able to see finding #9's
  // id, so the set is built before the per-finding loop, not during it.
  const fileIds = findings.map((f) => f?.id).filter((id) => typeof id === 'string' && id.trim());
  const supplied = toIdSet(ctx.knownFindingIds);
  const findingCtx = {
    ...ctx,
    knownFindingIds: new Set([...(supplied ?? []), ...fileIds]),
    knownFindingIdsComplete: Boolean(supplied),
  };

  for (const [i, f] of findings.entries()) {
    const { errors, warnings } = validateFinding(f, findingCtx);
    if (f?.id) {
      if (seen.has(f.id)) errors.push(`duplicate id "${f.id}" within this run`);
      seen.add(f.id);
    }
    if (ctx.phase !== undefined && f?.phase !== ctx.phase) {
      errors.push(`finding phase ${f?.phase} does not match the file's phase ${ctx.phase}`);
    }
    results.push({ index: i, id: f?.id ?? `#${i}`, errors, warnings });
  }

  // Rule 6: an admin-only run must not silently drop the Phase 5 reconciliation.
  if (ctx.phase === 5 && ctx.adminOnlyRun) {
    const hasPlaceholder = findings.some(
      (f) => f?.status === 'withheld' && /reconcil/i.test(`${f?.title ?? ''} ${f?.description ?? ''}`),
    );
    if (!hasPlaceholder) {
      fileErrors.push(
        'admin-only run: phase 5 findings must include a status "withheld" placeholder for the reachability ' +
          'reconciliation, so the evidence trail shows the gap was noticed (schema rule 6)',
      );
    }
  }

  const ok = fileErrors.length === 0 && results.every((r) => r.errors.length === 0);
  return { ok, fileErrors, results };
}

/**
 * Resolve the `supersedes` graph across every finding in a run (schema rule 7).
 *
 * A finding that corrects or replaces an earlier one lists that earlier id in
 * `supersedes`. Phase 10 then leaves the superseded finding out of the report,
 * so a correction cannot appear next to the statement it says is wrong. Without
 * this, the only filter was `status`, and a struck statement stayed published.
 *
 * @param {object[]} findings  every finding in the run
 * @returns {{
 *   supersededBy: Map<string, string[]>,  superseded id -> ids that supersede it
 *   dangling: {id: string, missing: string}[],  supersedes pointing at no finding
 *   conflicts: {a: string, b: string}[],  mutual supersession, kept not dropped
 * }}
 */
export function resolveSupersessions(findings) {
  const byId = new Map();
  for (const f of findings ?? []) {
    if (typeof f?.id === 'string' && f.id.trim()) byId.set(f.id, f);
  }

  const supersededBy = new Map();
  const dangling = [];
  for (const f of findings ?? []) {
    for (const target of f?.supersedes ?? []) {
      if (typeof target !== 'string' || !target.trim() || target === f.id) continue;
      if (!byId.has(target)) {
        dangling.push({ id: f.id, missing: target });
        continue;
      }
      if (!supersededBy.has(target)) supersededBy.set(target, []);
      if (!supersededBy.get(target).includes(f.id)) supersededBy.get(target).push(f.id);
    }
  }

  // Two findings each claiming to supersede the other cancel out. Dropping both
  // would delete the disagreement from the report, which is the opposite of the
  // point, so neither is dropped and the pair is reported as a conflict.
  const conflicts = [];
  for (const [target, sources] of supersededBy) {
    for (const source of sources) {
      if (!supersededBy.get(source)?.includes(target)) continue;
      if (conflicts.some((c) => (c.a === target && c.b === source) || (c.a === source && c.b === target))) continue;
      conflicts.push({ a: target, b: source });
    }
  }
  // Only the mutual edge is dropped, not the whole entry: a third finding may
  // also supersede one of the pair, and that supersession is still valid.
  for (const { a, b } of conflicts) {
    for (const [target, other] of [[a, b], [b, a]]) {
      const rest = (supersededBy.get(target) ?? []).filter((id) => id !== other);
      if (rest.length) supersededBy.set(target, rest);
      else supersededBy.delete(target);
    }
  }

  return { supersededBy, dangling, conflicts };
}

/**
 * Deep link for a platform record, per schema rule 5.
 */
export function recordDeepLink(instanceBase, table, sysId) {
  return `${instanceBase}/now/nav/ui/classic/params/target/${table}.do%3Fsys_id%3D${sysId}`;
}
