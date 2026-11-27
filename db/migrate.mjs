#!/usr/bin/env node
// Minimal, idempotent migration runner for the central FMS database.
// Usage: DATABASE_URL=postgres://user:pass@host:5432/fms node db/migrate.mjs [--seed]
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/fms';
const client = new pg.Client({ connectionString: url });

await client.connect();
try {
  // Serialise concurrent runners (e.g. several pods starting at once).
  await client.query('SELECT pg_advisory_lock(727272)');
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await client.query('SELECT name FROM public.schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  const dirs = [join(here, 'migrations')];
  if (process.argv.includes('--seed')) dirs.push(join(here, 'seed'));

  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const key = `${dir.endsWith('seed') ? 'seed/' : ''}${file}`;
      if (done.has(key)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations(name) VALUES ($1)', [key]);
        await client.query('COMMIT');
        console.log(`applied ${key}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`failed ${key}: ${err.message}`);
        process.exitCode = 1;
        break;
      }
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(727272)').catch(() => {});
  await client.end();
}
