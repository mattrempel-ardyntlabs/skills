// The one narrow, operator-declared write exception.
// See reference/13-data-access.md.
//
// This module produces NOTHING unless the run's metadata.json carries a
// write_exception block that the operator declared at Phase 0, before the audit
// started. In a normal run buildWriteException() returns null, so there is no
// write action anywhere in the process to call.
//
// When one is declared, the returned object exposes exactly one method,
// perform(), hard-scoped to the single declared target. It cannot be pointed at
// another table or another record. Delete is refused with no override.
//
// Two distinct jobs, both in this one function:
//
//   1. The gate. Every check below runs before anything is returned, and
//      nothing here touches the network. bin/init-run.mjs calls it at Phase 0
//      on the operator's declaration and refuses to create the run if it
//      throws, so a malformed or unapproved declaration never reaches
//      metadata.json and is never inherited by a later phase. This is the
//      only copy of those rules; do not re-implement a subset elsewhere.
//   2. The action. perform() issues the single declared request and logs both
//      the attempt and the result. A run that declares no exception never
//      reaches it, because buildWriteException() returned null.

// Exported for any caller that needs the delete blocklist on its own. The gate
// below applies it too, so a caller that goes through buildWriteException()
// does not need to test it separately.
export const FORBIDDEN_ACTION = /\b(delete|remove|destroy|purge|drop|truncate)\b/i;
const ALLOWED_ACTIONS = ['update', 'insert'];

/**
 * @param {object|null} declaration  metadata.write_exception, or null
 * @param {object} deps
 * @param {string} deps.base
 * @param {string|null} [deps.authHeader]  a dedicated credential, if the
 *   customer provisioned one. Exactly one of authHeader/sessionAuth is used.
 * @param {import('./session-auth.mjs').SessionAuth|null} [deps.sessionAuth]
 *   the default: the interactive session captured by bin/capture-session.mjs.
 * @param {import('./run-log.mjs').RunLog} deps.log
 * @returns {null | {name: string, describe(): string, perform(payload: object): Promise<object>}}
 */
export function buildWriteException(declaration, { base, authHeader = null, sessionAuth = null, log }) {
  if (!declaration) return null;

  const { name, action, target, reason, approved } = declaration;
  if (approved !== true) {
    throw new Error(
      'A write_exception declaration exists but approved is not true. ' +
        'The operator must declare it explicitly at Phase 0, never mid-run.',
    );
  }
  if (!name || !action || !target?.table || !reason) {
    throw new Error('write_exception needs name, action, target.table and reason.');
  }
  if (FORBIDDEN_ACTION.test(action) || FORBIDDEN_ACTION.test(name)) {
    throw new Error('Delete is never allowed under the write exception, with no override.');
  }
  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new Error(`write_exception action must be one of ${ALLOWED_ACTIONS.join(', ')}. Got "${action}".`);
  }
  if (action === 'update' && !target.sys_id) {
    throw new Error('An update exception must name the exact target sys_id.');
  }

  const table = target.table;
  const sysId = target.sys_id ?? null;

  return {
    name,
    describe() {
      return `${action} on ${table}${sysId ? `/${sysId}` : ''} ("${name}"): ${reason}`;
    },
    /**
     * Perform the single declared action. Every call is logged locally.
     * Findings produced from it must set write_exception_used to `name`.
     */
    async perform(payload) {
      const url =
        action === 'update'
          ? `${base}/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`
          : `${base}/api/now/table/${encodeURIComponent(table)}`;
      const method = action === 'update' ? 'PATCH' : 'POST';
      await log?.writeExceptionUse(name, { phase: 'attempt', action, table, sys_id: sysId, url, payloadKeys: Object.keys(payload ?? {}) });
      const authHeaders = sessionAuth ? await sessionAuth.headers() : { Authorization: authHeader };
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(payload ?? {}),
      });
      const body = await res.json().catch(() => null);
      await log?.writeExceptionUse(name, { phase: 'result', status: res.status, ok: res.ok, resultSysId: body?.result?.sys_id ?? null });
      if (!res.ok) throw new Error(`write exception "${name}" failed with HTTP ${res.status}`);
      return body?.result ?? {};
    },
  };
}
