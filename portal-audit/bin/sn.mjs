#!/usr/bin/env node
// Read-only query CLI. This is the only way any agent in this skill touches the
// instance's data. It can read records and read counts. It cannot write.
//
//   node bin/sn.mjs get   <table> --run <dir> --fields a,b,c [--query Q] [--limit N] [--all] [--display all]
//   node bin/sn.mjs count <table> --run <dir> [--query Q] [--group-by field1,field2]
//
// Output is JSON on stdout. Every response is also written to <run>/cache/.
//
// Options:
//   --summary        print counts and a bounded sample instead of every row
//   --sample N       rows to include with --summary (default 5)
//   --fields         REQUIRED for get. Unbounded field selection is forbidden.
//   --refresh        bypass the disk cache for this call

import { openSession, parseArgs, die } from '../lib/session.mjs';

const args = parseArgs(process.argv.slice(2));
const [command, table] = args._;

if (!command || !table) {
  die('usage: sn.mjs <get|count> <table> --run <dir> [options]');
}
if (!args.run) die('--run <run folder> is required, so responses land in that run\'s cache.');

const { api } = await openSession(args.run);

if (command === 'get') {
  if (!args.fields) die('--fields is required. See reference/13-data-access.md, context discipline.');
  const res = await api.get(table, {
    fields: String(args.fields).split(',').map((s) => s.trim()).filter(Boolean),
    query: args.query || undefined,
    limit: args.limit ? Number(args.limit) : 100,
    offset: args.offset ? Number(args.offset) : 0,
    all: Boolean(args.all),
    maxRows: args['max-rows'] ? Number(args['max-rows']) : 10000,
    displayValue: args.display ?? 'false',
    noDomain: Boolean(args['no-domain']),
    refresh: Boolean(args.refresh),
  });
  if (res.error) {
    process.stdout.write(JSON.stringify({ table, status: res.status, error: res.error, rows: [] }, null, 2) + '\n');
    process.exit(res.status === 403 || res.status === 401 ? 3 : 4);
  }
  if (args.summary) {
    const n = args.sample ? Number(args.sample) : 5;
    process.stdout.write(
      JSON.stringify(
        { table, rowCount: res.rows.length, truncated: res.truncated, fromCache: res.fromCache, sample: res.rows.slice(0, n) },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(JSON.stringify({ table, rowCount: res.rows.length, truncated: res.truncated, rows: res.rows }, null, 2) + '\n');
  }
} else if (command === 'count') {
  const res = await api.count(table, {
    query: args.query || undefined,
    groupBy: args['group-by'] ? String(args['group-by']).split(',').map((s) => s.trim()) : [],
    refresh: Boolean(args.refresh),
  });
  if (res.error) {
    process.stdout.write(JSON.stringify({ table, status: res.status, error: res.error }, null, 2) + '\n');
    process.exit(res.status === 403 || res.status === 401 ? 3 : 4);
  }
  process.stdout.write(JSON.stringify({ table, total: res.total, groups: res.groups }, null, 2) + '\n');
} else {
  die(`unknown command "${command}". This client reads. It has no write command, by design.`);
}
