// Run folder layout and metadata, per reference/15-report-model.md.
//
// portal-audit-runs/<portal-suffix>-<date>/
//   cache/             raw API responses, keyed by table plus query
//   screenshots/       per template, width and persona
//   crawl-state.json   frontier queue and visited nodes, for resuming
//   findings/          one JSON file per phase
//   logs/              impersonation start/stop, write-exception use, errors
//   metadata.json      authorization confirmation, environment, timestamps
//   report.md

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const RUNS_ROOT = 'portal-audit-runs';

export function runFolderName(suffix, date = new Date()) {
  const d = date.toISOString().slice(0, 10);
  return `${String(suffix).replace(/[^\w-]/g, '_')}-${d}`;
}

export class RunFolder {
  constructor(root) {
    this.root = path.resolve(root);
  }

  static async create(root) {
    const rf = new RunFolder(root);
    await mkdir(rf.cacheDir, { recursive: true });
    await mkdir(rf.screenshotsDir, { recursive: true });
    await mkdir(rf.findingsDir, { recursive: true });
    await mkdir(rf.logsDir, { recursive: true });
    return rf;
  }

  get cacheDir() {
    return path.join(this.root, 'cache');
  }
  get screenshotsDir() {
    return path.join(this.root, 'screenshots');
  }
  get findingsDir() {
    return path.join(this.root, 'findings');
  }
  get logsDir() {
    return path.join(this.root, 'logs');
  }
  get metadataPath() {
    return path.join(this.root, 'metadata.json');
  }
  get crawlStatePath() {
    return path.join(this.root, 'crawl-state.json');
  }
  get contextPath() {
    return path.join(this.root, 'shared-context.json');
  }
  get inventoryPath() {
    return path.join(this.root, 'inventory.json');
  }
  get reportPath() {
    return path.join(this.root, 'report.md');
  }

  async readJson(p, fallback = null) {
    try {
      return JSON.parse(await readFile(p, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  async writeJson(p, value) {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }

  metadata() {
    return this.readJson(this.metadataPath, null);
  }

  sharedContext() {
    return this.readJson(this.contextPath, null);
  }

  async findingsFiles() {
    try {
      const names = await readdir(this.findingsDir);
      return names.filter((n) => n.endsWith('.json')).sort();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}

/**
 * Find the most recent prior run folder for the same portal suffix, excluding
 * the current one. Used for the "Progress since last audit" section.
 */
export async function findPriorRun(suffix, currentRoot, runsRoot = RUNS_ROOT) {
  let names;
  try {
    names = await readdir(runsRoot);
  } catch {
    return null;
  }
  const prefix = `${String(suffix).replace(/[^\w-]/g, '_')}-`;
  const current = path.resolve(currentRoot);
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = path.resolve(runsRoot, name);
    if (full === current) continue;
    const st = await stat(full).catch(() => null);
    if (!st?.isDirectory()) continue;
    candidates.push({ name, full });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates.length ? candidates[candidates.length - 1].full : null;
}
