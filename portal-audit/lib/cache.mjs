// Disk cache for raw API responses, keyed by table plus query.
//
// Two jobs, per reference/13-data-access.md:
//  1. Sub-agents read from the cache instead of re-querying the instance.
//  2. The cache is the audit's evidence trail, so a disputed finding can be
//     re-checked without touching the customer instance again.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export class Cache {
  #dir;
  #enabled;

  constructor(dir, { enabled = true } = {}) {
    this.#dir = dir;
    this.#enabled = enabled;
  }

  static keyFor(kind, table, params) {
    const canonical = JSON.stringify(sortKeys(params ?? {}));
    const hash = createHash('sha256').update(`${kind}|${table}|${canonical}`).digest('hex').slice(0, 16);
    return `${kind}__${table.replace(/[^\w.-]/g, '_')}__${hash}`;
  }

  #pathFor(key) {
    return path.join(this.#dir, `${key}.json`);
  }

  async read(key) {
    if (!this.#enabled) return null;
    try {
      const text = await readFile(this.#pathFor(key), 'utf8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(key, entry) {
    if (!this.#enabled) return;
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#pathFor(key), JSON.stringify(entry, null, 2), 'utf8');
  }

  async list() {
    try {
      const names = await readdir(this.#dir);
      return names.filter((n) => n.endsWith('.json'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return obj;
}
