#!/usr/bin/env node
// Phase 0: scope and identity.
//
// Resolves the three things that make this kind of tool fail late, in the order
// the build prompt sets out. Authorization is already recorded by init-run.mjs,
// which this script refuses to run without.
//
//   node bin/phase0.mjs --run portal-audit-runs/esc-2026-09-10
//
// Prints a JSON block and writes <run>/phase0.json. The orchestrator reads it,
// then talks to the operator about personas, admin access and the search
// baseline before dispatching anything.

import path from 'node:path';
import { openSession, parseArgs, die } from '../lib/session.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.run) die('--run <run folder> is required.');

const { api, runFolder, config, metadata, log } = await openSession(args.run);
if (!metadata?.authorization?.confirmed) {
  die(
    'No confirmed authorization in metadata.json. Run bin/init-run.mjs first. ' +
      'No query runs before the customer has authorized a read-only audit of this environment.',
  );
}

const suffix = metadata.portalSuffixRequested;
const out = { suffix, instanceBase: config.base, probes: {}, warnings: [] };

// ---------------------------------------------------------------------------
// 1. Does the suffix resolve to an sp_portal record at all?
// ---------------------------------------------------------------------------
const portalRes = await api.get('sp_portal', {
  fields: [
    'sys_id',
    'title',
    'url_suffix',
    'homepage',
    'login_page',
    'notfound_page',
    'theme',
    // No 'main_menu': sp_portal has no such column. "Main menu" is the form
    // label for sp_rectangle_menu, which is already in this list
    // (reference/01-portal-record.md). The Table API silently drops an unknown
    // field name instead of erroring, so requesting it cost a field and
    // returned nothing, every run.
    'kb_knowledge_base',
    'sc_catalog',
    'default_title',
    'css_variables',
    'logo',
    'icon',
    'inactive',
    'alternate_portal',
    'enable_ais',
    'search_source',
    'sp_rectangle_menu',
    'quick_start_config',
    'notification',
  ],
  query: `url_suffix=${suffix}`,
  limit: 5,
  displayValue: 'all',
});

if (portalRes.error) {
  out.probes.portal = { ok: false, status: portalRes.status, error: portalRes.error };
  out.fatal = 'Could not read sp_portal. Check the credential and the sp_* read access.';
} else if (portalRes.rows.length === 0) {
  // Out of scope checks: UI Builder experience, or a CMS site.
  const uxb = await api.get('sys_ux_page_registry', { fields: ['sys_id', 'path', 'title'], query: `path=${suffix}^ORpathLIKE${suffix}`, limit: 5 });
  const cms = await api.get('content_site', { fields: ['sys_id', 'title', 'url_suffix'], query: `url_suffix=${suffix}`, limit: 5 });
  out.probes.portal = { ok: false, resolved: false };
  if (!uxb.error && uxb.rows.length) {
    out.fatal = `"${suffix}" resolves to a UI Builder experience (sys_ux_page_registry), not a Service Portal. Different technology, different audit. Stop and say so.`;
    out.probes.uiBuilder = uxb.rows;
  } else if (!cms.error && cms.rows.length) {
    out.fatal = `"${suffix}" resolves to a CMS site (content_site). com.glide.cms can no longer be activated and deprecates in the C release. That is a migration conversation, not an audit.`;
    out.probes.cms = cms.rows;
  } else {
    out.fatal = `No sp_portal record has url_suffix "${suffix}", and it is not a UI Builder experience or a CMS site either. Confirm the suffix with the operator.`;
  }
} else if (portalRes.rows.length > 1) {
  out.warnings.push(`${portalRes.rows.length} sp_portal records share url_suffix "${suffix}". Exactly one should match. Resolve with the operator before continuing.`);
  out.probes.portal = { ok: true, resolved: true, rows: portalRes.rows };
} else {
  out.probes.portal = { ok: true, resolved: true, row: portalRes.rows[0] };
}

if (out.fatal) {
  await runFolder.writeJson(path.join(runFolder.root, 'phase0.json'), out);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(2);
}

const portal = portalRes.rows[0];
const portalSysId = value(portal.sys_id);

// ---------------------------------------------------------------------------
// 2. Can the credential read sys_update_xml? Phase 8 depends on it.
// ---------------------------------------------------------------------------
const updateXml = await api.get('sys_update_xml', { fields: ['sys_id'], limit: 1 });
out.probes.sys_update_xml = {
  readable: !updateXml.error,
  status: updateXml.status,
  note: updateXml.error
    ? 'Phase 8, the customized out-of-box inventory, is degraded. Say so now, not at the end of the run.'
    : 'Phase 8 can run at full fidelity.',
};

// Is Upgrade History reachable through the Table API at all? Open question 4b.
const upgradeTables = await api.get('sys_db_object', {
  fields: ['name', 'label'],
  query: 'nameLIKEupgrade^ORnameLIKEsys_upgrade',
  limit: 50,
});
out.probes.upgradeHistoryTables = upgradeTables.error ? { readable: false } : upgradeTables.rows.map((r) => value(r.name));
out.probes.stalenessTierAvailable = (out.probes.upgradeHistoryTables?.length ?? 0) > 0 ? 'A candidate found, verify contents' : 'B or C only';

// ---------------------------------------------------------------------------
// 3. Release family, instance history, domain separation.
//    Open questions 4 and 4a. Both need per-engagement verification.
// ---------------------------------------------------------------------------
// One batched nameIN query, so the cost here is a single request no matter how
// many names are listed: dropping a name saves no round trip. What a wrong name
// does cost is fidelity, because sys_properties answers "no row" identically
// for a misspelled name and for a real property left at its platform default.
//
// Checked against the cached sys_properties reads in portal-audit-runs/*/cache
// (two different instances, esc and sp, 2026-09-11):
//   - glide.sp.theme.parse is a WRONG NAME, corrected below to
//     glide.sp.theme.parse_scss. `name=glide.sp.theme.parse` returned 0 rows,
//     while a `nameSTARTSWITHglide.sp.theme^ORnameLIKEtheme.parse` sweep on the
//     other instance returned glide.sp.theme.css_variables_list and
//     glide.sp.theme.parse_scss and no bare ".parse". The sweep would have
//     caught the bare name had it existed.
//   - the other nine names that came back empty (glide.buildname,
//     glide.buildtag, glide.sys.domain.enabled, glide.ui.accessibility, ...)
//     are absent on BOTH instances with no near-miss name anywhere in the
//     cached sweeps. That is the documented default-valued-property case
//     (13-data-access.md), not a bad name, and every consumer below already
//     treats null as "not persisted" rather than "off". They stay.
const props = await api.get('sys_properties', {
  fields: ['name', 'value'],
  query:
    'nameINglide.buildname,glide.buildtag,glide.war,glide.sys.domain.enabled,glide.service_portal.user_criteria_enabled,' +
    'glide.service_portal.enable_ais_portal.allow_list,glide.sp.starting.page.ignore.list,glide.sp.entitlement.override,' +
    'glide.sp.portals.language,glide.sp.theme.parse_scss,glide.ui.accessibility,glide.sp.otto_onboarding.suppressed_portals,' +
    'sn_ex_sp.u_allow.rollup.mesp',
  limit: 100,
});
const propMap = Object.fromEntries((propRows(props) ?? []).map((r) => [value(r.name), value(r.value)]));
out.probes.properties = propMap;
// glide.war is fetched by the same query above and names the release family
// directly (e.g. "glide-australia-02-11-2026__patch3-...zip", confirmed on a
// live instance 2026-09-11). It survives on instances where glide.buildname
// was never persisted as a row, which is the common case -- a property left at
// its platform default has no sys_properties record at all (13-data-access.md).
// Release family gates whether a missing release-gated feature is a defect, so
// leaving it null when the answer is sitting in an already-fetched property is
// a real loss of fidelity for every downstream agent.
const releaseDetail = inferReleaseDetail(propMap['glide.buildname'], propMap['glide.buildtag'], propMap['glide.war']);
out.probes.releaseFamily = {
  buildname: propMap['glide.buildname'] ?? null,
  buildtag: propMap['glide.buildtag'] ?? null,
  war: propMap['glide.war'] ?? null,
  inferred: releaseDetail.family,
  inferredFrom: releaseDetail.source,
  caveat: releaseCaveat(releaseDetail, propMap['glide.war']),
};

const domainCount = await api.count('sys_domain', { query: 'active=true' });
const domainQueryable = domainCount.total !== null;
out.probes.domainSeparation = {
  property: propMap['glide.sys.domain.enabled'] ?? null,
  activeDomainCount: domainCount.total,
  domainQueryable,
  // Unreachable (status 400 observed empirically, not 401/403) is treated as
  // "cannot rule out", not "not active". Folding a query failure into false
  // would silently suppress the report's scope-limitation line exactly when
  // it is least safe to. See open question 4 in 14-open-questions.md and
  // 13-data-access.md's Domain separation section.
  // true / false / 'unknown'. 'unknown' is a literal string on purpose: the
  // report renderer branches on all three. Never collapse it to a boolean.
  likelyActive: domainSeparationState({
    domainQueryable,
    domainEnabledProperty: propMap['glide.sys.domain.enabled'] ?? null,
    activeDomainCount: domainCount.total,
  }),
  caveat: domainQueryable
    ? 'No confirmed detection method exists. Both signals are candidates, neither is verified (open question 4). If this reads as active, state the limitation in the report.'
    : `sys_domain returned status ${domainCount.status} rather than a usable count. This does NOT mean domain separation is inactive; on a fresh non-domain-separated PDI this table was unreachable through the Table API regardless (open question 4). Treat this instance's domain-separation state as unknown and state that in the report rather than asserting either way.`,
};

// ---------------------------------------------------------------------------
// 4. The audit account's own effective roles, and impersonator availability.
// ---------------------------------------------------------------------------
const me = await api.get('sys_user', {
  fields: ['sys_id', 'user_name', 'name', 'active'],
  query: 'user_name=javascript:gs.getUserName()',
  limit: 1,
});
const meRow = me.rows?.[0] ?? null;
out.probes.auditUser = meRow ? { sys_id: value(meRow.sys_id), user_name: value(meRow.user_name), name: value(meRow.name) } : null;

let effectiveRoles = [];
if (meRow) {
  const roles = await api.get('sys_user_has_role', {
    fields: ['role', 'inherited', 'granted_by'],
    query: `user=${value(meRow.sys_id)}`,
    limit: 500,
    all: true,
    displayValue: 'all',
  });
  effectiveRoles = (roles.rows ?? []).map((r) => display(r.role)).filter(Boolean);
}
out.probes.adminEffectiveRoles = effectiveRoles;
out.probes.impersonatorAvailable = effectiveRoles.includes('impersonator') || effectiveRoles.includes('admin');
if (!out.probes.impersonatorAvailable) {
  out.warnings.push(
    'The audit account does not appear to hold the impersonator role. Additional personas are not available through impersonation, and the audit proceeds admin-only.',
  );
}

// ---------------------------------------------------------------------------
// 5. Roles this portal's own security surface actually references.
//    Used to guide the persona offer instead of asking the operator to guess.
// ---------------------------------------------------------------------------
const pagesWithRoles = await api.get('sp_page', { fields: ['id', 'roles'], query: 'rolesISNOTEMPTY', limit: 1000, all: true });
const widgetsWithRoles = await api.get('sp_widget', { fields: ['id', 'roles'], query: 'rolesISNOTEMPTY', limit: 1000, all: true });
const referenced = new Set();
for (const row of [...(pagesWithRoles.rows ?? []), ...(widgetsWithRoles.rows ?? [])]) {
  for (const r of String(value(row.roles) ?? '').split(',')) {
    const t = r.trim();
    if (t) referenced.add(t);
  }
}
out.probes.rolesReferencedByPortalSurface = [...referenced].sort();

// ---------------------------------------------------------------------------
// 6. Inactive flag and alternate portal. Changes the meaning of everything.
// ---------------------------------------------------------------------------
out.probes.portalState = {
  inactive: value(portal.inactive) === 'true',
  alternate_portal: display(portal.alternate_portal) || null,
};
if (out.probes.portalState.inactive) {
  out.warnings.push(
    'This portal is Inactive. That changes the meaning of every downstream finding. Users are redirected to the alternate portal, or shown a deactivation message from sys_ui_message.',
  );
}

// ---------------------------------------------------------------------------
// 7. Employee Center scoped apps present?
// ---------------------------------------------------------------------------
// This fixed, enumerated scope list has already been caught missing real,
// installed apps twice (sn_ect was wrongly dropped after a first test
// concluded it "wasn't real" -- it is, it just owns no tables of its own;
// sn_ex_sp_notifs was never in the list at all until a live audit run found
// it active alongside the rest of the EC chain). Any list like this will
// keep drifting behind whatever ships next. Add to it as you find more, but
// don't trust an app's absence here as proof it isn't installed -- cross-
// check against a broader sys_scope/sys_store_app query when it matters
// (see 14-open-questions.md item 1).
const scopes = await api.get('sys_scope', {
  fields: ['scope', 'name', 'version', 'active'],
  query: 'scopeINsn_ex_sp,sn_hr_sp,sn_ect,sn_ex_emp_fd,sn_ex_sp_pro,sn_ex_sp_gd_help,sn_ex_sp_notifs,sn_ca,sn_cd,sn_hr_integr_fw,sn_ja,sn_lp,sn_lnp,sn_mh',
  limit: 50,
});
const scopeRows = (scopes.rows ?? []).map((r) => ({ scope: value(r.scope), name: value(r.name), version: value(r.version), active: value(r.active) }));
out.probes.scopes = scopeRows;
out.probes.employeeCenterPresent = scopeRows.some((s) => s.scope === 'sn_ex_sp');
out.probes.ecProPresent = scopeRows.some((s) => s.scope === 'sn_ex_sp_pro');

// ---------------------------------------------------------------------------
// 8. AI Search state and baseline eligibility.
// ---------------------------------------------------------------------------
// Confirmed empirically 2026-09-11: this property's value is a comma
// separated list of PORTAL SYS_IDs (baseline portals AI Search is allowed on),
// not url_suffix strings. Comparing it against `suffix` (e.g. "sp") could
// never match, and would misreport an allow-listed portal as not
// allow-listed -- caught on a live instance where this portal's own sys_id
// was plainly present in the property value and the old check still said no.
out.probes.search = {
  enable_ais: value(portal.enable_ais) === 'true',
  allowListProperty: propMap['glide.service_portal.enable_ais_portal.allow_list'] ?? null,
  portalOnAllowList: (propMap['glide.service_portal.enable_ais_portal.allow_list'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(portalSysId),
};

out.nextSteps = [
  out.probes.releaseFamily.inferred
    ? `Release family reads as ${out.probes.releaseFamily.inferred} (from ${out.probes.releaseFamily.inferredFrom}). Confirm with the operator; neither the buildname mapping nor the war file name is authoritative.`
    : 'Neither glide.buildname nor glide.war was readable from sys_properties. Confirm the release family with the operator from the instance\'s /stats.do page.',
  out.probes.sys_update_xml.readable
    ? 'Phase 8 can run at full fidelity.'
    : 'Tell the operator now that Phase 8 will be degraded: sys_update_xml is not readable with this credential.',
  out.probes.impersonatorAvailable
    ? `Offer additional personas, guided by the roles this portal actually references: ${out.probes.rolesReferencedByPortalSurface.slice(0, 15).join(', ') || '(none referenced)'}`
    : 'Additional personas are unavailable. The run is admin-only, so the Phase 5 reconciliation will be withheld.',
];

await runFolder.writeJson(path.join(runFolder.root, 'phase0.json'), out);
await log.event('phase0.complete', { portalSysId, warnings: out.warnings.length });
process.stdout.write(JSON.stringify(out, null, 2) + '\n');

// ---------------------------------------------------------------------------

function propRows(res) {
  return res.error ? [] : res.rows;
}

function value(v) {
  if (v && typeof v === 'object') return v.value ?? null;
  return v ?? null;
}

function display(v) {
  if (v && typeof v === 'object') return v.display_value ?? v.value ?? null;
  return v ?? null;
}

// This list goes stale the moment a new release ships (open question 4a), which
// is why releaseFromWar() falls back to parsing the family token out of the war
// file name rather than returning null for anything it has not heard of.
const RELEASE_FAMILIES = ['australia', 'zurich', 'yokohama', 'xanadu', 'washington', 'vancouver', 'utah', 'tokyo'];

// Tokens that can sit in the second position of a war file name without being a
// release family. Keeps the open-ended parse from inventing a family.
const NOT_A_FAMILY = new Set(['patch', 'hotfix', 'build', 'release', 'glide', 'war', 'app', 'store', 'snapshot']);

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Returns { family, source }. source is 'glide.buildname/glide.buildtag',
// 'glide.war', or null when nothing resolved.
function inferReleaseDetail(buildname, buildtag, war) {
  const text = `${buildname ?? ''} ${buildtag ?? ''}`.toLowerCase();
  for (const family of RELEASE_FAMILIES) {
    if (text.includes(family)) return { family: titleCase(family), source: 'glide.buildname/glide.buildtag' };
  }
  const fromWar = releaseFromWar(war);
  if (fromWar) return { family: fromWar, source: 'glide.war' };
  return { family: null, source: null };
}

function inferRelease(buildname, buildtag, war) {
  return inferReleaseDetail(buildname, buildtag, war).family;
}

// glide.war looks like "glide-australia-02-11-2026__patch3-05-25-2026_06-12-2026_1106.zip"
// (real value, esc instance, 2026-09-11): "glide-", the release family, then
// the build date and patch train.
function releaseFromWar(war) {
  if (!war) return null;
  const lower = String(war).trim().toLowerCase();
  if (!lower) return null;
  for (const family of RELEASE_FAMILIES) {
    if (lower.includes(family)) return titleCase(family);
  }
  const match = /(?:^|[\\/])glide-([a-z]{3,})[-_]/.exec(lower);
  if (match && !NOT_A_FAMILY.has(match[1])) return titleCase(match[1]);
  return null;
}

function releaseCaveat(detail, war) {
  if (detail.source === 'glide.buildname/glide.buildtag') {
    return 'Mapping glide.buildname to a release family needs a lookup table that changes as releases ship (open question 4a). Confirm with the operator.';
  }
  if (detail.source === 'glide.war') {
    return `glide.buildname is not present as a sys_properties row on this instance (expected, not an error: properties left at their platform default are often never persisted as a row -- open question 4a in 14-open-questions.md). The release family above was read from glide.war instead, whose value on this instance is "${war}". That names the family directly and is a stronger signal than a buildname lookup table, but it is still an inference from a file name: confirm against /stats.do ("Build name") if a release-gated finding turns on it.`;
  }
  return 'Neither glide.buildname/glide.buildtag nor glide.war is present as a sys_properties row on this instance. That is expected, not an error: properties left at their platform default are often never persisted as a row (confirmed empirically, open question 4a in 14-open-questions.md). This Table-API-only probe has no read path to /stats.do, which reliably shows the build name. Ask the operator to confirm the release family there.';
}

// true / false / 'unknown'. An unreachable or inconclusive probe is 'unknown'
// -- never true and never false. Asserting "domain separation IS active"
// because the sys_domain query returned a 400 is a fabricated fact, and folding
// it into false would silently suppress the report's scope-limitation line.
// The report renderer branches on all three values; do not swap the sentinel.
function domainSeparationState({ domainQueryable, domainEnabledProperty, activeDomainCount }) {
  if (!domainQueryable) return 'unknown';
  if (typeof activeDomainCount !== 'number') return 'unknown';
  if (domainEnabledProperty === 'true') return true;
  return activeDomainCount > 1;
}
