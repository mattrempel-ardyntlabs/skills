#!/usr/bin/env node
// Offline test for how a rendered Service Portal widget is recognized.
// Run from the skill directory:  node test/widget-selector.mjs
//
// No ServiceNow instance, no network and no browser. The selector logic in
// lib/browser.mjs is exported precisely so it can be exercised this way; the
// identical matching is inlined inside observe()'s page.evaluate(), and
// test/smoke.mjs covers that DOM path against a mock portal that now renders
// the real markup.
//
// Why this file exists: Service Portal wraps each rendered widget in an
// element carrying a `v<32-hex sp_widget sys_id>` class. The crawler used to
// look for `[widget-id]`, `[data-widget-id]`, `sp-widget` and `[id^=sp_widget]`
// instead -- none of which the platform emits -- so a 237-page crawl recorded
// three widget nodes and every frontend-review capture came back with an empty
// widget list. Nothing in the suite noticed, because the only widget markup
// under test was invented. These checks pin both halves: the real pattern
// matches, and the near-misses that a loosened pattern would sweep up do not.
//
// Covers:
//   - WIDGET_CLASS_PATTERN is anchored, so a v-prefixed hex run inside a
//     longer class name is not a match;
//   - widgetSysIdFromClasses() accepts a class attribute or a classList, picks
//     the widget class out of a multi-class element, and lowercases the sys_id;
//   - 31-hex, 33-hex, non-hex, missing-prefix and ordinary v-words are all
//     rejected;
//   - real selectors captured from a live instance's sp_css bodies all match.

import { WIDGET_CLASS_PATTERN, WIDGET_ATTRIBUTE_SELECTOR, widgetSysIdFromClasses } from '../lib/browser.mjs';

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

// Four selectors taken verbatim out of the sp_css bodies cached under
// portal-audit-runs/esc-2026-09-11/cache/table__sp_css__*.json, which contain
// 78 distinct `.v<32-hex>` selectors between them. Copied in rather than read
// off disk so this test stays offline and runs without a run folder present.
const REAL_SP_CSS_SELECTORS = [
  '.v00d66f61530600101db6ddeeff7b1237',
  '.v04b1cc07c3231200e44574e1c1d3ae96',
  '.v065ce522d7001200a9addd173e24d46a',
  '.v077810090be432004ce28ffe15673adb',
];

const SYS_ID = '6f2a1c9d4b8e7305af16d2c8b904e7f1';

// -------------------------------------------------------------------
// 1. The pattern itself
// -------------------------------------------------------------------
check('WIDGET_CLASS_PATTERN is anchored at the start', WIDGET_CLASS_PATTERN.startsWith('^'));
check('WIDGET_CLASS_PATTERN is anchored at the end', WIDGET_CLASS_PATTERN.endsWith('$'));
check(
  'WIDGET_CLASS_PATTERN requires exactly 32 hex digits after the v',
  WIDGET_CLASS_PATTERN === '^v[0-9a-f]{32}$',
  WIDGET_CLASS_PATTERN,
);

// -------------------------------------------------------------------
// 2. What must match
// -------------------------------------------------------------------
check('a bare .v<sys_id> class matches', widgetSysIdFromClasses(`v${SYS_ID}`) === SYS_ID);
check(
  'the widget class is found among other classes',
  widgetSysIdFromClasses(`panel panel-default v${SYS_ID} ng-scope`) === SYS_ID,
);
check('a classList (array) input works as well as a string', widgetSysIdFromClasses(['ng-scope', `v${SYS_ID}`]) === SYS_ID);
check(
  'an uppercase sys_id is matched and normalized to lowercase',
  widgetSysIdFromClasses(`V${SYS_ID.toUpperCase()}`) === SYS_ID,
  String(widgetSysIdFromClasses(`V${SYS_ID.toUpperCase()}`)),
);
check(
  'extra whitespace in a class attribute does not break matching',
  widgetSysIdFromClasses(`  panel   v${SYS_ID}  `) === SYS_ID,
);
check(
  'the first widget class wins when an element somehow carries two',
  widgetSysIdFromClasses(`v${SYS_ID} v0b1c2d3e4f50617283940a1b2c3d4e5f`) === SYS_ID,
);
for (const selector of REAL_SP_CSS_SELECTORS) {
  const cls = selector.slice(1); // drop the leading "." -> the class name
  check(
    `real captured sp_css selector ${selector} is recognized`,
    widgetSysIdFromClasses(cls) === cls.slice(1),
    String(widgetSysIdFromClasses(cls)),
  );
}

// -------------------------------------------------------------------
// 3. What must NOT match. Every one of these is a lookalike that a
//    loosened pattern (unanchored, or [0-9a-z], or {32,}) would swallow.
// -------------------------------------------------------------------
const lookalikes = [
  ['31 hex digits', `v${SYS_ID.slice(0, 31)}`],
  ['33 hex digits', `v${SYS_ID}a`],
  ['32 chars but one is not hex', 'v6f2a1c9d4b8e7305afg6d2c8b904e7f1'],
  ['a 32-hex class with no v prefix', SYS_ID],
  ['an ordinary v-word class', 'version-banner'],
  ['a hyphenated class that embeds a sys_id', `widget-v${SYS_ID}`],
  ['a sys_id class with a trailing suffix', `v${SYS_ID}-inner`],
  ['a bare v', 'v'],
  ['the empty string', ''],
];
for (const [label, cls] of lookalikes) {
  check(`${label} is not a widget class (${cls.slice(0, 40)})`, widgetSysIdFromClasses(cls) === null, String(widgetSysIdFromClasses(cls)));
}
check('a null classes argument returns null, it does not throw', widgetSysIdFromClasses(null) === null);
check('an undefined classes argument returns null, it does not throw', widgetSysIdFromClasses(undefined) === null);
check('an element with only unrelated classes returns null', widgetSysIdFromClasses(['panel', 'ng-scope', 'sp-widget']) === null);

// -------------------------------------------------------------------
// 4. The attribute fallback is kept, not replaced
// -------------------------------------------------------------------
check('the attribute selector still covers [widget-id]', WIDGET_ATTRIBUTE_SELECTOR.includes('[widget-id]'));
check('the attribute selector still covers [data-widget-id]', WIDGET_ATTRIBUTE_SELECTOR.includes('[data-widget-id]'));

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write('\nFailures:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.exit(failed === 0 ? 0 : 1);
