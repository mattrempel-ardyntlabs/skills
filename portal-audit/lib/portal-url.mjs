// Portal URL structure, normalization and deduplication.
// See reference/03-routing-reachability.md.
//
//   https://<instance>/<suffix>/<guest language>/<keywords>?id=<page id>&lang=<lang>&<params>

// Non-material for structural dedup, retained for the Phase 6 translation review.
const NON_MATERIAL = new Set(['lang', 'spa', 'sysparm_nostack', 'sysparm_stack', 't']);

// Record selectors: material that the parameter exists, not which record it points at.
// A thousand knowledge articles collapse into one kb_article node.
const COLLAPSED = new Set(['sys_id', 'sysparm_document_key', 'number', 'sysparm_article']);

export function buildPageUrl(instanceBase, suffix, pageId, params = {}, { lang = null, guestLang = null } = {}) {
  const segment = guestLang ? `/${guestLang}` : '';
  const url = new URL(`${instanceBase}/${suffix}${segment}/`);
  if (pageId) url.searchParams.set('id', pageId);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  if (lang) url.searchParams.set('lang', lang);
  return url.toString();
}

/**
 * Parse a URL into portal terms. Returns null when the URL does not belong to
 * this portal (another portal's suffix, an external host, a platform UI link).
 */
export function parsePortalUrl(rawUrl, { instanceBase, suffix }) {
  let url;
  try {
    url = new URL(rawUrl, `${instanceBase}/${suffix}/`);
  } catch {
    return null;
  }
  if (url.origin !== new URL(instanceBase).origin) {
    return { external: true, href: url.toString() };
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== suffix) {
    return { otherPortalOrPlatform: true, href: url.toString(), firstSegment: segments[0] ?? null };
  }
  // segments[1] may be a guest-language code when it is two letters.
  const guestLang = segments[1] && /^[a-z]{2}(-[a-z]{2})?$/i.test(segments[1]) ? segments[1] : null;

  const params = {};
  let pageId = null;
  let lang = null;
  for (const [k, v] of url.searchParams.entries()) {
    if (k === 'id') pageId = v;
    else if (k === 'lang') lang = v;
    else params[k] = v;
  }
  return { external: false, pageId, params, lang, guestLang, href: url.toString() };
}

/**
 * Structural dedup key: page ID plus material parameters.
 * Without this the crawl is unbounded on any real customer portal.
 */
export function nodeKey(pageId, params = {}) {
  const parts = [];
  for (const key of Object.keys(params).sort()) {
    if (NON_MATERIAL.has(key)) continue;
    parts.push(COLLAPSED.has(key) ? `${key}=<record>` : `${key}=${params[key]}`);
  }
  return [pageId ?? '(default)', ...parts].join('|');
}

export function isMaterialParam(key) {
  return !NON_MATERIAL.has(key);
}

export function isCollapsedParam(key) {
  return COLLAPSED.has(key);
}

/**
 * Page IDs referenced statically inside widget templates, client scripts,
 * server scripts and instance option JSON. This is how the seed frontier is
 * built before a browser opens.
 */
export function extractPageIds(text) {
  if (!text) return [];
  const ids = new Set();
  const patterns = [
    /[?&]id=([A-Za-z0-9_.-]+)/g,
    /\bid\s*:\s*['"]([A-Za-z0-9_.-]+)['"]/g,
    /getWidget\(\s*['"]([A-Za-z0-9_.-]+)['"]/g,
    /\bpage_id\s*[:=]\s*['"]([A-Za-z0-9_.-]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(String(text))) !== null) ids.add(m[1]);
  }
  return [...ids];
}

/** Required page parameters are declared in practice via $sp.getParameter. */
export function extractParameterNames(serverScript) {
  if (!serverScript) return [];
  const names = new Set();
  const re = /getParameter\(\s*['"]([A-Za-z0-9_.-]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(String(serverScript))) !== null) names.add(m[1]);
  return [...names];
}

/** Hardcoded portal suffixes inside a cloned widget, a documented failure mode. */
export function findHardcodedPortalPaths(text, ownSuffix) {
  if (!text) return [];
  const hits = new Set();
  const re = /['"(\s](\/(?:sp|esc|csm|hr|kb|now|[a-z0-9_-]{2,20}))\/?\?id=/gi;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const found = m[1].replace(/^\//, '');
    if (found !== ownSuffix) hits.add(found);
  }
  return [...hits];
}
