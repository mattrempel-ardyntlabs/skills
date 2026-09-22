// Read-only browser wrapper. Playwright underneath.
//
// READ-ONLY BY CONSTRUCTION. A ReadOnlyTab exposes exactly the five actions
// named in reference/13-data-access.md and nothing else:
//
//   navigate(url)                 follow a URL (GET)
//   clickLink(target)             click, gated by lib/blocklist.mjs
//   observe(options)              snapshot the rendered page; options.accessibility
//                                 runs the vendored axe-core in read-only mode
//   screenshot(name, options)     capture a PNG into <run>/screenshots/
//   startImpersonation / stopImpersonation   on the session, not the tab
//
// There is no fill, type, press, select, setInputFiles, submit, or generic
// evaluate on the public surface. The Playwright Page is a private field. The
// only evaluate() calls in this file are the ones inside observe(), and they
// read the DOM.
//
// Start/Stop Impersonating is a named, deliberate exception: it changes session
// state on the instance. Every start and stop is logged locally, and close()
// always stops impersonation even if a phase failed partway through.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { clickAllowed, SKIP_REASON } from './blocklist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AXE_PATH = path.join(HERE, '..', 'vendor', 'axe.min.js');

export const WIDTHS = { mobile: 390, tablet: 820, desktop: 1440 };

// How Service Portal actually marks a widget in the rendered DOM.
//
// The element wrapping a rendered widget carries a CSS class of the form
// `v<sp_widget sys_id>` -- a literal lowercase "v" followed by the 32-hex
// sys_id of the sp_widget record. That is the hook the platform's own
// widget-scoped CSS compiles against, which is why theme stylesheets that
// address widgets by record identity are written as `.v<sys_id> { ... }`.
// Confirmed against real captured instance data: the 17 sp_css bodies cached
// under portal-audit-runs/esc-2026-09-11/cache/table__sp_css__*.json contain
// exactly 78 distinct `.v<32-hex>` selectors, and 45 of those 78 sys_ids
// resolve to real sp_widget records (report.md, finding 1).
//
// The previous selector here was `[widget-id],[data-widget-id],sp-widget,
// [id^="sp_widget"]`, none of which Service Portal emits. The cost was not
// theoretical: the esc-2026-09-11 crawl visited 237 pages and recorded a
// grand total of 3 widget nodes, every one of them with widgetId, instanceId
// and cssId all null, and every frontend-review capture came back with
// widgetIds: []. The widget inventory was silently empty.
//
// The attribute selectors are kept as well. They cost nothing, they cover
// releases or custom containers that do annotate widgets, and test/smoke.mjs
// renders its mock portal that way.
export const WIDGET_CLASS_PATTERN = '^v[0-9a-f]{32}$';
export const WIDGET_ATTRIBUTE_SELECTOR = '[widget-id],[data-widget-id],[sp-widget],sp-widget,[id^="sp_widget"]';

/**
 * The `v<sp_widget sys_id>` class on one element, or null.
 *
 * Exported so the pattern can be exercised without a browser. The identical
 * logic is inlined inside observe()'s page.evaluate(), which cannot close
 * over module scope.
 *
 * @param {Iterable<string>|string} classes  a classList, or a class attribute
 * @returns {string|null} the sp_widget sys_id, lowercased
 */
export function widgetSysIdFromClasses(classes) {
  const re = new RegExp(WIDGET_CLASS_PATTERN, 'i');
  const list = typeof classes === 'string' ? classes.split(/\s+/) : Array.from(classes ?? []);
  for (const cls of list) {
    if (re.test(cls)) return cls.slice(1).toLowerCase();
  }
  return null;
}

/** Resolve playwright from the skill, the user's global install, or gstack. */
export async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    'playwright',
    path.join(HERE, '..', 'node_modules', 'playwright', 'index.mjs'),
    path.join(process.env.HOME ?? '', '.claude', 'skills', 'gstack', 'node_modules', 'playwright', 'index.mjs'),
  ];
  for (const c of candidates) {
    try {
      const resolved = c.startsWith('/') ? c : require.resolve(c);
      const mod = await import(resolved.startsWith('/') ? `file://${resolved}` : resolved);
      if (mod.chromium) return mod;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'Playwright is not available. Run `node bin/setup.mjs` in the skill directory, or set ' +
      'PORTAL_AUDIT_PLAYWRIGHT to a playwright entry point. Phases 5 and 6 cannot run without it; ' +
      'see the auth fallback ladder in reference/13-data-access.md.',
  );
}

export class ReadOnlyBrowser {
  #browser;
  #context;
  #log;
  #screenshotsDir;
  #instanceBase;
  #impersonating = null;
  #tabs = [];

  constructor({ browser, context, log, screenshotsDir, instanceBase }) {
    this.#browser = browser;
    this.#context = context;
    this.#log = log;
    this.#screenshotsDir = screenshotsDir;
    this.#instanceBase = instanceBase;
  }

  /**
   * Launch with a saved storage state (the session captured by
   * captureSession()). Headless by default.
   */
  static async launch({ instanceBase, storageStatePath, screenshotsDir, log, headless = true }) {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ headless });
    const storageState = storageStatePath ? await readJsonIfExists(storageStatePath) : undefined;
    const context = await browser.newContext({
      storageState: storageState ?? undefined,
      viewport: { width: WIDTHS.desktop, height: 900 },
      ignoreHTTPSErrors: false,
    });
    return new ReadOnlyBrowser({ browser, context, log, screenshotsDir, instanceBase });
  }

  /**
   * Interactive one-time login capture, for the SSO case. Opens a headed
   * browser at the instance, waits for the operator to finish authenticating,
   * then saves storage state for later headless reuse.
   * See reference/13-data-access.md, Authentication.
   *
   * `headless` defaults to false (a real operator needs to see the window to
   * log in) and exists as a parameter only so test/smoke.mjs can exercise the
   * readiness-polling logic below without needing a real display.
   */
  static async captureSession({ instanceBase, storageStatePath, timeoutMs = 600000, headless = false }) {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${instanceBase}/login.do`, { waitUntil: 'domcontentloaded' });
    process.stdout.write('Complete the login in the browser window. Waiting for an authenticated session...\n');
    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (Date.now() < deadline) {
      // Do NOT poll the Table API here: it requires X-UserToken (see
      // lib/session-auth.mjs and reference/13-data-access.md), which this
      // readiness check has no way to attach before a real page has loaded.
      // Polling it directly would return 401 forever, regardless of whether
      // login actually succeeded, and this check would time out every time.
      // Poll a classic-UI page instead and look for the literal
      // `window.g_ck = '...'` it renders once authenticated -- the same
      // signal lib/session-auth.mjs uses, and one a plain GET can see.
      const res = await context.request.get(`${instanceBase}/navpage.do`).catch(() => null);
      const text = res ? await res.text().catch(() => '') : '';
      if (res && res.status() === 200 && /window\.g_ck\s*=\s*'[0-9a-f]+'/.test(text)) {
        ok = true;
        break;
      }
      await sleep(2000);
    }
    if (!ok) {
      await browser.close();
      throw new Error('Timed out waiting for an authenticated session.');
    }
    await mkdir(path.dirname(storageStatePath), { recursive: true });
    await context.storageState({ path: storageStatePath });
    await browser.close();
    return storageStatePath;
  }

  get impersonating() {
    return this.#impersonating;
  }

  /**
   * Open up to `n` tabs sharing this session's login. Confirmed to work with
   * Playwright specifically: independent contexts loaded from the same
   * storage state are concurrently scriptable and each carries the session
   * cookie (test/smoke.mjs, "three tabs open from one saved login"). Open
   * question 4c in reference/14-open-questions.md motivated this design but
   * was tested against a different tool (the Claude Browser pane, not
   * Playwright); the smoke test above is what actually proves it for the
   * browser-automation layer this file uses. Capped at 3 by the caller, per
   * reference/03-routing-reachability.md.
   */
  async openTabs(n = 1) {
    const state = await this.#context.storageState();
    const tabs = [];
    for (let i = 0; i < n; i += 1) {
      const ctx = await this.#browser.newContext({
        storageState: state,
        viewport: { width: WIDTHS.desktop, height: 900 },
      });
      const page = await ctx.newPage();
      tabs.push(new ReadOnlyTab({ page, ctx, log: this.#log, screenshotsDir: this.#screenshotsDir, index: i }));
    }
    this.#tabs.push(...tabs);
    return tabs;
  }

  async closeTabs() {
    for (const tab of this.#tabs) await tab._dispose();
    this.#tabs = [];
  }

  /**
   * Named exception: changes session state on the instance and is logged there.
   * Logged locally too, both directions.
   *
   * @param {string} persona  registry name key this impersonation represents
   * @param {string} userIdentifier  a real active user's sys_id or user_name
   */
  async startImpersonation(persona, userIdentifier) {
    if (this.#impersonating) {
      throw new Error(
        `Already impersonating ${this.#impersonating.persona}. Impersonation is one identity per session; ` +
          'stop before starting another (reference/03-routing-reachability.md).',
      );
    }
    const sysId = await this.#resolveUserSysId(userIdentifier);
    await this.#log?.impersonationStart(persona, { identifier: userIdentifier, sys_id: sysId });
    await this.#impersonationCall('start', sysId);
    const who = await this.#currentUserName();
    this.#impersonating = { persona, userIdentifier, sysId, observedUser: who };
    await this.#log?.event('impersonation.verified', { persona, expected: userIdentifier, observed: who });
    return this.#impersonating;
  }

  async stopImpersonation() {
    if (!this.#impersonating) return null;
    const was = this.#impersonating;
    try {
      await this.#impersonationCall('end', null);
    } finally {
      this.#impersonating = null;
      const who = await this.#currentUserName().catch(() => null);
      await this.#log?.impersonationStop(was.persona, { observedUserAfterStop: who });
    }
    return was;
  }

  /** Always stops impersonation first, even on a failed phase. */
  async close() {
    try {
      await this.stopImpersonation();
    } catch (err) {
      await this.#log?.error('impersonation-stop-failed', { error: String(err) });
    }
    await this.closeTabs();
    await this.#context.close().catch(() => {});
    await this.#browser.close().catch(() => {});
  }

  // -------------------------------------------------------------------
  // Private. The only non-GET call this whole file can make is the
  // impersonation endpoint, and it cannot be pointed anywhere else.
  // -------------------------------------------------------------------
  #impersonationCall = async (mode, sysId) => {
    const startPath = process.env.SN_IMPERSONATE_START_PATH || '/api/now/ui/impersonate/user';
    const endPath = process.env.SN_IMPERSONATE_END_PATH || '/api/now/ui/impersonate/end';
    const rawPath = mode === 'start' ? startPath : endPath;
    // Normalize through URL before the allow-list check, not after: checking
    // the raw, operator-supplied env var string would let something like
    // "/api/now/ui/impersonate/../../../some_processor.do" pass the regex
    // and still resolve to an arbitrary path once requested.
    const pathname = new URL(rawPath, this.#instanceBase).pathname;
    if (!/^\/api\/now\/ui\/impersonate\//.test(pathname) && !/^\/logout_impersonate\.do$/.test(pathname)) {
      throw new Error(`Blocked: ${pathname} is not an impersonation endpoint.`);
    }
    const token = await this.#userToken();
    const res = await this.#context.request.post(`${this.#instanceBase}${pathname}`, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { 'X-UserToken': token } : {}),
      },
      data: mode === 'start' ? { sysId } : {},
    });
    if (res.status() >= 400) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Impersonation ${mode} failed with HTTP ${res.status()} against ${pathname}. ` +
          `Override the endpoint with SN_IMPERSONATE_START_PATH / SN_IMPERSONATE_END_PATH if this release differs. Body: ${body.slice(0, 300)}`,
      );
    }
  };

  #userToken = async () => {
    const page = await this.#context.newPage();
    try {
      await page.goto(`${this.#instanceBase}/navpage.do`, { waitUntil: 'domcontentloaded' });
      return await page.evaluate(() => window.g_ck || window.NOW?.g_ck || null);
    } catch {
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  };

  #currentUserName = async () => {
    const res = await this.#context.request.get(
      `${this.#instanceBase}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=user_name&sysparm_exclude_reference_link=true&sysparm_query=${encodeURIComponent('user_name=javascript:gs.getUserName()')}`,
      { headers: { Accept: 'application/json' } },
    );
    if (res.status() !== 200) return null;
    const body = await res.json().catch(() => null);
    return body?.result?.[0]?.user_name ?? null;
  };

  #resolveUserSysId = async (identifier) => {
    if (/^[0-9a-f]{32}$/i.test(identifier)) return identifier;
    const res = await this.#context.request.get(
      `${this.#instanceBase}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id,user_name,active&sysparm_exclude_reference_link=true&sysparm_query=${encodeURIComponent(`user_name=${identifier}^active=true`)}`,
      { headers: { Accept: 'application/json' } },
    );
    const body = await res.json().catch(() => null);
    const row = body?.result?.[0];
    if (!row?.sys_id) {
      throw new Error(`No active sys_user found for "${identifier}". A persona needs a real, active named user.`);
    }
    return row.sys_id;
  };
}

export class ReadOnlyTab {
  #page;
  #ctx;
  #log;
  #screenshotsDir;
  #index;
  #axeSource = null;

  constructor({ page, ctx, log, screenshotsDir, index }) {
    this.#page = page;
    this.#ctx = ctx;
    this.#log = log;
    this.#screenshotsDir = screenshotsDir;
    this.#index = index;
  }

  get index() {
    return this.#index;
  }

  // ---- action 1: navigate -------------------------------------------
  /**
   * @returns {{url: string, status: number|null, ok: boolean, timedOut: boolean}}
   */
  async navigate(url, { waitMs = 1500, timeoutMs = 45000 } = {}) {
    let status = null;
    let timedOut = false;
    try {
      const res = await this.#page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      status = res?.status() ?? null;
      // Service Portal builds links client side. Extraction must happen after
      // Angular render, not from raw HTML.
      await this.#page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await this.#page.waitForTimeout(waitMs);
    } catch (err) {
      timedOut = true;
      await this.#log?.error('navigate', { url, error: String(err) });
    }
    return { url: this.#page.url(), requestedUrl: url, status, ok: status !== null && status < 400, timedOut };
  }

  // ---- action 2: click a link ---------------------------------------
  /**
   * Click one candidate link. Applies the form check and the write-verb
   * blocklist from lib/blocklist.mjs before every click, with no way to skip
   * the gate. Used only for controls with no resolvable href; anything with an
   * href is reached with navigate(), which is unambiguously a GET.
   *
   * @param {string} selector  a CSS selector resolving to one element
   */
  async clickLink(selector, { timeoutMs = 20000 } = {}) {
    const locator = this.#page.locator(selector).first();
    const probe = await locator
      .evaluate((el) => ({
        visibleText: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim(),
        insideForm: el.closest('form') !== null,
        tag: el.tagName.toLowerCase(),
        href: el.getAttribute('href'),
      }))
      .catch(() => null);
    if (!probe) {
      return { clicked: false, reason: 'element not found', selector };
    }

    const gate = clickAllowed(probe);
    if (!gate.allowed) {
      await this.#log?.event('click.skipped', { selector, text: probe.visibleText, reason: gate.reason });
      return { clicked: false, reason: gate.reason, skipped: true, text: probe.visibleText, selector };
    }

    const before = this.#page.url();
    try {
      await locator.click({ timeout: timeoutMs, noWaitAfter: false });
      await this.#page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    } catch (err) {
      await this.#log?.error('click', { selector, error: String(err) });
      return { clicked: false, reason: String(err), selector };
    }
    return { clicked: true, from: before, to: this.#page.url(), text: probe.visibleText, selector };
  }

  // ---- action 3: observe --------------------------------------------
  /**
   * Snapshot the rendered page. Read-only DOM inspection.
   *
   * @param {object} opts
   * @param {boolean} [opts.accessibility=false]  run vendored axe-core
   * @param {boolean} [opts.aria=false]           include the ARIA tree
   */
  async observe({ accessibility = false, aria = false } = {}) {
    const snapshot = await this.#page.evaluate(({ widgetClassPattern, widgetAttributeSelector }) => {
      const abs = (href) => {
        try {
          return new URL(href, document.baseURI).href;
        } catch {
          return null;
        }
      };
      const anchors = Array.from(document.querySelectorAll('a')).map((a, i) => ({
        index: i,
        text: (a.innerText || a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        href: a.getAttribute('href'),
        resolved: a.getAttribute('href') ? abs(a.getAttribute('href')) : null,
        insideForm: a.closest('form') !== null,
        selector: a.id ? `#${CSS.escape(a.id)}` : null,
      }));
      const clickables = Array.from(document.querySelectorAll('[ng-click],[data-page-id],[role="link"]')).map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        insideForm: el.closest('form') !== null,
        pageId: el.getAttribute('data-page-id') || null,
      }));
      // Service Portal marks a rendered widget with a `v<sp_widget sys_id>`
      // class, not with a widget-id attribute. Match on that class, and keep
      // the attribute selectors for anything that does annotate widgets.
      // One pass over the document so the result stays in document order and
      // an element matching both ways is only counted once.
      const widgetClassRe = new RegExp(widgetClassPattern, 'i');
      const widgetSysIdOf = (el) => {
        const classes = el.classList ? Array.from(el.classList) : [];
        for (const cls of classes) {
          if (widgetClassRe.test(cls)) return cls.slice(1).toLowerCase();
        }
        return null;
      };
      const widgets = [];
      for (const el of document.querySelectorAll('*')) {
        const widgetSysId = widgetSysIdOf(el);
        let matchedBy = widgetSysId ? 'class' : null;
        if (!matchedBy) {
          let byAttribute = false;
          try {
            byAttribute = el.matches(widgetAttributeSelector);
          } catch {
            byAttribute = false;
          }
          if (!byAttribute) continue;
          matchedBy = 'attribute';
        }
        widgets.push({
          // Fall back to the sys_id so downstream inventories key on
          // something real instead of collapsing everything into "unknown".
          // lib/report.mjs groups on widgetId; bin/phase1.mjs holds the
          // sys_id -> sp_widget.id name mapping if a run wants names.
          widgetId: el.getAttribute('widget-id') || el.getAttribute('data-widget-id') || widgetSysId,
          widgetSysId,
          instanceId: el.getAttribute('instance-id') || el.getAttribute('data-instance-id') || null,
          cssId: el.id || null,
          matchedBy,
        });
      }
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({
        level: Number(h.tagName.slice(1)),
        text: (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      }));
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        url: location.href,
        title: document.title,
        lang: document.documentElement.getAttribute('lang'),
        anchors,
        clickables,
        widgets,
        headings,
        landmarks: Array.from(document.querySelectorAll('main,nav,header,footer,[role]')).length,
        formCount: document.querySelectorAll('form').length,
        imagesWithoutAlt: document.querySelectorAll('img:not([alt])').length,
        bodyTextSample: bodyText.slice(0, 2000),
        bodyTextLength: bodyText.length,
        // Documented crawl outcomes that are not HTTP status codes.
        notAuthorizedMessage: /You are either not authorized or record is not valid/i.test(bodyText),
        pageNotFound: /page not found/i.test(bodyText),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    }, { widgetClassPattern: WIDGET_CLASS_PATTERN, widgetAttributeSelector: WIDGET_ATTRIBUTE_SELECTOR });

    if (aria) {
      snapshot.aria = await this.#page
        .locator('body')
        .ariaSnapshot()
        .catch(() => null);
    }

    if (accessibility) {
      snapshot.axe = await this.#runAxe();
    }
    return snapshot;
  }

  /**
   * Set the viewport ahead of navigate(), not after. Responsive logic that
   * only runs at load time (Service Portal widgets checking
   * `$window.innerWidth` once, in an initial digest) does not re-run on a
   * resize after the page has already rendered, so a caller measuring
   * per-breakpoint behavior should call this before navigate(), not rely on
   * screenshot()'s own resize.
   */
  async setViewport(width, { waitMs = 300 } = {}) {
    await this.#page.setViewportSize({ width, height: 900 });
    if (waitMs) await this.#page.waitForTimeout(waitMs);
  }

  // ---- action 4: screenshot -----------------------------------------
  /**
   * @param {string} name  file name stem, conventionally
   *                       <template>__<width>__<persona>
   * @param {object} [opts]
   * @param {number|null} [opts.width]  resize immediately before capturing.
   *   Pass null (default) if the caller already set the viewport with
   *   setViewport() before navigating, so the page loaded at that width
   *   rather than being resized after the fact.
   */
  async screenshot(name, { width = null, fullPage = true } = {}) {
    if (width) await this.setViewport(width, { waitMs: 600 });
    const safe = String(name).replace(/[^\w.-]/g, '_');
    const file = path.join(this.#screenshotsDir, `${safe}.png`);
    await mkdir(this.#screenshotsDir, { recursive: true });
    await this.#page.screenshot({ path: file, fullPage });
    return file;
  }

  /** Observed performance signals, complementing the static analysis. */
  async timing() {
    return this.#page
      .evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource');
        const bytes = resources.reduce((a, r) => a + (r.transferSize || 0), 0);
        return {
          requestCount: resources.length,
          transferBytes: bytes,
          domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          loadMs: nav ? Math.round(nav.loadEventEnd) : null,
          scssRequests: resources.filter((r) => /sp_bootstrap\.scss|\.scss/.test(r.name)).length,
        };
      })
      .catch(() => null);
  }

  async _dispose() {
    await this.#page.close().catch(() => {});
    await this.#ctx.close().catch(() => {});
  }

  // axe-core is injected by evaluating its vendored source directly in the
  // page's main world (page.evaluate), which a strict `script-src 'self'`
  // CSP does not block, confirmed by test/smoke.mjs ("axe-core injects under
  // a strict CSP"). Open question 4d in reference/14-open-questions.md tested
  // a different mechanism against a different tool: injecting axe-core via a
  // `<script src>` CDN tag in the Claude Browser pane, not evaluate() in
  // Playwright, and it never claimed addScriptTag specifically was blocked.
  // Vendoring the source and evaluating it, as this file does, sidesteps
  // that question rather than answering it: it needs no external script
  // load, CDN or otherwise, so a strict CSP is not a factor either way.
  #runAxe = async () => {
    if (this.#axeSource === null) {
      this.#axeSource = await readFile(AXE_PATH, 'utf8').catch(() => '');
    }
    if (!this.#axeSource) {
      return { error: 'axe-core is not vendored. Run `node bin/setup.mjs` in the skill directory.' };
    }
    try {
      await this.#page.evaluate(this.#axeSource);
      return await this.#page.evaluate(async () => {
        // eslint-disable-next-line no-undef
        const results = await axe.run(document, {
          resultTypes: ['violations'],
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
        });
        return {
          violations: results.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            helpUrl: v.helpUrl,
            nodeCount: v.nodes.length,
            sample: v.nodes.slice(0, 3).map((n) => ({ target: n.target, html: String(n.html).slice(0, 200) })),
          })),
          testedUrl: location.href,
        };
      });
    } catch (err) {
      return { error: String(err) };
    }
  };
}

export { SKIP_REASON };

async function readJsonIfExists(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function writeJson(p, value) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
