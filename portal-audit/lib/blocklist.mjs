// The click safety gate, taken verbatim from reference/13-data-access.md:
//
//   "Before any click, check two things: the element is not inside a <form>,
//    and its visible text does not match a blocklist of write verbs (order,
//    submit, save, book, approve, comment, react, apply, request, add to cart,
//    checkout, post, delete, remove). If either check fails, skip the click and
//    log it as 'skipped: looked like a mutating control.'"
//
// This list is the one in that file. Do not extend it, shorten it, or
// re-derive it. Matching is case-insensitive substring matching on the
// element's normalized visible text, which is the conservative reading: it
// over-blocks rather than under-blocks. Every skip is logged with the text that
// triggered it, so the operator can see exactly what the crawl declined.

export const WRITE_VERBS = Object.freeze([
  'order',
  'submit',
  'save',
  'book',
  'approve',
  'comment',
  'react',
  'apply',
  'request',
  'add to cart',
  'checkout',
  'post',
  'delete',
  'remove',
]);

export const SKIP_REASON = 'skipped: looked like a mutating control';

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The write-verb half of the gate.
 * @returns {{blocked: boolean, verb: string|null}}
 */
export function matchesWriteVerb(visibleText) {
  const text = normalizeText(visibleText);
  for (const verb of WRITE_VERBS) {
    if (text.includes(verb)) return { blocked: true, verb };
  }
  return { blocked: false, verb: null };
}

/**
 * Both halves of the gate. `insideForm` comes from the DOM check
 * (element.closest('form') !== null) performed by the browser wrapper.
 *
 * @returns {{allowed: boolean, reason: string|null, verb: string|null}}
 */
export function clickAllowed({ visibleText, insideForm }) {
  if (insideForm) {
    return { allowed: false, reason: `${SKIP_REASON} (inside a <form>)`, verb: null };
  }
  const { blocked, verb } = matchesWriteVerb(visibleText);
  if (blocked) {
    return { allowed: false, reason: `${SKIP_REASON} (write verb "${verb}")`, verb };
  }
  return { allowed: true, reason: null, verb: null };
}
