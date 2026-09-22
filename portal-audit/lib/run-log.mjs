// Local audit log. Append-only JSONL under <run>/logs/.
//
// Two entry kinds are mandatory by policy, per reference/13-data-access.md:
//   impersonation.start / impersonation.stop   every single one, both directions
//   write-exception.use                        every use of the declared exception
// Errors and skipped items are logged here too so a thin report section can be
// traced back to the failures that caused it.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export class RunLog {
  #dir;

  constructor(logsDir) {
    this.#dir = logsDir;
  }

  async #append(file, entry) {
    await mkdir(this.#dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    await appendFile(path.join(this.#dir, file), line, 'utf8');
  }

  // (persona, detail), matching impersonationStop below -- there is only one
  // call site (lib/browser.mjs), and it always passes a single detail object
  // ({identifier, sys_id}), never a separate target argument.
  impersonationStart(persona, detail = {}) {
    return this.#append('impersonation.jsonl', { event: 'start', persona, ...detail });
  }

  impersonationStop(persona, detail = {}) {
    return this.#append('impersonation.jsonl', { event: 'stop', persona, ...detail });
  }

  writeExceptionUse(name, detail) {
    return this.#append('write-exception.jsonl', { exception: name, ...detail });
  }

  error(kind, detail) {
    return this.#append('errors.jsonl', { kind, ...detail });
  }

  event(kind, detail) {
    return this.#append('events.jsonl', { kind, ...detail });
  }

  async read(file) {
    try {
      const text = await readFile(path.join(this.#dir, file), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}
