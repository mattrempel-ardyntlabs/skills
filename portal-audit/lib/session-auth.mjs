// Turns the interactive session captured by bin/capture-session.mjs into
// credentials a plain Node fetch() can use for the Table API, with no
// browser required after capture.
//
// This is the DEFAULT, lightweight way this skill authenticates Table API
// calls: one interactive login (including SSO), captured once by Playwright,
// then replayed here as a cookie header plus a CSRF token read with a single
// plain GET. No separate service account or OAuth client is required, and no
// browser stays open for the length of the run.
//
// A heavier alternative exists in principle: route every Table API call
// through a live Playwright page (e.g. page.evaluate(fetch(...))) instead of
// an extracted, cached cookie/token pair. That is NOT implemented here. It
// would require a browser process kept alive and shared across every phase's
// separate CLI invocation (bin/phase1.mjs, bin/crawl.mjs, etc. each start a
// new Node process today), which means standing up a small persistent
// server those short-lived scripts would talk to, and it ties Table API
// access to one browser instance staying healthy for the whole run instead
// of a plain, cheaply-parallelized HTTP client. Reach for it only if this
// lightweight replay approach turns out to be blocked or fingerprinted by an
// instance's security controls, which has not been observed. See
// reference/13-data-access.md, Authentication.
//
// Empirically confirmed (reference/14-open-questions.md, item 4b's
// discovery): the Table API returns 401 for a session-cookie request with no
// X-UserToken, and 200 once that header carries the value of window.g_ck.
// That value appears in the literal HTML of any classic-UI page load, e.g.
//   window.g_ck = '2c7d6e89c3938350175f1d0ed401317dce6ea0aa5a6202a228e6a6cf69df12e693a67bac';
// so it can be read with a plain GET and a regex, without evaluating any
// script or opening a browser.

import { readFile } from 'node:fs/promises';

const TOKEN_PATH = '/navpage.do';
const TOKEN_PATTERN = /window\.g_ck\s*=\s*'([0-9a-f]+)'/;

export class SessionAuth {
  #instanceBase;
  #storageStatePath;
  #log;
  #cookieHeader = null;
  #token = null;

  constructor({ instanceBase, storageStatePath, log = null }) {
    this.#instanceBase = instanceBase;
    this.#storageStatePath = storageStatePath;
    this.#log = log;
  }

  /**
   * Cookie plus CSRF-token headers for one Table API request. Cached after
   * the first call; pass forceRefresh to re-read the storage state file and
   * fetch a fresh token (used after a 401, see lib/table-api.mjs).
   *
   * @param {object} [opts]
   * @param {boolean} [opts.forceRefresh=false]
   * @returns {Promise<{Cookie: string, 'X-UserToken': string}>}
   */
  async headers({ forceRefresh = false } = {}) {
    if (forceRefresh || !this.#cookieHeader) {
      this.#cookieHeader = await this.#loadCookieHeader();
      this.#token = null;
    }
    if (!this.#token) {
      this.#token = await this.#fetchToken(this.#cookieHeader);
    }
    return { Cookie: this.#cookieHeader, 'X-UserToken': this.#token };
  }

  async #loadCookieHeader() {
    let state;
    try {
      state = JSON.parse(await readFile(this.#storageStatePath, 'utf8'));
    } catch (err) {
      throw new Error(
        `No captured session at ${this.#storageStatePath} (${err.code === 'ENOENT' ? 'not found' : err.message}). ` +
          'Run: node bin/capture-session.mjs --run <run>  before any phase that touches the Table API. That one login ' +
          'covers the browser phases and every Table API call; no separate service account is needed.',
      );
    }
    const host = new URL(this.#instanceBase).hostname;
    const cookies = (state.cookies ?? []).filter((c) => {
      const domain = String(c.domain ?? '').replace(/^\./, '');
      return host === domain || host.endsWith(`.${domain}`) || domain === host;
    });
    if (!cookies.length) {
      throw new Error(
        `The captured session at ${this.#storageStatePath} has no cookies for ${host}. Re-run bin/capture-session.mjs.`,
      );
    }
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  async #fetchToken(cookieHeader) {
    const res = await fetch(`${this.#instanceBase}${TOKEN_PATH}`, {
      headers: { Cookie: cookieHeader, Accept: 'text/html' },
      redirect: 'follow',
    });
    const text = await res.text().catch(() => '');
    const match = text.match(TOKEN_PATTERN);
    if (!match) {
      await this.#log?.error('session-auth', {
        reason: 'no g_ck in navpage.do response',
        status: res.status,
        finalUrl: res.url,
        looksLikeLogin: /\/login\.do/i.test(res.url) || /user_name/i.test(text),
      });
      throw new Error(
        `Could not find a CSRF token in the captured session's response from ${TOKEN_PATH} (status ${res.status}, ` +
          `landed on ${res.url}). The session has most likely expired. Re-run: node bin/capture-session.mjs --run <run>.`,
      );
    }
    return match[1];
  }
}
